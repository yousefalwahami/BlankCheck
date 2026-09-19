/*
 * Phase 2 smoke test: play a short all-bot game against the DEPLOYED referee on Thru, print every
 * transaction with its measured latency, then read the Table account back from the RPC node and check
 * it against the game: chips, buy-ins, pot, winner, every sealed envelope and every shell commitment.
 *
 *   REFEREE_MODE=thru THRU_HOST_SECRET=… REFEREE_PROGRAM_ADDRESS=… pnpm --filter @blankcheck/server chain:smoke
 *   (or put those in apps/server/.env)
 */
import { parseTable, TABLE_STATUS, toHex } from "@blankcheck/shared";
import { createThruClient } from "@thru/sdk";
import { config } from "../config";
import { initReferee } from "../referee";
import { playHeadless } from "../sim";

if (config.refereeMode !== "thru") {
  console.error("Set REFEREE_MODE=thru (plus THRU_HOST_SECRET and REFEREE_PROGRAM_ADDRESS) to run the chain smoke test.");
  process.exit(2);
}

const makeReferee = await initReferee();
const referee = makeReferee();
if (referee.mode !== "thru") {
  console.error("The chain isn't usable (see the warning above). Nothing was sent.");
  process.exit(2);
}

const seats = Number(process.env.SMOKE_SEATS ?? 3);
const rounds = Number(process.env.SMOKE_ROUNDS ?? 2);
const gameId = BigInt(Date.now());
console.log(`⛓ playing a ${seats}-bot, ${rounds}-round game on ${config.thruRpcUrl} (game ${gameId})\n`);

const byKind = new Map<string, number[]>();
let failed = 0;
const result = await playHeadless(referee, {
  seed: `smoke-${gameId}`,
  seats,
  rounds,
  gameId,
  onReceipt: (r) => {
    if (!r.ok) failed++;
    if (r.ok) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r.ms]);
    console.log(`${r.ok ? "✓" : "✖"} ${r.kind.padEnd(14)} ${String(r.ms).padStart(5)} ms  ${r.explorerUrl ?? ""}${r.error ? `  ${r.error}` : ""}`);
  },
});

console.log("\nlatency (submit → executed):");
for (const [kind, ms] of byKind) {
  const sorted = [...ms].sort((a, b) => a - b);
  console.log(`  ${kind.padEnd(14)} n=${String(ms.length).padStart(3)}  min ${sorted[0]}  median ${sorted[Math.floor(sorted.length / 2)]}  max ${sorted[sorted.length - 1]} ms`);
}

const thru = createThruClient({ baseUrl: config.thruRpcUrl });
const acct = await thru.accounts.get(result.tableAddress);
const table = acct.data?.data ? parseTable(acct.data.data) : null;
let mismatches = 0;
if (!table) {
  console.log("\n✖ couldn't read the Table account back");
  mismatches++;
} else {
  const s = result.state;
  const check = (ok: boolean, what: string) => {
    if (!ok) {
      mismatches++;
      console.log(`  ✖ ${what}`);
    }
  };
  check(table.status === TABLE_STATUS.FINISHED, "status is FINISHED");
  check(table.winner === s.winner, `winner ${table.winner} vs engine ${s.winner}`);
  check(JSON.stringify(table.chips.slice(0, seats)) === JSON.stringify(s.seats.map((x) => x.chips)), "chips match");
  check(JSON.stringify(table.buyIns.slice(0, seats)) === JSON.stringify(s.seats.map((x) => x.buyIns)), "buy-ins match");
  check(table.pot === s.pot, `pot ${table.pot} vs engine ${s.pot}`);
  let hashes = 0;
  for (const r of s.tape) {
    check(toHex(table.shellsCommit(r.round)) === r.commit, `round ${r.round + 1} shell commitment`);
    for (const e of r.envelopes) {
      hashes++;
      check(toHex(table.env(r.round, e.window, e.seat)) === e.hash, `envelope r${r.round} w${e.window} s${e.seat}`);
    }
  }
  console.log(`\nTable ${result.tableAddress}: ${s.tape.length} rounds, ${hashes} envelopes read back from the chain`);
}

console.log(`\n${config.explorerUrl}/address/${result.tableAddress}`);
if (failed || mismatches) {
  console.log(`\n❌ ${failed} failed transaction(s), ${mismatches} mismatch(es)`);
  process.exit(1);
}
console.log("\n✅ the deployed referee accepted every instruction and the chain agrees with the game");
