# AEC-DIAGNOSIS — Reference FIFO overflow → bypass

Written before touching any code, per handoff Phase A. Repo state: `main` @ `b8649ec`,
baseline re-confirmed this session: **21/21 guards PASS, `tsc` clean** (after restoring the
missing `node_modules`; the initial 6 guard failures were `ERR_MODULE_NOT_FOUND: vite`,
an environment defect, not a code regression).

---

## 1. The true arrival rate (handoff §7-A, checked, not assumed)

**Producer (Rust → JS):** the WASAPI loopback capture thread is event-driven
(`src-tauri/src/speaker/windows.rs:248` — `wait_for_event` per device period), so chunks
reach the reference worker at realtime. `run_reference_worker`
(`src-tauri/src/speaker/reference.rs:319-376`) blocks on `recv_timeout` and emits one
320-sample frame per 20 ms of captured audio → **50 frames/s = 16,000 samples/s**.

> The handoff's literal hypothesis — "the Rust tap drains its queue and emits 16 kHz
> frames faster than realtime" — is **disproven**. A plain loop over a channel that is
> fed by a realtime event-driven capture is itself realtime-paced on average; the worker
> cannot emit samples faster than WASAPI produces them, and the 129-tap sinc resample of
> a 1024-sample chunk is sub-millisecond, so the worker never becomes the bottleneck.

**Consumer (JS):** `mic-aec-worklet.js:103-124` accumulates one 16 kHz mic sample per
`sampleRate/16000` context samples (≈3 at 48 kHz) and posts a 256-sample hop every 16 ms
→ 62.5 hops/s. Each hop calls `takeRef(256)` (`mic-aec.ts:307`) → **16,000 samples/s**.

**The framing mismatch (320-sample frames vs 256-sample hops) is NOT a rate bug.**
Both sides run at exactly 16,000 samples/s; `takeRef` spans partial frames correctly via
`QueuedFrame.offset` (`reference.ts:113-130`). Rates match on average — which is itself
the problem:

> **Zero-drift queue:** production rate ≡ consumption rate, so the FIFO level has no
> restoring force. Whatever depth exists at the first hop is the depth forever (±drift).
> It can only ratchet up.

## 2. Why `depth 10` is pinned and never drains

`takeRef` does not exist until the AudioWorklet bridge is wired, which happens *after*
worker load + `waitForReferenceBuffer` (`mic-aec.ts:246-262`). Everything the feed
receives between channel connect and the first hop accumulates unconsumed. In the live
run that was ~200 ms of audio → 10 frames → `refDelayMs: 200` at activation, then zero
drift pins `depth 10` for the whole session. This matches the telemetry exactly.

## 3. The fatal dynamic — one stall = eleven strikes

Frames arrive on the WebView **main thread** via the Tauri Channel
(`reference-channel.ts:6-10`). The consumer (`bridge.port.onmessage` → `takeRef`) runs on
the **same thread**, so during a main-thread stall (GC, React render, GC-in-IPC — the
observed transit σ swings 7 → 336 → 9 ms) *nothing drains*: delivery pauses AND
consumption pauses. When the stall ends, the queued IPC messages flush as a burst that
lands entirely on top of the standing backlog.

Numbers: backlog 10 frames + a 336 ms stall (~21 frames at 16 kHz). The first 10 fill
the headroom (capacity 20); the remaining ~11 arrive into a full FIFO where the current
policy drops exactly ONE oldest frame **per arriving frame**, counting one overflow each
(`reference.ts:198-204`) → **~11 overflow counts from a single stall episode**.

The ladder (`recovery.ts:9-14`) sums counts and bypasses when the total exceeds 4 → the
**first** stall of >200 ms bypasses the AEC. That is precisely the observed failure:
`[mic] aec: {"state":"active",...,"hops":0}` → `[aec] bypass (overload): Reference FIFO
overflow recurred`, with the bypass landing right after the σ=336.2 ms reading. Startup
is the worst possible time for this: worker load, render, and console spam make big
stalls most likely exactly when `hops` is still 0–1.

## 4. Root cause (one sentence)

The reference FIFO has no flow control that survives an arrival burst: a zero-drift queue
with a 200 ms pre-activation backlog and a drop-one-per-frame overflow policy converts
one routine ~336 ms delivery burst into ~11 overflow strikes, and the recovery ladder
(working as designed) then bypasses.

