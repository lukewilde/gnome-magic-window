import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class UltrawideShortcutsPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    this._settings = this.getSettings();
    this._window = window;
    window.set_default_size(700, 600);

    const page = new Adw.PreferencesPage({
      title: 'App Shortcuts',
      icon_name: 'input-keyboard-symbolic',
    });
    window.add(page);

    const behaviorGroup = new Adw.PreferencesGroup({
      title: 'App Shortcut Behavior',
      description: 'Guard against accidental launches by requiring two presses to start an app that is not already running.',
    });
    page.add(behaviorGroup);

    const doublePressRow = new Adw.SwitchRow({
      title: 'Require double-press to launch',
      subtitle: 'Press the shortcut twice within the timeout to launch the app. Focus and cycle behaviour is unaffected.',
    });
    this._settings.bind('require-double-press-to-launch', doublePressRow, 'active',
      Gio.SettingsBindFlags.DEFAULT);
    behaviorGroup.add(doublePressRow);

    const timeoutRow = new Adw.ActionRow({
      title: 'Double-press timeout',
      subtitle: 'Maximum time between the two presses (ms)',
    });
    const timeoutSpin = new Gtk.SpinButton({
      adjustment: new Gtk.Adjustment({
        lower: 150, upper: 2000, step_increment: 50, page_increment: 200,
      }),
      numeric: true,
      width_chars: 5,
      valign: Gtk.Align.CENTER,
    });
    this._settings.bind('double-press-timeout-ms', timeoutSpin, 'value',
      Gio.SettingsBindFlags.DEFAULT);
    timeoutRow.add_suffix(timeoutSpin);
    behaviorGroup.add(timeoutRow);

    timeoutRow.set_sensitive(doublePressRow.get_active());
    doublePressRow.connect('notify::active', () => {
      timeoutRow.set_sensitive(doublePressRow.get_active());
    });

    this._bindingsGroup = new Adw.PreferencesGroup({
      title: 'App Shortcuts',
      description: 'Each shortcut maps a keyboard shortcut to an application.',
    });
    page.add(this._bindingsGroup);

    this._loadBindings();

    const addButton = new Gtk.Button({
      label: 'Add App Shortcut',
      css_classes: ['suggested-action'],
      halign: Gtk.Align.CENTER,
      margin_top: 12,
    });
    addButton.connect('clicked', () => this._addBinding());
    this._bindingsGroup.add(addButton);

    this._settingsChangedId = this._settings.connect('changed::bindings', () => {
      // Only reload if change came from outside (dconf CLI, etc.)
      if (!this._writing) this._loadBindings();
    });

    window.connect('close-request', () => {
      if (this._settingsChangedId) {
        this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = null;
      }
    });

    // --- Window Positions page ---
    this._positionsPage = new Adw.PreferencesPage({
      title: 'Window Positions',
      icon_name: 'view-grid-symbolic',
    });
    window.add(this._positionsPage);

    const positionsDescGroup = new Adw.PreferencesGroup({
      description: 'Each window position defines a grid layout with keyboard shortcuts that snap windows into position.',
    });
    this._positionsPage.add(positionsDescGroup);

    // Stored so _loadPositions can keep it last.
    this._addPositionGroup = new Adw.PreferencesGroup();
    const addPositionButton = new Gtk.Button({
      label: 'Add Window Position',
      css_classes: ['suggested-action'],
      halign: Gtk.Align.CENTER,
      margin_top: 12,
    });
    addPositionButton.connect('clicked', () => this._addPosition());
    this._addPositionGroup.add(addPositionButton);

    this._restoreDefaultsGroup = new Adw.PreferencesGroup();
    const restoreButton = new Gtk.Button({
      label: 'Restore Default Window Positions',
      halign: Gtk.Align.CENTER,
      margin_top: 4,
      margin_bottom: 8,
    });
    restoreButton.connect('clicked', () => this._settings.reset('positions'));
    this._restoreDefaultsGroup.add(restoreButton);

    this._loadPositions();

    this._positionsChangedId = this._settings.connect('changed::positions', () => {
      if (!this._writingPositions) this._loadPositions();
    });

    window.connect('close-request', () => {
      if (this._positionsChangedId) {
        this._settings.disconnect(this._positionsChangedId);
        this._positionsChangedId = null;
      }
    });

    window.connect('close-request', () => {
      if (this._scrollRestoreId) {
        GLib.source_remove(this._scrollRestoreId);
        this._scrollRestoreId = null;
      }
    });

    // --- Drag-to-Snap page ---
    this._buildDragSnapPage(window);
  }

  _buildDragSnapPage(window) {
    const page = new Adw.PreferencesPage({
      title: 'Drag-to-Snap',
      icon_name: 'input-mouse-symbolic',
    });
    window.add(page);

    const group = new Adw.PreferencesGroup({
      title: 'Drag-to-Snap',
      description:
        'Snap windows into configured grid positions while dragging. ' +
        'Snapping activates only while you hold the modifier key assigned to a grid. ' +
        'Configure modifier keys on the Window Positions page.',
    });
    page.add(group);

    const enableRow = new Adw.SwitchRow({
      title: 'Enable Drag-to-Snap',
      subtitle: 'Snap to grid when dragging with the assigned modifier held',
    });
    this._settings.bind('drag-snap-enabled', enableRow, 'active',
      Gio.SettingsBindFlags.DEFAULT);
    group.add(enableRow);

    const opacityRow = new Adw.ActionRow({
      title: 'Hint Opacity',
      subtitle: 'Fill transparency of the snap hint (0–100%)',
    });
    const opacitySpin = new Gtk.SpinButton({
      adjustment: new Gtk.Adjustment({
        lower: 0, upper: 100, step_increment: 5, page_increment: 10,
      }),
      numeric: true,
      width_chars: 4,
      valign: Gtk.Align.CENTER,
    });
    this._settings.bind('drag-hint-opacity', opacitySpin, 'value',
      Gio.SettingsBindFlags.DEFAULT);
    opacityRow.add_suffix(opacitySpin);
    group.add(opacityRow);

    const borderRow = new Adw.ActionRow({
      title: 'Border Width',
      subtitle: 'Thickness of the snap hint outline (px)',
    });
    const borderSpin = new Gtk.SpinButton({
      adjustment: new Gtk.Adjustment({
        lower: 0, upper: 20, step_increment: 1, page_increment: 5,
      }),
      numeric: true,
      width_chars: 4,
      valign: Gtk.Align.CENTER,
    });
    this._settings.bind('drag-hint-border-width', borderSpin, 'value',
      Gio.SettingsBindFlags.DEFAULT);
    borderRow.add_suffix(borderSpin);
    group.add(borderRow);

    const edgeGroup = new Adw.PreferencesGroup({
      title: 'Edge Snapping',
      description:
        'Drag a window near a monitor edge to snap. No modifier needed. ' +
        'Hold a drag-snap modifier to override.',
    });
    page.add(edgeGroup);

    const edgeEnableRow = new Adw.SwitchRow({
      title: 'Enable Edge Snapping',
      subtitle: 'Show a snap hint when dragging near a monitor edge',
    });
    this._settings.bind('edge-snap-enabled', edgeEnableRow, 'active',
      Gio.SettingsBindFlags.DEFAULT);
    edgeGroup.add(edgeEnableRow);

    const thresholdRow = new Adw.ActionRow({
      title: 'Trigger Zone',
      subtitle: 'Distance from edge (px) that activates the snap hint',
    });
    const thresholdSpin = new Gtk.SpinButton({
      adjustment: new Gtk.Adjustment({
        lower: 0, upper: 200, step_increment: 4, page_increment: 16,
      }),
      numeric: true,
      width_chars: 4,
      valign: Gtk.Align.CENTER,
    });
    this._settings.bind('edge-snap-threshold', thresholdSpin, 'value',
      Gio.SettingsBindFlags.DEFAULT);
    thresholdRow.add_suffix(thresholdSpin);
    edgeGroup.add(thresholdRow);
  }

  _getBindings() {
    try {
      return JSON.parse(this._settings.get_string('bindings'));
    } catch {
      return [];
    }
  }

  _saveBindings(bindings) {
    this._writing = true;
    this._settings.set_string('bindings', JSON.stringify(bindings));
    this._writing = false;
  }

  _loadBindings() {
    const expandedStates = this._bindingRows
      ? this._bindingRows.map(r => r.get_expanded())
      : [];

    if (this._bindingRows) {
      this._bindingRows.forEach(r => this._bindingsGroup.remove(r));
    }
    this._bindingRows = [];

    const bindings = this._getBindings();
    bindings.forEach((binding, index) => {
      const row = this._createBindingRow(binding, index);
      if (expandedStates[index]) row.set_expanded(true);
      this._bindingsGroup.add(row);
      this._bindingRows.push(row);
    });
  }

  _accelToLabel(accel) {
    if (!accel) return 'No shortcut';
    try {
      const parsed = Gtk.accelerator_parse(accel);
      const keyval = parsed[1];
      const mods = parsed[2];
      if (keyval) return Gtk.accelerator_get_label(keyval, mods);
    } catch { /* invalid accel string */ }
    return accel;
  }

  _startListening(label, onCapture, currentAccel) {
    const wasListening = this._listeningLabel === label;

    // Stop any active listener, restoring its label
    if (this._listeningController) {
      this._window.remove_controller(this._listeningController);
      this._listeningController = null;
      this._listeningLabel?.set_label(this._listeningRestoreText ?? 'No shortcut');
      this._listeningLabel = null;
      this._listeningRestoreText = null;
    }

    // Toggle off if same button clicked again
    if (wasListening) return;

    const restoreText = this._accelToLabel(currentAccel);
    this._listeningLabel = label;
    this._listeningRestoreText = restoreText;
    label.set_label('Press a shortcut…');

    const controller = new Gtk.EventControllerKey();
    this._listeningController = controller;

    controller.connect('key-pressed', (_ctrl, keyval, keycode, state) => {
      const mask = state & ~(Gdk.ModifierType.LOCK_MASK | Gdk.ModifierType.MOD2_MASK);

      if (keyval === Gdk.KEY_Escape) {
        this._window.remove_controller(controller);
        this._listeningController = null;
        label.set_label(restoreText);
        this._listeningLabel = null;
        return true;
      }

      if (keyval === Gdk.KEY_BackSpace && mask === 0) {
        onCapture('');
        this._window.remove_controller(controller);
        this._listeningController = null;
        label.set_label('No shortcut');
        this._listeningLabel = null;
        return true;
      }

      if (Gtk.accelerator_valid(keyval, mask)) {
        const accelName = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
        const accelLabel = Gtk.accelerator_get_label(keyval, mask);
        onCapture(accelName);
        this._window.remove_controller(controller);
        this._listeningController = null;
        label.set_label(accelLabel);
        this._listeningLabel = null;
        return true;
      }

      return false;
    });

    this._window.add_controller(controller);
  }

  // Resolve a wmClass via DesktopAppInfo — the shell's AppSystem is
  // unavailable in the prefs process. Mirrors the extension's _resolveApp.
  _resolveAppInfo(wmClass) {
    if (!wmClass) return null;
    const lc = wmClass.toLowerCase();
    let info = GioUnix.DesktopAppInfo.new(`${lc}.desktop`);
    if (!info) {
      info = Gio.AppInfo.get_all().find(a => {
        const id = (a.get_id?.() || '').toLowerCase();
        const wm = (a.get_startup_wm_class?.() || '').toLowerCase();
        return id.includes(lc) || (wm && wm.includes(lc));
      }) ?? null;
    }
    return info;
  }

  _refreshBindingHeader(row, image, index) {
    const binding = this._getBindings()[index] ?? {};
    const wmClass = binding.wmClass || '';
    const info = this._resolveAppInfo(wmClass);

    const gicon = info?.get_icon?.();
    if (gicon) image.set_from_gicon(gicon);
    else image.set_from_icon_name('application-x-executable-symbolic');

    const name = info?.get_display_name?.() || info?.get_name?.();
    const shortcut = this._accelToLabel(binding.shortcut);
    row.set_title(GLib.markup_escape_text(name || wmClass || '(empty)', -1));
    row.set_subtitle(GLib.markup_escape_text(shortcut, -1));
  }

  _createBindingRow(binding, index) {
    const row = new Adw.ExpanderRow();
    const appIcon = new Gtk.Image({ pixel_size: 32, valign: Gtk.Align.CENTER });
    row.add_prefix(appIcon);
    this._refreshBindingHeader(row, appIcon, index);

    const shortcutRow = new Adw.ActionRow({ title: 'Shortcut' });
    const shortcutLabel = new Gtk.Label({
      label: this._accelToLabel(binding.shortcut),
      css_classes: ['dim-label'],
      valign: Gtk.Align.CENTER,
    });
    const setShortcutBtn = new Gtk.Button({
      label: 'Set',
      valign: Gtk.Align.CENTER,
      css_classes: ['flat'],
    });
    setShortcutBtn.connect('clicked', () => {
      const currentShortcut = this._getBindings()[index]?.shortcut ?? '';
      this._startListening(shortcutLabel, (accel) => {
        this._updateBinding(index, 'shortcut', accel);
        this._refreshBindingHeader(row, appIcon, index);
      }, currentShortcut);
    });
    shortcutRow.add_suffix(shortcutLabel);
    shortcutRow.add_suffix(setShortcutBtn);
    row.add_row(shortcutRow);

    const wmClassRow = new Adw.EntryRow({ title: 'Window class' });
    wmClassRow.set_text(binding.wmClass || '');
    wmClassRow.connect('changed', () => {
      this._updateBinding(index, 'wmClass', wmClassRow.get_text());
      this._refreshBindingHeader(row, appIcon, index);
    });

    const detectButton = new Gtk.Button({
      icon_name: 'find-location-symbolic',
      valign: Gtk.Align.CENTER,
      tooltip_text: 'Detect from running windows',
      css_classes: ['flat'],
    });
    detectButton.connect('clicked', () => {
      this._showWindowPicker(wmClassRow);
    });
    wmClassRow.add_suffix(detectButton);
    row.add_row(wmClassRow);

    const commandRow = new Adw.EntryRow({ title: 'Launch Command' });
    commandRow.set_text(binding.command || '');
    commandRow.connect('changed', () => {
      this._updateBinding(index, 'command', commandRow.get_text());
    });
    row.add_row(commandRow);

    const deleteRow = new Adw.ActionRow();
    const deleteButton = new Gtk.Button({
      label: 'Remove Shortcut',
      css_classes: ['destructive-action'],
      halign: Gtk.Align.CENTER,
      margin_top: 6,
      margin_bottom: 6,
    });
    deleteButton.connect('clicked', () => {
      const bindings = this._getBindings();
      bindings.splice(index, 1);
      this._saveBindings(bindings);
      this._loadBindings();
    });
    deleteRow.set_child(deleteButton);
    row.add_row(deleteRow);

    return row;
  }

  _updateBinding(index, field, value) {
    const bindings = this._getBindings();
    if (index < bindings.length) {
      bindings[index][field] = value;
      this._saveBindings(bindings);
    }
  }

  _addBinding() {
    const bindings = this._getBindings();
    bindings.push({
      shortcut: '',
      wmClass: '',
      command: '',
    });
    this._saveBindings(bindings);
    this._loadBindings();
  }

  _showWindowPicker(targetEntry) {
    try {
      const connection = Gio.DBus.session;
      const result = connection.call_sync(
        'org.gnome.Shell',
        '/org/gnome/Shell/Extensions/UltrawideShortcuts',
        'org.gnome.Shell.Extensions.UltrawideShortcuts',
        'list_windows',
        null,
        new GLib.VariantType('(s)'),
        Gio.DBusCallFlags.NONE,
        -1,
        null
      );

      const json = result.get_child_value(0).get_string()[0];
      const windows = JSON.parse(json);
      const unique = [...new Map(windows.map(w => [w.wmClass, w])).values()];

      if (unique.length === 0) {
        this._showMessage('No windows detected');
        return;
      }

      const dialog = new Adw.AlertDialog({
        heading: 'Select Window',
        body: 'Choose a running application:',
      });

      unique.forEach((w, i) => {
        dialog.add_response(`win-${i}`, `${w.wmClass}  —  ${w.windowTitle}`);
      });
      dialog.add_response('cancel', 'Cancel');
      dialog.set_default_response('cancel');
      dialog.set_close_response('cancel');

      dialog.connect('response', (_dialog, response) => {
        if (response.startsWith('win-')) {
          const idx = parseInt(response.split('-')[1]);
          targetEntry.set_text(unique[idx].wmClass);
        }
      });

      dialog.present(this._window);
    } catch (e) {
      console.error(`ultrawide-shortcuts: window detection failed: ${e.message}`);
      this._showMessage('Failed to detect windows. Is the extension running?');
    }
  }

  _showMessage(text) {
    const dialog = new Adw.AlertDialog({
      heading: 'Info',
      body: text,
    });
    dialog.add_response('ok', 'OK');
    dialog.present(this._window);
  }

  // --- Position helpers ---

  _getPositions() {
    try {
      return JSON.parse(this._settings.get_string('positions')) || [];
    } catch {
      return [];
    }
  }

  _savePositions(positions) {
    this._writingPositions = true;
    this._settings.set_string('positions', JSON.stringify(positions));
    this._writingPositions = false;
  }

  _positionSubtitle(position) {
    return `${position.cols}×${position.rows}  ·  edge ${position.edgeMargin}px  ·  gap ${position.cellGap}px`;
  }

  _positionSummary(grid, positions) {
    if (positions.length === 0) return 'No positions';
    return positions.map(pos => {
      const c1 = Math.min(pos.anchor.col, pos.target.col);
      const c2 = Math.max(pos.anchor.col, pos.target.col);
      const r1 = Math.min(pos.anchor.row, pos.target.row);
      const r2 = Math.max(pos.anchor.row, pos.target.row);
      const colPart = c1 === c2 ? `c${c1}` : `c${c1}–${c2}`;
      if (grid.rows === 1) return colPart;
      const rowPart = r1 === r2 ? `r${r1}` : `r${r1}–${r2}`;
      return `${colPart} ${rowPart}`;
    }).join(' · ');
  }

  _makePairRow(title, s1, s2) {
    const row = new Adw.ActionRow({ title });

    const makeSpin = ({ label, value, min, max, onChanged }) => {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        valign: Gtk.Align.CENTER,
        spacing: 2,
        margin_start: 8,
      });
      box.append(new Gtk.Label({
        label,
        css_classes: ['caption'],
        halign: Gtk.Align.CENTER,
      }));
      const spin = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({
          lower: min,
          upper: max,
          step_increment: 1,
          page_increment: 10,
        }),
        numeric: true,
        width_chars: 4,
        valign: Gtk.Align.CENTER,
      });
      spin.set_value(value);
      spin.connect('value-changed', () => onChanged(spin.get_value_as_int()));
      box.append(spin);
      return box;
    };

    row.add_suffix(makeSpin(s1));
    row.add_suffix(makeSpin(s2));
    return row;
  }

  _positionsToText(positions) {
    return positions
      .map(p => `${p.anchor.col}:${p.anchor.row} ${p.target.col}:${p.target.row}`)
      .join(', ');
  }

  _textToPositions(text, grid) {
    const maxCol = grid?.cols ?? Infinity;
    const maxRow = grid?.rows ?? Infinity;
    const results = text.split(',').map(part => {
      const tokens = part.trim().split(/\s+/);
      if (tokens.length < 2) return null;
      const [c1, r1] = tokens[0].split(':').map(Number);
      const [c2, r2] = tokens[1].split(':').map(Number);
      if ([c1, r1, c2, r2].some(n => isNaN(n) || n < 1)) return null;
      // Out-of-grid coords are an error, not a position that lands off-screen.
      if (c1 > maxCol || c2 > maxCol || r1 > maxRow || r2 > maxRow) return null;
      return { anchor: { col: c1, row: r1 }, target: { col: c2, row: r2 } };
    });
    return results.includes(null) ? [] : results;
  }

  _updatePosition(positionIndex, field, value) {
    const positions = this._getPositions();
    if (positionIndex < positions.length) {
      positions[positionIndex][field] = value;
      this._savePositions(positions);
    }
  }

  _updateShortcut(positionIndex, shortcutIndex, field, value) {
    const positions = this._getPositions();
    if (positionIndex < positions.length && shortcutIndex < positions[positionIndex].shortcuts.length) {
      positions[positionIndex].shortcuts[shortcutIndex][field] = value;
      this._savePositions(positions);
    }
  }

  _addPosition() {
    const positions = this._getPositions();
    positions.push({ name: 'New Position', cols: 6, rows: 4, edgeMargin: 0, cellGap: 0, shortcuts: [] });
    this._savePositions(positions);
    this._loadPositions();
  }

  _addShortcut(positionIndex) {
    const positions = this._getPositions();
    if (positionIndex < positions.length) {
      positions[positionIndex].shortcuts.push({ shortcut: '', positions: [] });
      this._savePositions(positions);
      this._loadPositions();
    }
  }

  _getPositionsScrollAdj() {
    let child = this._positionsPage.get_first_child();
    while (child && !(child instanceof Gtk.ScrolledWindow)) {
      child = child.get_first_child();
    }
    return child?.get_vadjustment() ?? null;
  }

  _loadPositions() {
    const positionStates = this._positionGroups
      ? this._positionGroups.map(g => ({
          shortcutStates: (g._shortcutRows || []).map(r => r.get_expanded()),
        }))
      : [];

    const adj = this._getPositionsScrollAdj();
    const scrollPos = adj?.get_value() ?? 0;

    if (this._positionGroups) {
      this._positionGroups.forEach(g => this._positionsPage.remove(g));
    }
    this._positionsPage.remove(this._addPositionGroup);
    this._positionsPage.remove(this._restoreDefaultsGroup);
    this._positionGroups = [];

    const positions = this._getPositions();
    positions.forEach((position, index) => {
      const group = this._createPositionGroup(position, index);
      const state = positionStates[index];
      (group._shortcutRows || []).forEach((sr, si) => {
        if (state?.shortcutStates[si]) sr.set_expanded(true);
      });
      this._positionsPage.add(group);
      this._positionGroups.push(group);
    });

    this._positionsPage.add(this._addPositionGroup);
    this._positionsPage.add(this._restoreDefaultsGroup);

    if (adj && scrollPos > 0) {
      if (this._scrollRestoreId)
        GLib.source_remove(this._scrollRestoreId);
      this._scrollRestoreId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        adj.set_value(scrollPos);
        this._scrollRestoreId = null;
        return GLib.SOURCE_REMOVE;
      });
    }
  }

  _createPositionGroup(position, positionIndex) {
    const group = new Adw.PreferencesGroup({
      title: position.name || '(unnamed)',
      description: this._positionSubtitle(position),
    });

    const deleteBtn = new Gtk.Button({
      label: 'Delete',
      css_classes: ['destructive-action'],
      valign: Gtk.Align.CENTER,
    });
    deleteBtn.connect('clicked', () => {
      const positions = this._getPositions();
      positions.splice(positionIndex, 1);
      this._savePositions(positions);
      this._loadPositions();
    });
    group.set_header_suffix(deleteBtn);

    const gridHeader = new Adw.ActionRow({ title: 'Grid Settings' });
    gridHeader.set_activatable(false);
    group.add(gridHeader);

    const nameRow = new Adw.EntryRow({ title: 'Name' });
    nameRow.set_text(position.name || '');
    nameRow.connect('changed', () => {
      this._updatePosition(positionIndex, 'name', nameRow.get_text());
      group.set_title(nameRow.get_text() || '(unnamed)');
    });
    group.add(nameRow);

    group.add(this._makePairRow('Grid size',
      {
        label: 'Cols', value: position.cols, min: 1, max: 100,
        onChanged: v => {
          this._updatePosition(positionIndex, 'cols', v);
          group.set_description(this._positionSubtitle(this._getPositions()[positionIndex]));
        },
      },
      {
        label: 'Rows', value: position.rows, min: 1, max: 100,
        onChanged: v => {
          this._updatePosition(positionIndex, 'rows', v);
          group.set_description(this._positionSubtitle(this._getPositions()[positionIndex]));
        },
      }
    ));

    group.add(this._makePairRow('Margins',
      {
        label: 'Edge (px)', value: position.edgeMargin, min: 0, max: 500,
        onChanged: v => {
          this._updatePosition(positionIndex, 'edgeMargin', v);
          group.set_description(this._positionSubtitle(this._getPositions()[positionIndex]));
        },
      },
      {
        label: 'Gap (px)', value: position.cellGap, min: 0, max: 500,
        onChanged: v => {
          this._updatePosition(positionIndex, 'cellGap', v);
          group.set_description(this._positionSubtitle(this._getPositions()[positionIndex]));
        },
      }
    ));

    group.add(this._makeDragModifierRow(position, positionIndex));
    group.add(this._makeNavPrefixRow(position, positionIndex));

    const edgeSnapRow = new Adw.SwitchRow({
      title: 'Include in edge snapping',
      subtitle: 'Use this grid as a source of edge-snap candidates',
      active: position.edgeSnapEnabled === true,
    });
    edgeSnapRow.connect('notify::active', () => {
      this._updatePosition(positionIndex, 'edgeSnapEnabled', edgeSnapRow.get_active());
    });
    group.add(edgeSnapRow);

    const shortcutsHeader = new Adw.ActionRow({ title: 'Shortcuts' });
    shortcutsHeader.set_activatable(false);
    group.add(shortcutsHeader);

    group._shortcutRows = [];
    position.shortcuts.forEach((shortcutConfig, shortcutIndex) => {
      const sr = this._createShortcutRow(positionIndex, position, shortcutConfig, shortcutIndex);
      group._shortcutRows.push(sr);
      group.add(sr);
    });

    const addShortcutRow = new Adw.ActionRow();
    const addShortcutBtn = new Gtk.Button({
      label: '+ Add Shortcut',
      css_classes: ['flat'],
      halign: Gtk.Align.START,
      margin_top: 6,
      margin_bottom: 6,
    });
    addShortcutBtn.connect('clicked', () => this._addShortcut(positionIndex));
    addShortcutRow.set_child(addShortcutBtn);
    group.add(addShortcutRow);

    return group;
  }

  _makeDragModifierRow(position, positionIndex) {
    const modifiers = ['none', 'ctrl', 'alt'];
    const labels = ['None (snap disabled)', 'Ctrl', 'Alt'];

    const model = new Gtk.StringList();
    labels.forEach(l => model.append(l));

    const row = new Adw.ComboRow({
      title: 'Drag Modifier',
      subtitle: 'Hold this key while dragging a window to snap into this grid',
      model,
    });

    const current = (position.dragModifier || 'none').toLowerCase();
    let initialIdx = modifiers.indexOf(current);
    if (initialIdx < 0) initialIdx = 0;
    row.set_selected(initialIdx);

    row.connect('notify::selected', () => {
      const idx = row.get_selected();
      this._updatePosition(positionIndex, 'dragModifier', modifiers[idx]);
    });

    return row;
  }

  _makeNavPrefixRow(position, positionIndex) {
    const prefixes = ['', '<Super>', '<Alt><Super>', '<Ctrl><Super>', '<Shift><Super>'];
    const labels = ['None (navigation disabled)', 'Super', 'Alt+Super', 'Ctrl+Super', 'Shift+Super'];

    const model = new Gtk.StringList();
    labels.forEach(l => model.append(l));

    const row = new Adw.ComboRow({
      title: 'Directional Navigation',
      subtitle: 'Prefix + arrow keys move the focused window between this grid’s positions ' +
        '(Left/Right = nearest split, Up/Down = wider/narrower). ' +
        'Super takes over GNOME tiling/maximize shortcuts while the extension is enabled.',
      model,
    });

    const current = position.navPrefix || '';
    let initialIdx = prefixes.indexOf(current);
    if (initialIdx < 0) initialIdx = 0;
    row.set_selected(initialIdx);

    row.connect('notify::selected', () => {
      this._updatePosition(positionIndex, 'navPrefix', prefixes[row.get_selected()]);
    });

    return row;
  }

  _createShortcutRow(positionIndex, position, shortcutConfig, shortcutIndex) {
    const row = new Adw.ExpanderRow({
      title: GLib.markup_escape_text(shortcutConfig.shortcut || '(no shortcut)', -1),
      subtitle: this._positionSummary(position, shortcutConfig.positions),
    });

    const shortcutRow = new Adw.ActionRow({ title: 'Shortcut' });
    const shortcutLabel = new Gtk.Label({
      label: this._accelToLabel(shortcutConfig.shortcut),
      css_classes: ['dim-label'],
      valign: Gtk.Align.CENTER,
    });
    const setShortcutBtn = new Gtk.Button({
      label: 'Set',
      valign: Gtk.Align.CENTER,
      css_classes: ['flat'],
    });
    setShortcutBtn.connect('clicked', () => {
      const positions = this._getPositions();
      const currentShortcut = positions[positionIndex]?.shortcuts[shortcutIndex]?.shortcut ?? '';
      this._startListening(shortcutLabel, (accel) => {
        this._updateShortcut(positionIndex, shortcutIndex, 'shortcut', accel);
        const title = accel ? this._accelToLabel(accel) : '(no shortcut)';
        row.set_title(GLib.markup_escape_text(title, -1));
      }, currentShortcut);
    });
    shortcutRow.add_suffix(shortcutLabel);
    shortcutRow.add_suffix(setShortcutBtn);
    row.add_row(shortcutRow);

    const posEntry = new Adw.EntryRow({ title: 'Positions (col:row col:row, …)' });
    posEntry.set_text(this._positionsToText(shortcutConfig.positions));
    posEntry.connect('changed', () => {
      const text = posEntry.get_text().trim();
      if (text === '') {
        posEntry.remove_css_class('error');
        this._updateShortcut(positionIndex, shortcutIndex, 'positions', []);
        row.set_subtitle(this._positionSummary(position, []));
        return;
      }
      const grid = this._getPositions()[positionIndex];
      const positions = this._textToPositions(text, grid);
      if (positions.length > 0) {
        posEntry.remove_css_class('error');
        this._updateShortcut(positionIndex, shortcutIndex, 'positions', positions);
        row.set_subtitle(this._positionSummary(position, positions));
      } else {
        posEntry.add_css_class('error');
      }
    });
    row.add_row(posEntry);

    const removeRow = new Adw.ActionRow();
    const removeBtn = new Gtk.Button({
      label: 'Remove Shortcut',
      css_classes: ['destructive-action'],
      halign: Gtk.Align.CENTER,
      margin_top: 4,
      margin_bottom: 4,
    });
    removeBtn.connect('clicked', () => {
      const positions = this._getPositions();
      positions[positionIndex].shortcuts.splice(shortcutIndex, 1);
      this._savePositions(positions);
      this._loadPositions();
    });
    removeRow.set_child(removeBtn);
    row.add_row(removeRow);

    return row;
  }

}
