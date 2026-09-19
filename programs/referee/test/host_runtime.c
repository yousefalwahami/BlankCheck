/* A tiny host-side stand-in for the Thru VM runtime, so blank_check.c can be compiled with gcc and
 * driven by a test. It implements the SDK functions the referee uses over an in-memory account store,
 * builds a real v1 transaction header (so the SDK's inline helpers work unchanged), and turns
 * tsdk_return / tsdk_revert into longjmp. Reverts roll account data back, like the VM does. */

#include <setjmp.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <thru-sdk/c/tn_sdk.h>
#include <thru-sdk/c/tn_sdk_syscall.h>

#include "host_runtime.h"

#define MAX_TXN_ACCTS (16)
#define MAX_STORE     (64)

typedef struct {
  int    used;
  uchar  addr[32];
  uchar  owner[32];
  uchar *data;
  ulong  sz;
  uchar *snap;
  ulong  snap_sz;
} store_ent_t;

static store_ent_t         g_store[MAX_STORE];
static uchar               g_txn[sizeof(tsdk_txn_hdr_v1_t) + 32 * MAX_TXN_ACCTS + 65536] __attribute__((aligned(16)));
static int                 g_n_accts;
static int                 g_auth[MAX_TXN_ACCTS];
static tsdk_account_meta_t g_meta[MAX_TXN_ACCTS];
static uchar               g_zero[128];
static jmp_buf             g_jmp;
static ulong               g_code;
static int                 g_reverted;

static char  g_events[64][33];
static int   g_n_events;

extern void start(void const *instr, ulong sz) __attribute__((noreturn));

static tn_pubkey_t const *addr_of(int idx) { return &tsdk_txn_get_acct_addrs(tsdk_get_txn())[idx]; }

static store_ent_t *find(uchar const addr[32]) {
  for (int i = 0; i < MAX_STORE; i++)
    if (g_store[i].used && !memcmp(g_store[i].addr, addr, 32)) return &g_store[i];
  return NULL;
}

static store_ent_t *find_idx(ushort idx) {
  if ((int)idx >= g_n_accts) return NULL;
  return find(addr_of(idx)->key);
}

/* ───────────── test driver API ───────────── */

void host_begin(uchar accts[][32], int n, int const *authorized, int n_auth, uchar const *ix, ulong ix_sz) {
  memset(g_txn, 0, sizeof(tsdk_txn_hdr_v1_t));
  tsdk_txn_hdr_v1_t *h = (tsdk_txn_hdr_v1_t *)g_txn;
  h->transaction_version    = 1;
  h->readwrite_accounts_cnt = (ushort)(n - 2);
  h->readonly_accounts_cnt  = 0;
  h->instr_data_sz          = (ushort)ix_sz;
  h->chain_id               = 1;
  memcpy(h->fee_payer_pubkey.key, accts[0], 32);
  memcpy(h->program_pubkey.key, accts[1], 32);
  uchar *p = g_txn + sizeof(tsdk_txn_hdr_v1_t);
  for (int i = 2; i < n; i++, p += 32) memcpy(p, accts[i], 32);
  memcpy(p, ix, ix_sz);
  g_n_accts = n;
  memset(g_auth, 0, sizeof(g_auth));
  for (int i = 0; i < n_auth; i++) g_auth[authorized[i]] = 1;
  g_n_events = 0;
}

int host_run(ulong *code) {
  for (int i = 0; i < MAX_STORE; i++) {
    store_ent_t *e = &g_store[i];
    if (!e->used) continue;
    free(e->snap);
    e->snap    = e->sz ? malloc(e->sz) : NULL;
    e->snap_sz = e->sz;
    if (e->sz) memcpy(e->snap, e->data, e->sz);
  }
  int created_before[MAX_STORE];
  for (int i = 0; i < MAX_STORE; i++) created_before[i] = g_store[i].used;

  if (setjmp(g_jmp) == 0) {
    tsdk_txn_t const *txn = tsdk_get_txn();
    start(tsdk_txn_get_instr_data(txn), tsdk_txn_get_instr_data_sz(txn));
  }
  *code = g_code;
  if (g_reverted) {
    for (int i = 0; i < MAX_STORE; i++) {
      store_ent_t *e = &g_store[i];
      if (!e->used) continue;
      if (!created_before[i]) { /* created during a reverted txn: undo */
        free(e->data);
        memset(e, 0, sizeof(*e));
        continue;
      }
      e->data = realloc(e->data, e->snap_sz ? e->snap_sz : 1);
      e->sz   = e->snap_sz;
      if (e->snap_sz) memcpy(e->data, e->snap, e->snap_sz);
    }
    g_n_events = 0;
  }
  return !g_reverted;
}

