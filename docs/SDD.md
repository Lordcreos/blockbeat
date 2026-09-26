# Blockbeat — System Design Document

Version 0.1 · 2026-09-24 · Target: Monad Blitz Berlin, 2026-09-26

## 1. One-liner

A 16-step techno sequencer whose metronome is the Monad blockchain. Every Monad block
(300 ms) is one step. The audience joins from their phones via QR, and every note they
trigger is a real transaction that lands on a step. The room composes a loop together,
live, and the final pattern is minted as an NFT.

## 2. Why this wins (locked decisions)

- **Audience-voted hackathon.** Every voter becomes a co-author of the demo.
- **Monad's thesis is the mechanic.** 300 ms blocks are the clock. 600 ms finality is the
  quantization latency. Nobody needs to explain TPS: they hear it.
- **Small contract, huge polish ceiling.** All risk is in UX and audio, not in the chain.
- **Leaves an artifact.** The "Berlin Blitz Track" NFT closes the pitch.

Locked: Monad testnet (chain 10143). No MetaMask in the audience flow. No indexer. No
backend database. Mainnet deploy is optional stretch, never required.

### 2.1 The four layers (priority order)

| Layer | What | Status |
| --- | --- | --- |
| 1. Live sequencer | Room composes a loop; every note is a tx; block = step | MVP, mandatory |
| 2. Attribution and tips | Every note is attributed to its player; tips to a session are split pro rata by notes; finalize mints the track NFT listing contributors | MVP, mandatory |
| 3. Resident DJ agent | An AI agent (Claude) with its own wallet and ERC-8004 identity listens to the pattern and adds fills as real txs; the room can tip it | Firm goal |
| 4. Remix lineage | Any finalized track can be forked into a new session; the contract records the parent; leaderboard by notes and tips | Stretch (only if Wave 2 is done by Friday noon) |

## 3. User experience

### 3.1 Roles

| Role | Device | Route | What they do |
| --- | --- | --- | --- |
| Player (audience) | Phone | `/join/[session]` | Scan QR, get a burner wallet silently, tap pads to send notes |
| Stage (presenter) | Laptop on the big screen | `/stage/[session]` | Shows grid, playhead, HUD, QR; plays the audio |
| Host | Laptop | `/host` | Creates a session, finalizes and mints the track |

### 3.2 Player flow (must feel like ~3 seconds from scan to first note)

