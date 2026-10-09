#!/bin/sh
# uninstall-host.sh — removes the WebSDR-Sync relay from this machine.
#
#   ./uninstall-host.sh             remove the registration and generated files
#   ./uninstall-host.sh --dry-run   list what would be removed, change nothing
#
# This takes out the native-messaging registration for every Chromium-family
# browser, under BOTH the current host name and the pre-rename one, plus the
# files the installer generated. It then re-checks and reports anything that
# survived, rather than assuming success.
#
# It does not delete this folder, and it does not touch the extension itself --
# both are yours to remove, and the script says how.

set -e

DRY=0
[ "$1" = "--dry-run" ] || [ "$1" = "-n" ] && DRY=1

# Both names: a folder that was set up before the rename still has the old one
# registered, pointing at a script that no longer exists.
HOST_NAMES="nl.websdrsync.rigctld_bridge nl.catsdr.rigctld_bridge"

DIR="$(cd "$(dirname "$0")" && pwd)"

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

# Files the installer generated. Shipped sources are never touched.
GENERATED="
$DIR/websdrsync_host.sh
$DIR/websdrsync_host.bat
$DIR/websdrsync_host.win.json
$DIR/websdrsync_host.log
$DIR/catsdr_host.sh
$DIR/catsdr_host.log"

if [ "$DRY" = "1" ]; then
  echo "DRY RUN — nothing will be changed."
  echo
fi

FOUND=0

# ------------------------------------------------------- registrations
echo "$TARGET_DIRS" | while IFS= read -r d; do
  [ -z "$d" ] && continue
  for n in $HOST_NAMES; do
    f="$d/$n.json"
    if [ -f "$f" ]; then
      if [ "$DRY" = "1" ]; then echo "would remove  $f"
      else rm -f "$f"; echo "removed  $f"; fi
    fi
  done
done

# ------------------------------------------------------- generated files
echo "$GENERATED" | while IFS= read -r f; do
  [ -z "$f" ] && continue
  if [ -f "$f" ]; then
    if [ "$DRY" = "1" ]; then echo "would remove  $f"
    else rm -f "$f"; echo "removed  $f"; fi
  fi
done

if [ -d "$DIR/__pycache__" ]; then
  if [ "$DRY" = "1" ]; then echo "would remove  $DIR/__pycache__"
  else rm -rf "$DIR/__pycache__"; echo "removed  $DIR/__pycache__"; fi
fi

# ------------------------------------------------------- verify
if [ "$DRY" = "0" ]; then
  LEFT=""
  echo "$TARGET_DIRS" | while IFS= read -r d; do
    [ -z "$d" ] && continue
    for n in $HOST_NAMES; do
      [ -f "$d/$n.json" ] && echo "STILL PRESENT  $d/$n.json"
    done
  done > /tmp/websdrsync_uninstall_left.$$ 2>/dev/null || true
  echo "$GENERATED" | while IFS= read -r f; do
    [ -z "$f" ] && continue
    [ -f "$f" ] && echo "STILL PRESENT  $f"
  done >> /tmp/websdrsync_uninstall_left.$$ 2>/dev/null || true

  if [ -s /tmp/websdrsync_uninstall_left.$$ ]; then
    echo
    cat /tmp/websdrsync_uninstall_left.$$
    echo "Some items could not be removed — check permissions and re-run."
    rm -f /tmp/websdrsync_uninstall_left.$$
    exit 1
  fi
  rm -f /tmp/websdrsync_uninstall_left.$$
  echo
  echo "Relay removed. Nothing of it is left registered on this machine."
fi

cat <<'EOF'

Two things this script deliberately does not do:

  1. Remove the extension. Go to chrome://extensions and click Remove on
     WebSDR-Sync. Your saved settings (rigctld host, receiver choice) live with
     the extension and go with it.

  2. Delete this folder. Once the extension is removed you can delete it
     yourself; nothing outside it will still point here.
EOF
