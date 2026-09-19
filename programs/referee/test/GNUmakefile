# Host test for the referee (plain gcc; on Windows run it in WSL).
#   make -C programs/referee/test
#
# Compiles ../src/blank_check.c against the REAL Thru C SDK headers and SHA-256 source, fetched at a
# pinned commit. The SDK's SHA-256 uses RISC-V Zknh instructions (sha256sum0/1, sha256sig0/1) through
# inline asm; for the host build those four macros are swapped for their standard C definitions.
# Everything else (padding, byte order, finalization) is the SDK's own code.

THRU_REF ?= 05603c14cc04c3fcaa3502b2d6c4c26125ece93f
SDK_RAW  := https://raw.githubusercontent.com/Unto-Labs/thru/$(THRU_REF)/sdks/c/thru-sdk/c
SDK_DIR  := build/sdk/thru-sdk/c
SDK_HDRS := tn_sdk.h tn_sdk_base.h tn_sdk_types.h tn_sdk_txn.h tn_sdk_syscall.h tn_sdk_sha256.h

CC      ?= gcc
CFLAGS  ?= -std=gnu17 -O1 -g -Wall -Wextra -Wno-unused-parameter -Wno-attributes
CPPFLAGS += -Ibuild/sdk -I../src -I.

.PHONY: test clean
test: build/host_test
	./build/host_test .

build/host_test: $(addprefix $(SDK_DIR)/,$(SDK_HDRS)) build/tn_sdk_sha256_host.c ../src/blank_check.c ../src/blank_check.h host_runtime.c host_runtime.h test_main.c trace.txt vectors.txt
	$(CC) $(CFLAGS) $(CPPFLAGS) -o $@ test_main.c host_runtime.c ../src/blank_check.c build/tn_sdk_sha256_host.c

$(SDK_DIR)/%.h:
	@mkdir -p $(SDK_DIR)
	curl -fsSL $(SDK_RAW)/$*.h -o $@

$(SDK_DIR)/tn_sdk_sha256.c:
	@mkdir -p $(SDK_DIR)
	curl -fsSL $(SDK_RAW)/tn_sdk_sha256.c -o $@

build/tn_sdk_sha256_host.c: $(SDK_DIR)/tn_sdk_sha256.c
	sed -E \
	  -e 's@^# define Sigma0\(x, res\).*@# define Sigma0(x, res) { res = ((x)>>2|(x)<<30) ^ ((x)>>13|(x)<<19) ^ ((x)>>22|(x)<<10); }@' \
	  -e 's@^# define Sigma1\(x, res\).*@# define Sigma1(x, res) { res = ((x)>>6|(x)<<26) ^ ((x)>>11|(x)<<21) ^ ((x)>>25|(x)<<7); }@' \
	  -e 's@^# define sigma0\(x, res\).*@# define sigma0(x, res) { uint _x = (x); res = (_x>>7|_x<<25) ^ (_x>>18|_x<<14) ^ (_x>>3); }@' \
	  -e 's@^# define sigma1\(x, res\).*@# define sigma1(x, res) { uint _x = (x); res = (_x>>17|_x<<15) ^ (_x>>19|_x<<13) ^ (_x>>10); }@' \
	  -e 's@#include "tn_sdk_sha256.h"@#include <thru-sdk/c/tn_sdk_sha256.h>@' \
	  $< > $@.tmp
	@! grep -q "__asm__(\"sha256" $@.tmp || (echo "failed to replace Zknh asm" && false)
	mv $@.tmp $@

clean:
	rm -rf build
