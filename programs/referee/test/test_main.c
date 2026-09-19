/* Host test for the BLANK CHECK referee.
 *   1. Hash vectors: C (the SDK's SHA-256) must match TypeScript and node:crypto byte for byte.
 *   2. Trace replay: every instruction recorded from the TypeScript mirror (full games + refusals)
 *      runs through blank_check.c; results, revert codes, events and final Table bytes must match. */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <thru-sdk/c/tn_sdk.h>
#include <thru-sdk/c/tn_sdk_sha256.h>

#include "blank_check.h"
#include "host_runtime.h"

static int fails = 0;

static int unhex(char const *s, uchar *out, size_t max) {
  size_t n = strlen(s) / 2;
  if (n > max) return -1;
  for (size_t i = 0; i < n; i++) {
    unsigned v;
    if (sscanf(s + 2 * i, "%2x", &v) != 1) return -1;
    out[i] = (uchar)v;
  }
  return (int)n;
}

static void tohex(uchar const *b, size_t n, char *out) {
  for (size_t i = 0; i < n; i++) sprintf(out + 2 * i, "%02x", b[i]);
}

static void check(int ok, char const *what, char const *detail) {
  if (!ok) {
    fails++;
    fprintf(stderr, "FAIL %s %s\n", what, detail ? detail : "");
  }
}

static void run_vectors(char const *path) {
  FILE *f = fopen(path, "r");
  if (!f) { perror(path); exit(2); }
  char line[4096];
  int n = 0;
  while (fgets(line, sizeof line, f)) {
    uchar table[32], salt[32], want[32], got[32], shells[16];
    char  th[80], sh[80], wh[80], shx[40];
    unsigned round, window, seat, cheat, shell, cnt;
    char hex[65];
    if (line[0] == 'E' && sscanf(line, "E %64s %u %u %u %u %u %64s %64s", th, &round, &window, &seat, &cheat, &shell, sh, wh) == 8) {
      unhex(th, table, 32); unhex(sh, salt, 32); unhex(wh, want, 32);
      bc_envelope_hash(table, (uchar)round, (uchar)window, (uchar)seat, (uchar)cheat, (uchar)shell, salt, got);
      tohex(got, 32, hex);
      check(!memcmp(got, want, 32), "envelope vector", hex);
      n++;
    } else if (line[0] == 'S' && sscanf(line, "S %64s %u %u %32s %64s %64s", th, &round, &cnt, shx, sh, wh) == 6) {
      unhex(th, table, 32); unhex(sh, salt, 32); unhex(wh, want, 32); unhex(shx, shells, sizeof shells);
      bc_shells_hash(table, (uchar)round, (uchar)cnt, shells, salt, got);
      tohex(got, 32, hex);
      check(!memcmp(got, want, 32), "shells vector", hex);
      n++;
    }
  }
  fclose(f);
  printf("vectors: %d checked\n", n);
}

static char *next_field(char **s) {
  char *f = strsep(s, " \n");
  return f ? f : (char *)"";
}

static void run_trace(char const *path) {
  FILE *f = fopen(path, "r");
  if (!f) { perror(path); exit(2); }
  size_t cap = 1 << 20;
  char  *line = malloc(cap);
  int    n = 0, tables = 0;
  static uchar accts[16][32];
  static uchar ix[8192];
  while (fgets(line, (int)cap, f)) {
    char *s = line;
    if (line[0] == 'T') {
      next_field(&s);
      char *label = next_field(&s);
      int   want_ok = atoi(next_field(&s));
      ulong want_err = strtoul(next_field(&s), NULL, 16);
      int   ix_sz = unhex(next_field(&s), ix, sizeof ix);

      char *acc = next_field(&s);
      int   n_acc = 0;
      for (char *a; (a = strsep(&acc, ",")) && n_acc < 16;) unhex(a, accts[n_acc++], 32);

      char *auth = next_field(&s);
      int   authorized[16], n_auth = 0;
      if (strcmp(auth, "-")) for (char *a; (a = strsep(&auth, ",")) && n_auth < 16;) authorized[n_auth++] = atoi(a);

      char *events = next_field(&s);

      host_begin(accts, n_acc, authorized, n_auth, ix, (ulong)ix_sz);
      ulong code = 0;
      int   ok = host_run(&code);

      char detail[256];
      snprintf(detail, sizeof detail, "#%d %s: want ok=%d err=%lx, got ok=%d code=%lx", n, label, want_ok, want_err, ok, code);
      check(ok == want_ok && (ok ? code == 0 : code == want_err), "result", detail);

      int ev = 0;
      if (strcmp(events, "-")) {
        for (char *e; (e = strsep(&events, ","));) {
          check(ev < host_event_count() && !strcmp(e, host_event_hex(ev)), "event", detail);
          ev++;
        }
      }
      check(ev == host_event_count(), "event count", detail);
      n++;
    } else if (line[0] == 'F') {
      next_field(&s);
      uchar addr[32], want[32], got[32];
      unhex(next_field(&s), addr, 32);
      unhex(next_field(&s), want, 32);
      uchar const *data;
      ulong        sz;
      if (!host_account_data(addr, &data, &sz)) {
        check(0, "final table", "missing");
        continue;
      }
      tsdk_sha256_hash(data, sz, got);
      char hex[65];
      tohex(got, 32, hex);
      check(sz == sizeof(bc_table_t) && !memcmp(got, want, 32), "final table bytes", hex);
      tables++;
    }
  }
  free(line);
  fclose(f);
  printf("trace: %d instructions replayed, %d final tables compared\n", n, tables);
}

int main(int argc, char **argv) {
  char const *dir = argc > 1 ? argv[1] : ".";
  char        path[1024];
  snprintf(path, sizeof path, "%s/vectors.txt", dir);
  run_vectors(path);
  snprintf(path, sizeof path, "%s/trace.txt", dir);
  run_trace(path);
  if (fails) {
    printf("❌ %d failure(s)\n", fails);
    return 1;
  }
  printf("✅ blank_check.c matches the TypeScript referee byte for byte\n");
  return 0;
}
