#!/bin/sh
# Removes the Botwarren ship agent for the current user (macOS, Linux). No root needed.
#
#   ~/.local/share/botwarren/uninstall.sh [--yes] [--keep-config] [--keep-data]
#   botwarren uninstall [--yes] [--keep-config] [--keep-data]
#
# Removes: the background service (and the previous installer's), the `botwarren` command, the program files
# (runtime, launcher, versions, update state, logs) and, unless you keep them, your config + ship secret and your local
# data (private journal, tokens). Public events already published stay on your public page until you delete your ship on
# the website.
#   --keep-config   keep ~/.config/botwarren-ship (config.json, ship.secret) so a reinstall reconnects at once
#   --keep-data     keep ~/.local/share/botwarren-ship (the local private journal)
#   --yes           do not ask (required when not run from a terminal)
# Source: https://github.com/turbokast/botwarren-ship (apps/shipagent/packaging/uninstall.sh)
set -u

main() {
  YES=0; KEEP_CONFIG=0; KEEP_DATA=0
  for a in "$@"; do
    case "$a" in
      --yes|-y) YES=1 ;;
      --keep-config) KEEP_CONFIG=1 ;;
      --keep-data) KEEP_DATA=1 ;;
      -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; return 0 ;;
      *) printf 'uninstall: unknown option %s\n' "$a" >&2; return 2 ;;
    esac
  done

  ROOT="${BOTWARREN_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/botwarren}"
  BIN_DIR="${BOTWARREN_BIN_DIR:-$HOME/.local/bin}"
  CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/botwarren-ship"
  DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/botwarren-ship"
  LEGACY_DIR="$HOME/.local/lib/botwarren-ship"
  OS=$(uname -s)

  # never delete a path that is not clearly ours
  safe_root "$ROOT" || { printf 'uninstall: refusing to remove %s (not a Botwarren install)\n' "$ROOT" >&2; return 1; }

  if [ "$YES" != 1 ]; then
    if [ -t 0 ] && [ -t 1 ]; then
      printf 'This removes Botwarren%s%s. Continue? [y/N] ' "$([ "$KEEP_CONFIG" = 1 ] || echo ', your config and ship secret')" "$([ "$KEEP_DATA" = 1 ] || echo ', and your local data')"
      read -r ans || ans=n
      case "$ans" in y|Y|yes|YES) ;; *) printf 'Cancelled.\n'; return 1 ;; esac
    else
      printf 'uninstall: not a terminal; add --yes to confirm\n' >&2; return 2
    fi
  fi

  printf '==> Stopping the service\n'
  if [ "$OS" = Darwin ]; then
    for l in com.turbokast.botwarren com.botwarren.ship; do launchctl bootout "gui/$(id -u)/$l" >/dev/null 2>&1 || true; done
    rm -f "$HOME/Library/LaunchAgents/com.turbokast.botwarren.plist" "$HOME/Library/LaunchAgents/com.botwarren.ship.plist"
  else
    if command -v systemctl >/dev/null 2>&1; then
      for u in botwarren.service botwarren-ship.service; do systemctl --user disable --now "$u" >/dev/null 2>&1 || true; done
      rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/botwarren.service" "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/botwarren-ship.service"
      systemctl --user daemon-reload >/dev/null 2>&1 || true
    fi
    rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/autostart/botwarren.desktop"
  fi
  # a launcher started by hand or by autostart
  if [ -f "$ROOT/state/launcher.lock" ]; then
    PID=$(cat "$ROOT/state/launcher.lock" 2>/dev/null || echo)
    case "$PID" in ''|*[!0-9]*) ;; *) kill "$PID" >/dev/null 2>&1 || true ;; esac
    sleep 1
  fi

  printf '==> Removing the command and program files\n'
  rm -f "$BIN_DIR/botwarren"
  rm -rf "$LEGACY_DIR"
  rm -f "$HOME/.local/bin/botwarren"   # the previous installer's wrapper lived here too
  rm -rf "$ROOT"

  if [ "$KEEP_DATA" != 1 ]; then rm -rf "$DATA_DIR"; else printf '    kept local data: %s\n' "$DATA_DIR"; fi
  if [ "$KEEP_CONFIG" != 1 ]; then rm -rf "$CFG_DIR"; else printf '    kept config: %s\n' "$CFG_DIR"; fi
  printf 'Removed. Public events already published stay on your public page until you delete your ship on the website.\n'
}

safe_root() {
  case "$1" in /|"$HOME"|"$HOME"/|'') return 1 ;; /*) ;; *) return 1 ;; esac
  [ -e "$1/current.json" ] || [ -e "$1/launcher/launcher.mjs" ] || [ ! -e "$1" ]
}

main "$@"
