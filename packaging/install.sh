#!/bin/sh
# Botwarren ship agent installer for macOS and Linux. Per-user, never needs root.
#
#   curl -fsSL https://downloads.botwarren.com/install.sh | sh
#   curl -fsSL https://downloads.botwarren.com/install.sh | sh -s -- --no-service
#
# ZERO-TOUCH (what botwarren.com/get gives you: one command with a single-use claim code for your ship):
#   curl -fsSL https://downloads.botwarren.com/install.sh | BOTWARREN_CLAIM=bwc_xxxx sh
# The code works once and expires after 30 minutes, so it is worthless if it stays in your shell history. It is passed to
# `botwarren connect` only through that one process's environment: never as an argument, never written to a file, a service
# definition or a log, and never printed. (The environment form does not show up in `ps`; `--claim <code>` also works but does.)
# Without a code, a terminal install ends by starting the device-code flow (a short code and the browser).
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
# CHECKSUM-VERIFIED MODE (--checksum-only), for releases that have no signed update manifest (the case until the production
# release key exists; see docs/RELEASING.md). It never falls back to this by itself: you ask for it.
#   curl -fsSL https://downloads.botwarren.com/install.sh | sh -s -- --checksum-only --version 0.5.0
#   curl -fsSL https://downloads.botwarren.com/install.sh | sh -s -- --checksum-only            (newest, from latest.txt)
# It downloads <base>/<version>/SHA256SUMS over HTTPS, checks the archive against it, lists the archive and refuses unsafe paths,
# then installs. This is weaker than the signed path: an attacker who controls the download host could change the archive AND its
# checksum, so nothing here binds the file to a release key. You can compare the same hash with the GitHub Release and its build
# provenance attestation (`gh attestation verify`, see README). Auto-update is DISABLED for such an install until a signed
# manifest exists (the updater has nothing signed to fetch, so it never runs unsigned code).
#
# Options (or the matching environment variables):
#   --base-url URL    BOTWARREN_BASE_URL     download base (default https://downloads.botwarren.com)
#   --version X.Y.Z   BOTWARREN_VERSION      install that version instead of the stable one ("latest" = newest published)
#   --checksum-only   BOTWARREN_CHECKSUM_ONLY=1  no signed manifest: verify against <base>/<version>/SHA256SUMS (see above)
#   --install-dir D   BOTWARREN_INSTALL_DIR  default ~/.local/share/botwarren
#   --bin-dir D       BOTWARREN_BIN_DIR      default ~/.local/bin
#   --no-service      BOTWARREN_NO_SERVICE=1 do not register or start the background service
#   --linger          --no-linger            Linux: keep the service running after logout (loginctl enable-linger)
#   --claim CODE     BOTWARREN_CLAIM        single-use claim code from botwarren.com/get (prefer the environment variable)
#   --no-connect      BOTWARREN_NO_CONNECT=1 install only; do not connect this computer to a ship
#   --non-interactive BOTWARREN_NONINTERACTIVE=1  never start the device-code flow or ask questions (scripts, provisioning)
#   --dry-run         BOTWARREN_DRY_RUN=1    print what would happen, change nothing
#   --print-service[=KIND]                   print the service definition (systemd|launchd|autostart) and exit
#   --help
# Exit codes: 0 ok, 1 failed (nothing half-installed is left active), 2 bad usage, 4 installed, but the claim code could not be used
# (it expired, was used already, or the network failed: the install stands; get a fresh command at botwarren.com/get).
set -eu

