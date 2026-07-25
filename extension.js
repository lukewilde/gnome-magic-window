import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gridToPixels, pickNeighbour, shrinkWorkArea } from './positioning.js';
import { KeybindingConflictManager } from './keybinding-conflicts.js';
import { SnapManager } from './snap-manager.js';
import { DragSnapStrategy } from './drag-snap.js';
import { EdgeSnapStrategy } from './edge-snap.js';
import { TimerRegistry } from './timers.js';

// The shell OSD auto-hides 1500ms after the last show(); refresh under that to
// keep it up for the whole double-press window.
const OSD_REFRESH_MS = 1000;
const LAUNCH_OSD_MS = 1000;

// Prefs fires 'changed' per keystroke; an undebounced positions reload would
// rewrite mutter's nav keybindings on every character.
const SETTINGS_RELOAD_DEBOUNCE_MS = 300;

// Every GLib source this file owns, keyed here so disable() can drop the lot
// with one removeAll(). Each key holds at most one live source — see
// TimerRegistry in timers.js. SnapManager keeps its own registry, drained by
// its own disable().
const TIMER = {
  RELOAD_BINDINGS: 'reload-bindings',   // debounce 'changed::bindings'
  RELOAD_POSITIONS: 'reload-positions', // debounce 'changed::positions'
  PRESET_CYCLE: 'preset-cycle',         // expire the position-cycling window
  NAV_GRAB: 'nav-grab',                 // retry grabbing nav accelerators
  LAUNCH_DEBOUNCE: 'launch-debounce',   // suppress repeat app launches
  OSD_HIDE: 'osd-hide',                 // hide the "Launching …" OSD
  LAUNCH_PROMPT_REFRESH: 'launch-prompt-refresh', // keep the OSD alive
  LAUNCH_PROMPT_EXPIRY: 'launch-prompt-expiry',   // double-press deadline
};

// Mirrors the schema default. Used only when 'positions' was never set or is
// invalid — an explicitly emptied list stays empty.
const DEFAULT_POSITIONS = [
  {
    name: 'Columns',
    cols: 16, rows: 1, edgeMargin: 0, cellGap: 0,
    dragModifier: 'ctrl', edgeSnapEnabled: true, navPrefix: '<Super>',
    shortcuts: [
      { shortcut: '<Alt><Super>1', positions: [{ anchor: { col: 1, row: 1 }, target: { col: 4, row: 1 } }, { anchor: { col: 1, row: 1 }, target: { col: 3, row: 1 } }] },
      { shortcut: '<Alt><Super>2', positions: [{ anchor: { col: 4, row: 1 }, target: { col: 8, row: 1 } }, { anchor: { col: 5, row: 1 }, target: { col: 8, row: 1 } }] },
      { shortcut: '<Alt><Super>3', positions: [{ anchor: { col: 13, row: 1 }, target: { col: 16, row: 1 } }, { anchor: { col: 14, row: 1 }, target: { col: 16, row: 1 } }] },
      { shortcut: '<Alt><Super>4', positions: [{ anchor: { col: 1, row: 1 }, target: { col: 8, row: 1 } }, { anchor: { col: 1, row: 1 }, target: { col: 12, row: 1 } }] },
      { shortcut: '<Alt><Super>5', positions: [{ anchor: { col: 5, row: 1 }, target: { col: 12, row: 1 } }, { anchor: { col: 4, row: 1 }, target: { col: 13, row: 1 } }, { anchor: { col: 3, row: 1 }, target: { col: 14, row: 1 } }] },
      { shortcut: '<Alt><Super>6', positions: [{ anchor: { col: 9, row: 1 }, target: { col: 16, row: 1 } }, { anchor: { col: 5, row: 1 }, target: { col: 16, row: 1 } }] },
      { shortcut: '<Alt><Super>7', positions: [{ anchor: { col: 1, row: 1 }, target: { col: 3, row: 1 } }] },
      { shortcut: '<Alt><Super>8', positions: [{ anchor: { col: 9, row: 1 }, target: { col: 13, row: 1 } }, { anchor: { col: 9, row: 1 }, target: { col: 12, row: 1 } }] },
      { shortcut: '<Alt><Super>9', positions: [{ anchor: { col: 14, row: 1 }, target: { col: 16, row: 1 } }] },
    ],
  },
  {
    name: 'Floating Grid',
    cols: 8, rows: 4, edgeMargin: 0, cellGap: 0,
    dragModifier: 'alt', edgeSnapEnabled: false, navPrefix: '<Alt><Super>',
    shortcuts: [
      { shortcut: '<Shift><Alt><Super>1', positions: [{ anchor: { col: 1, row: 3 }, target: { col: 2, row: 4 } }] },
      { shortcut: '<Shift><Alt><Super>2', positions: [{ anchor: { col: 4, row: 3 }, target: { col: 5, row: 4 } }] },
      { shortcut: '<Shift><Alt><Super>3', positions: [{ anchor: { col: 7, row: 3 }, target: { col: 8, row: 4 } }] },
      { shortcut: '<Shift><Alt><Super>4', positions: [{ anchor: { col: 1, row: 2 }, target: { col: 2, row: 3 } }] },
      { shortcut: '<Shift><Alt><Super>5', positions: [{ anchor: { col: 4, row: 2 }, target: { col: 5, row: 3 } }] },
      { shortcut: '<Shift><Alt><Super>6', positions: [{ anchor: { col: 7, row: 2 }, target: { col: 8, row: 3 } }] },
      { shortcut: '<Shift><Alt><Super>7', positions: [{ anchor: { col: 1, row: 1 }, target: { col: 2, row: 2 } }] },
      { shortcut: '<Shift><Alt><Super>8', positions: [{ anchor: { col: 4, row: 1 }, target: { col: 5, row: 2 } }] },
      { shortcut: '<Shift><Alt><Super>9', positions: [{ anchor: { col: 7, row: 1 }, target: { col: 8, row: 2 } }] },
    ],
  },
];

