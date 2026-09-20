#include <stddef.h>
#include <thru-sdk/c/tn_sdk.h>
#include <thru-sdk/c/tn_sdk_sha256.h>
#include <thru-sdk/c/tn_sdk_syscall.h>
#include "blank_check.h"

/* BLANK CHECK referee: see blank_check.h. The stack is small (4 KiB), so no big locals. */

static uchar const BC_MAGIC[4] = { 'B', 'C', 'K', '2' };

/* ───────────── hashing ───────────── */

void
bc_envelope_hash( uchar const table[32], uchar round, uchar window, uchar seat, uchar cheat, uchar shell,
                  uchar const salt[32], uchar out[32] ) {
  uchar pre[72] __attribute__((aligned(8)));
  memcpy( pre, table, 32UL );
  pre[32] = round;
  pre[33] = window;
  pre[34] = seat;
  pre[35] = cheat;
  pre[36] = shell;
  memcpy( pre + 37, salt, 32UL );
  tsdk_sha256_hash( pre, 69UL, out );
}

void
bc_shells_hash( uchar const table[32], uchar round, uchar n, uchar const * shells, uchar const salt[32], uchar out[32] ) {
  uchar pre[80] __attribute__((aligned(8)));
  memcpy( pre, table, 32UL );
  pre[32] = round;
  pre[33] = n;
  memcpy( pre + 34, shells, (ulong)n );
  memcpy( pre + 34 + n, salt, 32UL );
  tsdk_sha256_hash( pre, 66UL + (ulong)n, out );
}

/* ───────────── helpers ───────────── */

static tn_pubkey_t const *
bc_addrs( void ) {
  return tsdk_txn_get_acct_addrs( tsdk_get_txn() );
}

static uchar
bc_u8( ulong v ) {
  return (uchar)( v > 255UL ? 255UL : v );
}

static void
bc_emit( bc_table_t const * t, uchar kind, uchar round, uchar window_or_shot, uchar seat_a, uchar seat_b, uchar value, uchar value2 ) {
  bc_event_t e;
  e.kind           = kind;
  e.round          = round;
  e.window_or_shot = window_or_shot;
  e.seat_a         = seat_a;
  e.seat_b         = seat_b;
  e.value          = value;
  e.value2         = value2;
  e.pad            = 0;
  e.game_id        = t->game_id;
  if( tsys_emit_event( &e, sizeof( e ) ) != TSDK_SUCCESS ) tsdk_revert( BC_ERR_EVENT );
}

static void
bc_clear_pending( bc_table_t * t ) {
  t->trigger_pulled  = 0;
  t->pending_target  = BC_NONE;
  t->pending_accuser = BC_NONE;
  t->pending_accused = BC_NONE;
}

/* Next seat with chips clockwise. Must match nextFunded() in apps/server/src/engine/rules.ts. */
static uchar
bc_next_seat( bc_table_t const * t, uchar from ) {
  for( uint i = 1U; i <= t->num_seats; i++ ) {
    uchar c = (uchar)( ( from + i ) % t->num_seats );
    if( t->chips[c] > 0 ) return c;
  }
  return from;
}

static uint
bc_funded( bc_table_t const * t ) {
  uint k = 0U;
  for( uchar i = 0; i < t->num_seats; i++ ) if( t->chips[i] > 0 ) k++;
  return k;
}

/* The game is over: the winner is the biggest profit in chips (chips − buy-ins × chips per buy-in),
   the lowest seat on a tie. Must match gameOver() in apps/server/src/engine/step.ts. */
static void
bc_finish( bc_table_t * t, uchar early ) {
  uchar best        = 0;
  long  best_profit = (long)t->chips[0] - (long)t->buy_ins[0] * (long)t->buy_in_chips;
  for( uchar i = 1; i < t->num_seats; i++ ) {
    long p = (long)t->chips[i] - (long)t->buy_ins[i] * (long)t->buy_in_chips;
    if( p > best_profit ) {
      best        = i;
      best_profit = p;
    }
  }
  t->status = BC_STATUS_FINISHED;
  t->winner = best;
  bc_emit( t, BC_EVT_GAME_OVER, t->round, 0, best, BC_NONE, early, 0 );
}

static void
bc_store_envelopes( bc_table_t * t, uchar round, uchar window, uchar const * env, uchar n ) {
  for( uchar i = 0; i < n; i++ ) memcpy( t->env[round][window][i], env + 32UL * i, 32UL );
  t->window              = (uchar)( window + 1 );
  t->window_count[round] = (uchar)( window + 1 );
}

