import { toHex, type TapeData, type TapeMoney } from "@blankcheck/shared";
import type { GameState } from "./engine/types";
import type { Receipt } from "./referee/Referee";

/** Assemble Review the Tape from the engine's history plus the chain receipts, keyed by effect tag. */
export function buildTape(
  s: GameState,
  receipts: Map<string, Receipt>,
  x: {
    refereeMode: TapeData["refereeMode"];
    tableAddress: string | null;
    explorerUrl: string;
    onChainActions: number;
    failedTxs: number;
    money: TapeMoney;
  },
): TapeData {
  const sig = (tag: string) => receipts.get(tag)?.signature;
  const rounds = s.tape.map((r) => {
    const windowTx = new Map<number, string | undefined>();
    for (const shot of r.shots) windowTx.set(shot.window, sig(`resolve:${r.round}:${shot.shellIndex}`));
    for (const [tag, rc] of receipts) {
      const m = /^seal:(\d+):(\d+)$/.exec(tag);
      if (m && Number(m[1]) === r.round) windowTx.set(Number(m[2]), rc.signature);
    }
    // Buy-back chain txs are tagged buyin:<round>:<seat>:<nth buy-in>; hand them out in order.
    const buyInTxs = new Map<number, (string | undefined)[]>();
    for (const [tag, rc] of receipts) {
      const m = /^buyin:(\d+):(\d+):(\d+)$/.exec(tag);
      if (m && Number(m[1]) === r.round) buyInTxs.set(Number(m[2]), [...(buyInTxs.get(Number(m[2])) ?? []), rc.signature]);
    }
    return {
      ...r,
      commitTx: sig(`commit:${r.round}`),
      revealShellsTx: sig(`shells:${r.round}`),
      shellsOk: receipts.get(`shells:${r.round}`)?.ok,
      shots: r.shots.map((shot) => ({
        ...shot,
        triggerTx: sig(`trigger:${r.round}:${shot.shellIndex}`),
        resolveTx: sig(`resolve:${r.round}:${shot.shellIndex}`),
      })),
      envelopes: r.envelopes.map((e) => ({
        ...e,
        sealTx: windowTx.get(e.window),
        revealTx: sig(`tape:${r.round}:${e.seat}`),
        revealOk: receipts.get(`tape:${r.round}:${e.seat}`)?.ok,
      })),
      accusations: r.accusations.map((a) => ({ ...a, tx: sig(`accuse:${r.round}:${a.accuser}`) })),
      buyIns: r.buyIns.map((b) => ({ ...b, tx: buyInTxs.get(b.seat)?.shift() })),
      pot: r.pot ? { ...r.pot, tx: sig(`endround:${r.round}`) } : null,
    };
  });
  return {
    room: s.room,
    refereeMode: x.refereeMode,
    tableKey: toHex(s.tableKey),
    tableAddress: x.tableAddress,
    explorerUrl: x.explorerUrl,
    seats: s.seats.map((seat) => ({ seat: seat.seat, name: seat.name, kind: seat.kind, personality: seat.personality })),
    winner: s.winner ?? 0,
    rounds,
    money: x.money,
    onChainActions: x.onChainActions,
    failedTxs: x.failedTxs,
  };
}
