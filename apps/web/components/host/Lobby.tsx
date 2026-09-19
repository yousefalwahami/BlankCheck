"use client";

import { BOTS, BOT_IDS, MAX_SEATS, type BotId, type PublicState } from "@blankcheck/shared";
import { AnimatePresence, motion } from "motion/react";
import { QRCodeSVG } from "qrcode.react";
import { Avatar } from "../ui/bits";

export function Lobby(props: {
  state: PublicState;
  joinUrl: string;
  error: string | null;
  busy: boolean;
  onAddBot: (p: BotId) => void;
  onKick: (seat: number) => void;
  onConfig: (c: { hearts?: number; faceIdOnTrigger?: boolean }) => void;
  onStart: () => void;
}) {
  const { state } = props;
  const full = state.seats.length >= MAX_SEATS;
  const humans = state.seats.filter((s) => s.kind === "human");
  return (
    <div className="grid h-full grid-cols-1 gap-[3vw] p-[3vw] lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <section className="flex flex-col items-center justify-center gap-[2vh] text-center">
        <h1 className="animate-flicker font-display text-[9vh] leading-none">
          BLANK <span className="text-blood">CHECK</span>
        </h1>
        <p className="font-type text-[2.4vh] text-bone/70">Everyone cheats. The chain remembers.</p>
        <div className="rounded-2xl bg-bone p-[1.6vh] shadow-[0_0_60px_rgb(239_230_210/0.15)]">
          <QRCodeSVG value={props.joinUrl} size={320} bgColor="#efe6d2" fgColor="#0a0807" level="M" className="h-[34vh] w-[34vh]" />
        </div>
        <div>
          <p className="font-crt text-[2.4vh] tracking-[0.3em] text-ash">ROOM CODE</p>
          <p className="font-display text-[11vh] leading-none tracking-[0.2em] text-brass">{state.room}</p>
        </div>
        <p className="max-w-[40vw] break-all font-crt text-[2vh] text-ash">{props.joinUrl.replace(/^https?:\/\//, "")}</p>
      </section>

      <section className="flex min-h-0 flex-col gap-[2vh]">
        <h2 className="font-display text-[4.5vh] tracking-wide">
          THE TABLE <span className="text-ash">{state.seats.length}/{MAX_SEATS}</span>
        </h2>
        <ul className="grid grid-cols-2 gap-[1.2vh]">
          <AnimatePresence>
            {Array.from({ length: MAX_SEATS }, (_, i) => {
              const s = state.seats[i];
              return s ? (
                <motion.li
                  key={`${s.name}-${i}`}
                  layout
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  className="group flex items-center gap-3 rounded-xl border border-bone/10 bg-soot/80 p-[1.2vh]"
                >
                  <Avatar seat={{ ...s, hearts: 1 }} size={52} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-display text-[2.8vh] tracking-wide">{s.name}</p>
                    <p className="font-crt text-[1.9vh] text-ash">
                      {s.kind === "bot" ? `🤖 ${BOTS[s.personality!].tagline}` : s.walletReady ? "🔐 wallet ready" : s.connected ? "📱 no Face ID yet" : "📵 disconnected"}
                    </p>
                  </div>
                  <button
                    onClick={() => props.onKick(i)}
                    className="rounded-md px-2 py-1 font-crt text-[2vh] text-ash opacity-0 hover:text-blood group-hover:opacity-100"
                    aria-label={`Remove ${s.name}`}
                  >
                    ✕
                  </button>
                </motion.li>
              ) : (
                <li key={`empty-${i}`} className="flex items-center justify-center rounded-xl border border-dashed border-bone/10 p-[1.2vh] font-crt text-[2.2vh] text-ash/60">
                  empty seat
                </li>
              );
            })}
          </AnimatePresence>
        </ul>

        <div>
          <p className="mb-[1vh] font-crt text-[2.2vh] tracking-widest text-ash">ADD A BOT (JEV BY TYPESAFE)</p>
          <div className="grid grid-cols-2 gap-[1vh] xl:grid-cols-4">
            {BOT_IDS.map((id) => (
              <button
                key={id}
                disabled={full}
                onClick={() => props.onAddBot(id)}
                className="rounded-xl border border-bone/15 bg-smoke px-3 py-[1.2vh] text-left hover:border-brass disabled:opacity-40"
              >
                <span className="text-[3vh]">{BOTS[id].emoji}</span>
                <span className="block font-display text-[2.2vh] tracking-wide">{BOTS[id].name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-[2vh] font-crt text-[2.3vh]">
          <span className="text-ash">HEARTS</span>
          {[3, 2].map((h) => (
            <button
              key={h}
              onClick={() => props.onConfig({ hearts: h })}
              className={`rounded-lg border px-3 py-1 ${state.config.hearts === h ? "border-blood bg-blood/20 text-bone" : "border-bone/15 text-ash"}`}
            >
              {"❤️".repeat(h)} {h === 2 ? "demo" : ""}
            </button>
          ))}
          <label className="ml-auto flex cursor-pointer items-center gap-2 text-ash">
            <input
              type="checkbox"
              className="h-5 w-5 accent-blood"
              checked={state.config.faceIdOnTrigger}
              onChange={(e) => props.onConfig({ faceIdOnTrigger: e.target.checked })}
            />
            Face ID on trigger
          </label>
        </div>

        <div className="mt-auto flex items-end gap-4">
          <div className="flex-1 font-crt text-[2.1vh] leading-tight text-ash">
            {humans.length === 0 ? "Scan the code to sit down. Add bots to fill seats." : `${humans.length} human${humans.length > 1 ? "s" : ""} at the table.`}
            <br />
            Referee: {state.refereeMode === "thru" ? "⛓ Thru alphanet (C program)" : "🧪 mock chain (same rules, in memory)"}
            {props.error && <span className="block text-blood">{props.error}</span>}
          </div>
          <button
            onClick={props.onStart}
            disabled={state.seats.length < 2 || props.busy}
            className="animate-pulse-red rounded-2xl bg-blood px-[4vh] py-[2vh] font-display text-[5vh] tracking-widest text-bone disabled:animate-none disabled:opacity-40"
          >
            {props.busy ? "DEALING…" : "START"}
          </button>
        </div>
      </section>
    </div>
  );
}
