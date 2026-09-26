# ADR 0001 — Note decay: a live layer over the recorded pattern

- Status: accepted (2026-09-25).
- Code: `packages/shared/src/decay.ts` (the rule), `apps/web/lib/{eventFeed,decay}.ts`, `apps/agent/src/lib/pattern.ts`, `apps/agent/src/lib/brain/*`.

## Context

`Blockbeat.sol` is deployed on Monad testnet (`0xf1808F23…4060`) and frozen. `hit()` XOR-toggles bit
`track*32+note` in the word of `step = (block − startBlock) % 16`. A note turns off only when somebody
lands the same pad on the same step, and the block picks the step, so that almost never happens. On the
device rehearsal the 16×8 grid filled in a minute or two and turned into static noise. The contract cannot
change, so notes can only go away in the clients.

## Decision

### Two layers

| | RECORDED layer | LIVE layer |
| --- | --- | --- |
| Source | `pattern(sessionId)` in the contract | every `Hit` log of the session |
| Rule | XOR per hit: a second hit on a cell clears it | every `Hit` is a note played at its block, whatever its `on` flag; a cell is alive for `NOTE_LIFETIME_BARS` = 8 bars (128 blocks, ~38 s) after its **most recent** hit; a later hit refreshes it |
| Voice cap | none | at most `MAX_LIVE_PER_TRACK` = 6 live notes per track; the newest by (blockNumber, logIndex) win, the oldest are evicted |
| Who uses it | `finalize` (the NFT), `/track`, the finalize overlay | the stage audio, the stage grid and HUD (`Live notes N`), the phone strip, the DJ agent |
| Meaning | every note the room played, the record of the session | what the room hears now |

The live layer deliberately does not follow XOR. With decay, XOR would let a tap on a full recorded grid
produce silence, and that kills the room: every tap must sound. The UI states this split. `/track` says
"Recorded pattern: every note the room played", the phone always says `landed`, and the stage HUD shows
`Hits` (all taps) next to `Live notes` (what is playing).

### One pure rule, shared

`livePattern(hits, currentBlock, lifetimeBars, { maxLivePerTrack, presorted })` in `@blockbeat/shared`.
It replays hits in chain order. Each hit refreshes its cell and makes it the track's newest voice. Voices
that expired before the hit give up their place. Above the cap, the oldest voice is evicted at that hit's
block. At `currentBlock` a cell is alive when `currentBlock − lastBlock < 128` and it was not evicted after
its last hit. It returns the 16 alive step words (the same bit layout as `pattern()`), each cell's age and
remaining blocks, and the cells evicted in the last 2 bars. It is deterministic and does not depend on
input order.

- Off-by-one: a hit at block B sounds on B, B+16, …, B+112 (8 plays, the landing included) and is dark at
  B+128. The stage audio evaluates the layer at `head + 1`, because the engine schedules a step just before
  its block, so a note is never heard a ninth time.
- Bounded cost: only hits at or after `currentBlock − 2·lifetime − fade` can change the result (a live cell
  was hit within one lifetime, and its eviction depends only on the voices of the lifetime before that). The
  replay starts there, found by binary search on the feed's sorted history. A scratch cross-check against a
  full replay on 3000 blocks of random traffic, with caps 0, 2 and 6, gave 237/237 identical results.