static void
bc_require_host( bc_table_t const * t ) {
  if( memcmp( &bc_addrs()[0], t->host, 32UL ) != 0 ) tsdk_revert( BC_ERR_NOT_HOST );
}

/* The wallet at wallet_idx must be this seat's wallet or the table host, and authorized.
   Passkey seats sign via passkey-manager CPI; the host may sign when they shoot someone else. */
static void
bc_require_seat( bc_table_t const * t, ushort wallet_idx, uchar seat ) {
  if( !tsdk_is_account_idx_valid( wallet_idx ) ) tsdk_revert( BC_ERR_ACCT );
  if( memcmp( &bc_addrs()[wallet_idx], t->seat_wallet[seat], 32UL ) != 0 &&
      memcmp( &bc_addrs()[wallet_idx], t->host, 32UL ) != 0 )
    tsdk_revert( BC_ERR_NOT_SEAT );
  if( !tsdk_is_account_authorized_by_idx( wallet_idx ) ) tsdk_revert( BC_ERR_NOT_SEAT );
}

static bc_table_t *
bc_load_table( ushort table_idx ) {
  if( !tsdk_account_exists( table_idx ) ) tsdk_revert( BC_ERR_NOT_TABLE );
  if( !tsdk_is_account_owned_by_current_program( table_idx ) ) tsdk_revert( BC_ERR_NOT_TABLE );
  if( tsdk_get_account_meta( table_idx )->data_sz < sizeof( bc_table_t ) ) tsdk_revert( BC_ERR_NOT_TABLE );
  bc_table_t * t = (bc_table_t *)tsdk_get_account_data_ptr( table_idx );
  if( memcmp( t->magic, BC_MAGIC, 4UL ) != 0 ) tsdk_revert( BC_ERR_NOT_TABLE );
  if( tsys_set_account_data_writable( table_idx ) != TSDK_SUCCESS ) tsdk_revert( BC_ERR_WRITABLE );
  return t;
}

/* ───────────── instructions ───────────── */

static void
bc_create_table( uchar const * ix, ulong sz, ushort table_idx ) {
  if( sz < 17UL ) tsdk_revert( BC_ERR_SHORT );
  ulong game_id      = TSDK_LOAD( ulong, ix + 6 );
  uchar n            = ix[14];
  uchar buy_in_chips = ix[15];
  uchar rounds       = ix[16];
  if( n < 2U || n > BC_MAX_SEATS || buy_in_chips < 1U || buy_in_chips > BC_MAX_BUY_IN_CHIPS || rounds < 1U || rounds > BC_MAX_ROUNDS ) {
    tsdk_revert( BC_ERR_ARGS );
  }
  ulong wallets_end = 17UL + 32UL * n;
  if( sz < wallets_end + 4UL ) tsdk_revert( BC_ERR_SHORT );
  uint proof_sz = TSDK_LOAD( uint, ix + wallets_end );
  if( sz != wallets_end + 4UL + proof_sz ) tsdk_revert( BC_ERR_SHORT );
  if( tsdk_account_exists( table_idx ) ) tsdk_revert( BC_ERR_CREATE );

  uchar seed[TN_SEED_SIZE];
  memset( seed, 0, sizeof( seed ) );
  memcpy( seed, "table", 5UL );
  memcpy( seed + 5, &game_id, 8UL );
  void const * proof = proof_sz ? (void const *)( ix + wallets_end + 4UL ) : NULL;
  if( tsys_account_create( table_idx, seed, proof, proof_sz ) != TSDK_SUCCESS ) tsdk_revert( BC_ERR_CREATE );
  if( tsys_set_account_data_writable( table_idx ) != TSDK_SUCCESS ) tsdk_revert( BC_ERR_WRITABLE );
  if( tsys_account_resize( table_idx, sizeof( bc_table_t ) ) != TSDK_SUCCESS ) tsdk_revert( BC_ERR_RESIZE );

  bc_table_t * t = (bc_table_t *)tsdk_get_account_data_ptr( table_idx );
  memset( t, 0, sizeof( bc_table_t ) );
  memcpy( t->magic, BC_MAGIC, 4UL );
  memcpy( t->host, &bc_addrs()[0], 32UL );
  t->game_id      = game_id;
  t->status       = BC_STATUS_PLAYING;
  t->num_seats    = n;
  t->buy_in_chips = buy_in_chips;
  t->rounds_total = rounds;
  t->round        = BC_NONE;
  t->round_ended  = 1;
  bc_clear_pending( t );
  t->winner = BC_NONE;
  for( uchar i = 0; i < n; i++ ) {
    t->chips[i]   = buy_in_chips; /* everyone bought in at the lobby */
    t->buy_ins[i] = 1;
    memcpy( t->seat_wallet[i], ix + 17UL + 32UL * i, 32UL );
  }
  bc_emit( t, BC_EVT_TABLE_CREATED, 0, 0, BC_NONE, BC_NONE, n, buy_in_chips );
}

