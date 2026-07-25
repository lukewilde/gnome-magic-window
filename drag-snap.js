// drag-snap.js — Candidate selection for modifier-held dragging: while a grid's
// drag modifier is down, the position in that grid whose centre is nearest the
// pointer wins. Runs as the highest-priority strategy on SnapManager, which
// owns everything shared with edge-snap (grab hooks, poll, overlay, commit).

import Clutter from 'gi://Clutter';
import { gridToPixels, shrinkWorkArea } from './positioning.js';

const MOD_NAME_TO_MASK = {
  none: 0,
  ctrl: Clutter.ModifierType.CONTROL_MASK,
  alt: Clutter.ModifierType.MOD1_MASK,
};

const TRACKED_MOD_MASK =
  Clutter.ModifierType.CONTROL_MASK |
  Clutter.ModifierType.MOD1_MASK;

export class DragSnapStrategy {
  constructor() {
    this.settingsKey = 'drag-snap-enabled';
  }

  // Any configured drag modifier being down claims the drag, even when no grid
  // matches it exactly. Lower-priority strategies stay out of the way for the
  // whole time a modifier is held rather than snapping underneath it.
  claims(ctx) {
    return (ctx.modMask & this._modUnion(ctx.grids)) !== 0;
  }

  rectFor(ctx) {
    const grid = this._selectGrid(ctx.grids, ctx.modMask & TRACKED_MOD_MASK);
    if (!grid) return null;
    const workArea = shrinkWorkArea(ctx.workArea, grid.edgeMargin);
    return this._closestCandidate(grid, workArea, ctx.px, ctx.py);
  }

  _modUnion(grids) {
    let mask = 0;
    for (const grid of grids) {
      const m = MOD_NAME_TO_MASK[(grid.dragModifier || 'none').toLowerCase()];
      if (m) mask |= m;
    }
    return mask;
  }

  // Exact mask match — Ctrl+Alt does not activate a Ctrl-only grid.
  _selectGrid(grids, trackedMask) {
    if (trackedMask === 0) return null;
    for (const grid of grids) {
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
}
