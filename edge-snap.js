// edge-snap.js — Modifier-free snapping to edge-touching grid positions when
// dragging near a monitor edge. Yields to drag-snap while its modifier is held.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gridToPixels, shrinkWorkArea } from './positioning.js';

const POLL_INTERVAL_MS = 16;

const MOD_NAME_TO_MASK = {
  ctrl: Clutter.ModifierType.CONTROL_MASK,
  alt: Clutter.ModifierType.MOD1_MASK,
};

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

export class EdgeSnapManager {
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
    this._lockedCandidates = null;
    this._lockMonitorIdx = -1;
    this._lockEdgeKey = null;

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
    this._lockedCandidates = null;
  }

  _onGrabBegin(_display, window, op) {
    if (!this._settings.get_boolean('edge-snap-enabled')) return;
    if (!window) return;
    if (!this._isMoveOp(op)) return;

    this._draggedWindow = window;
    this._currentRect = null;
    this._lastRectKey = null;
    this._lockedCandidates = null;

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

    const [, , modMask] = global.get_pointer();
    const yielding = this._shouldYieldToDragSnap(modMask);

    if (!yielding && this._draggedWindow && this._draggedWindow === window && this._currentRect) {
      const rect = this._currentRect;
      const w = window;
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
    this._lockedCandidates = null;
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

  _dragSnapMaskUnion() {
    let mask = 0;
    const positions = this._cachedGrids || this._extension._getPositions();
    for (const grid of positions) {
      const name = (grid.dragModifier || 'none').toLowerCase();
      const m = MOD_NAME_TO_MASK[name];
      if (m) mask |= m;
    }
    return mask;
  }

  _shouldYieldToDragSnap(modMask) {
    if (!this._settings.get_boolean('drag-snap-enabled')) return false;
    return (modMask & this._dragSnapMaskUnion()) !== 0;
  }

  _tick() {
    const [px, py, modMask] = global.get_pointer();

    if (this._shouldYieldToDragSnap(modMask)) {
      this._lockedCandidates = null;
      this._clearHint();
      return;
    }

    const monitorIdx = this._monitorIndexAt(px, py);
    if (monitorIdx < 0) { this._clearHint(); return; }

    const workspace = global.workspace_manager.get_active_workspace();
    const wa = workspace.get_work_area_for_monitor(monitorIdx);
    const threshold = this._settings.get_int('edge-snap-threshold');
    if (threshold <= 0) {
      this._lockedCandidates = null;
      this._clearHint();
      return;
    }

    const edges = {
      left:   px - wa.x < threshold,
      right:  (wa.x + wa.width) - px < threshold,
      top:    py - wa.y < threshold,
      bottom: (wa.y + wa.height) - py < threshold,
    };
    const inZone = edges.left || edges.right || edges.top || edges.bottom;
    if (!inZone) {
      this._lockedCandidates = null;
      this._clearHint();
      return;
    }

    // Invalidate the lock on monitor change (adjacent zones are contiguous, so
    // we never leave one) or when the edge set changes (edge → corner).
    const edgeKey = `${edges.left ? 'L' : ''}${edges.right ? 'R' : ''}` +
                    `${edges.top ? 'T' : ''}${edges.bottom ? 'B' : ''}`;
    if (this._lockedCandidates &&
        (monitorIdx !== this._lockMonitorIdx || edgeKey !== this._lockEdgeKey)) {
      this._lockedCandidates = null;
    }

    if (!this._lockedCandidates) {
      this._lockedCandidates = this._collectCandidates(wa, edges);
      this._lockMonitorIdx = monitorIdx;
      this._lockEdgeKey = edgeKey;
    }
    const bestRect = this._pickCandidate(this._lockedCandidates, wa, edges, px, py);
    if (!bestRect) { this._clearHint(); return; }
    this._currentRect = bestRect;
    this._updateOverlay(bestRect);
  }

  // Vertical edges: pointer Y maps to a width-sorted index. Horizontal edges:
  // closest center. Corners: the per-edge picks compete on closest center.
  _pickCandidate(groups, wa, edges, px, py) {
    const picks = [];
    if (edges.left   && groups.left.length)   picks.push(this._cyclePick(groups.left,   py, wa.y, wa.height));
    if (edges.right  && groups.right.length)  picks.push(this._cyclePick(groups.right,  py, wa.y, wa.height));
    if (edges.top    && groups.top.length)    picks.push(this._closestByCenter(groups.top,    px, py));
    if (edges.bottom && groups.bottom.length) picks.push(this._closestByCenter(groups.bottom, px, py));
    if (picks.length === 0) return null;
    if (picks.length === 1) return picks[0];
    return this._closestByCenter(picks, px, py);
  }

  _cyclePick(sorted, p, axisStart, axisLength) {
    const n = sorted.length;
    if (n === 1) return sorted[0];
    const t = Math.max(0, Math.min(0.9999, (p - axisStart) / axisLength));
    return sorted[Math.floor(t * n)];
  }

  _closestByCenter(rects, px, py) {
    let best = null;
    let bestDist = Infinity;
    for (const rect of rects) {
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const d = (px - cx) ** 2 + (py - cy) ** 2;
      if (d < bestDist) { bestDist = d; best = rect; }
    }
    return best;
  }

  _collectCandidates(wa, edges) {
    const positions = this._cachedGrids || this._extension._getPositions();
    const groups = { left: [], right: [], top: [], bottom: [] };
    for (const grid of positions) {
      if (!grid.edgeSnapEnabled) continue;
      const workArea = shrinkWorkArea(wa, grid.edgeMargin);
      const cellGap = grid.cellGap || 0;
      const gridSize = { cols: grid.cols, rows: grid.rows };
      for (const sc of grid.shortcuts || []) {
        for (const pos of sc.positions || []) {
          if (!pos?.anchor || !pos?.target) continue;
          const c1 = Math.min(pos.anchor.col, pos.target.col);
          const c2 = Math.max(pos.anchor.col, pos.target.col);
          const r1 = Math.min(pos.anchor.row, pos.target.row);
          const r2 = Math.max(pos.anchor.row, pos.target.row);
          const onLeft   = c1 === 1;
          const onRight  = c2 === grid.cols;
          const onTop    = r1 === 1;
          const onBottom = r2 === grid.rows;
          if (!(onLeft || onRight || onTop || onBottom)) continue;
          const sel = {
            anchor: { col: c1 - 1, row: r1 - 1 },
            target: { col: c2 - 1, row: r2 - 1 },
          };
          const rect = gridToPixels(sel, gridSize, workArea, cellGap);
          if (edges.left   && onLeft)   groups.left.push(rect);
          if (edges.right  && onRight)  groups.right.push(rect);
          if (edges.top    && onTop)    groups.top.push(rect);
          if (edges.bottom && onBottom) groups.bottom.push(rect);
        }
      }
    }
    const dedupe = arr => {
      const seen = new Set();
      const out = [];
      for (const r of arr) {
        const k = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(r);
      }
      return out;
    };
    // Left/right: widest-first for _cyclePick. Top/bottom: _closestByCenter's
    // strict `<` makes the first entry win ties — narrowest for top, widest for bottom.
    groups.left   = dedupe(groups.left).sort((a, b) => b.width - a.width);
    groups.right  = dedupe(groups.right).sort((a, b) => b.width - a.width);
    groups.top    = dedupe(groups.top).sort((a, b) => a.width - b.width);
    groups.bottom = dedupe(groups.bottom).sort((a, b) => b.width - a.width);
    return groups;
  }

  _clearHint() {
    this._currentRect = null;
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