export default class UltrawideShortcutsExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    this._actions = [];
    this._positionActions = [];
    this._navActions = [];
    this._navPending = [];
    // Every GLib source this class creates lives here, keyed by TIMER.*, and
    // disable() drains it. Never call GLib.timeout_add directly.
    this._reloadTimers = new TimerRegistry();
    this._conflicts = new KeybindingConflictManager(this._settings);
    this._launching = false;
    this._lastPreset = null; // { key, windowId, index }
    this._focusHistory = []; // stableSequence[], MRU first
    this._cycleSnapshot = null; // { wmClass, order: stableSequence[] }
    this._pendingLaunch = null; // { key, icon, name } — timers live in _reloadTimers
    this._requireDoublePress = this._settings.get_boolean('require-double-press-to-launch');
    this._doublePressTimeoutMs = this._settings.get_int('double-press-timeout-ms');
    global.display.connectObject(
      'notify::focus-window', this._onFocusChanged.bind(this), this);

    this._setupDbus();
    this._registerBindings();
    this._registerPositions();
    this._conflicts.healStaleBackup();
    this._registerNav();

    this._settings.connectObject(
      'changed::bindings', () => this._scheduleReload(TIMER.RELOAD_BINDINGS, () => {
        this._unregisterBindings();
        this._registerBindings();
      }),
      'changed::positions', () => this._scheduleReload(TIMER.RELOAD_POSITIONS, () => {
        this._unregisterPositions();
        this._unregisterNav();
        this._registerPositions();
        this._registerNav();
      }),
      'changed::require-double-press-to-launch', () => {
        this._requireDoublePress = this._settings.get_boolean('require-double-press-to-launch');
        if (!this._requireDoublePress) this._clearPendingLaunch();
      },
      'changed::double-press-timeout-ms', () => {
        this._doublePressTimeoutMs = this._settings.get_int('double-press-timeout-ms');
      },
      this);

    // Highest priority first — a held drag modifier claims the drag, so
    // edge-snap only sees modifier-free drags.
    this._snap = new SnapManager(this, this._settings, [
      new DragSnapStrategy(),
      new EdgeSnapStrategy(this._settings),
    ]);
    this._snap.enable();
  }

  disable() {
    // Remove main-loop sources first thing (EGO review guideline). Every
    // source this class creates is in the registry — see the TIMER keys above.
    // SnapManager drains its own registry in its disable().
    this._reloadTimers.removeAll();
    this._pendingLaunch = null;

    if (this._snap) {
      this._snap.disable();
      this._snap = null;
    }

    this._settings.disconnectObject(this);
    global.display.disconnectObject(this);

    this._unregisterBindings();
    this._unregisterPositions();
    this._unregisterNav();

    this._dbus.flush();
    this._dbus.unexport();

    this._dbus = null;
    this._conflicts = null;
    this._settings = null;
    this._lastPreset = null;
    this._focusHistory = null;
    this._cycleSnapshot = null;
  }

  _scheduleReload(key, fn) {
    this._reloadTimers.add(key, SETTINGS_RELOAD_DEBOUNCE_MS, () => {
      fn();
      return GLib.SOURCE_REMOVE;
    });
  }

  _setupDbus() {
    this._dbus = Gio.DBusExportedObject.wrapJSObject(`
      <node>
        <interface name="org.gnome.Shell.Extensions.UltrawideShortcuts">
          <method name="magic_key_pressed">
            <arg type="s" direction="in" name="wmClass"/>
            <arg type="s" direction="in" name="command"/>
          </method>
          <method name="list_windows">
            <arg type="s" direction="out" name="json"/>
          </method>
        </interface>
      </node>`, this);
    this._dbus.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/UltrawideShortcuts');
  }

  // --- App focus/launch bindings (from GSettings) ---

  _getBindings() {
    return JSON.parse(this._settings.get_string('bindings'));
  }

  _registerBindings() {
    const bindings = this._getBindings();

    for (const binding of bindings) {
      if (!binding.wmClass || !binding.shortcut) continue;

      const action = global.display.grab_accelerator(binding.shortcut, 0);
      if (action === Meta.KeyBindingAction.NONE) {
        console.warn(`ultrawide-shortcuts: could not grab app shortcut '${binding.shortcut}' for '${binding.wmClass}' — already in use by GNOME, another extension, or a duplicate row; it will not fire`);
        continue;
      }

      const handlerId = global.display.connect(
        'accelerator-activated',
        (_display, activatedAction, _deviceId, _timestamp) => {
          if (activatedAction === action) {
            this.magic_key_pressed(
              binding.wmClass,
              binding.command,
              binding.shortcut
            );
          }
        }
      );

      const name = Meta.external_binding_name_for_action(action);
      Main.wm.allowKeybinding(name, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);

      this._actions.push({ action, handlerId });
    }
  }

  _unregisterBindings() {
    for (const { action, handlerId } of this._actions) {
      global.display.disconnect(handlerId);
      global.display.ungrab_accelerator(action);
    }
    this._actions = [];
  }

  // --- Positions (snap focused window to grid) ---

  _getPositions() {
    const parsed = JSON.parse(this._settings.get_string('positions'));
    if (!Array.isArray(parsed)) return DEFAULT_POSITIONS;
    // Only resurrect the defaults when the key has never been set.
    if (parsed.length === 0 && this._settings.get_user_value('positions') === null)
      return DEFAULT_POSITIONS;
    return parsed;
  }

  _registerPositions() {
    const grids = this._getPositions();
    for (const grid of grids) {
      for (const shortcutConfig of grid.shortcuts) {
        if (!shortcutConfig.shortcut) continue;
        const action = global.display.grab_accelerator(shortcutConfig.shortcut, 0);
        if (action === Meta.KeyBindingAction.NONE) {
          console.warn(`ultrawide-shortcuts: could not grab position shortcut '${shortcutConfig.shortcut}' in grid '${grid.name}' — already in use by GNOME, another extension, or a duplicate row; it will not fire`);
          continue;
        }

        const handlerId = global.display.connect(
          'accelerator-activated',
          (_display, activatedAction, _deviceId, _timestamp) => {
            if (activatedAction === action)
              this._applyPositionShortcut(grid, shortcutConfig);
          }
        );

        const name = Meta.external_binding_name_for_action(action);
        Main.wm.allowKeybinding(name, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
        this._positionActions.push({ action, handlerId });
      }
    }
  }

  _unregisterPositions() {
    for (const { action, handlerId } of this._positionActions) {
      global.display.disconnect(handlerId);
      global.display.ungrab_accelerator(action);
    }
    this._positionActions = [];
  }

  _applyPositionShortcut(grid, shortcutConfig) {
    const focused = global.display.focus_window;
    if (!focused || !shortcutConfig.positions.length) return;

    // Same shortcut + same window within 1s cycles to the next position.
    const focusedId = focused.get_stable_sequence();
    let nextIndex = 0;
    if (this._lastPreset &&
        this._lastPreset.key === shortcutConfig.shortcut &&
        this._lastPreset.windowId === focusedId) {
      nextIndex = (this._lastPreset.index + 1) % shortcutConfig.positions.length;
    }
    this._lastPreset = { key: shortcutConfig.shortcut, windowId: focusedId, index: nextIndex };

    this._reloadTimers.add(TIMER.PRESET_CYCLE, 1000, () => {
      this._lastPreset = null;
      return GLib.SOURCE_REMOVE;
    });

    // 1-indexed storage → 0-indexed for gridToPixels.
    const pos = shortcutConfig.positions[nextIndex];
    if (!pos?.anchor || !pos?.target) return;
    const selection = {
      anchor: { col: pos.anchor.col - 1, row: pos.anchor.row - 1 },
      target: { col: pos.target.col - 1, row: pos.target.row - 1 },
    };

    this._applySelectionToFocused(grid, focused, selection);
  }

  _workAreaFor(grid, focused) {
    const monitorIdx = focused.get_monitor();
    const workspace = global.workspace_manager.get_active_workspace();
    const wa = workspace.get_work_area_for_monitor(monitorIdx);
    return shrinkWorkArea(wa, grid.edgeMargin);
  }

  // selection is already 0-indexed.
  _applySelectionToFocused(grid, focused, selection) {
    const workArea = this._workAreaFor(grid, focused);
    const rect = gridToPixels(selection, { cols: grid.cols, rows: grid.rows }, workArea, grid.cellGap);
    // Fullscreen windows ignore move_resize_frame.
    if (focused.is_fullscreen()) focused.unmake_fullscreen();
    focused.unmaximize();
    focused.move_resize_frame(
      false,
      Math.round(rect.x),
      Math.round(rect.y),
      Math.round(rect.width),
      Math.round(rect.height)
    );
  }

  // --- Directional navigation (move focused window between grid positions) ---

  _buildCandidates(grid, focused) {
    const workArea = this._workAreaFor(grid, focused);
    const gridSize = { cols: grid.cols, rows: grid.rows };
    const candidates = [];
    for (const sc of grid.shortcuts) {
      for (const pos of sc.positions) {
        if (!pos?.anchor || !pos?.target) continue;
        const selection = {
          anchor: { col: pos.anchor.col - 1, row: pos.anchor.row - 1 },
          target: { col: pos.target.col - 1, row: pos.target.row - 1 },
        };
        const rect = gridToPixels(selection, gridSize, workArea, grid.cellGap);
        candidates.push({ rect, selection });
      }
    }
    return candidates;
  }

  _navigate(grid, direction) {
    const focused = global.display.focus_window;
    if (!focused) return;
    const candidates = this._buildCandidates(grid, focused);
    if (!candidates.length) return;
    const fr = focused.get_frame_rect();
    const windowRect = { x: fr.x, y: fr.y, width: fr.width, height: fr.height };
    const idx = pickNeighbour(windowRect, candidates.map(c => c.rect), direction);
    if (idx < 0) return;
    this._applySelectionToFocused(grid, focused, candidates[idx].selection);
  }

  _navAccels() {
    const accels = [];
    for (const grid of this._getPositions()) {
      if (!grid.navPrefix) continue;
      for (const key of ['Left', 'Right', 'Up', 'Down'])
        accels.push(`${grid.navPrefix}${key}`);
    }
    return accels;
  }

  _registerNav() {
    // Take over colliding GNOME shortcuts before grabbing ours.
    this._conflicts.takeOver(this._navAccels());

    const dirs = [
      ['Left', 'left'], ['Right', 'right'],
      ['Up', 'wider'], ['Down', 'narrower'],
    ];
    this._navPending = [];
    for (const grid of this._getPositions()) {
      if (!grid.navPrefix) continue;
      for (const [key, direction] of dirs)
        this._navPending.push({ accel: `${grid.navPrefix}${key}`, grid, direction });
    }

    // Mutter releases the bindings takeOver() stripped only on a later
    // main-loop iteration; grabbing in the same stack frame races that and
    // leaves the key dead. Defer the first attempt and retry briefly.
    this._navGrabRetries = 5;
    this._reloadTimers.add(TIMER.NAV_GRAB, 100, () => this._grabPendingNav());
  }

  // Repeats on the TIMER.NAV_GRAB source until every accelerator is grabbed or
  // the retries run out; returning SOURCE_REMOVE drops the registry entry.
  _grabPendingNav() {
    this._navPending = this._navPending.filter(({ accel, grid, direction }) => {
      const action = global.display.grab_accelerator(accel, 0);
      if (action === Meta.KeyBindingAction.NONE) return true; // keep — retry

      const handlerId = global.display.connect(
        'accelerator-activated',
        (_display, activatedAction, _deviceId, _timestamp) => {
          if (activatedAction === action) this._navigate(grid, direction);
        }
      );

      const name = Meta.external_binding_name_for_action(action);
      Main.wm.allowKeybinding(name, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
      this._navActions.push({ action, handlerId });
      return false;
    });

    if (this._navPending.length === 0) return GLib.SOURCE_REMOVE;
    if (this._navGrabRetries-- <= 0) {
      console.error('ultrawide-shortcuts: failed to grab nav accelerators: ' +
        this._navPending.map(p => p.accel).join(', '));
      this._navPending = [];
      return GLib.SOURCE_REMOVE;
    }
    return GLib.SOURCE_CONTINUE;
  }

  _unregisterNav() {
    this._reloadTimers.remove(TIMER.NAV_GRAB);
    this._navPending = [];
    for (const { action, handlerId } of this._navActions) {
      global.display.disconnect(handlerId);
      global.display.ungrab_accelerator(action);
    }
    this._navActions = [];
    if (this._conflicts) this._conflicts.restore();
  }

  // --- Window helpers ---

  _getWindows() {
    return global.get_window_actors()
      .map(a => {
        const w = a.get_meta_window();
        return {
          id: a.toString(),
          actor: a,
          metaWindow: w,
          wmClass: w.get_wm_class() || '',
          windowTitle: w.get_title() || '',
          monitor: w.get_monitor(),
          stableSequence: w.get_stable_sequence(),
        };
      })
      .filter(w => w.wmClass && !w.wmClass.includes('Gnome-shell'));
  }

  _getActiveWindow() {
    const focused = global.display.focus_window;
    if (!focused) return null;
    const windows = this._getWindows();
    return windows.find(w => w.metaWindow === focused) || null;
  }

  _onFocusChanged() {
    const w = global.display.focus_window;
    if (!w) return;
    // Focus left the cycling app — end the snapshot so the next summon re-sorts.
    if (this._cycleSnapshot) {
      const wc = (w.get_wm_class() || '').toLowerCase();
      if (!wc.includes(this._cycleSnapshot.wmClass))
        this._cycleSnapshot = null;
    }
    const seq = w.get_stable_sequence();
    this._focusHistory = [seq, ...this._focusHistory.filter(s => s !== seq)];
    if (this._focusHistory.length > 200)
      this._focusHistory.length = 200;
  }

  _findWindows(wmClass) {
    const lc = wmClass.toLowerCase();
    const windows = this._getWindows()
      .filter(w => w.wmClass.toLowerCase().includes(lc));

    // Mid-cycle, keep the snapshot order so history updates can't scramble it.
    if (this._cycleSnapshot && this._cycleSnapshot.wmClass === lc) {
      const order = this._cycleSnapshot.order;
      return windows.sort((a, b) => {
        const ai = order.indexOf(a.stableSequence);
        const bi = order.indexOf(b.stableSequence);
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
    }

    // Fresh MRU sort; unvisited windows go to the history tail.
    for (const w of windows) {
      if (!this._focusHistory.includes(w.stableSequence))
        this._focusHistory.push(w.stableSequence);
    }
    const sorted = windows.sort((a, b) =>
      this._focusHistory.indexOf(a.stableSequence) -
      this._focusHistory.indexOf(b.stableSequence));

    this._cycleSnapshot = { wmClass: lc, order: sorted.map(m => m.stableSequence) };
    return sorted;
  }

  magic_key_pressed(wmClass, command, shortcut) {
    const current = this._getActiveWindow();
    const matches = this._findWindows(wmClass);

    if (matches.length === 0) {
      // No matching window — launch the application
      if (this._launching || !command) return;

      // Only accelerator presses are gated; D-Bus callers bypass double-press.
      if (this._requireDoublePress && shortcut) {
        if (this._pendingLaunch && this._pendingLaunch.key === shortcut) {
          const { icon, name } = this._pendingLaunch;
          this._clearPendingLaunch();
          this._showOsd(icon, `Launching ${name}`);
          this._reloadTimers.add(TIMER.OSD_HIDE, LAUNCH_OSD_MS, () => {
            Main.osdWindowManager.hideAll();
            return GLib.SOURCE_REMOVE;
          });
          // fall through to launch
        } else {
          this._clearPendingLaunch();
          this._reloadTimers.remove(TIMER.OSD_HIDE);
          const { icon, name } = this._resolveApp(wmClass);
          const label = `Press again to launch ${name}`;
          this._showOsd(icon, label);
          this._pendingLaunch = { key: shortcut, icon, name };
          this._reloadTimers.add(TIMER.LAUNCH_PROMPT_REFRESH, OSD_REFRESH_MS, () => {
            this._showOsd(icon, label);
            return GLib.SOURCE_CONTINUE;
          });
          this._reloadTimers.add(TIMER.LAUNCH_PROMPT_EXPIRY, this._doublePressTimeoutMs, () => {
            this._clearPendingLaunch();
            Main.osdWindowManager.hideAll();
            return GLib.SOURCE_REMOVE;
          });
          return;
        }
      }

      this._launching = true;
      this._reloadTimers.add(TIMER.LAUNCH_DEBOUNCE, 1000, () => {
        this._launching = false;
        return GLib.SOURCE_REMOVE;
      });
      try {
        GLib.spawn_command_line_async(command);
      } catch (e) {
        console.error(`ultrawide-shortcuts: failed to launch '${command}': ${e.message}`);
        Main.notify('Ultrawide Shortcuts', `Failed to launch: ${command}\n${e.message}`);
      }
    } else {
      // A different shortcut activating a window cancels any pending launch
      this._clearPendingLaunch();
      if (!current || !matches.some(w => w.metaWindow === current.metaWindow)) {
        // Matching window exists but isn't focused — activate first match
        Main.activateWindow(matches[0].metaWindow);
      } else if (matches.length > 1) {
        // Current window IS a match and there are multiple — cycle to next
        const currentIdx = matches.findIndex(w => w.metaWindow === current.metaWindow);
        const nextIdx = (currentIdx + 1) % matches.length;
        Main.activateWindow(matches[nextIdx].metaWindow);
      }
      // Single match already focused — do nothing
    }
  }

  _clearPendingLaunch() {
    this._reloadTimers.remove(TIMER.LAUNCH_PROMPT_REFRESH);
    this._reloadTimers.remove(TIMER.LAUNCH_PROMPT_EXPIRY);
    this._pendingLaunch = null;
  }

  _resolveApp(wmClass) {
    const appSystem = Shell.AppSystem.get_default();
    const lc = wmClass.toLowerCase();
    let app = appSystem.lookup_app(`${lc}.desktop`);
    if (!app) {
      const installed = appSystem.get_installed?.() || [];
      app = installed.find(info => {
        const id = (info.get_id?.() || '').toLowerCase();
        const wm = (info.get_startup_wm_class?.() || '').toLowerCase();
        return id.includes(lc) || (wm && wm.includes(lc));
      });
    }

    return {
      icon: app?.get_icon?.() ?? new Gio.ThemedIcon({ name: 'system-run-symbolic' }),
      name: app?.get_name?.() ?? wmClass,
    };
  }

  _showOsd(icon, label) {
    // GNOME 48 replaced show(monitorIndex, …) with showAll().
    if (Main.osdWindowManager.showAll)
      Main.osdWindowManager.showAll(icon, label, null, null);
    else
      Main.osdWindowManager.show(-1, icon, label, null, null);
  }

  list_windows() {
    const windows = this._getWindows().map(w => ({
      wmClass: w.wmClass,
      windowTitle: w.windowTitle,
      monitor: w.monitor,
    }));
    return JSON.stringify(windows);
  }
}