static void
bc_commit_round( bc_table_t * t, uchar const * ix, ulong sz ) {
  if( sz != BC_HDR_SZ + 4UL + 32UL ) tsdk_revert( BC_ERR_SHORT );
  bc_require_host( t );
  uchar round = ix[6], shell_count = ix[7], live_count = ix[8], first_seat = ix[9];
  if( t->status != BC_STATUS_PLAYING ) tsdk_revert( BC_ERR_STATUS );
  uchar cur = t->round;
  if( round != ( cur == BC_NONE ? 0U : (uint)cur + 1U ) ) tsdk_revert( BC_ERR_ROUND );
  if( !t->round_ended ) tsdk_revert( BC_ERR_ROUND );
  if( shell_count == 0U ) {
    /* Not enough players with money left: cash out early. */
    bc_finish( t, 1 );
    return;
  }
  if( round >= BC_MAX_ROUNDS || round >= t->rounds_total ) tsdk_revert( BC_ERR_ROUND );
  if( shell_count < BC_MIN_SHELLS || shell_count > BC_MAX_SHELLS || live_count < 1U || live_count >= shell_count ) {
    tsdk_revert( BC_ERR_ARGS );
  }
  if( first_seat >= t->num_seats || t->chips[first_seat] == 0 ) tsdk_revert( BC_ERR_TURN );
  t->round       = round;
  t->round_ended = 0;
  memcpy( t->shells_commit[round], ix + 10, 32UL );
  t->shell_count[round]  = shell_count;
  t->live_count[round]   = live_count;
  t->window_count[round] = 0;
  t->current_seat        = first_seat;
  t->shot                = 0;
  t->window              = 0;
  memset( t->busted, 0, BC_MAX_SEATS );
  memset( t->accuse_used, 0, BC_MAX_SEATS );
  bc_clear_pending( t );
  bc_emit( t, BC_EVT_ROUND_COMMITTED, round, 0, first_seat, BC_NONE, shell_count, live_count );
}

static void
bc_pull_trigger( bc_table_t * t, uchar const * ix, ulong sz ) {
  if( sz != BC_HDR_SZ + 2UL + 4UL ) tsdk_revert( BC_ERR_SHORT );
  ushort wallet_idx = TSDK_LOAD( ushort, ix + 6 );
  uchar round = ix[8], shot = ix[9], shooter = ix[10], target = ix[11];
  if( t->status != BC_STATUS_PLAYING ) tsdk_revert( BC_ERR_STATUS );
  if( t->round == BC_NONE || round != t->round || t->round_ended ) tsdk_revert( BC_ERR_ROUND );
  if( shot != t->shot || shot >= t->shell_count[round] ) tsdk_revert( BC_ERR_SHOT );
  if( shooter >= t->num_seats || target >= t->num_seats ) tsdk_revert( BC_ERR_ARGS );
  if( shooter != t->current_seat || t->chips[shooter] == 0 || t->chips[target] == 0 ) tsdk_revert( BC_ERR_TURN );
  if( t->trigger_pulled || t->pending_accused != BC_NONE ) tsdk_revert( BC_ERR_PENDING );
  bc_require_seat( t, wallet_idx, shooter );
  t->trigger_pulled = 1;
  t->pending_target = target;
  bc_emit( t, BC_EVT_TRIGGER_PULLED, round, shot, shooter, target, 0, 0 );
}

