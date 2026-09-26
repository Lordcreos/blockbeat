# Blockbeat — Architecture

How the pieces work, in enough detail to defend them on stage and to change them on
Saturday. Product decisions live in [SDD.md](SDD.md); this document describes what was
actually built and measured. Every number cites its evidence file.

Repository layout:

```
contracts/         Blockbeat.sol, Blockbeat.t.sol (49 tests), Deploy.s.sol
packages/shared/   abi.ts, chain.ts, addresses.ts, constants.ts, types.ts  ← the integration contract
apps/web/          lib/ (runtime), app/ (routes), components/, lib/audio/, e2e/
apps/agent/        src/agent.ts (bar loop), src/lib/{scheduler,pattern,brain,identity,...}
scripts/           src/{loadtest,fund-drip,session,anvil-clock}.ts + src/lib
```

`packages/shared` is written first and is the only source of ABI, addresses, chain
objects and constants (`STEPS = 16`, `TRACKS = 8`, `NOTES_PER_TRACK = 32`, `BLOCK_MS = 300`,
`HIT_GAS_LIMIT_FIRST = 160000`, `HIT_GAS_LIMIT = 80000`, `TIP_GAS_LIMIT = 90000`,
`DRIP_AMOUNT_MON = '0.3'`). Nothing in `apps/` or `scripts/` hand-writes any of these.

## 1. Contract: `Blockbeat.sol`

One contract, no owner, no fees, no pausing, no upgradeability. Solidity 0.8.28,
OpenZeppelin 5.7.0 ERC-721. Session ids and token ids are 1-based so `0` means "none".

### Step derivation

```solidity
uint8 step = uint8((block.number - s.startBlock) % STEPS);   // in hit()
```

The step is derived from the block the transaction lands in and never chosen by the
caller. That single line is the whole product: the chain decides where your note falls.
`stepOf(sessionId, blockNumber)` exposes the same formula as a view, and the shared package
mirrors it as `stepForBlock` so the web clock, the agent scheduler and the load test predict
steps exactly like the contract.

### Pattern storage: 16 bitmask words

A session's pattern is `uint256[16]`, one word per step. Each word packs the 8 tracks × 32
notes = 256 bits:

```solidity
uint256 mask = uint256(1) << (uint256(track) * NOTES_PER_TRACK + uint256(note));
uint256 word = _steps[sessionId][step] ^ mask;
_steps[sessionId][step] = word;
emit Hit(sessionId, msg.sender, uint64(block.number), step, track, note, (word & mask) != 0);
```

A hit XORs its bit, so a second hit on the same cell toggles the note off. The `on` flag
in the event tells clients what happened without a read. Bounds: `track < 8`, `note < 32`,
custom errors `TrackOutOfRange`, `NoteOutOfRange`. `hit` reverts once the session is
finalized and has no external calls. `pattern(sessionId)` returns the 16 words and never
reverts for an unknown session (zeros), so the stage can poll before the host starts.

Gas measured in Foundry ([w1-contracts.md](evidence/w1-contracts.md)): 140,091 for a
player's first hit in a session (cold contributor slot), 61,538 for later hits. Those two
numbers drive the tiered gas limits below.

### Attribution

On every hit: `hitCount++` (session denominator) and `hits[sessionId][player]++`. On a
player's first hit in a session the address is appended to `contributors[sessionId]`.
Views: `hitsOf`, `contributorsOf` (unbounded copy, `eth_call` only; roughly 2.1k gas per
address, so a 500-player session reads in about 1.3 M gas), plus paged `contributorCount`
and `contributorsSlice(offset, limit)` added after the security review so a pumped list can
still be read.

### Tips and claim

- `tip(sessionId)` is payable, before or after finalize, adds `msg.value` to `tipPool`.
  Reverts with `ZeroTip` on zero value and with `NoHits` while `hitCount == 0` (otherwise
  the wei could never be claimed by anyone).
- `claim(sessionId)` is pull-based and **only after finalize**, so the denominator is
  frozen: `share = tipPool * hitsOf(player) / hitCount`, minus what the player already
  claimed (`_claimed` stores the absolute share, so a re-entrant call reverts
  `NothingToClaim`). Checks-effects-interactions, then `call` with the full delta, revert
  `TransferFailed` on failure. A 256-run fuzz test proves the sum of all claims never
  exceeds `tipPool`. Rounding dust (up to `hitCount − 1` wei per pool) is stranded by
  design; there is no owner to sweep it.

### Finalize and `tokenURI`

