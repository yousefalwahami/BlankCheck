#!/usr/bin/env bash
# Build the Thru VM binary inside Ubuntu 24.04 (glibc 2.39). WSL Ubuntu 22.04
# cannot run the RISC-V gcc from Thru's toolchain (needs GLIBC_2.36+).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq make gcc g++ python3 ca-certificates >/dev/null
echo "host gcc: $(gcc --version | head -1)"
echo "riscv gcc: $(/root/.thru/sdk/toolchain/bin/riscv64-unknown-elf-gcc --version | head -1)"
export RISCV_TOOLCHAIN_ROOT=/root/.thru/sdk/toolchain
export HOME=/root
echo "=== install C SDK into thru-sdk (lib + include) ==="
make -C /root/.thru/sdk/c -j"$(nproc)" BASEDIR=/root/.thru/sdk/c/ BUILDDIR=thru-sdk all lib include
test -f /root/.thru/sdk/c/thru-sdk/thru_c_program.mk && echo "sdk mk ok"
test -f /root/.thru/sdk/c/thru-sdk/lib/libtn_sdk.a && echo "sdk lib ok"
echo "=== compile referee ==="
make -C /work/programs/referee
ls -l /work/programs/referee/build/thruvm/bin/blank_check_referee_c.bin
echo DONE