static void
bc_resolve_shot( bc_table_t * t, uchar const * ix, ulong sz ) {
  if( sz < 11UL ) tsdk_revert( BC_ERR_SHORT );
  bc_require_host( t );
  uchar round = ix[6], shot = ix[7], is_live = ix[8], window = ix[9], n = ix[10];
  if( sz != 11UL + 32UL * n || n != t->num_seats ) tsdk_revert( BC_ERR_SHORT );
  if( t->status != BC_STATUS_PLAYING ) tsdk_revert( BC_ERR_STATUS );
  if( round != t->round ) tsdk_revert( BC_ERR_ROUND );
  if( shot != t->shot ) tsdk_revert( BC_ERR_SHOT );
  if( !t->trigger_pulled ) tsdk_revert( BC_ERR_PENDING );
  if( window != t->window || window >= BC_MAX_WINDOWS ) tsdk_revert( BC_ERR_WINDOW );
  if( is_live > 1U ) tsdk_revert( BC_ERR_ARGS );
  uchar shooter = t->current_seat;
  uchar target  = t->pending_target;
  /* A live hit knocks one chip into the pot. */
  if( is_live && t->chips[target] > 0 ) {
    t->chips[target]--;
    t->pot++;
  }
  bc_store_envelopes( t, round, window, ix + 11, n );
  t->shot           = (uchar)( shot + 1 );
  t->trigger_pulled = 0;
  t->pending_target = BC_NONE;
  bc_emit( t, BC_EVT_SHOT_RESOLVED, round, shot, shooter, target, is_live, bc_u8( t->chips[target] ) );
  /* A blank on yourself means you go again; otherwise the next seat with chips. */
  if( !( is_live == 0 && target == shooter ) ) t->current_seat = bc_next_seat( t, shooter );
}

static void
bc_seal( bc_table_t * t, uchar const * ix, ulong sz ) {
  if( sz < 9UL ) tsdk_revert( BC_ERR_SHORT );
  bc_require_host( t );
  uchar round = ix[6], window = ix[7], n = ix[8];
  if( sz != 9UL + 32UL * n || n != t->num_seats ) tsdk_revert( BC_ERR_SHORT );
  if( t->status != BC_STATUS_PLAYING ) tsdk_revert( BC_ERR_STATUS );
  if( round != t->round ) tsdk_revert( BC_ERR_ROUND );
  if( window != t->window || window >= BC_MAX_WINDOWS ) tsdk_revert( BC_ERR_WINDOW );
  if( t->trigger_pulled ) tsdk_revert( BC_ERR_PENDING );
  bc_store_envelopes( t, round, window, ix + 9, n );
  bc_emit( t, BC_EVT_SEALED, round, window, BC_NONE, BC_NONE, n, 0 );
}

static void
bc_accuse( bc_table_t * t, uchar const * ix, ulong sz ) {
  if( sz != BC_HDR_SZ + 2UL + 3UL ) tsdk_revert( BC_ERR_SHORT );
  ushort wallet_idx = TSDK_LOAD( ushort, ix + 6 );
  uchar round = ix[8], accuser = ix[9], accused = ix[10];
  if( t->status != BC_STATUS_PLAYING ) tsdk_revert( BC_ERR_STATUS );
  if( round != t->round || t->round_ended ) tsdk_revert( BC_ERR_ROUND );
  if( accuser >= t->num_seats || accused >= t->num_seats || accuser == accused ) tsdk_revert( BC_ERR_ARGS );
  if( t->chips[accuser] == 0 || t->chips[accused] == 0 ) tsdk_revert( BC_ERR_TURN );
  if( t->accuse_used[accuser] || t->busted[accused] ) tsdk_revert( BC_ERR_ACCUSE );
  if( t->pending_accused != BC_NONE || t->trigger_pulled ) tsdk_revert( BC_ERR_PENDING );
  bc_require_seat( t, wallet_idx, accuser );
  t->accuse_used[accuser] = 1;
  t->pending_accuser      = accuser;
  t->pending_accused      = accused;
  bc_emit( t, BC_EVT_ACCUSED, round, t->window, accuser, accused, 0, 0 );
}

/* mode 0 (verdict): open the accused's envelopes for this round and move the chips.
   mode 1 (tape):    after the game, open any seat's envelopes for any round. */
