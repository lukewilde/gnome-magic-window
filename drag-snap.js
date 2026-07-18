// drag-snap.js — Snap dragged windows into grid positions on release; a hint
// overlay tracks the closest candidate during the drag.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gridToPixels, shrinkWorkArea } from './positioning.js';

const POLL_INTERVAL_MS = 16;

const TRACKED_MOD_MASK =
  Clutter.ModifierType.CONTROL_MASK |
  Clutter.ModifierType.MOD1_MASK;

const MOD_NAME_TO_MASK = {
  none: 0,
  ctrl: Clutter.ModifierType.CONTROL_MASK,
  alt: Clutter.ModifierType.MOD1_MASK,
};

// libadwaita standalone accent palette (GNOME 47+).
const ACCENT_PALETTE = {
  blue:   { r: 0x35, g: 0x84, b: 0xe4 },
  teal:   { r: 0x21, g: 0x90, b: 0xa4 },
  green:  { r: 0x3a, g: 0x94, b: 0x4a },
  yellow: { r: 0xc8, g: 0x88, b: 0x00 },
  orange: { r: 0xed, g: 0x5b, b: 0x00 },
  red:    { r: 0xe6, g: 0x2d, b: 0x42 },
  pink:   { r: 0xd5, g: 0x61, b: 0x99 },
  purple: { r: 0x91, g: 0x41, b: 0xac },
  slate:  { r: 0x6f, g: 0x83, b: 0x96 },
};

export class DragSnapManager {
  constructor(extension, settings) {
    this._extension = extension;
    this._settings = settings;

    this._grabBeginId = 0;
    this._grabEndId = 0;
    this._pollId = 0;
    this._idleCommitId = 0;

    this._draggedWindow = null;
    this._currentRect = null;
    this._cachedStyle = null;
    this._cachedGrids = null;
    this._lastRectKey = null;

    this._overlay = null;
  }

  enable() {
    this._grabBeginId = global.display.connect(
      'grab-op-begin', this._onGrabBegin.bind(this));
    this._grabEndId = global.display.connect(
      'grab-op-end', this._onGrabEnd.bind(this));
  }

  disable() {
    this._stopPoll();
    if (this._idleCommitId) {
      GLib.source_remove(this._idleCommitId);
      this._idleCommitId = 0;
    }
    if (this._grabBeginId) {
      global.display.disconnect(this._grabBeginId);
      this._grabBeginId = 0;
    }
    if (this._grabEndId) {
      global.display.disconnect(this._grabEndId);
      this._grabEndId = 0;
    }
    this._destroyOverlay();
    this._draggedWindow = null;
    this._currentRect = null;
    this._cachedStyle = null;
    this._cachedGrids = null;
    this._lastRectKey = null;
  }

  _onGrabBegin(_display, window, op) {
    if (!this._settings.get_boolean('drag-snap-enabled')) return;
    if (!window) return;
    if (!this._isMoveOp(op)) return;

    this._draggedWindow = window;
    this._currentRect = null;
    this._lastRectKey = null;

    const accent = this._readAccentRgb();
    const opacity = this._settings.get_int('drag-hint-opacity');
    const border = this._settings.get_int('drag-hint-border-width');
    this._cachedStyle = {
      bg: `rgba(${accent.r},${accent.g},${accent.b},${(opacity / 100).toFixed(3)})`,
      border: border > 0
        ? `${border}px solid rgba(${accent.r},${accent.g},${accent.b},1)`
        : 'none',
    };

    // Parse grids once per drag — the tick must not JSON.parse at 60 Hz.
    this._cachedGrids = this._extension._getPositions();

    this._ensureOverlay();
    this._startPoll();
  }