main() {
  BASE_URL="${BOTWARREN_BASE_URL:-https://downloads.botwarren.com}"
  VERSION="${BOTWARREN_VERSION:-}"
  CHECKSUM_ONLY=0
  [ "${BOTWARREN_CHECKSUM_ONLY:-0}" = 1 ] && CHECKSUM_ONLY=1
  ROOT="${BOTWARREN_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/botwarren}"
  BIN_DIR="${BOTWARREN_BIN_DIR:-$HOME/.local/bin}"
  WANT_SERVICE=1
  [ "${BOTWARREN_NO_SERVICE:-0}" = 1 ] && WANT_SERVICE=0
  DRY_RUN="${BOTWARREN_DRY_RUN:-0}"
  LINGER=ask
  # the claim code is read once and removed from the environment, so nothing else this script starts can see it
  CLAIM="${BOTWARREN_CLAIM:-}"
  unset BOTWARREN_CLAIM
  WANT_CONNECT=1
  INTERACTIVE=1
  [ "${BOTWARREN_NONINTERACTIVE:-0}" = 1 ] && INTERACTIVE=0
  [ "${BOTWARREN_NO_CONNECT:-0}" = 1 ] && WANT_CONNECT=0
  PRINT_SERVICE=0
  PRINT_KIND=

  while [ $# -gt 0 ]; do
    case "$1" in
      --base-url) [ $# -ge 2 ] || usage_error "--base-url needs a value"; BASE_URL=$2; shift ;;
      --version) [ $# -ge 2 ] || usage_error "--version needs a value"; VERSION=$2; shift ;;
      --install-dir) [ $# -ge 2 ] || usage_error "--install-dir needs a value"; ROOT=$2; shift ;;
      --bin-dir) [ $# -ge 2 ] || usage_error "--bin-dir needs a value"; BIN_DIR=$2; shift ;;
      --checksum-only) CHECKSUM_ONLY=1 ;;
      --no-service) WANT_SERVICE=0 ;;
      --claim) [ $# -ge 2 ] || usage_error "--claim needs a value"; CLAIM=$2; shift ;;
      --no-connect) WANT_CONNECT=0 ;;
      --non-interactive) INTERACTIVE=0 ;;
      --linger) LINGER=yes ;;
      --no-linger) LINGER=no ;;
      --dry-run) DRY_RUN=1 ;;
      --print-service) PRINT_SERVICE=1 ;;
      --print-service=*) PRINT_SERVICE=1; PRINT_KIND=${1#*=} ;;
      -h|--help) sed -n '2,51p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) usage_error "unknown option: $1" ;;
    esac
    shift
  done

  # check the claim code's shape BEFORE downloading anything, and never print it (not even in an error)
  if [ -n "$CLAIM" ]; then
    case "$CLAIM" in
      bwc_*[!A-Za-z0-9_-]*|*[!A-Za-z0-9_-]*) die "that command looks cut off or changed (the claim code has odd characters). Copy it again from https://botwarren.com/get" ;;
      bwc_*) ;;
      *) die "that command looks cut off or changed (the claim code is not one of ours). Copy it again from https://botwarren.com/get" ;;
    esac
    CLAIM_LEN=${#CLAIM}
    { [ "$CLAIM_LEN" -ge 24 ] && [ "$CLAIM_LEN" -le 84 ]; } || die "that command looks cut off (the claim code is the wrong length). Copy it again from https://botwarren.com/get"
  fi

  BASE_URL=${BASE_URL%/}
  [ "$VERSION" = latest ] && VERSION=
  if [ -n "$VERSION" ]; then
    case "$VERSION" in *[!0-9.]*) die "--version must look like 1.2.3 (or latest)" ;; esac
  fi
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
  if [ "$CHECKSUM_ONLY" = 1 ]; then say "  verification: SHA256SUMS over HTTPS only (no signed manifest); auto-update will be DISABLED"; else say "  verification: signed release manifest"; fi
  if [ "$WANT_CONNECT" != 1 ]; then say "  connect     : no (--no-connect)"; elif [ -n "$CLAIM" ]; then say "  connect     : with your single-use claim code (not shown)"; else say "  connect     : device code (a terminal install only)"; fi
  if [ "$DRY_RUN" = 1 ]; then say "dry run: nothing was downloaded or changed."; return 0; fi

  TMP=$(mktemp -d "${TMPDIR:-/tmp}/botwarren-install.XXXXXX")
  trap 'rm -rf "$TMP"' EXIT INT TERM HUP

  step "Looking up the release"
  SIZE=
  if [ "$CHECKSUM_ONLY" = 1 ]; then
    # no signed manifest: the version is explicit (or read from latest.txt) and the hash comes from <base>/<version>/SHA256SUMS
    if [ -n "$VERSION" ]; then NEW_VERSION=$VERSION
    else
      fetch "$BASE_URL/latest.txt" "$TMP/latest.txt"
      NEW_VERSION=$(head -n 1 "$TMP/latest.txt" | tr -d ' \r\n')
    fi
    case "$NEW_VERSION" in [0-9]*.[0-9]*.[0-9]*) ;; *) die "bad version (expected 1.2.3, got: $NEW_VERSION)" ;; esac
    case "$NEW_VERSION" in *[!0-9.]*|*..*|*.) die "bad version: $NEW_VERSION" ;; esac
    fetch "$BASE_URL/$NEW_VERSION/SHA256SUMS" "$TMP/SHA256SUMS"
    FILE="botwarren-$NEW_VERSION-$TARGET.tar.gz"
    SHA=$(awk -v f="$FILE" '$2 == f || $2 == "*" f { print $1; exit }' "$TMP/SHA256SUMS")
    [ -n "$SHA" ] || die "SHA256SUMS for $NEW_VERSION does not list $FILE"
    FILE_URL="$BASE_URL/$NEW_VERSION/$FILE"
  else
    if ! fetch_try "$BASE_URL/install-index.txt" "$TMP/install-index.txt"; then
      die "this release has no signed update manifest yet (could not download $BASE_URL/install-index.txt). Nothing was installed.
