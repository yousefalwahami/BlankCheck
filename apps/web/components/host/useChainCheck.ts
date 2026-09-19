"use client";

import { parseTable, toHex, type TapeData } from "@blankcheck/shared";
import { useEffect, useState } from "react";

export type ChainCheck = { ok: boolean; label: string };

/**
 * Independent check for Review the Tape: read the Table account straight from a Thru RPC node
 * (not from our game server) and compare every sealed envelope hash, shell commitment, and final chip count.
 */
export function useChainCheck(tape: TapeData): ChainCheck | null {
  const [check, setCheck] = useState<ChainCheck | null>(null);
  useEffect(() => {
    if (tape.refereeMode !== "thru" || !tape.tableAddress) return;
    let cancelled = false;
    setCheck({ ok: true, label: "⛓ reading the table from Thru…" });
    (async () => {
      try {
        const { createThruClient, AccountView } = await import("@thru/sdk");
        const thru = createThruClient({ baseUrl: process.env.NEXT_PUBLIC_THRU_RPC_URL ?? "https://rpc.alphanet.thru.org" });
        const acct = await thru.accounts.get(tape.tableAddress!, { view: AccountView.FULL });
        const data = (acct as unknown as { data?: { data?: Uint8Array } }).data?.data;
        const t = data ? parseTable(data) : null;
        if (!t) throw new Error("table account not found");
        let good = 0;
        let total = 0;
        for (const r of tape.rounds) {
          total++;
          if (toHex(t.shellsCommit(r.round)) === r.commit) good++;
          for (const e of r.envelopes) {
            total++;
            if (toHex(t.env(r.round, e.window, e.seat)) === e.hash) good++;
          }
        }
        // The final chip counts (what everyone cashed out) are on the Table account too.
        for (const x of tape.money.results) {
          total++;
          if (t.chips[x.seat] === x.chips && t.buyIns[x.seat] === x.buyIns) good++;
        }
        if (!cancelled) setCheck({ ok: good === total, label: `⛓ ${good}/${total} hashes and chip counts match the Table account on Thru` });
      } catch (e) {
        if (!cancelled) setCheck({ ok: false, label: `⛓ couldn't read the chain: ${(e as Error).message}` });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tape]);
  return check;
}
