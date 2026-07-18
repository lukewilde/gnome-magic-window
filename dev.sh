#!/usr/bin/env bash
set -euo pipefail

EXT="ultrawide-shortcuts@lukewilde.co.uk"
DBUS_PATH="/org/gnome/Shell/Extensions/UltrawideShortcuts"
DBUS_IFACE="org.gnome.Shell.Extensions.UltrawideShortcuts"
DEBUG_FILE="/tmp/ultrawide-shortcuts-debug"

case "${1:-help}" in
  reload)
    # On Wayland, ES modules are cached for the shell process lifetime.
    # disable/enable re-runs lifecycle methods but does NOT re-import source files.
    # A full session restart is needed to pick up code changes.
    echo ":: Restarting GNOME Shell session to reload extension source..."
    echo ":: (Your session will restart — all windows will be preserved)"
    echo ""
    read -p "Press Enter to restart, or Ctrl+C to cancel..."
    busctl --user call org.gnome.Shell /org/gnome/Shell org.gnome.Shell.Extensions DisableExtension s "$EXT"
    busctl --user call org.gnome.Shell /org/gnome/Shell org.gnome.Shell.Extensions EnableExtension s "$EXT"
    # If that's not enough (code changes), fall back to session restart:
    echo ":: Note: If code changes didn't take effect, run: ./dev.sh restart-shell"
    ;;
  restart-shell)
    echo ":: This will log you out and back in. Save your work!"
    read -p "Press Enter to continue, or Ctrl+C to cancel..."
    gnome-session-quit --no-prompt
    ;;
  toggle)
    # Quick disable/enable — useful for testing enable()/disable() logic
    # without needing source changes to reload
    echo ":: Toggling extension off and on..."
    gnome-extensions disable "$EXT" 2>/dev/null || true
    sleep 0.5
    gnome-extensions enable "$EXT"
    echo ":: Toggled. (Note: source code is NOT reloaded, only lifecycle methods re-run)"
    ;;
  trigger)
    # Fire a magic_key_pressed via dbus — useful for testing without pressing keys
    WM_CLASS="${2:-test}"
    CMD="${3:-echo}"
    echo ":: Triggering magic_key_pressed('$WM_CLASS', '$CMD') via D-Bus..."
    gdbus call --session \
      --dest org.gnome.Shell \
      --object-path "$DBUS_PATH" \
      --method "$DBUS_IFACE.magic_key_pressed" \
      "$WM_CLASS" "$CMD"
    echo ":: Done."
    ;;
  logs)
    echo ":: Tailing GNOME Shell logs (Ctrl+C to stop)..."
    journalctl -f /usr/bin/gnome-shell -o cat
    ;;
  errors)
    echo ":: Extension errors:"
    busctl --user call org.gnome.Shell /org/gnome/Shell \
      org.gnome.Shell.Extensions GetExtensionErrors s "$EXT" 2>&1
    ;;
  debug)
    echo ":: Extension state:"
    gnome-extensions info "$EXT"
    echo ""
    echo ":: Last debug output:"
    cat "$DEBUG_FILE" 2>/dev/null || echo "(no debug output yet)"
    ;;
  pack)
    mkdir -p dist
    gnome-extensions pack . --out-dir=dist --force
    echo ":: Packed to dist/$EXT.shell-extension.zip"
    ;;
  ego)
    # Runs the same rules extensions.gnome.org applies to an upload, against the
    # same bundle CI builds. Pins tree-sitter: shexli 0.2.1 accepts >=0.25.0, but
    # tree-sitter 0.26 segfaults against tree-sitter-javascript's 0.25 ABI.
    VENV="${TMPDIR:-/tmp}/ultrawide-shexli-venv"
    if [ ! -x "$VENV/bin/shexli" ]; then
      echo ":: Bootstrapping shexli into $VENV..."
      python3 -m venv "$VENV"
      "$VENV/bin/pip" install --quiet shexli==0.2.1 "tree-sitter<0.26"
    fi
    ZIP="$(mktemp -d)/$EXT.zip"
    zip -q "$ZIP" -@ < bundle-files.txt
    "$VENV/bin/shexli" "$ZIP"
    # shexli exits 0 even when it reports errors, so gate on the JSON status.
    if [ "$("$VENV/bin/shexli" --format json "$ZIP" | jq -r '.summary.status')" != "clean" ]; then
      echo ":: FAILED — fix the findings above before uploading to EGO."
      exit 1
    fi
    ;;
  help|*)
    echo "Usage: ./dev.sh <command>"
    echo ""
    echo "Commands:"
    echo "  reload         - Disable/enable extension (re-runs lifecycle, no source reload)"
    echo "  restart-shell  - Restart GNOME session (required for source code changes)"
    echo "  toggle         - Quick off/on cycle for testing enable/disable logic"
    echo "  trigger [wm] [cmd]       - Fire magic_key_pressed via D-Bus"
    echo "  logs           - Tail GNOME Shell journal logs"
    echo "  errors         - Show extension errors from GNOME Shell"
    echo "  debug          - Show extension info and last debug output"
    echo "  ego            - Validate the release bundle with shexli (EGO review rules)"
    echo "  pack           - Package extension as .zip for distribution"
    ;;
esac
