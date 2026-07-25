// edge-snap.js — Candidate selection for modifier-free dragging near a monitor
// edge: the best grid position touching that edge wins. Runs as the lowest-
// priority strategy on SnapManager, which owns everything shared with drag-snap
// (grab hooks, poll, overlay, commit).
//
// No modifier check lives here. SnapManager consults drag-snap first, and a
// held drag modifier claims the drag outright, so this strategy is only asked
// when no modifier is in play.

import { gridToPixels, shrinkWorkArea } from './positioning.js';

export class EdgeSnapStrategy {
  constructor(settings) {
    this.settingsKey = 'edge-snap-enabled';
    this._settings = settings;
    this._lockedCandidates = null;
    this._lockMonitorIdx = -1;
    this._lockEdgeKey = null;
  }

  // Lowest priority — takes any drag drag-snap has not claimed.
  claims() {
    return true;
  }

  beginDrag() {
    this._lockedCandidates = null;
  }

  endDrag() {
    this._lockedCandidates = null;
  }

  // Another strategy owns this tick; drop the lock so re-entry re-collects.
  suspend() {
    this._lockedCandidates = null;
  }

  rectFor(ctx) {
    const { px, py, monitorIdx, workArea: wa } = ctx;

    const threshold = this._settings.get_int('edge-snap-threshold');
    if (threshold <= 0) {
      this._lockedCandidates = null;
      return null;
    }

    const edges = {
      left:   px - wa.x < threshold,
      right:  (wa.x + wa.width) - px < threshold,
      top:    py - wa.y < threshold,
      bottom: (wa.y + wa.height) - py < threshold,
    };
    if (!(edges.left || edges.right || edges.top || edges.bottom)) {
      this._lockedCandidates = null;
      return null;
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
      this._lockedCandidates = this._collectCandidates(ctx.grids, wa, edges);
      this._lockMonitorIdx = monitorIdx;
      this._lockEdgeKey = edgeKey;
    }
    return this._pickCandidate(this._lockedCandidates, wa, edges, px, py);
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

  _collectCandidates(grids, wa, edges) {
    const groups = { left: [], right: [], top: [], bottom: [] };
    for (const grid of grids) {
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
}
