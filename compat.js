// compat.js — Shims for Mutter API changes across supported shell versions (45–50).

import Meta from 'gi://Meta';

// Mutter 45 requires a MetaMaximizeFlags argument; 46+ is flagless. Detect by arity.
const _UNMAXIMIZE_NEEDS_FLAGS = Meta.Window.prototype.unmaximize.length > 0;

export function unmaximizeWindow(win) {
  if (_UNMAXIMIZE_NEEDS_FLAGS) {
    win.unmaximize(Meta.MaximizeFlags.BOTH);
  } else {
    win.unmaximize();
  }
}