`finalize(sessionId)` is host-only and once. It copies the 16 words into
`_tokenPatterns[tokenId]`, records `_tokenSessions[tokenId]`, marks the session finalized,
emits `Finalized(sessionId, tokenId, contributors)` and calls `_safeMint(host, tokenId)` as
the very last statement. `remix(parentSessionId)` creates a new session with the parent's
16 words copied and `parentSessionId` set; the parent must be finalized.

`tokenURI` is fully onchain: `data:application/json;base64,` of
`{ name: "Blockbeat Track #<id>", description, image, attributes: [hits, contributors,
parent, session] }`, where `image` is a base64 SVG rendered from the stored words on a
336×176 canvas with 20 px cells, one `<rect>` per lit cell (a cell is lit when any of the
track's 32 note bits is set on that step). Only decimal numbers and literals are
interpolated, never user strings. `tokenPattern(tokenId)` returns the raw words so any
client can replay the loop.

## 2. Web runtime (`apps/web/lib`)

### Chain selection and mock mode

`lib/chain/clients.ts` picks the chain from `NEXT_PUBLIC_CHAIN_ID` (10143 default, 31337
anvil) via shared `chainById`, and the address from `NEXT_PUBLIC_BLOCKBEAT_ADDRESS` or the
shared table. While the resolved address is zero, or `NEXT_PUBLIC_BLOCKBEAT_MOCK=1`, the
runtime builds everything on `lib/mock/simulator.ts`: an in-memory chain that emits a head
every 300 ms and echoes hits as `Hit` events one block later with the contract's step and
XOR semantics. Same hooks, same UI, no chain. The public client polls at `BLOCK_MS`
(viem's 4 s default made every receipt wait 5 s).

### Block clock: a phase-locked loop, not a chain-driven tick

`lib/blockClock.ts` is a free-running step scheduler. The chain is the metronome, but
audio must never wait for the network:

- Subscribes to `newHeads` over WebSocket (viem `watchBlockNumber` on `eth_subscribe`);
  on socket error it switches to HTTP polling every 400 ms and reports the error.
- Measures the block cadence over the last 32 heads (nominal 300 ms until 8 samples,
  clamped to 100–2000 ms). The HUD's BPM is `round(60000 / (measuredBlockMs × 2))`, one beat
  = two blocks, so 100 BPM at 300 ms.
- On each head it compares the arrival time with the expected time. Drift within one block
  nudges the phase by `nudgeGain × drift` (gain 0.3). Drift beyond one measured block
  hard-jumps so the playhead never visibly lags.
- Fires `onStep(step, atAudioTime)` 40 ms ahead, on the AudioContext time base once the
  audio engine hands it Tone's raw context (`setAudioClock`), so sounds are scheduled at
  sample-accurate times.

23 unit tests on fake timers and a fake head source ([w2-web-core.md](evidence/w2-web-core.md)).

### Event feed

`lib/eventFeed.ts` reads `pattern()` and `getSession()` once, then watches `Hit` logs
filtered by `sessionId` (WebSocket, 400 ms poll fallback), applies each hit to the local
pattern, de-duplicates by `(txHash, logIndex)`, and keeps the HUD numbers: rolling
`hitsPerMinute` over 60 s, `uniquePlayers`, `avgLatencyMs` shared with the hit sender.
Feeds are ref-counted per session in `lib/runtime.ts`.

### Burner wallet and hit sender

`lib/burner.ts` generates a viem private key on first visit and stores it under
`blockbeat:burner:pk:v1` in `localStorage`, every access in try/catch with a memory-only
fallback (iOS private mode), and wraps it in an account with viem's `nonceManager` so rapid
taps get sequential nonces. `lib/hitSender.ts` records `sentAt`, writes `hit` with an
explicit `gas` (so viem never calls `eth_estimateGas`), and resolves on the `Hit` log for
that tx hash, returning `{ txHash, blockNumber, step, latencyMs }` for the phone's landing
line. Typed `HitError` codes: `INVALID_ARGS`, `SEND_FAILED`, `TIMEOUT` (15 s).

### Tiered gas

Monad charges the gas limit, not the gas used. `lib/hitGas.ts` sends a burner's first hit
in a session with `HIT_GAS_LIMIT_FIRST` (160,000) and later hits with `HIT_GAS_LIMIT`
(80,000), remembering "confirmed in session X" under `blockbeat:burner:hits:v1` next to the
key. A lower-tier send whose receipt reverts having consumed its whole limit is retried
once with the first-hit limit. At the 100 gwei base fee this is 0.016 MON then 0.008 MON per
note; the agent uses the same two tiers (receipts in [w2b-agent.md](evidence/w2b-agent.md)
show 88,283 gas used for its first hit and 43,911–61,011 after, so both tiers have headroom).

### Drip

`POST /api/drip { address }` validates with viem `isAddress`, allows one drip per address
ever, 20 per minute per IP (`x-real-ip`, else the right-most `x-forwarded-for` hop) and 60
per minute globally, caps the body at 1 KiB, then sends `DRIP_AMOUNT_MON` (0.3 MON, about
35 hits) from `DRIP_PRIVATE_KEY` with a fixed 21,000 gas and **waits for the receipt**
before answering (otherwise the first tap failed with "total cost exceeds balance"). It
returns `{ txHash, track, alreadyFunded }` with the track assigned round robin over the 8
instruments. Errors are `{ error: { code, message } }` with no internals.

### Host routes, tips and the track page

- `POST /api/session/start` and `/finalize` sign with `HOST_PRIVATE_KEY`, require the
  `x-blockbeat-host` header to match `HOST_SECRET` (SHA-256 + `timingSafeEqual`, 10 wrong
  attempts per minute per IP), serialise host transactions, use fixed gas (250k start,
  900k finalize) and read `sessionId` / `tokenId` from the emitted logs. `/host` keeps the
  secret in `sessionStorage`.
- Tip the room: 0.005 MON with `TIP_GAS_LIMIT`, resolved on the receipt; a `NoHits` revert
  is decoded through a local ABI extension and shown as "Tip the room after the first note
  lands".
- `/track/[tokenId]` is a server component: reads `tokenURI`, decodes the JSON, renders the
  SVG as an `<img>` (never injected as HTML), lists contributors with hit counts and shares
  via `contributorsOf` + `hitsOf`, chunked at 8 calls to respect the 25 rps `eth_call`
  limit.

## 3. Audio engine (`apps/web/lib/audio`)

Framework-agnostic Tone.js engine behind the `AudioEngine` interface. No samples: the whole
kit is synthesized ([w4-audio.md](evidence/w4-audio.md) has the per-voice table).

- Eight voices in track order: kick (`MembraneSynth` + light distortion), snare (white +
  pink noise through a 1.4 kHz high-pass plus a membrane body), hat (`MetalSynth`, 6 kHz
  high-pass), clap (three 11 ms noise flams plus reverb send), bass (`MonoSynth` sawtooth,
  resonant low-pass, acid distortion), lead (square/saw pair into a 150 ms feedback delay),
  pad (`PolySynth` chords, 1.2 s reverb), fx (sweeping band-pass noise riser/drop plus a
  sine zap). Each track has 32 variants: drums, pad and fx split the note into pitch
  (`note & 7`) and variant (`note >> 3`); bass and lead use `note & 15` as a semitone and
  bit 4 as a timbre switch.
- Master chain: volume → +3 dB makeup → compressor (−18 dB, 3:1) → limiter (−1 dB) →
  destination. Sixteen simultaneous hits peak at or under 1.0 (offline-render test).
- `PatternPlayer` holds the 16 words, subscribes to `BlockClock.onStep`, decodes the step
  with shared `decodeStep` and triggers each `(track, note)` at the clock's audio time.
  Never schedules closer than 20 ms to `currentTime`; drops steps older than 250 ms rather
  than playing late; two notes on the same monophonic voice in one step are spread by 10 ms.
- `start()` must be called from a user gesture (the stage overlay click); it races
  `context.resume()` against a 1.5 s timeout and reports `isStarted()` from the real
  context state, so a suspended context (background tab) recovers on the next click.
  `playImmediate(track, note)` plays a hit that landed on the current step without waiting
  for the next pass.
- Tests render on `Tone.Offline` under Node via `node-web-audio-api` (46 audio tests
  inside the web suite).

## 4. Resident DJ agent (`apps/agent`)

A Node service the host runs on the stage laptop with its own key (`AGENT_PRIVATE_KEY`).
Loop, once per bar (16 blocks, 4.8 s), on the first head of each bar:

1. **Read.** `pattern(sessionId)` at the bar block, plus an incremental `Hit` log replay
   through a ledger that remembers who toggled each cell on last. Renders a 16×8 text grid
   (`.` empty, `H` human, `A` agent) and overlays the agent's in-flight hits so a fill is
   never planned twice. Player addresses never reach the prompt.
2. **Plan.** Two brains behind one interface. Rules: bass on an empty downbeat under a
   human kick, hat fill in the last quarter, snare fill on steps 14/15, clap on 12 every
   other bar, kick+hat seed on an empty grid. Claude: `claude-sonnet-5` through the
   Anthropic SDK with structured JSON output (`zodOutputFormat`), `effort: low`,
   `max_tokens 512`, a 3 s hard timeout and no retries; any error (timeout, 429, refusal,
   schema) falls back to the rules for that bar and the status line shows `brain llm` or
   `brain rules`. Every candidate from either brain is sanitized: range-checked, dropped if
   the cell is already on (a hit there would XOR it off), one note per track, at most 4 per
   bar, capped by the remaining budget (40 hits per session).
3. **Schedule.** For each addition `targetBlock = nextBarStart + step` and
   `sendBlock = targetBlock − lead`. The hit is sent on the head of `sendBlock` (with a timer
   at the predicted time + 1 block as a stall fallback), signed locally with viem's
   `nonceManager` and the tiered fixed gas. The receipt's `Hit` log gives the actual step;
   the scheduler logs intended vs actual and adapts `lead` from the measured inclusion
   delay, re-timing hits still pending. The lead starts at 2 blocks and, on anvil, settled
   to 1 after the first receipt.
4. **Guard.** `AGENT_ENABLED=false` keeps the loop and status line running but skips every
   send (kill switch, read at startup). SIGINT drains in-flight hits (5 s max) and prints a
   summary.

Identity (ERC-8004): on startup the agent checks `getCode` on the registry address from
the Monad docs (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`), registers with a `data:` URI
registration file and a fixed gas limit if there is code, and persists the agent id in
`.agent.json` (mode 600). On 2026-09-25 that address had no bytecode on testnet, so the
status line reports `erc8004 unregistered` with the reason; `ERC8004_IDENTITY_REGISTRY`
overrides the address. Registration is never a blocker.

Evidence ([w2b-agent.md](evidence/w2b-agent.md)), 4 bars on anvil at 300 ms with the rules
brain: 11 sent, 11 confirmed, 10 on the intended step (91 %; the miss is the first hit,
before the lead adapted), 0 notes toggled off, 561,617 gas, 309–332 ms send-to-receipt.
The stage colours hits from `NEXT_PUBLIC_AGENT_ADDRESS` with a white core inside the
track colour.

## 5. Load test method (`scripts/src/loadtest.ts`)

Reproduces the audience path without phones ([loadtest.md](evidence/loadtest.md)):

- N burner wallets (default 40) generated in memory and funded from the funder key. Each
  fires M hits (default 30) at seeded random offsets inside a window (default 60 s).
- Every RPC call, including funding, receipts and balance reads, passes through one token
  bucket capped at `--rps` (default 50, the public limit; more needs `--allow-over-limit`).
  Transports have `retryCount: 0` so a 429 shows in the report instead of being hidden.
- Hits are signed locally with the shared gas limit and sent with `eth_sendRawTransaction`:
  no `eth_estimateGas`, no chain-id lookups. Every CLI checks `eth_chainId` against
  `--chain-id` before resolving a key.
- At send time the script predicts the landing block from the latest head, the measured
  cadence and `--lag-blocks` (0 on anvil, 1 on Monad where the next block is already being
  built), and derives the intended step exactly like the contract.
- A hit is confirmed from the `Hit` log for its hash on one WebSocket subscription (the
  phone's path), so latency = log seen − send. A log that never arrives gets one receipt
  lookup after 15 s and is classed confirmed-via-receipt, reverted or timed out.
- "Hits cost" is funded minus final balance summed over burners, so it is the true charge
  whatever the chain bills (gas used on anvil, gas limit on Monad). `--sweep` returns the
  leftover. Provider URLs with embedded keys are redacted before anything is written.

Baseline, 2026-09-25, anvil driven at 300 ms by `scripts/src/anvil-clock.ts`: 1200/1200
confirmed, p50 155 ms, p95 284 ms, p99 297 ms, 99.7 % on the predicted step and 100 % within
one step, 19.91 confirmed hits/s, 0 RPC errors, 0 rate-limit hits, 16 token-bucket waits.
The p99 is one block because anvil includes a pending tx in the very next block. The same
command against Monad testnet is written in the evidence file and is pending funds.

Funding math on Monad (base fee 100 gwei, gas limit charged): a first hit costs 0.016 MON
and later hits 0.008 MON; the drip's 0.3 MON funds about 35 hits per player; the load test
funds each wallet with `hits × gasLimit × maxFeePerGas × 1.1`, so a 40 × 30 run wants about
32 MON in the funder before `--sweep` returns what was not spent.

## 6. Ownership and testing discipline

Every module was built test-first (RED commit with specs only, then the GREEN commit),
reviewed for security and type safety, and the
findings and fixes are in each evidence file. Counts on this checkout: 49 Foundry tests,
271 web, 89 agent, 71 scripts, 33 Playwright (1 skipped by design).
