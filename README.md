# BLANK CHECK

> **Everyone cheats. The chain remembers.**

A Jackbox-style party game inspired by Buckshot Roulette. The laptop plays on the TV, every phone is a
controller, and **Face ID pulls the trigger**. Each round everyone gets a secret cheat card. Cheating is
allowed; getting caught costs you. A **referee program written in C on Thru** keeps sealed evidence of
every cheat, and at the end **Review the Tape** replays the game and exposes everything nobody caught.

Full design: [docs/BLANK_CHECK_SPEC.md](docs/BLANK_CHECK_SPEC.md).

## How it fits together

```
📱 phones (/join, /play/ROOM) ─┐                      ┌─ Thru alphanet: referee program (C) + passkey-manager
                               ├─ Socket.IO ─ game server ─┤
📺 TV (/host) ─────────────────┘   (engine, secrets)   └─ Jev (bots + Pit Boss)
```

| Piece | Where | What it does |
|---|---|---|
| `apps/web` | Next.js → Vercel | TV screen, join flow, phone controller. No secrets. |
| `apps/server` | Node + Socket.IO → laptop / Railway / Render | Rules engine, rooms, shell orders, cheat cards, salts, bots, chain client |
| `packages/shared` | both | Types, zod schemas, commit-reveal hashing, tape verification, Table layout |
| `programs/referee` | Thru VM | The C referee: commitments, sealed envelopes, accusations, verdicts, hearts |

The engine is a pure reducer (`step(state, action) → { state, effects }`). Effects are chain calls,
timers, animations and private messages. The **referee is behind an interface**:

- `MockReferee` encodes the real instruction bytes and runs them through `program.ts`, a line-by-line
  TypeScript mirror of `blank_check.c`, so a game with no blockchain still obeys the chain's rules.
- `ThruReferee` sends the same bytes to the deployed C program on Thru.

## Quick start (no blockchain needed)

```bash
pnpm install
pnpm dev            # game server on :4000, web on :3000
```

