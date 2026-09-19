#!/usr/bin/env bash
# Build the referee for the Thru VM and deploy (or upgrade) it on the network in ~/.thru/cli/config.yaml.
# Prereqs (on Windows, run inside WSL2):
#   npm i -g thru && thru dev toolchain install && thru dev sdk install c
#   thru keys generate host && thru account create host     # fund with `thru faucet` if needed
set -euo pipefail
cd "$(dirname "$0")"

SEED="${REFEREE_SEED:-blank_check_referee}"
BIN=build/thruvm/bin/blank_check_referee_c.bin

make
ls -l "$BIN"

# First deploy: ./deploy.sh      Later: ./deploy.sh upgrade   (same seed → same program address)
if [ "${1:-}" = "upgrade" ]; then
  thru program upgrade "$SEED" "$BIN"
else
  thru program create "$SEED" "$BIN"
fi

echo
echo "Program account (put this in apps/server/.env as REFEREE_PROGRAM_ADDRESS):"
thru program derive-program-account "$SEED"