static void
bc_reveal( bc_table_t * t, uchar const * ix, ulong sz, ushort table_idx ) {
  if( sz < 10UL ) tsdk_revert( BC_ERR_SHORT );
  bc_require_host( t );
  uchar round = ix[6], seat = ix[7], mode = ix[8], n = ix[9];
  if( sz != 10UL + BC_REVEAL_ITEM_SZ * n ) tsdk_revert( BC_ERR_SHORT );
  if( round >= BC_MAX_ROUNDS || seat >= t->num_seats || mode > 1U ) tsdk_revert( BC_ERR_ARGS );
  if( mode == 0U ) {
    if( t->status != BC_STATUS_PLAYING ) tsdk_revert( BC_ERR_STATUS );
    if( round != t->round ) tsdk_revert( BC_ERR_ROUND );
    if( seat != t->pending_accused ) tsdk_revert( BC_ERR_PENDING );
    if( n != t->window ) tsdk_revert( BC_ERR_WINDOW ); /* can't skip windows */
  } else {
    if( t->status != BC_STATUS_FINISHED ) tsdk_revert( BC_ERR_STATUS );
    if( t->round == BC_NONE || round > t->round ) tsdk_revert( BC_ERR_ROUND );
    if( n != t->window_count[round] ) tsdk_revert( BC_ERR_WINDOW );
  }

  uchar const * table_addr = bc_addrs()[table_idx].key;
  uchar h[32] __attribute__((aligned(8)));
  uchar guilty = 0;
  for( uchar i = 0; i < n; i++ ) {
    uchar const * item  = ix + 10UL + BC_REVEAL_ITEM_SZ * i;
    uchar         cheat = item[0];
    uchar         shell = item[1];
    bc_envelope_hash( table_addr, round, i, seat, cheat, shell, item + 2, h );
    if( memcmp( h, t->env[round][i][seat], 32UL ) != 0 ) tsdk_revert( BC_ERR_HASH );
    if( cheat != 0U ) guilty = 1;
    if( mode == 1U ) bc_emit( t, BC_EVT_ENVELOPE_OPENED, round, i, seat, BC_NONE, cheat, shell );
  }

  if( mode == 0U ) {
    /* Guilty: the accuser takes ALL of the cheater's chips. Wrong call: the accuser pays one. */
    uchar  accuser = t->pending_accuser;
    uchar  from    = guilty ? seat : accuser;
    uchar  to      = guilty ? accuser : seat;
    ushort moved   = guilty ? t->chips[seat] : (ushort)( t->chips[accuser] > 0 ? 1 : 0 );
    t->chips[from] = (ushort)( t->chips[from] - moved );
    t->chips[to]   = (ushort)( t->chips[to] + moved );
    if( guilty ) t->busted[seat] = 1;
    bc_clear_pending( t );
    bc_emit( t, BC_EVT_VERDICT, round, t->window, accuser, seat, guilty, bc_u8( moved ) );
    /* A shooter who went broke in a verdict passes the gun on. */
    if( t->chips[t->current_seat] == 0 ) t->current_seat = bc_next_seat( t, t->current_seat );
  }
}

static void
bc_reveal_shells( bc_table_t * t, uchar const * ix, ulong sz, ushort table_idx ) {
  if( sz < 8UL ) tsdk_revert( BC_ERR_SHORT );
  bc_require_host( t );
  uchar round = ix[6], n = ix[7];
  if( sz != 8UL + n + 32UL ) tsdk_revert( BC_ERR_SHORT );
  if( t->status != BC_STATUS_FINISHED ) tsdk_revert( BC_ERR_STATUS );
  if( round >= BC_MAX_ROUNDS || t->round == BC_NONE || round > t->round ) tsdk_revert( BC_ERR_ROUND );
  if( n != t->shell_count[round] ) tsdk_revert( BC_ERR_ARGS );
  uchar const * shells = ix + 8;
  uchar live = 0;
  for( uchar i = 0; i < n; i++ ) {
    if( shells[i] > 1U ) tsdk_revert( BC_ERR_ARGS );
    live = (uchar)( live + shells[i] );
  }
  /* The dealer's announcement must have been honest too. */
  if( live != t->live_count[round] ) tsdk_revert( BC_ERR_HASH );
  uchar h[32] __attribute__((aligned(8)));
  bc_shells_hash( bc_addrs()[table_idx].key, round, n, shells, shells + n, h );
  if( memcmp( h, t->shells_commit[round], 32UL ) != 0 ) tsdk_revert( BC_ERR_HASH );
  bc_emit( t, BC_EVT_SHELLS_REVEALED, round, 0, BC_NONE, BC_NONE, n, live );
}

/* A broke seat paid $12 (the token transfer's signature rides along in `payment`) for more chips. */
static void
bc_buy_in( bc_table_t * t, uchar const * ix, ulong sz ) {
  if( sz != BC_HDR_SZ + 2UL + 64UL ) tsdk_revert( BC_ERR_SHORT );
  bc_require_host( t );
  uchar round = ix[6], seat = ix[7];
  if( t->status != BC_STATUS_PLAYING ) tsdk_revert( BC_ERR_STATUS );
  if( t->round == BC_NONE || round != t->round ) tsdk_revert( BC_ERR_ROUND );
  if( seat >= t->num_seats ) tsdk_revert( BC_ERR_ARGS );
  if( t->chips[seat] != 0 ) tsdk_revert( BC_ERR_CHIPS );
  if( t->trigger_pulled || t->pending_accused != BC_NONE ) tsdk_revert( BC_ERR_PENDING );
  t->chips[seat]   = t->buy_in_chips;
  t->buy_ins[seat] = bc_u8( (ulong)t->buy_ins[seat] + 1UL );
  bc_emit( t, BC_EVT_BUY_IN, round, 0, seat, BC_NONE, t->buy_in_chips, t->buy_ins[seat] );
}