int host_event_count(void) { return g_n_events; }
char const *host_event_hex(int i) { return g_events[i]; }

int host_account_data(uchar const addr[32], uchar const **data, ulong *sz) {
  store_ent_t *e = find(addr);
  if (!e) return 0;
  *data = e->data;
  *sz   = e->sz;
  return 1;
}

/* ───────────── SDK runtime (tn_sdk.h) ───────────── */

tsdk_txn_t const *tsdk_get_txn(void) { return (tsdk_txn_t const *)g_txn; }

int tsdk_is_account_idx_valid(ushort idx) { return (int)idx < g_n_accts; }

tsdk_account_meta_t const *tsdk_get_account_meta(ushort idx) {
  tsdk_account_meta_t *m = &g_meta[idx % MAX_TXN_ACCTS];
  memset(m, 0, sizeof(*m));
  store_ent_t *e = find_idx(idx);
  if (e) {
    m->version = 1;
    m->data_sz = (uint)e->sz;
    memcpy(m->owner.key, e->owner, 32);
  }
  return m;
}

void *tsdk_get_account_data_ptr(ushort idx) {
  store_ent_t *e = find_idx(idx);
  return e && e->data ? (void *)e->data : (void *)g_zero;
}

int tsdk_account_exists(ushort idx) { return find_idx(idx) != NULL; }

int tsdk_is_account_owned_by_current_program(ushort idx) {
  store_ent_t *e = find_idx(idx);
  return e && !memcmp(e->owner, addr_of(1)->key, 32);
}

int tsdk_is_account_authorized_by_idx(ushort idx) {
  if (idx == 0 || idx == 1) return 1; /* fee payer and current program, as in the SDK */
  return (int)idx < g_n_accts && g_auth[idx];
}

void tsdk_revert(ulong code) {
  g_code     = code;
  g_reverted = 1;
  longjmp(g_jmp, 1);
}

void tsdk_return(ulong code) {
  g_code     = code;
  g_reverted = 0;
  longjmp(g_jmp, 1);
}

void tsdk_printf(char const *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vfprintf(stderr, fmt, ap);
  va_end(ap);
  fputc('\n', stderr);
}

/* ───────────── syscalls (tn_sdk_syscall.h) ───────────── */

ulong tsys_set_account_data_writable(ulong idx) { return idx < (ulong)g_n_accts ? 0UL : 1UL; }

ulong tsys_account_create(ulong idx, uchar const seed[TN_SEED_SIZE], void const *proof, ulong proof_sz) {
  (void)seed; (void)proof; (void)proof_sz;
  if (idx >= (ulong)g_n_accts || find_idx((ushort)idx)) return 1UL;
  for (int i = 0; i < MAX_STORE; i++) {
    if (g_store[i].used) continue;
    memset(&g_store[i], 0, sizeof(g_store[i]));
    g_store[i].used = 1;
    memcpy(g_store[i].addr, addr_of((int)idx)->key, 32);
    memcpy(g_store[i].owner, addr_of(1)->key, 32);
    return 0UL;
  }
  return 2UL;
}

ulong tsys_account_resize(ulong idx, ulong new_size) {
  store_ent_t *e = find_idx((ushort)idx);
  if (!e || new_size > TSDK_ACCOUNT_DATA_SZ_MAX) return 1UL;
  e->data = realloc(e->data, new_size ? new_size : 1);
  if (new_size > e->sz) memset(e->data + e->sz, 0, new_size - e->sz);
  e->sz = new_size;
  return 0UL;
}

ulong tsys_emit_event(void const *data, ulong sz) {
  if (sz != 16 || g_n_events >= 64) return 1UL;
  uchar const *b = (uchar const *)data;
  for (ulong i = 0; i < sz; i++) sprintf(&g_events[g_n_events][2 * i], "%02x", b[i]);
  g_n_events++;
  return 0UL;
}
