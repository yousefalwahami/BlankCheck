#ifndef HEADER_blank_check_referee_h
#define HEADER_blank_check_referee_h

/* BLANK CHECK referee.
 *
 * The evidence locker and public scoreboard for a party game about cheating:
 * shell-order commitments, sealed envelopes, accusations, verdicts and hearts.
 * Every instruction starts with `u32 ix` then `u16 table_idx` (little-endian, packed).
 *
 * apps/server/src/referee/program.ts is a line-by-line TypeScript mirror of this file
 * (used by the offline MockReferee). Keep limits, layouts, check order and error codes in sync.
 */

#include <stddef.h>
#include <thru-sdk/c/tn_sdk.h>

#define BC_MAX_SEATS   (6U)
#define BC_MAX_ROUNDS  (24U)
#define BC_MAX_WINDOWS (16U) /* seal windows per round: shots + flushes */
#define BC_MIN_SHELLS  (2U)
#define BC_MAX_SHELLS  (8U)
#define BC_MAX_HEARTS  (5U)
#define BC_NONE        ((uchar)0xFFU) /* no seat / no round yet */

#define BC_STATUS_LOBBY    ((uchar)0U)
#define BC_STATUS_PLAYING  ((uchar)1U)
#define BC_STATUS_FINISHED ((uchar)2U)

/* Instructions */
#define BC_IX_CREATE_TABLE  (0U) /* host: u64 game_id, u8 n, u8 hearts, u8 wallets[n][32], u32 proof_sz, proof */
#define BC_IX_COMMIT_ROUND  (1U) /* host: u8 round, u8 shell_count, u8 live_count, u8 first_seat, u8 commit[32] */
#define BC_IX_PULL_TRIGGER  (2U) /* seat: u16 wallet_idx, u8 round, u8 shot, u8 shooter, u8 target */
#define BC_IX_RESOLVE_SHOT  (3U) /* host: u8 round, u8 shot, u8 is_live, u8 window, u8 n, u8 env[n][32] */
#define BC_IX_SEAL          (4U) /* host: u8 round, u8 window, u8 n, u8 env[n][32] */
#define BC_IX_ACCUSE        (5U) /* seat: u16 wallet_idx, u8 round, u8 accuser, u8 accused */
#define BC_IX_REVEAL        (6U) /* host: u8 round, u8 seat, u8 mode, u8 n, {u8 cheat, u8 shell, u8 salt[32]}[n] */
#define BC_IX_REVEAL_SHELLS (7U) /* host: u8 round, u8 n, u8 shells[n], u8 salt[32] */

#define BC_HDR_SZ         (6UL)
#define BC_REVEAL_ITEM_SZ (34UL)

/* Errors (tsdk_revert codes) */
#define BC_ERR_SHORT     (0x2000UL) /* instruction size wrong */
#define BC_ERR_BAD_IX    (0x2001UL)
#define BC_ERR_ACCT      (0x2002UL) /* account index out of range */
#define BC_ERR_NOT_TABLE (0x2003UL) /* missing, foreign, too small or bad magic */
#define BC_ERR_NOT_HOST  (0x2004UL) /* fee payer is not the table host */
#define BC_ERR_NOT_SEAT  (0x2005UL) /* wallet doesn't match the seat, or isn't authorized */
#define BC_ERR_STATUS    (0x2006UL) /* wrong game status */
#define BC_ERR_ROUND     (0x2007UL)
#define BC_ERR_ARGS      (0x2008UL)
#define BC_ERR_TURN      (0x2009UL) /* not your turn / someone is dead */
#define BC_ERR_PENDING   (0x200AUL) /* trigger or accusation state is wrong */
#define BC_ERR_WINDOW    (0x200BUL)
#define BC_ERR_ACCUSE    (0x200CUL) /* already accused this round, or target is BUSTED */
#define BC_ERR_HASH      (0x200DUL) /* revealed contents don't match what was sealed */
#define BC_ERR_CREATE    (0x200EUL)
#define BC_ERR_WRITABLE  (0x200FUL)
#define BC_ERR_RESIZE    (0x2010UL)
#define BC_ERR_SHOT      (0x2011UL)
#define BC_ERR_EVENT     (0x2012UL)

