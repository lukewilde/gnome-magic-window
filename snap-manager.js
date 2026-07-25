// snap-manager.js — The drag plumbing shared by drag-snap and edge-snap: grab
// hooks, pointer poll, hint overlay, and the deferred commit on release.
//
// Both features are the same interaction — drag a window, preview a target
// rect, snap to it on release — and differ only in how they pick the rect. They
// run as strategies on one manager rather than as two managers racing over the
// same display signals, so a drag costs one poll, one overlay actor and one
// commit path regardless of how many strategies are enabled.
//
// Strategy contract:
//   settingsKey  — GSettings boolean gating the strategy
//   claims(ctx)  — true when the strategy owns this drag, suppressing every
//                  lower-priority strategy even if it yields no rect
//   rectFor(ctx) — the rect to preview and commit, or null
//   beginDrag()/endDrag()/suspend() — optional per-drag state hooks; suspend()
//                  fires on each strategy that did not own the current tick
//
// Strategies are consulted in constructor order, highest priority first.
// ctx = { grids, px, py, modMask, monitorIdx, workArea }, where workArea is the
// raw monitor work area — a strategy shrinks it by its own grid's edge margin.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { TimerRegistry } from './timers.js';

const POLL_INTERVAL_MS = 16;

// Every GLib source this class owns, keyed here so disable() can drop the lot
// with one removeAll(). See TimerRegistry in timers.js.
const TIMER = {
  POLL: 'poll',               // 60 Hz pointer tracking during a drag
  IDLE_COMMIT: 'idle-commit', // deferred move_resize_frame after grab-op-end
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

export class SnapManager {
  constructor(extension, settings, strategies) {
    this._extension = extension;
    this._settings = settings;
    this._strategies = strategies;

    this._grabBeginId = 0;
    this._grabEndId = 0;
    // Every GLib source this class creates lives here, keyed by TIMER.*, and
    // disable() drains it. Never call GLib.timeout_add/idle_add directly.
    this._timers = new TimerRegistry();

    this._draggedWindow = null;
    this._activeStrategies = [];
    this._cachedStyle = null;
    this._cachedGrids = null;
    this._lastRectKey = null;

    this._interfaceSettings = null;
    this._overlay = null;
  }

  enable() {
    // Built once rather than per drag — the accent only needs re-reading when a
    // drag starts, not a fresh Gio.Settings each time.
    try {
      this._interfaceSettings =
        new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
    } catch {
      this._interfaceSettings = null;
    }
    this._grabBeginId = global.display.connect(
      'grab-op-begin', this._onGrabBegin.bind(this));
    this._grabEndId = global.display.connect(
      'grab-op-end', this._onGrabEnd.bind(this));
  }

  disable() {
    // Every source this class creates is in the registry — see TIMER above.
    this._timers.removeAll();
    if (this._grabBeginId) {
      global.display.disconnect(this._grabBeginId);
      this._grabBeginId = 0;
    }
    if (this._grabEndId) {
      global.display.disconnect(this._grabEndId);
      this._grabEndId = 0;
    }
    this._destroyOverlay();
    this._endDrag();
    this._interfaceSettings = null;
  }

  _onGrabBegin(_display, window, op) {
    if (!window) return;
    if (!this._isMoveOp(op)) return;

    this._activeStrategies = this._strategies.filter(
      s => this._settings.get_boolean(s.settingsKey));
    if (this._activeStrategies.length === 0) return;

    this._draggedWindow = window;
    this._lastRectKey = null;
    for (const s of this._activeStrategies) s.beginDrag?.();

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

    // Re-evaluate at release rather than trusting the last tick — a modifier may
    // drop in the same instant as the button, which hands the drag to a
    // different strategy or to none at all.
    const dragged = this._draggedWindow;
    let rect = null;
    if (this._activeStrategies.length > 0) {
      const [px, py, modMask] = global.get_pointer();
      rect = this._evaluate(px, py, modMask);
    }

    if (rect && dragged && dragged === window) {
      const w = window;
      // Defer commit — Mutter may still be finalizing the grab.
      this._timers.addIdle(TIMER.IDLE_COMMIT, () => {
        try { w.unmaximize(); } catch { /* already unmaximized */ }
        w.move_resize_frame(
          false,
          Math.round(rect.x), Math.round(rect.y),
          Math.round(rect.width), Math.round(rect.height));
        return GLib.SOURCE_REMOVE;
      });
    }

    this._endDrag();
    if (this._overlay) this._overlay.hide();
  }

  _endDrag() {
    for (const s of this._activeStrategies) s.endDrag?.();
    this._activeStrategies = [];
    this._draggedWindow = null;
    this._cachedStyle = null;
    this._cachedGrids = null;
    this._lastRectKey = null;
  }

  _isMoveOp(op) {
    if (op === Meta.GrabOp.MOVING) return true;
    if (Meta.GrabOp.KEYBOARD_MOVING !== undefined &&
        op === Meta.GrabOp.KEYBOARD_MOVING) return true;
    return false;
  }

  // A poll already running keeps its phase — don't re-arm it mid-drag.
  _startPoll() {
    if (this._timers.has(TIMER.POLL)) return;
    this._timers.add(TIMER.POLL, POLL_INTERVAL_MS,
      () => { this._tick(); return GLib.SOURCE_CONTINUE; });
  }

  _stopPoll() {
    this._timers.remove(TIMER.POLL);
  }

  _tick() {
    const [px, py, modMask] = global.get_pointer();
    const rect = this._evaluate(px, py, modMask);
    if (!rect) { this._clearHint(); return; }
    this._updateOverlay(rect);
  }

  // Walks the strategies in priority order. The first one to claim the drag owns
  // it outright: its rect is the answer even when that rect is null, so a
  // half-held modifier can't fall through to a lower-priority strategy.
  _evaluate(px, py, modMask) {
    const monitorIdx = this._monitorIndexAt(px, py);
    if (monitorIdx < 0) {
      this._suspendAll();
      return null;
    }

    const workspace = global.workspace_manager.get_active_workspace();
    const ctx = {
      grids: this._cachedGrids || this._extension._getPositions(),
      px, py, modMask, monitorIdx,
      workArea: workspace.get_work_area_for_monitor(monitorIdx),
    };

    let rect = null;
    let claimed = false;
    for (const s of this._activeStrategies) {
      if (!claimed && s.claims(ctx)) {
        claimed = true;
        rect = s.rectFor(ctx) || null;
      } else {
        s.suspend?.();
      }
    }
    return rect;
  }

  _suspendAll() {
    for (const s of this._activeStrategies) s.suspend?.();
  }

  _clearHint() {
    if (this._overlay) this._overlay.hide();
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
    const s = this._interfaceSettings;
    if (!s) return ACCENT_PALETTE.blue;
    try {
      if (!s.list_keys().includes('accent-color')) return ACCENT_PALETTE.blue;
      return ACCENT_PALETTE[s.get_string('accent-color')] || ACCENT_PALETTE.blue;
    } catch {
      return ACCENT_PALETTE.blue;
    }
  }
}