**Why previous attempts failed:** Step 5 (`1e7fbfa` "pace reference FIFO to prevent
overflow bypass") changed only `recovery.ts` tolerance (1→4) and briefly the FIFO
capacity (10→40, later re-pinned to 20 by `ec59aec`/`6bf0a6f`). It tuned the ladder and
the bucket size, never the flow. There is no pacing defect to fix in Rust — the flow
defect is the JS FIFO's overflow granularity.

**Engine ruled out:** bypass fires at `hops 0–1`, before meaningful inference; the model
is measured at 13.84 dB ERLE / 4.39× realtime offline. Plumbing, not engine.

## 5. The minimal fix (flow, not ladder; one file)

In `AecReferenceFeed.receive()` (`reference.ts`), treat a full-FIFO event as **one
episode**: drain the oldest frames down to a target depth of 10 frames (= 200 ms, the
top of the declared 100–200 ms `refDelayMs` band), count **one** overflow, mark **one**
gap. Concretely: inside the existing `if (this.frames.size >= FIFO_CAPACITY)` block,
replace the single-oldest drop with a loop that trims to `FIFO_TARGET_DEPTH`, keeping
`this.status.overflows += 1` and `this.pendingGap = true` executed once per episode.

Effect:

| Burst (stall) size | Today | After fix |
|---|---|---|
| ≤ 200 ms (≤10 frames) | no overflow | no overflow (headroom unchanged) |
| 336 ms (~21 frames) | ~11 counts → instant bypass | **1 count + 1 gap → stays active** |
| ≥ 1 s (sustained) | instant bypass | a few counts → ladder still bypasses (honest) |

- Steady-state depth returns to 10 → `refDelayMs` = 200 ms, inside the declared band;
  the first episode also lazily trims any oversized pre-activation backlog into the band.
- `recovery.ts`, `mic-aec.ts`, the Rust tap, and the byte-identical bypass path are
  untouched. No guard weakened: the overflow block still counts, drops oldest, and
  signals the discontinuity (`aec-pipeline-check.ts:94-96`).
- Each episode is a reference-side discontinuity, so the filter re-adapts via the
  existing `consumeGap()` → worker `reset` path — degradation, never bypass, for
  bursty-but-alive reference delivery.

## 6. Runtime acceptance (handoff Phase C — requires the human)

Static checks cannot prove this (that is how we got here). The human must run
`npm run tauri`, open devtools, start Listen with mic ON, and confirm:

1. `[mic] aec: {"state":"active",...}` with `hops` climbing for minutes — no
   `bypass (overload)`.
2. `[aec] ref 16k, ... depth ≤ 10` with σ not exploding to 300+ ms persistently.
3. The acceptance test: play system audio while speaking → **no System text under the
   `User` label**.

---

## 7. Runtime validation round 1 (live log, 2026-11-01) — reference fix CONFIRMED, next layer exposed

The human ran a live session with the episode-trim fix. Results:

**The reference overflow bypass is gone.** No `Reference FIFO overflow recurred` in the
entire log. Depth now sawtooths 10↔20 (burst → episode trim → refill) instead of pinning,
and σ recovers to ~7–10 ms once startup contention passes — the flow fix behaves as
designed. The user's headphone test also confirms routing/labels are correct end to end:
with no acoustic path (headphones), `User` and `System` separate perfectly.

**New failure layer: `LocalVQE worker queue overrun` at `hops:0`** (`mic-aec.ts`,
`pending.size >= 2`). `loadModel()` posts `"ready"` once the model is *constructed*
(`localvqe-worker.ts:150`), but the **first** `processFrame` call pays one-time WASM
lazy-init/JIT cost far above the two-deep queue's 32 ms budget (2 × 16 ms hops). Hop 0
starts a slow first inference, hop 1 queues behind it, hop 2 arrives → instant bypass.
This layer was previously unreachable — the reference overflow killed the session first.

**Band violation at activation:** `refDelayMs` was 220 ms and 340 ms across the two
sessions (band: 100–200 ms). The pre-activation backlog scales with startup latency and
the zero-drift FIFO would keep it — and its misalignment — forever.

**Fixes for this layer (same principles: flow, not policy; bypass untouched):**

1. **Engine warmup during activation** (`mic-aec.ts`): after `"ready"` and before the
   live bridge is wired, drive 3 silent hops through the worker and await the results.
   The first-call JIT cost is paid while the mic route is still raw pass-through, so the
   wait is free and `pending.size >= 2` gets its full 32 ms budget at steady state
   (~3.6 ms/hop measured offline → ~9× headroom). Warmup failure → `init-failed`
   bypass, as with any other activation failure.
2. **`AecReferenceFeed.trimExcess()`** (`reference.ts`): clamps the buffered backlog to
   `FIFO_TARGET_DEPTH` (10 frames = 200 ms). Called once at activation after
   `waitForReferenceBuffer`. Not an overflow — no count, no gap: the consumer never saw
   the dropped span, so the reference the AEC reads stays internally contiguous.

Both keep `recovery.ts`, the ladder, the Rust tap, and the byte-identical bypass path
untouched. Runtime round 2 still required: same three checks as §6.

---

## 8. Runtime round 2 + engine bench (2026-11-01) — delivery starvation identified

Round 2 failed identically: `LocalVQE worker queue overrun` at `hops:0` in all three
sessions, *after* a successful warmup (no `init-failed`; `refDelayMs` 220/200/200
confirms `trimExcess` ran). Since the first-call cost was already paid, the bypass was
not warmup and — per the bench below — not the engine.

**Engine bench (Node, this machine, vendored assets, engine framing mirrored):**
`avg 3.27 ms/hop, p50 3.05, p95 4.95, max 10.82` vs a 16 ms hop budget → **4.90×
realtime at 1 thread**. The offline 4.39× claim holds. The engine is exonerated
definitively; the bench script lives outside the repo (temp) and can be re-run on
demand.

**Remaining kill-switches, both driven by main-thread contention (log σ = 62–200 ms,
sustained — React renders, Tauri IPC, b64 WAV encoding for partial transcripts):**

1. `pending.size >= 2` (2-deep in-flight cap, 32 ms) — with the engine fast, in-flight
   depth beyond 2 is result-*pickup* delay on the main thread. Any adverse interleaving
   of hop-port vs worker-port tasks during a stall trips it.
2. Worklet output underrun: a stall > ~80 ms drains the 64 ms output preroll →
   `output-queue-underrun` fault → session bypass. Same disease: scheduling jitter
   treated as fatal.

**Round-3 fix (flow, not policy; bypass kept for real failures):**

- In-flight cap 2 → 4; beyond it, the hop is **concealed** (worklet inserts silence for
  the id, `skippedOutputIds` flushed in strict id order, `pendingMicGap` resets the
  filter on the next posted hop) instead of bypassing. Bypass only at **16 concealed
  hops within 5 s** — a genuinely slow engine drops ~37 hops/s and dies honestly in
  under a second; a stall burst stays far below.
- Worklet output underrun → **raw mic pass-through for that render + preroll re-arm**
  (byte-identical to a temporary bypass) instead of latching bypass; startup preroll
  also passes raw mic instead of dead air.
- New 1 Hz dev telemetry: `[aec] hop rtt avg Xms max Yms in-flight N concealed K/5s` —
  round 3's log will show which regime is actually running.

Ladder and reference episode-trim untouched; guards unchanged (nothing pinned the 2-cap
or the underrun fault).

---

## 9. Runtime rounds 4 (cap raise) and 5 (gap-wipe) — 2026-11-02

**Round 4 log (cap 16):** sessions ran clean (`concealed 0/5s`, depth stable 10–12,
rtt healthy) then died via `Reference FIFO underrun`. One session died at hop ~1 with
an 11-frame backlog — only an instant FIFO wipe explains that. The wipe existed:
`receive()` called `frames.clear()` on a **sequence gap**, discarding ~200 ms of
contiguous buffered audio because one frame went missing; the next hop found an empty
FIFO and bypassed. `sequenceGaps` was never logged, so the wipe was invisible.

**Round-5 fix (`19b3c22`):**

- `receive()`: a sequence gap no longer clears the FIFO. The pre-gap backlog is
  contiguous and valid; the gap flag resets the filter when the next hop consumes.
- `takeRef` underrun conceals the hop (silence + next-hop filter reset) instead of
  bypassing; a genuinely dead feed is still caught by the ready-state check. Both
  concealment paths share a single `concealHop()` and the 16-in-5s honest bypass.
- Ref telemetry now prints `gaps/overflows/underruns` counts.
- Guard updated: the old pin required `pendingGap = true; frames.clear();` — it now
  pins that a gap marks the discontinuity **and keeps** the buffered audio. The
  guard's intent (discontinuity → filter reset) is unchanged; its mechanism contract
  now encodes this defect.

**Round-5 validation targets:** `[mic] aec:` stays `active` for minutes; `concealed`
near 0; the ref line's `gaps`/`underruns` counters reveal whether frame loss still
occurs (harmless now, but if `gaps` climbs steadily the upstream drop source — Rust
tap or IPC — deserves its own investigation).

---

## 10. Runtime round 5 → 6 (2026-11-02) — last transient kill-switch removed

Round-5 log: ~7 s clean (`gaps 0`, depth pinned 10–12, rtt healthy), 3
reference-underrun conceals absorbed at a wake burst, then death via the worklet's
`output-queue-overrun` fault — the catch-up burst after a ~200 ms stall (rtt max
199 ms) pushed the output queue past its 250 ms bound. A transient *recovery
overshoot* was still fatal.

**Round-6 fix (`7cebfba`):** the worklet now sheds the **oldest** output down to the
bound when it overshoots (standard jitter-buffer resync — the backlog exists because
the pipeline fell behind; the oldest output is the least valuable) instead of
bypassing. Position bookkeeping follows the splice; both the processed and dropped
message paths use the same shed. Guard unchanged (nothing pinned the overrun fault).

**Post-bypass `overflows 1→34` in the log is expected:** with no consumer, the
episode trim cycles at capacity once per fill; the counts are harmless.

**Remaining bypass triggers after this fix are all genuine faults:** worker errors
after the recovery reset, mic-hop sequence gaps, a dead reference feed (ready-state
check), the sustained concealment budget (16 in 5 s), mic source changes, and
activation failures. No transient scheduling event should be able to kill a session.
