#ifndef HEADER_blank_check_host_runtime_h
#define HEADER_blank_check_host_runtime_h

#include <thru-sdk/c/tn_sdk.h>

/* Set up the next transaction: accts[0] = fee payer, accts[1] = program, the rest read-write. */
void host_begin(uchar accts[][32], int n, int const *authorized, int n_auth, uchar const *ix, ulong ix_sz);
/* Run the referee's entrypoint. Returns 1 on success, 0 on revert; *code is the exit/revert code. */
int host_run(ulong *code);
int host_event_count(void);
char const *host_event_hex(int i);
int host_account_data(uchar const addr[32], uchar const **data, ulong *sz);

#endif