  _onGrabEnd(_display, window, _op) {
    this._stopPoll();

    // Recheck the modifier at release — it may drop in the same instant as the button.
    const [, , modMask] = global.get_pointer();
    const stillHeld = this._selectGrid(modMask & TRACKED_MOD_MASK) !== null;

    if (stillHeld && this._draggedWindow && this._draggedWindow === window && this._currentRect) {
      const rect = this._currentRect;
      const w = window;
      // Defer commit — Mutter may still be finalizing the grab.
      this._idleCommitId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        this._idleCommitId = 0;
        try { w.unmaximize(); } catch { /* already unmaximized */ }
        w.move_resize_frame(
          false,
          Math.round(rect.x), Math.round(rect.y),
          Math.round(rect.width), Math.round(rect.height));
        return GLib.SOURCE_REMOVE;
      });
    }

    this._draggedWindow = null;
    this._currentRect = null;
    this._cachedStyle = null;
    this._cachedGrids = null;
    this._lastRectKey = null;
    if (this._overlay) this._overlay.hide();
  }

  _isMoveOp(op) {
    if (op === Meta.GrabOp.MOVING) return true;
    if (Meta.GrabOp.KEYBOARD_MOVING !== undefined &&
        op === Meta.GrabOp.KEYBOARD_MOVING) return true;
    return false;
  }

  _startPoll() {
    if (this._pollId) return;
    this._pollId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT, POLL_INTERVAL_MS,
      () => { this._tick(); return GLib.SOURCE_CONTINUE; });
  }

  _stopPoll() {
    if (this._pollId) {
      GLib.source_remove(this._pollId);
      this._pollId = 0;
    }
  }

  _tick() {
    const [px, py, modMask] = global.get_pointer();
    const tracked = modMask & TRACKED_MOD_MASK;

    const grid = this._selectGrid(tracked);
    if (!grid) { this._clearHint(); return; }

    const monitorIdx = this._monitorIndexAt(px, py);
    if (monitorIdx < 0) { this._clearHint(); return; }

    const workspace = global.workspace_manager.get_active_workspace();
    const wa = workspace.get_work_area_for_monitor(monitorIdx);
    const workArea = shrinkWorkArea(wa, grid.edgeMargin);

    const winner = this._closestCandidate(grid, workArea, px, py);
    if (!winner) { this._clearHint(); return; }

    this._currentRect = winner;
    this._updateOverlay(winner);
  }

  _clearHint() {
    this._currentRect = null;
    if (this._overlay) this._overlay.hide();
  }

  // Exact mask match — Shift+Alt does not activate a Shift-only grid.
  _selectGrid(trackedMask) {
    if (trackedMask === 0) return null;
    const positions = this._cachedGrids || this._extension._getPositions();
    for (const grid of positions) {
      const name = (grid.dragModifier || 'none').toLowerCase();
      if (name === 'none') continue;
      const mask = MOD_NAME_TO_MASK[name];
      if (!mask) continue;
      if (trackedMask === mask) return grid;
    }
    return null;
  }

  _closestCandidate(grid, workArea, px, py) {
    let bestRect = null;
    let bestDist = Infinity;
    const gridSize = { cols: grid.cols, rows: grid.rows };
    const cellGap = grid.cellGap || 0;

    for (const sc of grid.shortcuts || []) {
      for (const pos of sc.positions || []) {
        if (!pos?.anchor || !pos?.target) continue;
        const sel = {
          anchor: { col: pos.anchor.col - 1, row: pos.anchor.row - 1 },
          target: { col: pos.target.col - 1, row: pos.target.row - 1 },
        };
        const rect = gridToPixels(sel, gridSize, workArea, cellGap);
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        const dx = px - cx;
        const dy = py - cy;
        const d = dx * dx + dy * dy;
        if (d < bestDist) {
          bestDist = d;
          bestRect = rect;
        }
      }
    }
    return bestRect;
  }

  _monitorIndexAt(x, y) {
    const monitors = Main.layoutManager.monitors;
    for (let i = 0; i < monitors.length; i++) {
      const m = monitors[i];
      if (x >= m.x && x < m.x + m.width &&
          y >= m.y && y < m.y + m.height)
        return m.index !== undefined ? m.index : i;
    }
    return -1;
  }

  _ensureOverlay() {
    if (this._overlay) return;
    this._overlay = new St.Widget({
      reactive: false,
      visible: false,
      can_focus: false,
    });
    Main.layoutManager.uiGroup.add_child(this._overlay);
  }

  _destroyOverlay() {
    if (this._overlay) {
      this._overlay.destroy();
      this._overlay = null;
    }
  }

  _updateOverlay(rect) {
    this._ensureOverlay();
    const x = Math.round(rect.x);
    const y = Math.round(rect.y);
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    const key = `${x},${y},${w},${h}`;
    if (key !== this._lastRectKey) {
      this._lastRectKey = key;
      this._overlay.set_position(x, y);
      this._overlay.set_size(w, h);
      this._overlay.set_style(
        `background-color: ${this._cachedStyle.bg}; border: ${this._cachedStyle.border};`);
    }
    this._overlay.show();
  }

  _readAccentRgb() {
    try {
      const s = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
      if (!s.list_keys().includes('accent-color')) return ACCENT_PALETTE.blue;
      const name = s.get_string('accent-color');
      return ACCENT_PALETTE[name] || ACCENT_PALETTE.blue;
    } catch {
      return ACCENT_PALETTE.blue;
    }
  }
}
