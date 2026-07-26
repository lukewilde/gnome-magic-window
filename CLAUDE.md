# Ultrawide Shortcuts

GNOME Shell 46–50 extension (GJS ES6+ modules, GObject Introspection).
Targeting 46+ is what lets the code call `unmaximize()` flaglessly and use
`Adw.AlertDialog` directly — EGO rejects the GNOME 45 shims for those.

## Critical: Source Changes Require Session Restart

GJS caches ES modules — `disable()`/`enable()` does NOT reload source files.
**Use `./dev.sh restart-shell` to pick up `.js` changes.** Batch changes to minimize restarts.
GSettings/dconf values ARE live — prefer config over hardcoded values.

## Critical: New Source Files Need Manual Wiring

Lint and the release bundle use **explicit file lists**, not globs. When adding a
new `.js` module, add it to **both** of these or it silently breaks:

- `package.json` → `lint` script (else it's never linted)
- `bundle-files.txt` → the release bundle (else it's missing from the released
  bundle and every `import` of it fails at load on users' machines)

Local `restart-shell` is unaffected (the installed dir is a symlink to the repo), so
a missing entry won't show up until CI/release. **shexli does not catch this** — it
reports a bundle missing an imported module as `clean`, which is how v1.2.2 shipped
broken. `bundle-files.txt` is the single source for CI and `./dev.sh ego`.

## Dev Commands

```bash
npm run lint                      # ESLint — always run before restart
./dev.sh ego                      # shexli — run before tagging a release/EGO upload
./dev.sh restart-shell            # Reload source (session logout/login)
./dev.sh toggle                   # Re-run enable()/disable() only
./dev.sh trigger WM CMD           # Test via D-Bus without keypress
./dev.sh errors                   # Extension errors from GNOME Shell
./dev.sh debug                    # Extension state + debug dump
./dev.sh logs                     # Tail GNOME Shell journal
gjs -m test/test_positioning.js   # Run unit tests
glib-compile-schemas schemas/     # After schema changes
```

## Releases

Run the **Release** workflow from the Actions tab and pick `patch`/`minor`/`major`.
It reads the newest `v*` tag, bumps it, creates the tag *and* the GitHub release,
and attaches the validated bundle. `git tag v1.3.3 && git push origin v1.3.3` still
works and takes the same path — the tag just supplies the version instead of the bump
input. After a dispatch release, `git fetch --tags` to pull the new tag down.

`release.yml` never duplicates the build: it calls `package.yml` via `workflow_call`,
so the bundle command and the shexli pin stay in one place.

**Versioning:** EGO owns the integer `version` field and overwrites whatever you send,
so metadata.json must not contain it. The semver string users see is `version-name`
(EGO rule: `[a-zA-Z0-9 .]{1,16}`, not overwritten). CI stamps it into the *bundle* from
the tag; the checked-in metadata.json stays version-less so the tag can't drift from a
committed number. `./dev.sh ego` stamps the newest tag the same way so local validation
matches the released zip.

## Positions — Indexing Gotcha

Positions stored **1-indexed** in GSettings. `gridToPixels()` takes **0-indexed** — subtract 1 before calling.
`DEFAULT_POSITIONS` in `extension.js` is the runtime fallback when `positions` key is empty/invalid.

Grid shape: `{name, cols, rows, edgeMargin, cellGap, dragModifier, edgeSnapEnabled, navPrefix, shortcuts[{shortcut, positions[{anchor, target}]}]}`.
Call these objects `grid` in code (not `position` — that's the anchor/target pair; never `ward`, a retired term).
Positions text format: `"col:row col:row, col:row col:row"` — comma = cycling positions.

## prefs.js Patterns

- `_writing`/`_writingPositions` flags prevent reload loop (suppress `changed::` during saves).
- Preserve `row.get_expanded()` before `_loadPositions()`/`_loadBindings()`, restore after rebuild.
