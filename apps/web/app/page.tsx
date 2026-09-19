import Link from "next/link";

export default function Home() {
  return (
    <main className="room-bg crt flex min-h-dvh flex-col items-center justify-center gap-10 px-4 text-center">
      <div className="grain" />
      <div>
        <p className="font-crt text-xl tracking-[0.3em] text-ash">A PARTY GAME ABOUT CHEATING</p>
        <h1 className="animate-flicker font-display text-7xl leading-none tracking-wide text-bone sm:text-9xl">
          BLANK <span className="text-blood">CHECK</span>
        </h1>
        <p className="mt-4 font-type text-lg text-bone/80">Everyone cheats. The chain remembers.</p>
      </div>
      <div className="flex w-full max-w-md flex-col gap-4 sm:flex-row">
        <Link
          href="/host"
          className="flex-1 rounded-xl border-2 border-bone/20 bg-soot px-6 py-5 font-display text-2xl tracking-wider hover:border-brass hover:text-brass"
        >
          📺 HOST ON THE TV
        </Link>
        <Link
          href="/join"
          className="flex-1 rounded-xl border-2 border-blood bg-blood/15 px-6 py-5 font-display text-2xl tracking-wider text-bone hover:bg-blood/30"
        >
          📱 JOIN ON A PHONE
        </Link>
      </div>
      <p className="max-w-lg font-crt text-lg leading-snug text-ash">
        Buy in for $12, play for chips, cash out the rest. Face ID pulls the trigger and pays the buy-in; every shot, sealed envelope, accusation and payout is a transaction on Thru, refereed by a program written in C.
      </p>
    </main>
  );
}
