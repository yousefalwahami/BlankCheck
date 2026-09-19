# GAMBIT RODEO

> **Everyone cheats. The chain remembers.**

A Jackbox-style party game. The laptop plays on the TV, every phone is a
controller, and **Face ID pops the confetti**. Each round everyone gets a secret cheat card. Cheating is
allowed; getting caught costs you. A **referee program written in C on Thru** keeps sealed evidence of
every cheat, and at the end **Review the Tape** replays the game and exposes everything nobody caught.

Full design: [docs/BLANK_CHECK_SPEC.md](docs/BLANK_CHECK_SPEC.md).

## How it fits together

```
📱 phones (/join, /play/ROOM) ─┐                           ┌─ Thru alphanet: referee program (C) + passkey-manager
                               ├─ Socket.IO ─ game server ─┤
📺 TV (/host) ─────────────────┘   (engine, secrets)       └─ Jev (bots + Pit Boss)
```

| Piece | Where it runs | What it does |
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

---

# Phase 1: Build

Everything happens locally, and nothing is published. When you're done, the referee is compiled for the
Thru VM, proven equal to the TypeScript mirror, and the whole game runs on your laptop.

### 1.1 Prerequisites

- Node 22+ and pnpm (`corepack enable`), plus git.
- **Windows:** WSL2 with Ubuntu, and `sudo apt install build-essential curl` inside it. Thru's C toolchain
  runs on Linux or macOS only, so every `thru` and `make` command below runs in WSL. The repo is already
  visible there at `/mnt/c/Users/<you>/…/BlankCheck`.

### 1.2 The JavaScript side

```bash
pnpm install
pnpm typecheck
pnpm test                                   # 53 tests
pnpm --filter @blankcheck/web build         # the exact build Vercel will run
```

### 1.3 Install the Thru toolchain (in WSL)

WSL needs its own Node. Windows' Node isn't on WSL's PATH, and the CLI's binary must be the Linux one:

```bash
# install nvm first: https://github.com/nvm-sh/nvm#installing-and-updating, then:
nvm install 22
npm i -g thru                 # the Thru CLI (prebuilt binary)
thru --help
thru dev toolchain install    # RISC-V toolchain → ~/.thru/sdk/toolchain
thru dev sdk install c        # C SDK → ~/.thru/sdk/c/thru-sdk
```

