"use client";

import type { ChainTx, PublicState } from "@blankcheck/shared";
import { AnimatePresence, motion } from "motion/react";

const SIGNER: Record<NonNullable<ChainTx["signer"]>, string> = {
  passkey: "🔐 passkey",
  house: "🤖 house key",
  host: "🎩 host",
};

/** Moves a player authorizes (trigger, accusation, a $12 buy-in), so the ticker says who signed. */
const SIGNED_KINDS = new Set(["PULL_TRIGGER", "ACCUSE", "BUY_IN_$"]);

export function Ticker({ txs, state }: { txs: ChainTx[]; state: PublicState }) {
  const recent = txs.slice(-5).reverse();
  const name = (seat?: number) => (seat === undefined ? "" : (state.seats[seat]?.name ?? `seat ${seat + 1}`));
  return (
    <div className="flex h-[7vh] min-h-12 items-center gap-4 overflow-hidden border-t border-crt/20 bg-black/70 px-4 font-crt text-[2.1vh] text-crt">
      <div className="shrink-0 tracking-widest text-crt/70">
        ⛓ {state.refereeMode === "thru" ? "THRU ALPHANET" : "MOCK CHAIN"} · {state.onChainActions} ACTIONS
        {state.bankMode !== state.refereeMode ? ` · ${state.bankMode === "thru" ? "THRU" : "MOCK"} BANK` : ""}
      </div>
      <div className="flex min-w-0 flex-1 gap-6">
        <AnimatePresence initial={false} mode="popLayout">
          {recent.map((t, i) => (
            <motion.a
              key={t.id}
              layout
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: i === 0 ? 1 : 0.55 - i * 0.08, y: 0 }}
              exit={{ opacity: 0 }}
              href={t.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className={`shrink-0 whitespace-nowrap ${t.ok ? "" : "text-blood"} ${t.explorerUrl ? "hover:underline" : "pointer-events-none"}`}
            >
              {t.ok ? "⛓" : "✖"} {t.kind}
              {t.seat !== undefined ? ` · ${name(t.seat)}` : ""} · {t.ms} ms
              {t.signer && SIGNED_KINDS.has(t.kind) ? ` · ${SIGNER[t.signer]}` : ""}
              {!t.ok && t.error ? ` · ${t.error}` : ""}
            </motion.a>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