To install a release that is verified only against its published SHA-256 checksums (auto-update stays off), run again with --checksum-only [--version X.Y.Z]. See the README, section Install."
    fi
    LINE=$(awk -v v="$VERSION" -v t="$TARGET" '$2 == t && (v == "" || $1 == v) { print; exit }' "$TMP/install-index.txt")
    [ -n "$LINE" ] || die "no release found for $TARGET${VERSION:+ version $VERSION}"
    # shellcheck disable=SC2086
    set -- $LINE
    NEW_VERSION=$1; FILE=$3; SHA=$4; SIZE=$5
    case "$NEW_VERSION" in *[!0-9.]*|'') die "bad version in the index" ;; esac
    case "$FILE" in */*|*..*|'') die "bad file name in the index" ;; esac
    FILE_URL="$BASE_URL/$FILE"
  fi
  case "$SHA" in *[!0-9a-f]*) die "bad checksum in the index" ;; esac
  [ ${#SHA} -eq 64 ] || die "bad checksum length in the index"
  say "  version $NEW_VERSION"

  step "Downloading $FILE"
  fetch "$FILE_URL" "$TMP/$FILE"
  if [ -n "$SIZE" ]; then
    GOT_SIZE=$(wc -c < "$TMP/$FILE" | tr -d ' ')
    [ "$GOT_SIZE" = "$SIZE" ] || die "size mismatch (expected $SIZE bytes, got $GOT_SIZE)"
  fi
  GOT_SHA=$(sha256_of "$TMP/$FILE")
  [ "$GOT_SHA" = "$SHA" ] || die "checksum mismatch: the download is not what the published hash says. Nothing was installed."
  say "  checksum ok"

  step "Checking the archive"
  tar -tzf "$TMP/$FILE" > "$TMP/list.txt" || die "not a valid archive"
  if grep -E '(^/|(^|/)\.\.(/|$))' "$TMP/list.txt" >/dev/null; then die "the archive contains unsafe paths. Nothing was installed."; fi
  mkdir "$TMP/x"
  tar -xzf "$TMP/$FILE" -C "$TMP/x"
  NODE_NEW="$TMP/x/runtime/node/node"
  [ -x "$NODE_NEW" ] || die "the archive has no runtime"
  [ -f "$TMP/x/versions/$NEW_VERSION/cli.mjs" ] || die "the archive has no version $NEW_VERSION"

  if [ "$CHECKSUM_ONLY" = 1 ]; then
    say "  NOTE: no signed release manifest was checked. This archive was verified only against the SHA256SUMS published at"
    say "        $BASE_URL/$NEW_VERSION/ over HTTPS. Auto-update is DISABLED for this install until a signed manifest exists."
    VERIFICATION=sha256sums
  else
    step "Verifying the signed release manifest"
    fetch "$BASE_URL/manifest.json" "$TMP/manifest.json"
    fetch "$BASE_URL/manifest.json.sig" "$TMP/manifest.json.sig"
    # the optional keys document (recovery-signed rotation/revocation, see docs/RELEASING.md): present only after a key change
    rm -f "$TMP/keys.json" "$TMP/keys.json.sig"
    if fetch_try "$BASE_URL/keys.json" "$TMP/keys.json" && fetch_try "$BASE_URL/keys.json.sig" "$TMP/keys.json.sig"; then
      "$NODE_NEW" --disable-warning=ExperimentalWarning "$TMP/x/versions/$NEW_VERSION/cli.mjs" verify-release \
        --manifest "$TMP/manifest.json" --sig "$TMP/manifest.json.sig" --keys "$TMP/keys.json" --keys-sig "$TMP/keys.json.sig" \
        --archive-sha256 "$SHA" --platform "$TARGET" --version "$NEW_VERSION" \
        || die "the release signature check failed. Nothing was installed."
    else
      "$NODE_NEW" --disable-warning=ExperimentalWarning "$TMP/x/versions/$NEW_VERSION/cli.mjs" verify-release \
        --manifest "$TMP/manifest.json" --sig "$TMP/manifest.json.sig" --archive-sha256 "$SHA" --platform "$TARGET" --version "$NEW_VERSION" \
        || die "the release signature check failed. Nothing was installed."
    fi
    VERIFICATION=signed-manifest
  fi

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
  BW_ROOT="$ROOT" BW_NEW="$NEW_VERSION" BW_OLD="$OLD_VERSION" BW_VERIFY="$VERIFICATION" "$NODE" -e '
    const fs = require("fs"), p = process.env.BW_ROOT + "/current.json", nv = process.env.BW_NEW, ov = process.env.BW_OLD;
    let old = null; try { old = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    const next = (ov && ov !== nv)
      ? { version: nv, previous: ov, knownGood: (old && old.knownGood) || ov, state: "trial", bootCount: 0, trialStarted: null }
      : (old && old.version === nv ? old : { version: nv, previous: null, knownGood: nv, state: "stable", bootCount: 0, trialStarted: null });
    fs.writeFileSync(p + ".tmp", JSON.stringify(next, null, 2) + "\n", { mode: 0o644 }); fs.renameSync(p + ".tmp", p);
    fs.writeFileSync(process.env.BW_ROOT + "/state/install-receipt.json", JSON.stringify({ method: "standalone", installedAt: new Date().toISOString(), version: nv, verification: process.env.BW_VERIFY }) + "\n", { mode: 0o600 });
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
  if [ "$CHECKSUM_ONLY" = 1 ]; then say "Auto-update is DISABLED for this install (no signed update manifest exists yet). Verified: SHA-256 over HTTPS. To update, run this installer again."; fi
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "Add $BIN_DIR to your PATH to use the 'botwarren' command, for example:"; say "    echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.profile" ;; esac
  connect_step
  say "Status: $BIN_DIR/botwarren status     Tools it can see: $BIN_DIR/botwarren adapters     Updates: $BIN_DIR/botwarren update status"
  say "Everything else (projects, names, delay, pause, disconnect) is on https://botwarren.com/account"
  say "Remove it:  botwarren uninstall   (or $ROOT/uninstall.sh; add --keep-config to keep your settings)"
  return "$CONNECT_EXIT"
}

# ---------------------------------------------------------------------------- helpers
# can a person see and answer us? stdout is a terminal, or a controlling terminal exists (curl | sh has a pipe on stdin)
has_tty() {
  [ "$INTERACTIVE" = 1 ] || return 1
  [ -t 1 ] && return 0
  ( : > /dev/tty ) 2>/dev/null
}

# Connects this computer to the ship, after the service is registered. The claim code travels ONLY in the environment of the one
# `connect` process (and is then dropped); it is never an argument, a file, a service definition or output.
connect_step() {
  CONNECT_EXIT=0
  CFG="${XDG_CONFIG_HOME:-$HOME/.config}/botwarren-ship/config.json"
  if [ "$WANT_CONNECT" != 1 ]; then
    say "Not connected (--no-connect). When you are ready, get your command at https://botwarren.com/get or run: $BIN_DIR/botwarren connect"
    CLAIM=; return 0
  fi
  if [ -n "$CLAIM" ]; then
    step "Connecting this computer to your ship"
    RC=0
    BOTWARREN_CLAIM="$CLAIM" "$BIN_DIR/botwarren" connect </dev/null || RC=$?
    CLAIM=
    case "$RC" in
      0) say "Connected! Watch it appear at https://botwarren.com/get (or open your ship from https://botwarren.com/account)." ;;
      3) say "This computer was already connected, so nothing changed." ;;
      *) say "Botwarren is installed, but this computer could not be connected."
         say "The claim code works once and expires after 30 minutes. If it expired, or the network was down, open https://botwarren.com/get for a fresh command."
         CONNECT_EXIT=4 ;;
    esac
    return 0
  fi
  if [ -f "$CFG" ]; then
    say "Your existing setup was kept. The ship agent keeps running in the background and updates itself."
    return 0
  fi
  if has_tty; then
    step "Connecting this computer to your ship (a short code, then your browser)"
    RC=0
    "$BIN_DIR/botwarren" connect </dev/null || RC=$?
    case "$RC" in
      0|3) ;;
      *) say "Could not connect right now. Botwarren is installed; open https://botwarren.com/get to connect this computer, or run: $BIN_DIR/botwarren connect" ;;
    esac
  else
    say "Open https://botwarren.com/get to connect this computer."
  fi
}

say() { printf '%s\n' "$*"; }
step() { printf '==> %s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }
usage_error() { printf 'install: %s (see --help)\n' "$*" >&2; exit 2; }

fetch_try() { # fetch_try URL DEST: like fetch, but returns non-zero instead of exiting
  if command -v curl >/dev/null 2>&1; then curl -fsSL --proto '=https,http' --retry 2 --connect-timeout 15 -o "$2" "$1" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1" 2>/dev/null
  else die "curl or wget is required"; fi
}

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
