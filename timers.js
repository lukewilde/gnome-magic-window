// timers.js — One keyed registry per owner for every GLib main-loop source the
// extension creates, so cleanup is a single removeAll() rather than a hunt for
// scattered source-id fields.
//
// Rules for callers:
//   - Never call GLib.timeout_add/idle_add directly; go through add()/addIdle()
//     so the source lands in a registry that disable() drains.
//   - Give each source a named key. One key holds at most one live source —
//     adding under a key that is already live removes the old source first.

import GLib from 'gi://GLib';

export class TimerRegistry {
  constructor() {
    this._sources = new Map(); // key -> GLib source id
  }

  // True while `key` holds a live source. Lets a caller skip re-arming a
  // repeating source without resetting its phase (see the drag polls).
  has(key) {
    return this._sources.has(key);
  }

  add(key, intervalMs, fn) {
    this._register(key, cb => GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, cb), fn);
  }

  addIdle(key, fn) {
    this._register(key, cb => GLib.idle_add(GLib.PRIORITY_DEFAULT, cb), fn);
  }

  // Safe to call for a key with no live source.
  remove(key) {
    const id = this._sources.get(key);
    if (id === undefined) return;
    this._sources.delete(key);
    GLib.source_remove(id);
  }

  removeAll() {
    for (const id of this._sources.values()) GLib.source_remove(id);
    this._sources.clear();
  }

  // The entry is dropped before `fn` runs, so a callback may remove its own
  // timer without GLib.source_remove() hitting a source GLib is already
  // finalizing. A callback returning SOURCE_CONTINUE is re-registered, so a
  // repeating source stays in the map for its whole life.
  _register(key, createSource, fn) {
    this.remove(key);
    const id = createSource(() => {
      this._sources.delete(key);
      if (fn() !== GLib.SOURCE_CONTINUE) return GLib.SOURCE_REMOVE;
      // Skip re-registering if fn() already claimed the key for a new source.
      if (!this._sources.has(key)) this._sources.set(key, id);
      return GLib.SOURCE_CONTINUE;
    });
    this._sources.set(key, id);
  }
}