- Fade: the stage draws a live note at full light until its last 2 bars. After that its opacity and glow
  fall linearly with the blocks left. With `prefers-reduced-motion` the fade steps once per bar and has no
  transition. An evicted note goes silent at once, and its colour fades out over 2 bars ("making room for
  newer notes" in its aria label).

### Where the hits come from

- Web feed: it keeps a history keyed by `txHash:logIndex`, sorted by (blockNumber, logIndex). After
  `pattern()` and `getSession()` it backfills with `eth_getLogs` in 100-block chunks, newest first, and only
  the replay window: 2 lifetimes + fade + 16 = 304 blocks, 4 requests whatever the session's age. Nothing older
  can change what plays. The public RPC refuses a 1000-block range, and 100 blocks take ~300 ms (testnet
  probe). A full backfill of a two-hour session took 70 s, and we saw the agent spend 63 s on one,
  so neither is done. Phones also filter by their own address, after a random 0–1.5 s delay so 60 phones do
  not start in the same second.
- Backfilled hits only enter the history. They never bump `hitCount` or fire `onHit`, because the phone's
  hit sender resolves taps from `onHit` and the live stream keeps its own dedupe.
- Every resync (WS drop, or every 10 s while polling) reads again from 16 blocks below the last scanned
  block to the head. A lagging load-balanced node cannot leave a hole, and the dedupe makes the overlap
  free.
- Phones run no block clock. They estimate the head from the feed's `headHint` (the newest block seen, and
  when) at 300 ms per block. Only the strip re-renders, once a block.
- DJ agent: it uses the getLogs ledger it already had, now with block and log index, and the same shared
  function. Its first scan also starts at the replay window. Recorded owners older than that are unknown and
  read as human, which is the safe side. It evaluates the layer at the block where the bar it plans starts. A
  plan that comes back after a send block has passed moves those notes to the following bar instead of
  dropping them.

### The DJ as curator

The DJ never removes a note, since with the live semantics no hit can. It keeps a groove floor:

- While the live grid, including its own pending hits, holds fewer than 12 notes, it adds
  `min(3, ceil((12 − live) / 4))` notes. From 12 notes up it adds nothing, and an LLM brain is not even
  called.
- It picks from the backbone in order: kick 0, clap 4, hat 2, bass root 0, kick 8, clap 12, hats 6/10/14.
- Only on open tracks: with the cap K, a track is open while it holds fewer than K/2 live notes (its own
  notes count), so a DJ note never evicts a human note. Empty tracks go first. Without a cap, open means
  tracks the room is not playing.
- Its own notes decay too, so the backbone comes back when it has faded.
- It never XORs off a human's recorded bit. When a human set the target's recorded bit, it plays the
  nearest free note variant instead, so the NFT keeps every human note.
- Rules, OpenAI and Anthropic brains all plan on the live grid. `sanitizeAdditions` enforces the rules for
  whichever brain produced the plan. The LLM prompt says notes fade after 8 bars and the DJ keeps the floor.
  The budget, the kill switch, the stop at finalize and brain selection are unchanged.

### Knobs

| Variable | Default | 0 means | Read by |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_NOTE_LIFETIME_BARS` | 8 | no decay: everything plays the recorded pattern, exactly as before (no backfill) | stage, phones, DJ (the stage passes it to a DJ it spawns) |
| `NEXT_PUBLIC_MAX_LIVE_PER_TRACK` | 6 | no voice cap | same |

Next inlines `NEXT_PUBLIC_*` at build time: after a change, restart `next dev` or rebuild. The agent reads
the same names, so it cannot plan on a grid the room does not hear.

## Consequences

- Positive: the grid never saturates. At a peak of ~7 hits/s, decay alone keeps ~87 % of the step×track
  cells lit (architect review), and the cap holds it at ≤ 48 of 128 (`decay.test.ts`, 60-player room).
  Every tap is heard, the room hears the music move, and nothing changes on chain.
- The recorded NFT and the sound differ: a refresh XORs the recorded bit, so re-tapped cells flip in the
  NFT. This is accepted and labelled ("Recorded pattern: every note the room played").
- Remixes: bits copied from the parent have no `Hit` logs, so a remix starts silent in the live layer. The
  bits are in the recorded layer, and the room plays the remix back in.
- Cost: every device makes 4 getLogs calls on start, then one catch-up per resync. The history is kept in
  memory for the page's life (a few thousand hits at most).
- The DJ may treat an old agent-set recorded bit as human and play a note variant there. That costs a
  different sample, never a human note.