1. Open link. A burner private key is generated in the browser and kept in `localStorage`.
2. The page POSTs the burner address to `/api/drip`. The server funds it with 0.3 MON (about 35
   hits; Monad charges the gas limit, so limits are tiered: 160k for a player's first hit, 80k after).
3. While funding (about 1 s), the pad UI is already visible with a "warming up" state.
4. The player is assigned a track by the server drip response (round robin over 8 tracks):
   kick, snare, hat, clap, bass, lead, pad, fx. The pad shows the track name and colour.
5. Tapping a pad sends `hit(session, track, note)` signed locally. No popup.
6. The pad flashes immediately (optimistic) and then shows the landing info:
   "landed · block 12,345 · step 7 · 412 ms".
7. A second tap on the same step toggles the note off (the contract XORs the bit).

### 3.3 Stage flow

- 16 columns (steps) × 8 rows (tracks). A vertical playhead moves one column per block.
- When a `Hit` event arrives the cell lights, and the note is heard on its next pass
  (and immediately if the step is the current one).
- HUD (always visible): current block, session tx count, hits per minute, average
  confirmation latency, unique players, current BPM (derived from measured block cadence).
- A large QR to `/join/[session]` and a short URL.
- Host controls (small, bottom right): start round, finalize and mint.

### 3.4 Round and finalize

A session is a loop that runs while the host wants. "Finalize" snapshots the 16 step
bitmasks into an ERC-721 with a fully onchain `tokenURI` (JSON + SVG of the grid).
The stage shows the token on the explorer.

**Addendum (2026-09-25): the live layer and the recorded layer.** The contract is frozen
and its XOR bitmask never lets a note go (§4.2: only the same pad on the same step clears it,
and the block picks the step), so a busy room filled the grid in a minute. The clients now
derive a LIVE layer from the `Hit` logs (`livePattern` in `packages/shared`): every hit is a
note played at its block whatever its `on` flag, alive for 8 bars (128 blocks, ~38 s) after its
most recent hit, at most 6 live notes per track (newest win). The stage audio, grid, HUD
(`Live notes`), the phone strip and the DJ agent use the live layer; `pattern()` stays the
RECORDED layer that finalize mints and `/track` shows ("Recorded pattern: every note the room
played"). §3.2 step 7 ("a second tap toggles the note off") now applies to the recorded layer
only; in the room every tap sounds, and the phone says `landed` for every hit. The DJ (§4.5)
plans on the live layer as a curator: under 12 live notes it adds 1–3 backbone notes (kick 0/8,
clap 4/12, hat offbeats, bass root 0) on tracks with fewer than 3 live notes, never on a live
cell and never on a human's recorded bit. Knobs `NEXT_PUBLIC_NOTE_LIFETIME_BARS` (8, 0 = the
previous behaviour) and `NEXT_PUBLIC_MAX_LIVE_PER_TRACK` (6, 0 = no cap). Full design:
[ADR 0001](adr/0001-note-decay.md).

## 4. Architecture

Monorepo, pnpm workspaces.

```
blockbeat/
  contracts/            Foundry. Blockbeat.sol, tests, deploy script
  packages/shared/      Contract ABI, addresses, constants, TypeScript types (contract-first)
  apps/web/             Next.js 16 (App Router), Tailwind, viem, Tone.js
  scripts/              Load test and ops scripts (TypeScript, tsx)
  docs/                 This SDD
```

### 4.1 Chain facts (verified 2026-09-24 in docs.monad.xyz)

| Item | Value |
| --- | --- |
| Chain ID | 10143 (Monad Testnet) |
| RPC | `https://testnet-rpc.monad.xyz` / `wss://testnet-rpc.monad.xyz` |
| Faucet | `https://faucet.monad.xyz` |
| Explorer | `https://testnet.monadscan.com` |
| Block time / finality | 300 ms / 600 ms |
| Public RPC limits | 50 rps, 25 rps for `eth_call` and `eth_estimateGas` |
| Toolchain minimums | Foundry >= 1.8, viem >= 2.40 |

The public RPC limit is the main scaling risk. See §7.

### 4.2 Contract: `Blockbeat.sol`

Constants: `STEPS = 16`, `TRACKS = 8`, `NOTES_PER_TRACK = 32` (8 × 32 = 256 bits, one
`uint256` per step).

```solidity
struct Session {
    uint64  startBlock;
    address host;
    bool    finalized;
    uint64  hitCount;        // total hits in the session (attribution denominator)
    uint256 tokenId;         // 0 until finalized
    uint256 parentSessionId; // 0 for an original, else the remixed session
    uint256 tipPool;         // wei tipped to this session, claimable pro rata by hits
}

event SessionStarted(uint256 indexed sessionId, uint64 startBlock, address indexed host,
                     uint256 indexed parentSessionId);
event Hit(uint256 indexed sessionId, address indexed player, uint64 blockNumber,
          uint8 step, uint8 track, uint8 note, bool on);
event Tipped(uint256 indexed sessionId, address indexed from, uint256 amount);
event Finalized(uint256 indexed sessionId, uint256 indexed tokenId, uint256 contributors);
event Claimed(uint256 indexed sessionId, address indexed player, uint256 amount);

function startSession() external returns (uint256 sessionId);
function remix(uint256 parentSessionId) external returns (uint256 sessionId);
function hit(uint256 sessionId, uint8 track, uint8 note) external;
function tip(uint256 sessionId) external payable;
function finalize(uint256 sessionId) external returns (uint256 tokenId);
function claim(uint256 sessionId) external;

function pattern(uint256 sessionId) external view returns (uint256[16] memory);
function stepOf(uint256 sessionId, uint64 blockNumber) external view returns (uint8);
function getSession(uint256 sessionId) external view returns (Session memory);
function hitsOf(uint256 sessionId, address player) external view returns (uint64);
function contributorsOf(uint256 sessionId) external view returns (address[] memory);
function claimableOf(uint256 sessionId, address player) external view returns (uint256);
```

Semantics:

- `step = (block.number - startBlock) % 16`. The step is derived from the block the tx
  lands in, never chosen by the caller. That is the whole point.
- `hit` XORs bit `track * 32 + note` in `steps[sessionId][step]`, emits `Hit` with the
  resulting `on` flag, increments `hitCount` and `hits[sessionId][player]`, and appends
  the player to `contributors[sessionId]` on their first hit. Reverts if finalized.
- `remix` creates a new session whose 16 step words are copied from the parent and whose
  `parentSessionId` is set. The parent must be finalized.
- `tip` adds `msg.value` to `tipPool`. Allowed before and after finalize. Reverts while the
  session has zero hits (nothing to attribute) and on zero value.
- `claim` is pull-based and only after finalize (so shares are fixed): `share = tipPool * hitsOf(player) / hitCount` minus what the
  player already claimed for that session (track `claimed[sessionId][player]`). Uses
  checks-effects-interactions and `call` with the full amount; reverts on failure.
- `finalize` only by host, once. Mints an ERC-721 (OpenZeppelin v5) to the host whose
  `tokenURI` is `data:application/json;base64,...` with name, description, attributes
  (hits, contributors, parent) and an inline SVG 16×8 grid rendered from the pattern.
  Pattern words are stored per token so any client can replay it.
- No fees, no pausing, no upgradeability, no owner. One `SSTORE` per hit plus one on a
  player's first hit.

Security notes: host-only `finalize`, bounds checks on
`track < 8` and `note < 32`, no external calls in `hit`, `claim` and `finalize` follow
checks-effects-interactions, integer math in `claim` cannot over-distribute (sum of shares
is at most `tipPool`), `contributorsOf` is bounded by sessions of a few hundred players
(document the gas ceiling).

### 4.3 Shared package (`packages/shared`) — the integration contract

Written first, so web and contracts could proceed in parallel:

- `abi.ts`: the ABI above as a `const` for viem type inference.
- `chain.ts`: viem `Chain` object for Monad testnet plus RPC URLs.
- `constants.ts`: `STEPS`, `TRACKS`, `NOTES_PER_TRACK`, track names and colours,
  `BLOCK_MS = 300`.
- `addresses.ts`: `BLOCKBEAT_ADDRESS` per chain id. Filled in after
  deploy. Until then it is the zero address and the web app runs in mock mode.
- `types.ts`: `HitEvent`, `SessionState`, `StepMask` helpers (`isOn`, `toggle`,
  `decodeStep`).

Rule: nothing in `apps/web` hand-writes an ABI, an address, or a chain id.

### 4.4 Web app (`apps/web`)

- **Block clock** (`lib/blockClock.ts`): subscribes to `newHeads` over WebSocket. Keeps a
  free-running 300 ms scheduler on Tone.js `Transport`. On each new head it computes the
  expected step and nudges the phase (phase-locked loop, never hard jumps unless the drift
  exceeds one full step). Exposes `currentStep`, `currentBlock`, `measuredBlockMs`.
- **Event feed** (`lib/eventFeed.ts`): on load reads `pattern(sessionId)` once, then
  subscribes to `Hit` logs via `eth_subscribe`. Falls back to `watchContractEvent`
  polling every 400 ms if the socket drops. Emits typed `HitEvent`s.
- **Audio engine** (`lib/audio/`): eight Tone.js instruments (kick, snare, hat, clap,
  bass, lead, pad, fx). `note` selects a variant (pitch or sample). Plays the pattern each
  loop; plays a hit immediately if it lands on the current step. Audio only starts after a
  user gesture on the stage (browser autoplay policy).
- **Burner wallet** (`lib/burner.ts`): `generatePrivateKey` from viem, stored in
  `localStorage`, wrapped in a `WalletClient` bound to Monad testnet. Nonce managed
  locally with `nonceManager` so rapid taps do not collide.
- **Hit sender** (`lib/hitSender.ts`): builds and sends `hit` with a fixed gas limit (no
  `eth_estimateGas`, that endpoint has the tighter rate limit), records `sentAt`, resolves
  on the `Hit` log for that tx hash, reports latency and step.
- **Drip API** (`app/api/drip/route.ts`): POST `{ address }`. Validates the address,
  rate-limits (one drip per address, max N per minute per IP, in-memory), sends 0.05 MON
  from `DRIP_PRIVATE_KEY`, returns `{ txHash, track }`. Track assignment is round robin.
  This route is a security trigger: `security-reviewer` must review it.
- **Pages**: `/host`, `/stage/[session]`, `/join/[session]`, and `/` (landing that
  explains the concept in three lines and links to a demo session).
- **Mock mode**: when the address is zero, the event feed and hit sender run against an
  in-memory simulator that emits blocks every 300 ms, so UI and audio work with no chain.

### 4.5 Resident DJ agent (`apps/agent`)

A small Node service (TypeScript, `tsx`), run by the host on the stage laptop.

- Has its own private key (`AGENT_PRIVATE_KEY`), funded like any burner.
- Registers once as an agent in the ERC-8004 identity registry on Monad testnet
  following `https://docs.monad.xyz/guides/erc-8004.md`, storing the agent id in
  `apps/agent/.agent.json`. If the registry is unavailable on testnet, the service still
  runs and the UI shows "unregistered"; registration is never a blocker.
- Loop, once per bar (16 blocks, about 4.8 s): read `pattern(sessionId)`, decode it into a
  text grid, ask Claude (`claude-sonnet-5` via the Anthropic SDK, temperature low, JSON
  output) for at most 4 additions in the next bar that complement what humans played
  (fills on hat or snare, a bass note on an empty downbeat, never more than one note per
  track per bar). Send each as a `hit` timed so it lands on the intended step: send at
  `targetBlock - 2` using the block clock. Log the intended versus actual step.
- Budget: hard cap of 40 hits per session and a kill switch (`AGENT_ENABLED=false`).
- The stage colours agent hits differently and shows the agent's wallet, hit count and
  tips received. The join page has a "tip the DJ" button that calls `tip` on the
  agent's own session share (simplest form: tips go to the session pool and the agent is
  just another contributor, which is honest and needs no extra contract code).

