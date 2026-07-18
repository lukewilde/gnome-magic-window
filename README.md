# Ultrawide Shortcuts

A GNOME Shell extension for people who drive their desktop from the keyboard. Built with ultrawide monitors in mind, where "left half / right half" tiling wastes most of the screen.

It does two things:

1. **App shortcuts**: one key per app. Press it to focus the app; press it again to cycle its windows; double-press to launch it if it isn't running.
2. **Grid window positions**: snap the focused window into positions on grids you define. The default grid has 16 columns, so you get useful ultrawide layouts like "centred half" or "left three-quarters", not just halves and quarters.

Everything below describes the **default** setup. Every shortcut, grid, and behaviour is configurable in the preferences UI.

## Install

Install from [extensions.gnome.org](https://extensions.gnome.org/extension/9926/ultrawide-shortcuts/).

<details>
<summary>Manual install from source</summary>

```bash
cd ~/.local/share/gnome-shell/extensions
git clone git@github.com:lukewilde/ultrawide-shortcuts.git ultrawide-shortcuts@lukewilde.co.uk
glib-compile-schemas ultrawide-shortcuts@lukewilde.co.uk/schemas/
```

Log out and back in, then:

```bash
gnome-extensions enable ultrawide-shortcuts@lukewilde.co.uk
```

</details>

## Two minutes to productive

Focus any window and try these:

| Press | What happens |
| --- | --- |
| `Alt+Super+4` | Snap to the **left half**. Press again: widen to three-quarters. |
| `Alt+Super+5` | Snap to the **centred half**. Repeat presses widen it. |
| `Alt+Super+6` | Snap to the **right half**. |
| `Ctrl` + drag a window | Preview and snap to the nearest grid position. Plain drags are untouched. |
| Drag a window to a screen edge | Snap to a grid position along that edge, no modifier needed. |

Then set up your first app shortcut: run `gnome-extensions prefs ultrawide-shortcuts@lukewilde.co.uk` and add a binding with three fields:

- **Shortcut** — e.g. `<Shift><Alt><Ctrl>r`
- **WM Class** — case-insensitive substring matching the window, e.g. `kitty`
- **Command** — what to run when no window matches, e.g. `/usr/bin/kitty`

## The default grids

Two grids ship out of the box:

**Columns** (16×1, for main work windows) — `Alt+Super+1–9`. Keys `4`/`5`/`6` are the halves shown above; `1`/`2`/`3` are quarter-ish slots (left, centre-left, right); `7`/`8`/`9` are narrow slots for chat/music-sized windows. Where a key has multiple sizes, repeated presses cycle through them.

**Floating Grid** (8×4, for small windows) — `Shift+Alt+Super+1–9` places the window in a 3×3 arrangement laid out like a numpad: `7` is top-left, `5` is centre, `3` is bottom-right. Its drag modifier is `Alt`.

You can edit these grids or add your own — grid dimensions, margins, gaps, and every position are yours to change.

## Beyond the basics

**Drag-to-snap** — hold a grid's modifier (`Ctrl` or `Alt`; each grid has its own) while dragging, release to commit. GNOME's built-in edge tiling fights with this — disable it for best results:

```bash
gsettings set org.gnome.mutter edge-tiling false
```

**Edge snapping** — drag near a screen edge (no modifier) and the window snaps to a grid position touching that edge. The top edge favours narrower positions, the bottom favours wider ones, and on the left/right edges the pointer's height picks the size, sweep down the edge to go from widest to narrowest.

**Directional navigation** — give a grid a prefix (e.g. `Super`), then `prefix+Left/Right` jumps the window to the nearest split in that direction and `prefix+Up/Down` widens/narrows it. A `Super` prefix takes over GNOME's built-in tiling shortcuts while the extension is enabled; the originals are backed up and restored on disable.

## License

GNU General Public License v3. Originally forked from [gnome-magic-window](https://github.com/adrienverge/gnome-magic-window) by Adrien Vergé.
