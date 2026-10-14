#!/bin/sh
# Botwarren ship agent installer for macOS and Linux. Per-user, never needs root.
#
#   curl -fsSL https://downloads.botwarren.com/install.sh | sh
#   curl -fsSL https://downloads.botwarren.com/install.sh | sh -s -- --no-service
#
# Source: https://github.com/turbokast/botwarren-ship  (apps/shipagent/packaging/install.sh)
#
# What it does:
#   1. finds the archive for this OS/CPU in install-index.txt and downloads it
#   2. checks its SHA-256, then lists the archive and refuses unsafe paths
#   3. unpacks to a temp dir and runs `botwarren verify-release`: the signed manifest (Ed25519, key pinned in the agent)
#      must contain exactly this archive's hash. Nothing is installed or started before that passes.
#   4. installs side by side into ~/.local/share/botwarren (runtime/, launcher/, versions/<v>/), a `botwarren` command in
#      ~/.local/bin, and a per-user background service (systemd --user on Linux, a launchd LaunchAgent on macOS)
# Trust note: steps 1-2 rest on TLS to the download host; the signature check in step 3 is what binds the archive to the
# release key. Prefer not to pipe to sh? Download this file, read it, then run it.
#
# Options (or the matching environment variables):
#   --base-url URL    BOTWARREN_BASE_URL     download base (default https://downloads.botwarren.com)
#   --version X.Y.Z   BOTWARREN_VERSION      install that version instead of the stable one
#   --install-dir D   BOTWARREN_INSTALL_DIR  default ~/.local/share/botwarren
#   --bin-dir D       BOTWARREN_BIN_DIR      default ~/.local/bin
#   --no-service      BOTWARREN_NO_SERVICE=1 do not register or start the background service
#   --linger          --no-linger            Linux: keep the service running after logout (loginctl enable-linger)
#   --dry-run         BOTWARREN_DRY_RUN=1    print what would happen, change nothing
#   --print-service[=KIND]                   print the service definition (systemd|launchd|autostart) and exit
#   --help
# Exit codes: 0 ok, 1 failed (nothing half-installed is left active), 2 bad usage.
set -eu

