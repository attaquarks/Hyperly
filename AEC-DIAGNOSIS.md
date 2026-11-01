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