/* The pot goes to the chip leader(s); an uneven split leaves the remainder in the pot.
   After the last round the game is over. Must match endRound() in apps/server/src/engine/step.ts. */
static void
bc_end_round( bc_table_t * t, uchar const * ix, ulong sz ) {
  if( sz != BC_HDR_SZ + 1UL ) tsdk_revert( BC_ERR_SHORT );
  bc_require_host( t );
  uchar round = ix[6];
  if( t->status != BC_STATUS_PLAYING ) tsdk_revert( BC_ERR_STATUS );
  if( t->round == BC_NONE || round != t->round || t->round_ended ) tsdk_revert( BC_ERR_ROUND );
  if( t->trigger_pulled || t->pending_accused != BC_NONE ) tsdk_revert( BC_ERR_PENDING );
  if( t->shot < t->shell_count[round] && bc_funded( t ) >= 2U ) tsdk_revert( BC_ERR_SHOT );

  ushort max = 0;
  for( uchar i = 0; i < t->num_seats; i++ ) if( t->chips[i] > max ) max = t->chips[i];
  uchar mask  = 0;
  uint  count = 0U;
  if( max > 0 ) {
    for( uchar i = 0; i < t->num_seats; i++ ) {
      if( t->chips[i] == max ) {
        mask = (uchar)( mask | ( 1U << i ) );
        count++;
      }
    }
  }
  ushort each = count ? (ushort)( t->pot / count ) : 0;
  for( uchar i = 0; i < t->num_seats; i++ ) if( mask & ( 1U << i ) ) t->chips[i] = (ushort)( t->chips[i] + each );
  t->pot         = (ushort)( t->pot - each * count );
  t->round_ended = 1;
  bc_emit( t, BC_EVT_POT_AWARDED, round, 0, mask, BC_NONE, bc_u8( each ), bc_u8( t->pot ) );
  if( (uint)round + 1U >= t->rounds_total ) bc_finish( t, 0 );
}

/* The VM passes instruction bytes in a0/a1, both for top-level calls and for CPI
   (e.g. passkey-manager `validate` invoking us), so read them from the arguments. */
TSDK_ENTRYPOINT_FN void
start( void const * instr, ulong sz ) {
  uchar const * ix = (uchar const *)instr;
  if( sz < BC_HDR_SZ ) tsdk_revert( BC_ERR_SHORT );
  uint   kind      = TSDK_LOAD( uint, ix );
  ushort table_idx = TSDK_LOAD( ushort, ix + 4 );
  if( !tsdk_is_account_idx_valid( table_idx ) ) tsdk_revert( BC_ERR_ACCT );

  if( kind == BC_IX_CREATE_TABLE ) {
    bc_create_table( ix, sz, table_idx );
    tsdk_return( TSDK_SUCCESS );
  }

  bc_table_t * t = bc_load_table( table_idx );
  switch( kind ) {
    case BC_IX_COMMIT_ROUND:  bc_commit_round( t, ix, sz );             break;
    case BC_IX_PULL_TRIGGER:  bc_pull_trigger( t, ix, sz );             break;
    case BC_IX_RESOLVE_SHOT:  bc_resolve_shot( t, ix, sz );             break;
    case BC_IX_SEAL:          bc_seal( t, ix, sz );                     break;
    case BC_IX_ACCUSE:        bc_accuse( t, ix, sz );                   break;
    case BC_IX_REVEAL:        bc_reveal( t, ix, sz, table_idx );        break;
    case BC_IX_REVEAL_SHELLS: bc_reveal_shells( t, ix, sz, table_idx ); break;
    case BC_IX_BUY_IN:        bc_buy_in( t, ix, sz );                   break;
    case BC_IX_END_ROUND:     bc_end_round( t, ix, sz );                break;
    default:                  tsdk_revert( BC_ERR_BAD_IX );
  }
  tsdk_return( TSDK_SUCCESS );
}
