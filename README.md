# Ultrawide Shortcuts
A GNOME Shell extension designed for efficient window management and application launching. Instantly spawn or focus applications with shortcuts, cycle through multi-window instances, and snap windows into custom grid layouts.

## Main Features

### Launcher
- **Launch apps** — Press a shortcut to focus an app. If it's not running, a second press launches it.
- **Multi-window cycling** — Multiple windows of the same app? The shortcut cycles through them.

### Window Positions
- **Grid positioning** — Snap the focused window into configurable grid positions with `Alt+Super+1-9`.
- **Preset cycling** — Press the same position shortcut again to cycle between alternative sizes.
- **Directional navigation** — Move the focused window between a grid's positions with a prefix + arrow keys (Left/Right = nearest split, Up/Down = wider/narrower).
- **Drag-to-snap** — Hold a per-grid modifier while dragging to snap a window to the nearest grid position.
- **Edge snapping** — Drag a window near a monitor edge to snap it to the best-matching grid position that touches that edge.

## Manual Install

```bash
cd ~/.local/share/gnome-shell/extensions
git clone git@github.com:lukewilde/ultrawide-shortcuts.git ultrawide-shortcuts@lukewilde.co.uk
cd ultrawide-shortcuts@lukewilde.co.uk
glib-compile-schemas schemas/
```

Restart your GNOME session (log out / log in) before running:

```bash
gnome-extensions enable ultrawide-shortcuts@lukewilde.co.uk
```

## Configure

Open the preferences UI:

```bash
gnome-extensions prefs ultrawide-shortcuts@lukewilde.co.uk
```

Each binding has three fields:

- **Shortcut** — The key combination (e.g. `<Shift><Alt><Ctrl>r`)
- **WM Class** — Case-insensitive substring to match the window (e.g. `kitty`)
- **Command** — Launch command if no matching window exists (e.g. `/usr/bin/kitty`)

## Position Presets

- `Alt+Super+1` through `Alt+Super+9` snap the focused window to grid positions on a **16-column × 1-row** grid.
- Presets with multiple sizes cycle on repeated presses
- column spans are 1-indexed and inclusive:

| Key | First press            | Second press               | Third press         |
| --- | ---------------------- | -------------------------- | ------------------- |
| 1   | Left quarter (1–4)     | Narrower left (1–3)        | —                   |
| 2   | Center-left (4–8)      | Narrower (5–8)             | —                   |
| 3   | Right quarter (13–16)  | Narrower right (14–16)     | —                   |
| 4   | Left half (1–8)        | Left three-quarters (1–12) | —                   |
| 5   | Center half (5–12)     | Wider center (4–13)        | Widest center (3–14) |
| 6   | Right half (9–16)      | Right three-quarters (5–16)| —                   |
| 7   | Narrow left (1–3)      | —                          | —                   |
| 8   | Right-center (9–13)    | Narrower (9–12)            | —                   |
| 9   | Narrow right (14–16)   | —                          | —                   |

`Shift+Alt+Super+1` through `Shift+Alt+Super+9` position a floating window on an **8-column × 4-row** grid.

| Key | Position      |
| --- | ------------- |
| 7   | Top left      |
| 8   | Top center    |
| 9   | Top right     |
| 4   | Mid left      |
| 5   | Mid center    |
| 6   | Mid right     |
| 1   | Bottom left   |
| 2   | Bottom center |
| 3   | Bottom right  |

## Drag-to-Snap

Hold a modifier key while dragging a window to snap it to the nearest grid position. Each grid can have its own modifier.

- Snapping is **opt-in**: no modifier held = normal drag.
- Release the mouse while holding the modifier to commit the snap.
- Available modifiers: **Ctrl**, **Alt**. (Shift and Super are intercepted by the compositor for window manipulation, so they can't be used here.)
- GNOME's built-in edge tiling will compete with drag-to-snap — disable it for best results:
  ```bash
  gsettings set org.gnome.mutter edge-tiling false
  ```

## Edge Snapping

Drag a window near a monitor edge to snap it to the best-matching grid position that touches that edge. No modifier is needed — just get the pointer within the edge threshold. Which position you get depends on which edge you're near and where along it the pointer sits:

- **Top edge** — favours the **narrower** edge-touching positions.
- **Bottom edge** — favours the **wider** edge-touching positions.
- **Left / right edges** — the pointer's **height** along the edge selects the size: sweep from top to bottom to cycle through the edge-touching positions from widest to narrowest.

Only grids with edge snapping enabled contribute positions, and only positions that actually touch the edge you're near are considered.

## Directional Navigation

Assign a prefix to a grid, then use **prefix + arrow keys** to move the focused window between that grid's positions:

- **Left / Right** — jump to the nearest split in that direction.
- **Up / Down** — make the window wider / narrower.

Configure the prefix per grid on the Window Positions page. Available prefixes: **None**, **Super**, **Alt+Super**, **Ctrl+Super**, **Shift+Super**. A `Super`-based prefix takes over GNOME's built-in tiling/maximize shortcuts while the extension is enabled; the originals are backed up and restored on disable.

## Double-Press to Launch

By default, an app shortcut only **launches** an app on a quick double-press; a single press still focuses or cycles existing windows. This guards against accidentally spawning apps. This is configurable.


## License

GNU General Public License v3. Originally forked from [gnome-magic-window](https://github.com/adrienverge/gnome-magic-window) by Adrien Vergé.
