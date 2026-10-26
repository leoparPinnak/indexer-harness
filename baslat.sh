#!/usr/bin/env sh
# Start the Indexer Harness Web UI on macOS and Linux (port 1234).
# Windows uses baslat.bat; both start the same source tree through tsx.
set -eu
cd "$(dirname "$0")"

DSH_HOME="${DSH_HOME:-$HOME/.indexer-harness}"
# Shared with the gateway's `gateway.deviceSecret`: it signs this installation's
# device id so the gateway can refuse a forged one. Set the same value there.
: "${DSH_DEVICE_SECRET:=}"
export DSH_HOME DSH_DEVICE_SECRET
[ -n "$DSH_DEVICE_SECRET" ] || export DSH_DEVICE_SECRET="$(cat "$DSH_HOME/.device-secret" 2>/dev/null || true)"

echo "========================================================"
echo "  DSH Web Sunucusu: http://127.0.0.1:1234/"
echo "  DSH_HOME        : $DSH_HOME"
echo "========================================================"

while :; do
  node --import tsx/esm apps/cli/src/bin.ts web --no-open --port 1234 \
    --trusted-host dsh.ottonline1553.xyz || echo "Sunucu durdu (kod $?). 2 sn icinde yeniden baslatiliyor..."
  sleep 2
done
