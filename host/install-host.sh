#!/bin/sh
# Registers the WebSDR-Sync TCP relay as a Chrome native messaging host.
#
#   ./install-host.sh              install
#   ./install-host.sh --test       check the relay runs, without Chrome
#   ./install-host.sh --uninstall  remove
set -e

HOST_NAME="nl.websdrsync.rigctld_bridge"
EXT_ID="oemieknppkbaemfioegnockcekglefbn"
DIR="$(cd "$(dirname "$0")" && pwd)"
PY_SCRIPT="$DIR/websdrsync_host.py"
LAUNCHER="$DIR/websdrsync_host.sh"
LOGFILE="$DIR/websdrsync_host.log"

case "$(uname -s)" in
  Darwin)
    SUPPORT="$HOME/Library/Application Support"
    TARGET_DIRS="
$SUPPORT/Google/Chrome/NativeMessagingHosts
$SUPPORT/Google/Chrome Beta/NativeMessagingHosts
$SUPPORT/Google/Chrome Canary/NativeMessagingHosts
$SUPPORT/Chromium/NativeMessagingHosts
$SUPPORT/Microsoft Edge/NativeMessagingHosts
$SUPPORT/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    ;;
  *)
    TARGET_DIRS="
$HOME/.config/google-chrome/NativeMessagingHosts
$HOME/.config/chromium/NativeMessagingHosts
$HOME/.config/microsoft-edge/NativeMessagingHosts
$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    ;;
esac

# ---------------------------------------------------------------- self test
run_test() {
  # Drive exactly what the host manifest points at.
  TARGET=""
  for d in $(echo "$TARGET_DIRS"); do :; done
  MAN=$(ls "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$HOST_NAME.json" \
           "$HOME/.config/google-chrome/NativeMessagingHosts/$HOST_NAME.json" 2>/dev/null | head -1)
  if [ -n "$MAN" ]; then
    TARGET=$(sed -n 's/.*"path"[^"]*"\(.*\)".*/\1/p' "$MAN" | head -1)
    echo "manifest : $MAN"
  fi
  [ -n "$TARGET" ] || TARGET="$PY_SCRIPT"
  echo "host path: $TARGET"
  if [ ! -x "$TARGET" ]; then
    echo "FAIL: $TARGET is missing or not executable — run ./install-host.sh"; exit 1
  fi
  echo "shebang  : $(head -1 "$TARGET")"
  if command -v xattr >/dev/null 2>&1; then
    Q=$(xattr "$TARGET" 2>/dev/null | tr '\n' ' ')
    echo "xattrs   : ${Q:-none}"
    case "$Q" in *quarantine*) echo "  ^^ QUARANTINED — macOS will refuse to let Chrome run this";; esac
  fi
  echo "folder   : $DIR"
  check_location
  echo "sending  : {\"op\":\"ping\"}"
  RESULT=$("$PYTEST" - "$TARGET" <<'PYEOF' 2>&1 || true
import json, struct, subprocess, sys
msg = json.dumps({"op": "ping"}).encode()
try:
    p = subprocess.Popen([sys.argv[1]], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out, err = p.communicate(struct.pack("<I", len(msg)) + msg, timeout=10)
except Exception as exc:
    print("FAIL: could not start the relay:", exc); raise SystemExit(1)
if len(out) >= 4:
    n, = struct.unpack("<I", out[:4])
    print("PASS: relay replied", out[4:4+n].decode())
else:
    print("FAIL: relay produced no output (exit code %s)" % p.returncode)
    if err:
        print("stderr:"); print(err.decode()[:800])
PYEOF
)
  echo "$RESULT"
  case "$RESULT" in
    PASS*) echo
           echo "The relay is fine. If Chrome still says \"Native host has exited\","
           echo "quit Chrome completely and reopen it, and confirm the extension id on"
           echo "chrome://extensions is $EXT_ID." ;;
    *)     echo
           echo "See $LOGFILE for the interpreter's own error output." ;;
  esac
}


# ------------------------------------------------------- location sanity
# macOS will not let Chrome exec anything out of a cloud-provider mount
# (~/Library/CloudStorage, iCloud Drive, Dropbox, Google Drive). Chrome reports
# that as the maddeningly vague "Native host has exited", so catch it here.
check_location() {
  BAD=""
  case "$DIR" in
    */Library/CloudStorage/*)      BAD="a cloud-storage mount (OneDrive/Box/Drive via File Provider)" ;;
    */Library/Mobile\ Documents/*) BAD="iCloud Drive" ;;
    */Dropbox/*)                   BAD="Dropbox" ;;
    */Google\ Drive*|*/GoogleDrive/*) BAD="Google Drive" ;;
    */OneDrive*)                   BAD="OneDrive" ;;
  esac
  if [ -n "$BAD" ]; then
    echo "ERROR: this folder is on $BAD:" >&2
    echo "         $DIR" >&2
    echo >&2
    echo "  macOS will not let Chrome run the relay from there, and the sync client" >&2
    echo "  can turn files into online-only placeholders while Chrome is reading them." >&2
    echo "  Move the whole extension folder somewhere local and re-run this script:" >&2
    echo >&2
    echo "      mkdir -p ~/WebSDR-Sync && cp -R \"$(cd "$DIR/.." && pwd)\" ~/WebSDR-Sync/" >&2
    echo "      cd ~/WebSDR-Sync/$(basename "$(cd "$DIR/.." && pwd)")/host && ./install-host.sh" >&2
    echo >&2
    echo "  Then re-load the unpacked extension from the new location." >&2
    echo "  (--force installs anyway, but expect it not to work.)" >&2
    [ "$FORCE" = "1" ] || exit 1
    echo "  --force given; continuing anyway." >&2
  fi

  # noexec volumes and the like: prove we can actually run something from here.
  T="$DIR/.exec-probe.$$"
  printf '#!/bin/sh\nexit 7\n' > "$T" 2>/dev/null || return 0
  chmod +x "$T" 2>/dev/null || { rm -f "$T"; return 0; }
  # NB: the probe deliberately exits 7, so it must run inside an if-condition —
  # a bare call would trip `set -e` and abort the install.
  if "$T" >/dev/null 2>&1; then rc=0; else rc=$?; fi
  rm -f "$T"
  if [ "$rc" -ne 7 ]; then
    echo "WARNING: cannot execute files from $DIR (exit $rc)." >&2
    echo "         The volume may be mounted noexec. Move the folder somewhere local." >&2
  fi
}

