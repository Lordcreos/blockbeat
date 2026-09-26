# ADR 0002 — The DJ plays phrases: a key, a set, and a target to build toward

- Status: accepted (2026-09-25).
- Code: `apps/agent/src/lib/music/{theory,arrangement,phrase}.ts`, `apps/agent/src/lib/brain/{rules,llm,types}.ts`, `apps/agent/src/lib/chain.ts` (batched send), `packages/shared/src/voicing.ts` (note layout contract).
- Builds on: [ADR 0001](0001-note-decay.md) (live layer: a note rings 8 bars after its last hit, at most 6 live notes per track).
- Evidence: [w17-dj-phrases](../evidence/w17-dj-phrases/README.md).

## Context

Until now the DJ added 1 to 3 isolated backbone notes per bar, and only while the live grid held fewer than 12 notes. The room heard a click here and there, not a track. The physics have not changed:

- The loop is 16 steps. A step is one 300 ms block, so a bar is 4.8 s.
- Every note is a transaction (0.02 MON for the first, 0.01 after), and the contract is frozen.
- A note repeats every bar for 8 bars, then goes dark. The DJ cannot remove a note.
- A track keeps at most 6 live notes. A 7th hit evicts the oldest note, and it may belong to a human.
- The LLM (gpt-6-luna, reasoning effort none) answers in about 2 s, and the loop plans the next bar.

## Decision

### 1. Harmony lives inside the loop, in one key for the whole session

A note laid down now still rings 8 bars later, so a progression that changed chord every bar would clash with itself. Instead, the 4-chord progression spans the 16 steps, one chord per 4 steps. By default that is A minor, i-VI-III-VII = Am-F-C-G. The key and progression stay fixed (`AGENT_KEY`, default `A minor`, because every pitched voice in the kit is tuned to A).

The theory module works out pitches from the kit's note layout (bass and lead: semitone above A plus a timbre bit; pad: root A2..E3 × chord type). That layout is now a shared contract in `@blockbeat/shared` `voicing.ts`. `apps/agent/src/lib/music/voicing.contract.test.ts` checks it against the stage kit's `noteVariant`, imported read-only.

The pad cannot reach an F or G root, so a scoring function picks the best voicing for each chord from all 32. It counts shared tones, penalises tones outside the key, and gives a bonus for the chord's own root. The result: Am → Am7, F → Dm7 (F6 over the F bass, as the architect pointed out), C → Cmaj7, G → Em7 (G6).

### 2. A deterministic set: intro 4, build 4, peak 8, breakdown 4

The set is counted from the first bar the DJ plays (`AGENT_SET_START_BAR` can open it later, for example on the peak). It is a 20-bar cycle. Each section has a job and a set of tracks:

| Section | Bars | Tracks | Target |
| --- | --- | --- | --- |
| intro | 4 | kick, clap | kick 0, 8 · clap 4, 12 |
| build | 4 | + hat, bass | kicks 4, 12 at once, hats a bar later, the bass root pulse (Am-F-C-G roots on 0, 4, 8, 12) a bar after that |
| peak | 8 | + snare, lead, pad | four kicks, claps, a 6-note bass line (octave bounce or walk, following each step's chord), pad chords on 0/4/8/12, hats, snare ghosts, open hat, a lead motif |
| breakdown | 4 | pad, lead, fx | pad chords, the lead call plus its inverted answer in the other half of the bar, an fx sweep |

The status line reads `section build · A minor · Am-F-C-G`. The brain gets the same section, key and progression.

### 3. A phrase is the most important part of the target that is missing

Every section has a target arrangement, ordered by priority. Each bar, the phrase is the top N target notes that the live grid is missing, where N = `AGENT_MAX_NOTES_PER_BAR` (default 8). N is scaled down when the room is busy: with 8 or more human live notes ×0.75, 16 or more ×0.5, 28 or more ×0.25. The budget also caps it.

Target-diffing is idempotent and heals itself. The groove builds over a few bars, then the DJ goes quiet while it rings, and re-lays each note as it goes dark.

There is a boundary bug to watch for (architect review). A cell counts as missing when its note goes dark before its step plays in the planned bar (`remainingBlocks ≤ step + 1`). Without that rule, every note would drop out for a bar every 8 bars.

The choices that shape a track's target are held for the whole cycle: bass template, motif and variation (none / transpose +2 / invert / shift +1), and the call-and-response half. Notes ring for 8 bars, so a target that changed bar by bar would stack two motifs.

### 4. One gate for every brain

Rules and LLM phrases alike pass through `sanitizePhrase`. It enforces these rules:

- The note is in range, and pitched notes are snapped to the key.
- One note per cell, and only on a cell that is not sounding.
- The live notes on a track plus the phrase never go over the cap of 6. On a track a human is playing, the limit is cap − 1, so a tap never has to evict anyone.
- The DJ stays off a track the room holds (3 or more human notes).
- Only the section's tracks are played. The first live call put bass in the intro, which is why this rule exists.
- No drum or bass note may ring more than 2 bars into the breakdown. That means the peak thins over its last bars and the breakdown is clean, even though the DJ cannot remove anything.
- A human's recorded bit is never XORed, and a note is never placed next to the same note on a neighbouring step (the ±1-block drift guard, both against the grid and inside the phrase). When a note is blocked, a pitch-preserving variant is used instead: bass and lead flip the timbre bit or take the octave; drums change their decay bits first.

Every dropped note is logged with its reason, and the raw LLM answer goes to a debug log (`AGENT_DEBUG_LLM=1`). If an LLM answer sanitises to zero, the rules phrase plays that bar instead.

### 5. The LLM picks from a menu

The LLM gets the section, the key, the chord for each step, a pitch table (the note numbers that sound in key), the live grid, the voices left on each track, and the rules phrase for this bar. That phrase is already valid, and the prompt says how many target notes are missing. The LLM answers `{"phrase":[{step,track,note,role}]}` under a strict schema: at most 8 notes, and roles from an enum.

In the earlier 10-call check, 3 answers came out of sanitisation with no notes. With this prompt the same check (10 calls, spread across all sections) had 0 of 10 sanitised to zero, and 66 of 70 notes kept. The LLM is not called when the section needs nothing this bar.

### 6. The notes of one step go out in one ordered batch

A downbeat carries kick, bass and pad, so 3 or 4 notes share one send block. The old path used one `writeContract` round trip after another, so the later notes landed one or two blocks late.

The notes of one step are now signed locally with consecutive nonces. The nonce comes from a local counter, read once from the pending count, and read again after any rejected broadcast so a gap never stalls the queue. The signed transactions go out in one JSON-RPC batch; the Monad public RPC accepts batches (probed). Each note is still sent at its own `targetBlock − lead`.

Confirmations report the MON charged: the gas limit × the effective gas price, because Monad charges the gas limit. The status line shows `sent`, `on-step` and `MON`.

## Consequences

- **Positive.** Even without an LLM, the DJ plays a track that builds. The 16-bar render has kick and clap, then hats, then a bass line on Am-F-C-G, then pads and a lead, going from 4 to 27 notes a bar ([phrase-demo.wav](../evidence/w17-dj-phrases/phrase-demo.wav)).
  - On testnet session 8, 8 bars cost 30 hits and 0.3264 MON, and 80 % of hits landed on the intended step. A 3-bar re-run on the final code sent 23 hits for 0.2346 MON, 91 % on step, with the two-note steps landing together.
- **Cost.** About 45 hits per 20-bar cycle in an empty room, so the default budget of 160 lasts about 6 minutes (about 1.6 MON). A busy room makes the DJ play fewer notes.
- **Accepted.** The peak thins over its last 3 bars, because notes laid down late would ring through the breakdown. The strict breakdown is the price of an audible drop.
- **Accepted.** A DJ refresh re-hits the DJ's own cell and clears its recorded bit. It is logged as a refresh, not a toggle-off. Human bits are never touched.
- **Latency.** The phrase prompt answers in p50 1.8 s and p95 3.6 s (the earlier shorter prompt: 1.3 s and 2.3 s). On testnet, 1 of 6 calls ran past 4 s and that bar played the rules phrase. Notes from an answer that arrives after their send block move one bar on.
- **Not solved here (web).** Phone taps on bass and lead are chromatic over 16 semitones, so they can clash with the key. Keeping the room in key would mean restricting the phone pads to scale notes. That is a web change.
- **Open.** A head stall on the websocket made the scheduler's existing fallback timer send one note 2 blocks early (testnet session 8). The drift guard covers ±1 block, not ±2.