main() {
  BASE_URL="${BOTWARREN_BASE_URL:-https://downloads.botwarren.com}"
  VERSION="${BOTWARREN_VERSION:-}"
  ROOT="${BOTWARREN_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/botwarren}"
  BIN_DIR="${BOTWARREN_BIN_DIR:-$HOME/.local/bin}"
  WANT_SERVICE=1
  [ "${BOTWARREN_NO_SERVICE:-0}" = 1 ] && WANT_SERVICE=0
  DRY_RUN="${BOTWARREN_DRY_RUN:-0}"
  LINGER=ask
  PRINT_SERVICE=0
  PRINT_KIND=

  while [ $# -gt 0 ]; do
    case "$1" in
      --base-url) [ $# -ge 2 ] || usage_error "--base-url needs a value"; BASE_URL=$2; shift ;;
      --version) [ $# -ge 2 ] || usage_error "--version needs a value"; VERSION=$2; shift ;;
      --install-dir) [ $# -ge 2 ] || usage_error "--install-dir needs a value"; ROOT=$2; shift ;;
      --bin-dir) [ $# -ge 2 ] || usage_error "--bin-dir needs a value"; BIN_DIR=$2; shift ;;
      --no-service) WANT_SERVICE=0 ;;
      --linger) LINGER=yes ;;
      --no-linger) LINGER=no ;;
      --dry-run) DRY_RUN=1 ;;
      --print-service) PRINT_SERVICE=1 ;;
      --print-service=*) PRINT_SERVICE=1; PRINT_KIND=${1#*=} ;;
      -h|--help) sed -n '2,32p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) usage_error "unknown option: $1" ;;
    esac
    shift
  done

  BASE_URL=${BASE_URL%/}
  case "$BASE_URL" in
    https://*) ;;
    http://127.0.0.1*|http://localhost*|http://\[::1\]*) ;;
    *) die "the download base must be https (got: $BASE_URL)" ;;
  esac
  case "$ROOT" in /*) ;; *) die "--install-dir must be an absolute path" ;; esac
  case "$ROOT" in *[!A-Za-z0-9._/@+\ -]*) die "the install directory may only contain letters, digits and . _ / @ + - and space" ;; esac
  case "$BIN_DIR" in /*) ;; *) die "--bin-dir must be an absolute path" ;; esac

  OS=$(uname -s)
  ARCH=$(uname -m)
  case "$OS" in
    Linux) PLAT=linux ;;
    Darwin) PLAT=mac ;;
    *) die "unsupported OS: $OS (Windows: use install.ps1)" ;;
  esac
  case "$ARCH" in
    x86_64|amd64) CPU=x64 ;;
    aarch64|arm64) CPU=arm64 ;;
    *) die "unsupported CPU: $ARCH" ;;
  esac
  # an Intel shell on Apple Silicon (Rosetta): install the native build
  if [ "$PLAT" = mac ] && [ "$CPU" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then CPU=arm64; fi
  TARGET="$PLAT-$CPU"

  SERVICE_KIND=none
  if [ "$WANT_SERVICE" = 1 ]; then
    if [ "$PLAT" = mac ]; then SERVICE_KIND=launchd
    elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then SERVICE_KIND=systemd
    else SERVICE_KIND=autostart; fi
  fi

  if [ "$PRINT_SERVICE" = 1 ]; then
    [ -n "$PRINT_KIND" ] && SERVICE_KIND=$PRINT_KIND
    [ "$SERVICE_KIND" = none ] && SERVICE_KIND=$([ "$PLAT" = mac ] && echo launchd || echo systemd)
    service_text "$SERVICE_KIND"
    return 0
  fi

  say "Botwarren ship agent installer ($TARGET)"
  say "  install dir : $ROOT"
  say "  command     : $BIN_DIR/botwarren"
  say "  service     : $SERVICE_KIND"
  say "  downloads   : $BASE_URL"
  if [ "$DRY_RUN" = 1 ]; then say "dry run: nothing was downloaded or changed."; return 0; fi

  TMP=$(mktemp -d "${TMPDIR:-/tmp}/botwarren-install.XXXXXX")
  trap 'rm -rf "$TMP"' EXIT INT TERM HUP

  step "Looking up the release"
  fetch "$BASE_URL/install-index.txt" "$TMP/install-index.txt"
  LINE=$(awk -v v="$VERSION" -v t="$TARGET" '$2 == t && (v == "" || $1 == v) { print; exit }' "$TMP/install-index.txt")
  [ -n "$LINE" ] || die "no release found for $TARGET${VERSION:+ version $VERSION}"
  # shellcheck disable=SC2086
  set -- $LINE
  NEW_VERSION=$1; FILE=$3; SHA=$4; SIZE=$5
  case "$NEW_VERSION" in *[!0-9.]*|'') die "bad version in the index" ;; esac
  case "$FILE" in */*|*..*|'') die "bad file name in the index" ;; esac
  case "$SHA" in *[!0-9a-f]*) die "bad checksum in the index" ;; esac
  [ ${#SHA} -eq 64 ] || die "bad checksum length in the index"
  say "  version $NEW_VERSION"

  step "Downloading $FILE"
  fetch "$BASE_URL/$FILE" "$TMP/$FILE"
  GOT_SIZE=$(wc -c < "$TMP/$FILE" | tr -d ' ')
  [ "$GOT_SIZE" = "$SIZE" ] || die "size mismatch (expected $SIZE bytes, got $GOT_SIZE)"
  GOT_SHA=$(sha256_of "$TMP/$FILE")
  [ "$GOT_SHA" = "$SHA" ] || die "checksum mismatch: the download is not what the index says. Nothing was installed."
  say "  checksum ok"

  step "Checking the archive"
  tar -tzf "$TMP/$FILE" > "$TMP/list.txt" || die "not a valid archive"
  if grep -E '(^/|(^|/)\.\.(/|$))' "$TMP/list.txt" >/dev/null; then die "the archive contains unsafe paths. Nothing was installed."; fi
  mkdir "$TMP/x"
  tar -xzf "$TMP/$FILE" -C "$TMP/x"
  NODE_NEW="$TMP/x/runtime/node/node"
  [ -x "$NODE_NEW" ] || die "the archive has no runtime"
  [ -f "$TMP/x/versions/$NEW_VERSION/cli.mjs" ] || die "the archive has no version $NEW_VERSION"

  step "Verifying the signed release manifest"
  fetch "$BASE_URL/manifest.json" "$TMP/manifest.json"
  fetch "$BASE_URL/manifest.json.sig" "$TMP/manifest.json.sig"
  "$NODE_NEW" --disable-warning=ExperimentalWarning "$TMP/x/versions/$NEW_VERSION/cli.mjs" verify-release \
    --manifest "$TMP/manifest.json" --sig "$TMP/manifest.json.sig" --archive-sha256 "$SHA" --platform "$TARGET" --version "$NEW_VERSION" \
    || die "the release signature check failed. Nothing was installed."

  step "Installing"
  OLD_VERSION=""
  [ -f "$ROOT/current.json" ] && OLD_VERSION=$(BW_F="$ROOT/current.json" "$NODE_NEW" -e 'try{const j=JSON.parse(require("fs").readFileSync(process.env.BW_F,"utf8"));if(/^[0-9.]+$/.test(j.version))console.log(j.version)}catch{}')
  stop_service_quietly
  umask 077
  mkdir -p "$ROOT/versions" "$ROOT/state" "$ROOT/launcher" "$ROOT/logs" "$BIN_DIR"
  chmod 755 "$ROOT" "$ROOT/versions" "$ROOT/launcher"
  chmod 700 "$ROOT/state"
  # runtime: replaced by rename (a running node keeps its old inode)
  if [ ! -x "$ROOT/runtime/node/node" ] || [ "$(cat "$ROOT/runtime/NODE_VERSION" 2>/dev/null || echo)" != "$(cat "$TMP/x/runtime/NODE_VERSION")" ]; then
    rm -rf "$ROOT/runtime.new"; mv "$TMP/x/runtime" "$ROOT/runtime.new"
    rm -rf "$ROOT/runtime.old"; [ -d "$ROOT/runtime" ] && mv "$ROOT/runtime" "$ROOT/runtime.old"
    mv "$ROOT/runtime.new" "$ROOT/runtime"; rm -rf "$ROOT/runtime.old"
  fi
  cp "$TMP/x/launcher/launcher.mjs" "$ROOT/launcher/launcher.mjs.new" && mv -f "$ROOT/launcher/launcher.mjs.new" "$ROOT/launcher/launcher.mjs"
  chmod 644 "$ROOT/launcher/launcher.mjs"
  if [ ! -d "$ROOT/versions/$NEW_VERSION" ]; then mv "$TMP/x/versions/$NEW_VERSION" "$ROOT/versions/$NEW_VERSION"; chmod 755 "$ROOT/versions/$NEW_VERSION"; fi
  cp "$TMP/x/uninstall.sh" "$ROOT/uninstall.sh" && chmod 755 "$ROOT/uninstall.sh"
  NODE="$ROOT/runtime/node/node"
  # pointer: a fresh install is stable; an upgrade over a different version starts in TRIAL (the launcher confirms or rolls back)
  BW_ROOT="$ROOT" BW_NEW="$NEW_VERSION" BW_OLD="$OLD_VERSION" "$NODE" -e '
    const fs = require("fs"), p = process.env.BW_ROOT + "/current.json", nv = process.env.BW_NEW, ov = process.env.BW_OLD;
    let old = null; try { old = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    const next = (ov && ov !== nv)
      ? { version: nv, previous: ov, knownGood: (old && old.knownGood) || ov, state: "trial", bootCount: 0, trialStarted: null }
      : (old && old.version === nv ? old : { version: nv, previous: null, knownGood: nv, state: "stable", bootCount: 0, trialStarted: null });
    fs.writeFileSync(p + ".tmp", JSON.stringify(next, null, 2) + "\n", { mode: 0o644 }); fs.renameSync(p + ".tmp", p);
    fs.writeFileSync(process.env.BW_ROOT + "/state/install-receipt.json", JSON.stringify({ method: "standalone", installedAt: new Date().toISOString(), version: nv }) + "\n", { mode: 0o600 });
  '
  umask 022
  cat > "$BIN_DIR/botwarren.new" <<SH
#!/bin/sh
# Botwarren command (installed by install.sh). Runs the CLI of the currently installed version.
export BOTWARREN_HOME="$ROOT"
exec "$ROOT/runtime/node/node" --disable-warning=ExperimentalWarning "$ROOT/launcher/launcher.mjs" cli "\$@"
SH
  chmod 755 "$BIN_DIR/botwarren.new"; mv -f "$BIN_DIR/botwarren.new" "$BIN_DIR/botwarren"
  say "  installed $NEW_VERSION${OLD_VERSION:+ (was $OLD_VERSION)}"

  migrate_legacy
  if [ "$SERVICE_KIND" != none ]; then step "Registering the background service ($SERVICE_KIND)"; register_service; fi

  say ""
  say "Botwarren $NEW_VERSION is installed."
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "Add $BIN_DIR to your PATH to use the 'botwarren' command, for example:"; say "    echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.profile" ;; esac
  if [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/botwarren-ship/config.json" ]; then
    say "Your existing configuration was kept. The ship agent is running in the background."
  else
    say "Next: connect this computer to your ship:   $BIN_DIR/botwarren pair"
    say "(the agent starts by itself as soon as the connection is set up)"
  fi
  say "Check updates and options: $BIN_DIR/botwarren update status    Tools it can see: $BIN_DIR/botwarren adapters"
  say "Remove everything:        $ROOT/uninstall.sh   (add --keep-config to keep your settings)"
}

# ---------------------------------------------------------------------------- helpers
say() { printf '%s\n' "$*"; }
step() { printf '==> %s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }
usage_error() { printf 'install: %s (see --help)\n' "$*" >&2; exit 2; }

fetch() { # fetch URL DEST
  if command -v curl >/dev/null 2>&1; then curl -fsSL --proto '=https,http' --retry 2 --connect-timeout 15 -o "$2" "$1" || die "could not download $1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1" || die "could not download $1"
  else die "curl or wget is required"; fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | awk '{print $NF}'
  else die "sha256sum, shasum or openssl is required"; fi
}

service_text() {
  case "$1" in
    systemd)
      cat <<UNIT
[Unit]
Description=Botwarren ship agent
After=network-online.target

[Service]
Environment="BOTWARREN_HOME=$ROOT"
ExecStart="$ROOT/runtime/node/node" --disable-warning=ExperimentalWarning "$ROOT/launcher/launcher.mjs" run
Restart=on-failure
RestartSec=10
NoNewPrivileges=yes

[Install]
WantedBy=default.target
UNIT
      ;;
    launchd)
      cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.turbokast.botwarren</string>
  <key>ProgramArguments</key><array>
    <string>$ROOT/runtime/node/node</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>$ROOT/launcher/launcher.mjs</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>BOTWARREN_HOME</key><string>$ROOT</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$ROOT/logs/launchd.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/launchd.log</string>
</dict></plist>
PLIST
      ;;
    autostart)
      cat <<DESK
[Desktop Entry]
Type=Application
Name=Botwarren ship agent
Exec=env BOTWARREN_HOME="$ROOT" "$ROOT/runtime/node/node" --disable-warning=ExperimentalWarning "$ROOT/launcher/launcher.mjs" run
X-GNOME-Autostart-enabled=true
DESK
      ;;
  esac
}

stop_service_quietly() {
  if [ "$PLAT" = mac ]; then
    launchctl bootout "gui/$(id -u)/com.turbokast.botwarren" >/dev/null 2>&1 || true
  elif command -v systemctl >/dev/null 2>&1; then
    systemctl --user stop botwarren.service >/dev/null 2>&1 || true
  fi
}

# the previous (zip based) installer: stop and remove its service and files, keep config and data
migrate_legacy() {
  LEGACY="$HOME/.local/lib/botwarren-ship"
  if [ "$PLAT" = mac ]; then
    launchctl bootout "gui/$(id -u)/com.botwarren.ship" >/dev/null 2>&1 || true
    rm -f "$HOME/Library/LaunchAgents/com.botwarren.ship.plist"
  elif command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now botwarren-ship.service >/dev/null 2>&1 || true
    rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/botwarren-ship.service"
  fi
  if [ -d "$LEGACY" ]; then rm -rf "$LEGACY"; say "  migrated from the previous installer (your config and data were kept)"; fi
}

register_service() {
  case "$SERVICE_KIND" in
    systemd)
      UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
      mkdir -p "$UNIT_DIR"
      service_text systemd > "$UNIT_DIR/botwarren.service"
      systemctl --user daemon-reload
      systemctl --user enable --now botwarren.service >/dev/null 2>&1 || say "  could not start the service now; it will start at your next login"
      handle_linger
      ;;
    launchd)
      mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/logs"
      PLIST="$HOME/Library/LaunchAgents/com.turbokast.botwarren.plist"
      service_text launchd > "$PLIST"
      launchctl bootout "gui/$(id -u)/com.turbokast.botwarren" >/dev/null 2>&1 || true
      launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || say "  could not start the service now; it will start at your next login"
      say "  macOS will show a 'Background Items Added' notice for Botwarren. That is expected."
      ;;
    autostart)
      mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
      service_text autostart > "${XDG_CONFIG_HOME:-$HOME/.config}/autostart/botwarren.desktop"
      say "  no systemd user session found: registered an autostart entry (starts at your next login)"
      ;;
  esac
}

handle_linger() {
  command -v loginctl >/dev/null 2>&1 || return 0
  [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo yes)" = yes ] && return 0
  case "$LINGER" in
    yes) loginctl enable-linger "$(id -un)" >/dev/null 2>&1 && say "  linger enabled: the agent keeps running after you log out" ;;
    no) ;;
    ask)
      if [ -t 0 ] && [ -t 1 ]; then
        printf 'Keep Botwarren running after you log out (SSH/headless)? Needs loginctl enable-linger. [y/N] '
        read -r ans || ans=n
        case "$ans" in y|Y|yes|YES) loginctl enable-linger "$(id -un)" >/dev/null 2>&1 && say "  linger enabled" ;; esac
      else
        say "  note: without 'loginctl enable-linger' the agent stops when you log out (re-run with --linger to enable)"
      fi ;;
  esac
}

main "$@"