# ------------------------------------------------------------------ python
find_python() {
  for c in /opt/local/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 \
           /usr/bin/python3 "$(command -v python3 2>/dev/null || true)"; do
    [ -n "$c" ] || continue
    [ -x "$c" ] || continue
    # /usr/bin/python3 on macOS can be a stub that exits unless the Command Line
    # Tools are installed, so prove the interpreter actually runs before using it.
    if "$c" -c 'import sys, socket, json, struct, threading, ipaddress' >/dev/null 2>&1; then
      echo "$c"; return 0
    fi
    echo "  skipping $c (present but does not run)" >&2
  done
  return 1
}

PYTEST="$(find_python || true)"

USE_LAUNCHER=0
FORCE=0
[ "$1" = "--launcher" ] && USE_LAUNCHER=1 && shift
[ "$1" = "--force" ] && FORCE=1 && shift

if [ "$1" = "--test" ]; then
  [ -n "$PYTEST" ] || { echo "FAIL: no working python3 found"; exit 1; }
  run_test; exit 0
fi

if [ "$1" = "--uninstall" ]; then
  # One implementation, in one place -- the old inline version here quietly
  # missed the pre-rename registration.
  if [ -f "$DIR/uninstall-host.sh" ]; then
    sh "$DIR/uninstall-host.sh"
    exit $?
  fi
  echo "ERROR: uninstall-host.sh is missing from $DIR" >&2
  exit 1
fi

# ----------------------------------------------------------------- install
PY="$PYTEST"
if [ -z "$PY" ]; then
  echo "ERROR: no working python3 found." >&2
  echo "       MacPorts: sudo port install python312" >&2
  exit 1
fi
echo "python3  : $PY"
echo "folder   : $DIR"
check_location
[ -f "$PY_SCRIPT" ] || { echo "ERROR: websdrsync_host.py not found next to this script" >&2; exit 1; }

# Files unpacked from a downloaded zip carry com.apple.quarantine, and macOS
# will refuse to let Chrome exec them. Strip it from the extension folder.
if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$DIR/.." 2>/dev/null || true
  echo "quarantine: cleared on $(cd "$DIR/.." && pwd)"
fi

# Chrome execs the host directly, so it must not depend on PATH. Bake the
# verified interpreter into the script's own shebang and register the .py
# itself -- one less link in the chain than exec'ing a shell wrapper.
#
# --launcher switches back to the wrapper, which additionally captures the
# interpreter's stderr to the log; useful if the direct route misbehaves.
TMP="$PY_SCRIPT.tmp$$"
{ printf '#!%s\n' "$PY"; tail -n +2 "$PY_SCRIPT"; } > "$TMP"
mv "$TMP" "$PY_SCRIPT"
chmod +x "$PY_SCRIPT"

if [ "$USE_LAUNCHER" = "1" ]; then
  cat > "$LAUNCHER" <<EOF
#!/bin/sh
echo "--- \$(date '+%Y-%m-%d %H:%M:%S') launcher pid \$\$ py=$PY" >> "$LOGFILE" 2>/dev/null
# A failed redirect would kill this shell outright, so only redirect if the log
# is actually writable.
if : >> "$LOGFILE" 2>/dev/null; then exec 2>>"$LOGFILE"; fi
exec "$PY" "$PY_SCRIPT" "\$@"
EOF
  chmod +x "$LAUNCHER"
  HOST_PATH="$LAUNCHER"
else
  rm -f "$LAUNCHER"
  HOST_PATH="$PY_SCRIPT"
fi
echo "host path: $HOST_PATH"

echo "$TARGET_DIRS" | while IFS= read -r d; do
  [ -z "$d" ] && continue
  [ -d "$(dirname "$d")" ] || continue        # that browser isn't installed
  mkdir -p "$d"
  cat > "$d/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "WebSDR-Sync: TCP relay to rigctld",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": [ "chrome-extension://$EXT_ID/" ]
}
EOF
  echo "installed $d/$HOST_NAME.json"
done

echo
echo "Host name    : $HOST_NAME"
echo "Extension id : $EXT_ID  (pinned by the 'key' field in manifest.json)"
echo "Relay log    : $LOGFILE"
echo
echo "Verify it runs:   ./install-host.sh --test"
echo "Then load the extension unpacked, start rigctld, and click Connect."
echo "Quit and reopen Chrome if it was already running."