/* Events: fixed 16 bytes */
#define BC_EVT_TABLE_CREATED   (1U)
#define BC_EVT_ROUND_COMMITTED (2U)
#define BC_EVT_TRIGGER_PULLED  (3U)
#define BC_EVT_SHOT_RESOLVED   (4U)
#define BC_EVT_SEALED          (5U)
#define BC_EVT_ACCUSED         (6U)
#define BC_EVT_VERDICT         (7U)
#define BC_EVT_ENVELOPE_OPENED (8U)
#define BC_EVT_SHELLS_REVEALED (9U)
#define BC_EVT_GAME_OVER       (10U)

typedef struct __attribute__((packed)) {
  uchar kind;
  uchar round;
  uchar window_or_shot;
  uchar seat_a;
  uchar seat_b;
  uchar value;
  uchar value2;
  uchar pad;
  ulong game_id;
} bc_event_t;

/* One per game, derived from seed "table" || u64 game_id. Layout mirrored in packages/shared/src/table.ts. */
typedef struct __attribute__((packed)) {
  uchar magic[4]; /* "BCK1" */
  uchar host[32]; /* game server pubkey (fee payer of every host instruction) */
  ulong game_id;
  uchar status;
  uchar num_seats;
  uchar start_hearts;
  uchar round;           /* BC_NONE before the first round */
  uchar current_seat;    /* whose turn */
  uchar shot;            /* next shot index this round */
  uchar window;          /* next seal window this round */
  uchar trigger_pulled;  /* 1 after PULL_TRIGGER, until RESOLVE_SHOT */
  uchar pending_target;
  uchar pending_accuser; /* BC_NONE = no accusation pending */
  uchar pending_accused;
  uchar winner; /* BC_NONE until finished */
  uchar hearts[BC_MAX_SEATS];
  uchar busted[BC_MAX_SEATS];      /* found guilty this round */
  uchar accuse_used[BC_MAX_SEATS]; /* used RIGGED! this round */
  uchar seat_wallet[BC_MAX_SEATS][32]; /* passkey wallet; the host key for bots / host-signed seats */
  uchar shells_commit[BC_MAX_ROUNDS][32];
  uchar shell_count[BC_MAX_ROUNDS];
  uchar live_count[BC_MAX_ROUNDS];
  uchar window_count[BC_MAX_ROUNDS];
  uchar env[BC_MAX_ROUNDS][BC_MAX_WINDOWS][BC_MAX_SEATS][32]; /* ~72 KB of sealed envelopes */
} bc_table_t;

_Static_assert(sizeof(bc_event_t) == 16UL, "event must be 16 bytes");
_Static_assert(sizeof(bc_table_t) == 74834UL, "table layout drifted from packages/shared/src/table.ts");
_Static_assert(offsetof(bc_table_t, game_id) == 36UL, "layout");
_Static_assert(offsetof(bc_table_t, hearts) == 56UL, "layout");
_Static_assert(offsetof(bc_table_t, seat_wallet) == 74UL, "layout");
_Static_assert(offsetof(bc_table_t, shells_commit) == 266UL, "layout");
_Static_assert(offsetof(bc_table_t, window_count) == 1082UL, "layout");
_Static_assert(offsetof(bc_table_t, env) == 1106UL, "layout");

/* Commit-reveal hashes (spec §6.5). Exposed so the host test can check them against test vectors.
 *   envelope = SHA-256(table[32] | round | window | seat | cheat | shell | salt[32])            (69 bytes)
 *   shells   = SHA-256(table[32] | round | n | shells[n] | salt[32])                            (66 + n bytes) */
void bc_envelope_hash(uchar const table[32], uchar round, uchar window, uchar seat, uchar cheat, uchar shell,
                      uchar const salt[32], uchar out[32]);
void bc_shells_hash(uchar const table[32], uchar round, uchar n, uchar const * shells, uchar const salt[32], uchar out[32]);

#endif /* HEADER_blank_check_referee_h */