Verify the install (these checks come from Thru's docs):

```bash
test -f ~/.thru/sdk/c/thru-sdk/thru_c_program.mk && echo "sdk ok"
test -x ~/.thru/sdk/toolchain/bin/riscv64-unknown-elf-gcc || test -x ~/.thru/sdk/toolchain/bin/riscv64-none-elf-gcc && echo "toolchain ok"
```

Point the CLI at alphanet in `~/.thru/cli/config.yaml` (`rpc_base_url: https://rpc.alphanet.thru.org`), then run
`thru --json getversion`. If it prints a `thru-node` version, the CLI can reach the network.

> Thru is pre-1.0 and these commands change. If one fails, check <https://thru.org/docs> (add `.md` to any page).

### 1.4 Compile the referee for the Thru VM

```bash
make -C programs/referee
ls -l programs/referee/build/thruvm/bin/blank_check_referee_c.bin
```

The static asserts in `blank_check.h` pin the Table layout (74,834 bytes). If the layout ever drifts from
`packages/shared/src/table.ts`, the build fails.

### 1.5 Prove the C program equals the TypeScript referee

```bash
make -C programs/referee/test      # expect: ✅ blank_check.c matches the TypeScript referee byte for byte
```

If you change the rules, change `program.ts` and `blank_check.c` together, then run `pnpm trace` and this test again.

### 1.6 Play it locally

```bash
pnpm dev
```

Play a full game on `localhost:3000/host`. Add bots, sit a couple of browser tabs down, cheat, call RIGGED!,
and watch the tape. For phones on the same Wi-Fi, open the TV via the laptop's LAN IP
(`http://192.168.x.x:3000/host`). Everything works except Face ID, which needs HTTPS, so phones get a
tap-to-fire button.

### 1.7 (Optional) Build the server image

```bash
docker build -f apps/server/Dockerfile -t blank-check-server .
docker run -p 4000:4000 blank-check-server         # curl localhost:4000/health
```

**Phase 1 is done when:** tests pass, the web build succeeds, `blank_check_referee_c.bin` exists, the host test
prints ✅, and a local game reaches Review the Tape.

---

# Phase 2: Deploy

This publishes things: a program on the public Thru alphanet, a game server, and a website. Run the `thru`
commands in WSL.

### 2.1 Create and fund the house key

The house key pays every fee, hosts every table, and signs for bots. Players never need tokens.

```bash
thru keys generate host
thru account create host
thru faucet withdraw host 10000        # repeat if deploys run out of balance (max 10000 per call)
thru keys get host                     # 64-char hex private key → THRU_HOST_SECRET (never commit it)
```

### 2.2 (Recommended) Deploy the docs' counter example first

Thru's docs advise this for the first hour. Build and deploy the counter from
<https://thru.org/docs/program-development/building-a-c-program.md> and call it once with `thru txn execute`.
If that works, your toolchain, key, and network are all fine, and any later failure is ours.

### 2.3 Deploy the referee

```bash
programs/referee/deploy.sh              # make + thru program create --fee-payer host blank_check_referee …
```

It prints the **program account** (`ta…`). That value is `REFEREE_PROGRAM_ADDRESS`. To ship changes later,
run `programs/referee/deploy.sh upgrade`: same seed, same address. Use `THRU_KEY` / `REFEREE_SEED` to
change the key name or seed.

Quick liveness check: a bare instruction with no table account should revert with our `ACCT` error
(0x2002 = 8194):

```bash
thru txn execute --fee 0 <REFEREE_PROGRAM_ADDRESS> 010000000200   # expect User Error Code: 8194
```

### 2.4 Point the game server at the chain

Copy `apps/server/.env.example` to `apps/server/.env` and set:

```bash
REFEREE_MODE=thru
THRU_HOST_SECRET=<from thru keys get host>
REFEREE_PROGRAM_ADDRESS=<from deploy.sh>
```

Run `pnpm dev:server`. The boot log should say `thru: house key ta… (balance …)` and `referee: thru`. If
it says it's falling back to MockReferee, it also prints why.

### 2.5 Smoke test on-chain

```bash
pnpm --filter @blankcheck/server chain:smoke
```

This plays a short all-bot game against the deployed program and prints every transaction with its
**measured latency** and explorer link. It then reads the Table account back from the RPC node and checks
hearts, winner, every sealed envelope and every shell commitment. **Write down the latency numbers**
(spec §11 Phase 0(d)); they go in the pitch. `SMOKE_SEATS` and `SMOKE_HEARTS` make the game longer.

If `CREATE_TABLE` is rejected for resources (it allocates ~75 KB), raise `THRU_STATE_UNITS` /
`THRU_MEMORY_UNITS` in `.env` and rerun.

### 2.6 Deploy the game server

It needs an always-on process with WebSockets, which is why it doesn't go on Vercel.

- **Railway:** New project → Deploy from repo → set the Dockerfile path to `apps/server/Dockerfile` (build
  context = repo root). Add the variables from 2.4 (plus `TYPESAFE_API_KEY`, `CORS_ORIGINS`), and set the
  health check to `/health`.
- **Render:** New → Blueprint → pick this repo (`render.yaml`), then fill in the secret variables.
- **Or your laptop:** `pnpm --filter @blankcheck/server start` plus `cloudflared tunnel --url http://localhost:4000`
  for a free HTTPS URL. It changes every run, which is fine because the TV passes it along with `?server=`.

Free tiers sleep, so open `https://<server>/health` a couple of minutes before playing.

### 2.7 Deploy the web app to Vercel

Import the repo and set **Root Directory = `apps/web`** (pnpm workspaces are detected). Add these variables:

```bash
NEXT_PUBLIC_GAME_SERVER_URL=https://<your game server>
NEXT_PUBLIC_THRU_RPC_URL=https://rpc.alphanet.thru.org
NEXT_PUBLIC_EXPLORER_URL=https://scan.thru.org
```

Keep **one stable domain**. Passkeys, and so everyone's Face ID wallet, are bound to it. Then open
`https://<app>.vercel.app/host` on the TV laptop. `?server=<url>` overrides the server without a redeploy,
and the QR code carries it to the phones.

### 2.8 Turn on Jev

Get a key at <https://console.typesafe.ai/keys> and set `TYPESAFE_API_KEY` on the server. Once your bot
thresholds are tuned, pin `JEV_MODEL`. The `/health` endpoint shows Jev call and failure counts. Without a
key, bots and the Pit Boss keep working on heuristics.

### 2.9 Real-device checks

Do this at least once on an **iPhone** and once on **Android**, against the Vercel URL:

1. **Sit down:** Face ID should create the passkey, and the TV lobby shows 🔐 wallet ready. In thru mode the
   server creates the passkey-manager wallet, which takes a second or two.
2. **Pull the trigger:** the ticker should show `PULL_TRIGGER · <name> · 🔐 Face ID` with a scan.thru.org link.
3. **RIGGED!:** "Swear on your face". Then `ACCUSE` (🔐) and `REVEAL` appear on the ticker, and the verdict screen
   shows the referee's confirmation time.
4. At the end, the tape's top-right corner should read `⛓ N/N hashes match the Table account on Thru`.

The trigger is already two taps: picking a target fetches the challenge, and **PULL TRIGGER** calls WebAuthn
directly inside the tap, as iOS requires. If a venue or device still refuses the prompt, uncheck **Face ID
on trigger** in the lobby. Seats are then house-signed and everything else stays on-chain.

### 2.10 Demo-day checklist

- The server is awake (`/health`), `DEMO_SEED` is set, and the TV is open at `/host?hearts=2`.
- The explorer is open on the table account (the TV's final card has a QR code for it).
- A backup video of a full on-chain game is recorded.
- Have one sentence on the trust model ready (below). Venue Wi-Fi blocking WebSockets? Use a phone hotspot.

**Phase 2 is done when:** `chain:smoke` prints ✅, a phone game on the Vercel URL shows 🔐 Face ID trigger
pulls on the ticker, and the tape says every hash matches the Table account on Thru.

---

## What happens on-chain

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

At boot the server checks the key and RPC and **falls back to the mock** if the chain isn't reachable.
During a game, a failed transaction shows red on the ticker and play continues. Waits on the chain are
capped at 4 s (`CHAIN_WAIT_CAP_MS`), so a slow alphanet never stalls a shot.

**Trust model (say it out loud if asked):** in this MVP the server is the dealer. It knows the shell order
and writes the envelopes. The chain stops it from *rewriting history*, not from lying at the moment of
sealing. Two things narrow that gap. The tape replays the committed order plus the revealed cheats and must
reproduce every reported shot. And `REVEAL_SHELLS` refuses a reveal whose live count doesn't match what was
announced. The stretch goal in spec §6.8 (phones seal their own envelopes with a session key) closes it.

## Status against the spec (§11)

| Phase | State |
|---|---|
| 0. De-risk | Alphanet RPC reachable (chain id 161 ms, height 84 ms, creating proof 84 ms). Tx latency: run `chain:smoke` (Phase 2.5) |
| 1. Offline game | ✅ Full rules, rooms, QR join, TV, phone controller, cheats, RIGGED!, Last Call, elimination, win |
| 2. Referee on-chain | ✅ C program + byte-for-byte host test; `ThruReferee` + tx queue + ticker. Compile + deploy: Phases 1.4 and 2.3 |
| 3. Face ID on-chain | ✅ Built on `@thru/passkey` (wallet creation, challenges prefetched on aim, validate→CPI). Device test: Phase 2.9 |
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
- **House transactions** share `@thru/passkey`'s global fee-payer queue, and cache chain id, slot and nonce,
  so a shot costs one round trip.
- **Sounds** are synthesized with Web Audio (no assets). The art is original; no Buckshot Roulette assets are used.
- `@thru/replay` isn't used. The tape comes from the server's tx list, verified against the Table account read
  directly from Thru. That's cut-list item 5.
