/*
 * Records instruction traces for the C host test (programs/referee/test):
 *   - a full random game (deterministic salts) played through the TypeScript mirror
 *   - a few deliberate failures (wrong turn, forged reveal, bad Face ID, not the host…)
 *   - the hash test vectors
 * The C test replays every instruction through blank_check.c and requires identical results,
 * identical events, and a byte-identical final Table account.
 *
 * Run: pnpm --filter @blankcheck/server trace
 */
import { sha256, toHex, fromHex } from "@blankcheck/shared";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encPullTrigger } from "../referee/encode";
import { MockReferee, type TraceEntry } from "../referee/MockReferee";
import { execute, Revert } from "../referee/program";
import { simulateGame } from "../sim";

const out = (p: string) => fileURLToPath(new URL(`../../../../programs/referee/test/${p}`, import.meta.url));
const line = (e: TraceEntry) =>
  ["T", e.label, e.ok ? 1 : 0, e.err.toString(16), e.ix, e.accounts.join(","), e.authorized.length ? e.authorized.join(",") : "-", e.events.length ? e.events.join(",") : "-"].join(" ");

const lines: string[] = [];
const finals: string[] = [];

// 1. Full games, each on its own table.
for (const [seed, seats, rounds, rebuy] of [
  ["trace-a", 4, 3, 0.8],
  ["trace-b", 6, 4, 1],
  ["trace-c", 2, 3, 0.3],
] as const) {
  const game = await simulateGame({ seed, seats, rounds, rebuy, trace: true, deterministicSalts: true });
  const failed = game.referee.trace!.filter((e) => !e.ok);
  if (failed.length) throw new Error(`${seed}: ${failed.length} failed instructions in a valid game`);
  const buyIns = game.state.seats.reduce((n, x) => n + x.buyIns, 0);
  lines.push(`# game ${seed}: ${seats} seats, ${game.state.tape.length}/${rounds} rounds, ${buyIns} buy-ins, winner seat ${game.state.winner}`);
  lines.push(...game.referee.trace!.map(line));
  finals.push(`F ${toHex(game.tableKey)} ${toHex(sha256(game.referee.tableData()!))}`);
}

// 2. Things the referee must refuse.
{
  const ref = new MockReferee();
  ref.trace = [];
  const { wallet } = await ref.bindWallet("cred", "11".repeat(64));
  const host = ref.hostAddress();
  const { key } = await ref.prepareTable(424242n);
  await ref.createTable({ gameId: 424242n, wallets: [wallet, host, host], buyInChips: 3, rounds: 2 });
  await ref.createTable({ gameId: 424242n, wallets: [wallet, host, host], buyInChips: 3, rounds: 2 }); // CREATE: already exists
  await ref.run({ kind: "commitRound", round: 1, shellCount: 2, liveCount: 1, firstSeat: 0, commit: new Uint8Array(32) }); // ROUND
  await ref.run({ kind: "commitRound", round: 0, shellCount: 2, liveCount: 2, firstSeat: 0, commit: new Uint8Array(32) }); // ARGS
  await ref.run({ kind: "commitRound", round: 0, shellCount: 2, liveCount: 1, firstSeat: 1, commit: new Uint8Array(32).fill(5) });
  await ref.run({ kind: "pullTrigger", round: 0, shot: 0, shooter: 0, target: 1, auth: { type: "host" } }); // TURN
  await ref.run({ kind: "pullTrigger", round: 0, shot: 0, shooter: 1, target: 0, auth: { type: "host" } });
  const env = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), new Uint8Array(32).fill(3)];
  await ref.run({ kind: "resolveShot", round: 0, shot: 0, isLive: false, window: 0, envelopes: env }); // blank at seat 0 → seat 2 is up
  await ref.run({ kind: "seal", round: 0, window: 5, envelopes: env }); // WINDOW
  await ref.run({ kind: "accuse", round: 0, accuser: 2, accused: 2, auth: { type: "host" } }); // ARGS
  await ref.run({ kind: "accuse", round: 0, accuser: 0, accused: 1, auth: { type: "host" } }); // passkey seat, no Face ID: NOT_SEAT
  await ref.run({ kind: "accuse", round: 0, accuser: 2, accused: 1, auth: { type: "host" } });
  await ref.run({ kind: "accuse", round: 0, accuser: 1, accused: 2, auth: { type: "host" } }); // PENDING
  await ref.run({ kind: "reveal", round: 0, seat: 1, mode: 0, entries: [{ cheat: 0, shell: 255, salt: new Uint8Array(32) }] }); // HASH
  await ref.run({ kind: "revealShells", round: 0, shells: [0, 1], salt: new Uint8Array(32) }); // STATUS (game not over)
  await ref.run({ kind: "buyIn", round: 0, seat: 2 }); // CHIPS: seat 2 still has chips
  await ref.run({ kind: "endRound", round: 0 }); // PENDING: the accusation is still open
  await ref.run({ kind: "commitRound", round: 1, shellCount: 3, liveCount: 1, firstSeat: 0, commit: new Uint8Array(32) }); // ROUND: round 0 never ended
  lines.push("# refusals");
  lines.push(...ref.trace.map(line));

  // Hand-built: not the host, bad instruction, account index out of range.
  const store = new Map([[toHex(key), ref.tableData()!.slice()]]);
  const stranger = sha256(new TextEncoder().encode("stranger"));
  const program = fromHex(ref.trace[0].accounts[1]);
  const manual = (label: string, ix: Uint8Array, accounts: Uint8Array[]) => {
    let ok = true;
    let err = 0;
    let events: Uint8Array[] = [];
    try {
      events = execute(ix, { accounts, authorized: new Set(), store });
    } catch (e) {
      if (!(e instanceof Revert)) throw e;
      ok = false;
      err = e.code;
    }
    if (ok) throw new Error(`${label} should have failed`);
    lines.push(line({ label, ix: toHex(ix), accounts: accounts.map(toHex), authorized: [], ok, err, events: events.map(toHex) }));
  };
  manual("NOT_HOST", fromHex("030000000200" + "00" + "01" + "00" + "01" + "03" + "00".repeat(96)), [stranger, program, key]);
  manual("BAD_IX", fromHex("090000000200"), [fromHex(host), program, key]);
  manual("ACCT", encPullTrigger({ tableIdx: 7, walletIdx: 0, round: 0, shot: 1, shooter: 2, target: 0 }), [fromHex(host), program, key]);
  finals.push(`F ${toHex(key)} ${toHex(sha256(ref.tableData()!))}`);
}

writeFileSync(out("trace.txt"), [...lines, ...finals].join("\n") + "\n");

// 3. Hash vectors, flattened for C.
const v = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../packages/shared/test/vectors.json", import.meta.url)), "utf8"));
const vec = [
  ...v.envelopes.map((e: any) => ["E", e.table, e.round, e.window, e.seat, e.cheat, e.shell, e.salt, e.hash].join(" ")),
  ...v.shells.map((s: any) => ["S", s.table, s.round, s.shells.length, s.shells.map((x: number) => x.toString(16).padStart(2, "0")).join(""), s.salt, s.hash].join(" ")),
];
writeFileSync(out("vectors.txt"), vec.join("\n") + "\n");
console.log(`wrote ${lines.filter((l) => l.startsWith("T")).length} instructions, ${finals.length} final tables, ${vec.length} vectors`);