### 4.6 Scripts

- `scripts/loadtest.ts`: creates N burner wallets, funds them from the drip key, fires M
  hits each with random timing, records confirmation latency percentiles and RPC errors.
  Target: 40 wallets × 30 hits in under 2 minutes with p95 latency under 1.5 s on the
  public RPC. If it fails, switch `RPC_URL` to a dedicated provider (Alchemy or QuickNode
  both list Monad) and rerun.
- `scripts/fund-drip.ts`: prints the drip address and balance, so the host knows when to
  top up from the faucet.

## 5. Visual and audio direction

- Dark stage. One accent per track, high contrast, readable from 10 metres.
- The playhead is the hero: a bright column sweeping at 300 ms. Cells pulse when hit.
- HUD numbers use tabular figures and update without layout shift.
- Phone pad: full-screen, thumb-sized pads, haptic-like flash on tap, the landing line
  under the pads. Works in Safari iOS and Chrome Android, portrait.
- Sound: minimal techno kit. Tight kick, short hat, clap with a little reverb, a
  monophonic acid-style bass, one pad, one riser for fx. Loud enough for a room through a
  laptop plus speaker.

## 6. Demo script (3 minutes)

1. 0:00 Stage shows an empty grid and the QR. "Every column is a Monad block. 300 ms."
2. 0:20 "Scan and tap." First hits land; sounds start. Show the landing line on a phone.
3. 1:00 Grid fills. Point at the HUD: hits per minute, average latency, players.
4. 1:30 "Meet the resident DJ." Enable the agent; its hits appear in a different colour
   and the groove gets fills. "It has a wallet, an ERC-8004 identity, and it pays gas."
5. 2:15 "Everything you hear is chain state. Every note has an owner." Hit finalize.
6. 2:40 Token appears on Monadscan with the contributor count. "Berlin Blitz Track #1.
   The forty people who tapped own it. Tips split by notes. Vote for the beat."

## 7. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Public RPC rate limit with 40 phones | Fixed gas limit (no estimateGas), one WS subscription per client, load test on Friday, dedicated RPC key as fallback |
| Block jitter makes audio stutter | Free-running scheduler with phase nudging; audio never waits for the chain |
| iOS Safari audio and localStorage quirks | Player page has no audio (only the stage plays); wrap storage in try/catch |
| Venue Wi-Fi | Stage laptop on phone hotspot; players use mobile data; short URL |
| Faucet limits for drip wallet | Start collecting MON Thursday night; several burner-funded wallets as reserve |
| Spam or griefing | Drip is one per address and IP-limited; the contract has no rate limit by design |

## 8. Out of scope

Mainnet deploy, accounts and logins, indexers, persistence beyond chain state, multiple
simultaneous sessions on one stage, recording audio.