Open `http://localhost:3000/host` on the laptop (that's the TV), then open `/join` in other browser
profiles or incognito windows (each tab is its own player). Add bots to fill seats and press **START**.

To play on **real phones**, they need to reach both the web app and the game server, and Face ID needs
**HTTPS on a real domain**:

```bash
cloudflared tunnel --url http://localhost:4000     # → https://<random>.trycloudflare.com
```

Then open the TV at `https://<your-vercel-app>/host?server=https://<random>.trycloudflare.com`. The QR
code carries the server URL to every phone, so switching servers never needs a redeploy. Over plain HTTP
on a LAN everything works except Face ID (phones get a tap-to-fire button).

Tips: `?hearts=2` on `/host` starts in demo mode. `DEMO_SEED=anything` on the server deals Uncle Gary a HOT LOAD
in round 1. In Chrome DevTools → More tools → WebAuthn → "Enable virtual authenticator" fakes Face ID on a desktop.

## Tests

```bash
pnpm test              # shared + server: 53 tests (engine rules, referee mirror, full games over sockets)
pnpm test:referee      # the C program (Linux/macOS, or WSL on Windows): needs gcc + curl
pnpm typecheck
```

What the tests prove:

- **Rules:** turn order (a blank on yourself means you go again), every cheat card, count mismatches, RIGGED!
  (guilty, innocent, busted, one per round, during Last Call), eliminations, and the view boundary: public
  state and the Pit Boss never contain secrets.
- **Chain rules:** 10 random full games (2–6 seats) run through the referee mirror. Every transaction is
  accepted, the chain's hearts and winner match the engine, and every revealed envelope re-hashes to the
  stored value.
- **C = TypeScript, byte for byte:** `programs/referee/test` compiles `blank_check.c` with gcc against the
  real Thru SDK headers and SHA-256 source (pinned commit). It checks the hash vectors (generated with
  `node:crypto`), then replays 156 recorded instructions: 3 full games plus deliberate refusals (wrong
  turn, forged reveal, missing Face ID, not the host…). Results, revert codes, emitted events and the final
  Table account bytes must all match. Regenerate the recording with `pnpm trace`.
- **End to end:** a TV, a phone and three bots play whole games over real sockets to Review the Tape, and a
  player who drops out doesn't freeze the table.

## Putting the referee on Thru

On Windows, do this in WSL2. The C toolchain is Linux/macOS only.

```bash
npm i -g thru
thru dev toolchain install && thru dev sdk install c
thru keys generate host && thru account create host     # fund with `thru faucet …` if needed
programs/referee/deploy.sh                              # make + thru program create
```

Then in `apps/server/.env` (see `.env.example`):

```bash
REFEREE_MODE=thru
THRU_HOST_SECRET=<host key: 32-byte Ed25519 seed, hex or base64>
REFEREE_PROGRAM_ADDRESS=<printed by deploy.sh>
```

At boot the server checks the key and RPC and **falls back to the mock** if the chain isn't reachable.
During a game, a failed transaction shows red on the ticker and play continues. Waits on the chain are capped
at 4 s (`CHAIN_WAIT_CAP_MS`), so a slow alphanet never stalls a shot.

### What happens on-chain

| Moment | Transaction | Signed by |
|---|---|---|
| START | `CREATE_TABLE` (a program-derived account, seed `"table" ‖ game_id`) | house key |
| Each round | `COMMIT_ROUND`: SHA-256 of the shell order and its salt | house key |
| Trigger | `PULL_TRIGGER` via passkey-manager `validate` (CPI into the referee) | **the player's Face ID** |
| After every shot | `RESOLVE_SHOT` + one sealed envelope per seat (decoys for honest players) | house key |
| RIGGED! | `SEAL` (flush), `ACCUSE` (Face ID), `REVEAL`: the program re-hashes and rules | Face ID + house |
| Game over | `REVEAL` (tape) for every seat and round, `REVEAL_SHELLS` for every round | house key |

Review the Tape re-hashes every revealed envelope and shell order **in the browser**. In `thru` mode it also
reads the Table account **straight from a Thru RPC node**, not from our server, and compares every sealed
hash. Each item links to `scan.thru.org`.

**Trust model (say it out loud if asked):** in this MVP the server is the dealer. It knows the shell order
and writes the envelopes. The chain stops it from *rewriting history*, not from lying at the moment of
sealing. Two things narrow that gap. The tape replays the committed order plus the revealed cheats and must
reproduce every reported shot. And `REVEAL_SHELLS` refuses a reveal whose live count doesn't match what was
announced. The stretch goal in spec §6.8 (phones seal their own envelopes with a session key) closes it.

## Deploying

- **Web → Vercel:** import the repo and set Root Directory to `apps/web`. Set `NEXT_PUBLIC_GAME_SERVER_URL`
  (optional thanks to `?server=`) and `NEXT_PUBLIC_THRU_RPC_URL`. Keep one stable domain, because passkeys
  are bound to it.
- **Game server → Railway / Render / Fly:** `apps/server/Dockerfile` (build context = repo root) or the
  `render.yaml` blueprint. Health check: `GET /health`. It needs always-on WebSockets, which is why it
  doesn't go on Vercel.
- **Jev:** set `TYPESAFE_API_KEY` (and optionally pin `JEV_MODEL`). Without it, bots and the Pit Boss use
  code-only heuristics behind the same interface.

## Status against the spec (§11)

| Phase | State |
|---|---|
| 0. De-risk | RPC reachable from here (chain id 161 ms, height 84 ms, creating proof 84 ms). **Still to do on real hardware:** deploy the program, time a real tx, and Face ID on an iPhone |
| 1. Offline game | ✅ Full rules, rooms, QR join, TV, phone controller, cheats, RIGGED!, Last Call, elimination, win |
| 2. Referee on-chain | ✅ C program + byte-for-byte host test; `ThruReferee` + tx queue + ticker. **Not yet deployed to alphanet** |
| 3. Face ID on-chain | ✅ Implemented with `@thru/passkey` (wallet creation, challenges prefetched on aim, validate→CPI). Needs an iPhone test against the deployed program |
| 4. Jev | ✅ Four personalities, typed taunts, Pit Boss meters; heuristic fallback |
| 5. Review the Tape | ✅ VHS replay, browser re-hash, direct chain read, CAUGHT / GOT AWAY stamps, awards |
| 6. Polish | ✅ Synthesized sound, CRT/VHS look, demo seed. Pitch rehearsal is yours |

## Implementation notes (things the docs taught us)

- **C entrypoint:** `start(void const *instr, ulong sz)`. The VM passes instruction bytes in `a0/a1` both
  at the top level and under CPI, which is how passkey-manager `validate` calls us. The program stack is
  4 KiB, so there are no large locals.
- **Table layout** (74,834 bytes) is defined once in `packages/shared/src/table.ts`, static-asserted in
  `blank_check.h`, and parsed by the browser for the tape. It adds `window_count[round]` so tape reveals of
  past rounds can require every window.
- **Every seal window seals every seat.** Eliminated seats get decoys too, which keeps `env[round][window][seat]` dense.
- **Round cap:** `COMMIT_ROUND` with 0 shells ends the game by hearts, for the unlikely 25th round.
- **SDK SHA-256** uses RISC-V Zknh instructions. The host test swaps only those four macros for C.
- **Sounds** are synthesized with Web Audio (no assets). The art is original; no Buckshot Roulette assets are used.
- `@thru/replay` isn't used. The tape comes from the server's tx list, verified against the Table account read
  directly from Thru. That's cut-list item 5.
