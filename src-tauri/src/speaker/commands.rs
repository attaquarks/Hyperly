// Hyperly AI Speech Detection, and capture system audio (speaker output) as a stream of f32 samples.
use crate::speaker::{AudioDevice, ReferenceFrame, ReferenceStream, ReferenceTap, SpeakerInput};
use anyhow::Result;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use futures_util::StreamExt;
use hound::{WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tauri_plugin_shell::ShellExt;
use tracing::{error, warn};

// VAD Configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VadConfig {
    pub enabled: bool,
    pub hop_size: usize,
    pub sensitivity_rms: f32,
    /// Voice sensitivity, 0.0-1.0. Scales both terms of the adaptive threshold
    /// — see the comment on it in `run_vad_capture`. 0.5 is the tuned default.
    /// `#[serde(default)]` so a payload saved before this field existed (under
    /// its old name `peak_threshold`, which was never a real control) still
    /// deserializes instead of failing the command.
    #[serde(default = "default_voice_sensitivity")]
    pub voice_sensitivity: f32,
    pub silence_chunks: usize,
    pub min_speech_chunks: usize,
    pub pre_speech_chunks: usize,
    pub noise_gate_threshold: f32,
    pub max_recording_duration_secs: u64,
}

/// Midpoint of the Voice Sensitivity range: the value at which the adaptive
/// threshold reproduces the constants this VAD was tuned with.
fn default_voice_sensitivity() -> f32 {
    0.5
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            hop_size: 1024,
            sensitivity_rms: 0.012, // Much less sensitive - only real speech
            voice_sensitivity: default_voice_sensitivity(),
            silence_chunks: 94, // mirror of TURN_HANGOVER_MS @48k; not read (see run_vad_capture)
            min_speech_chunks: 7,   // ~0.16s - captures short answers
            pre_speech_chunks: 12,  // ~0.27s - enough to catch word start
            noise_gate_threshold: 0.003, // Stronger noise filtering
            max_recording_duration_secs: 180, // 3 minutes default
        }
    }
}

#[tauri::command]
pub async fn start_system_audio_capture(
    app: AppHandle,
    vad_config: Option<VadConfig>,
    device_id: Option<String>,
) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();

    // Check if already capturing (atomic check)
    {
        let guard = state
            .stream_task
            .lock()
            .map_err(|e| format!("Failed to acquire lock: {}", e))?;

        if guard.is_some() {
            warn!("Capture already running");
            return Err("Capture already running".to_string());
        }
    }

    // Update VAD config if provided
    if let Some(config) = vad_config {
        let mut vad_cfg = state
            .vad_config
            .lock()
            .map_err(|e| format!("Failed to acquire VAD config lock: {}", e))?;
        *vad_cfg = config;
    }

    let input = SpeakerInput::new_with_device(device_id).map_err(|e| {
        error!("Failed to create speaker input: {}", e);
        format!("Failed to access system audio: {}", e)
    })?;

    let raw_stream = input.stream();
    let sr = raw_stream.sample_rate();

    // Validate sample rate
    if !(8000..=96000).contains(&sr) {
        error!("Invalid sample rate: {}", sr);
        return Err(format!(
            "Invalid sample rate: {}. Expected 8000-96000 Hz",
            sr
        ));
    }

    // This adapter copies raw samples into a bounded side FIFO while yielding
    // each original sample unchanged to the existing capture path.
    let stream = ReferenceStream::new(raw_stream, Arc::clone(&state.reference_tap));

    let app_clone = app.clone();
    let vad_config = state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to read VAD config: {}", e))?
        .clone();

    // Mark as capturing BEFORE spawning task
    *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to set capturing state: {}", e))? = true;
    *state
        .capture_sample_rate
        .lock()
        .map_err(|e| format!("Failed to store capture sample rate: {}", e))? = Some(sr);

    // Emit capture started event
    let _ = app_clone.emit("capture-started", sr);

    let state_clone = app.state::<crate::AudioState>();
    let stop_flag = Arc::clone(&state_clone.stop_requested);
    let task = tokio::spawn(async move {
        if vad_config.enabled {
            run_vad_capture(app_clone.clone(), stream, sr, vad_config, stop_flag).await;
        } else {
            run_continuous_capture(app_clone.clone(), stream, sr, vad_config).await;
        }

        let state = app_clone.state::<crate::AudioState>();
        stop_reference_tap(&state);
        if let Ok(mut sample_rate) = state.capture_sample_rate.lock() {
            *sample_rate = None;
        }
        {
            if let Ok(mut guard) = state.stream_task.lock() {
                *guard = None;
            };
        }
    });

    *state_clone
        .stream_task
        .lock()
        .map_err(|e| format!("Failed to store task: {}", e))? = Some(task);

    Ok(())
}

/// Start the raw loopback reference Channel for the currently running system
/// capture. The tee is installed before capture starts and can be enabled at
/// any point while that capture is running.
#[tauri::command]
pub async fn start_aec_reference(
    app: AppHandle,
    channel: Channel<ReferenceFrame>,
) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();
    let is_capturing = *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to read capture state: {}", e))?;
    if !is_capturing {
        return Err("System audio capture must be running before starting the AEC reference".into());
    }
    let sample_rate = state
        .capture_sample_rate
        .lock()
        .map_err(|e| format!("Failed to read capture sample rate: {}", e))?
        .ok_or_else(|| "System audio sample rate is not available".to_string())?;

    let tap = ReferenceTap::start(channel, sample_rate);
    let previous = state
        .reference_tap
        .lock()
        .map_err(|e| format!("Failed to update reference tap: {}", e))?
        .replace(tap);
    if let Some(previous) = previous {
        previous.stop();
    }
    Ok(())
}

/// Stop the reference tee without stopping system-audio transcription.
#[tauri::command]
pub async fn stop_aec_reference(app: AppHandle) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();
    stop_reference_tap(&state);
    Ok(())
}

fn stop_reference_tap(state: &crate::AudioState) {
    let tap = state
        .reference_tap
        .lock()
        .ok()
        .and_then(|mut slot| slot.take());
    if let Some(tap) = tap {
        tap.stop();
    }
}

// VAD-enabled capture - OPTIMIZED for real-time speech detection
// Adaptive VAD tuning. See the threshold comment inside `run_vad_capture`.
/// How far energy must fall from the recent speech level toward the noise
/// floor before the utterance is treated as paused — at the default Voice
/// Sensitivity (0.5). The slider scales this: see `run_vad_capture`. The
/// lowest value that still found a pause under a music bed in simulation, so
/// the least likely to chop continuous speech into fragments.
const DROP_RATIO: f32 = 0.35;
/// Noise floor chase rates (per chunk). Fast downward, very slow upward.
const FLOOR_FALL: f32 = 0.05;
const FLOOR_RISE: f32 = 0.0005;
/// Decay of the recent-speech reference, so old loud passages are forgotten.
const REF_DECAY: f32 = 0.997;

/// Trailing silence that finalizes a turn, in milliseconds. Mirrored by
/// `TURN_HANGOVER_MS` in src/lib/turn-boundary.ts; `scripts/turn-boundary-check.ts`
/// fails if the two disagree. The UX contract behind the number: a pause of up
/// to ~1 s must not split a turn — humans pause mid-sentence while thinking —
/// so both sources sit at 1200 ms, comfortably above 1 s while cutting the
/// old 2000 ms finalize lag by 800 ms.
pub const TURN_HANGOVER_MS: u64 = 1200;

/// How often a live delta partial is emitted, in ms of NEW speech. The old
/// cadence was 2000 ms AND each partial re-emitted the whole utterance buffer,
/// so the live transcript lagged speech by 2 s + a growing upload. 600 ms of
/// new audio per partial keeps the live text sub-second behind the voice at a
/// constant, tiny payload (see `resample_to_stt_rate`).
pub const PARTIAL_INTERVAL_MS: u64 = 600;

/// All audio sent to the cloud STT provider is downsampled to 16 kHz mono
/// before the WAV encode. Speech recognition never uses more bandwidth, and
/// every provider resamples to this internally anyway — 48 kHz payloads only
/// inflated the base64 crossing the IPC bridge and the upload 3×.
pub const STT_SAMPLE_RATE: u32 = 16000;

/// The hangover expressed in hop-size chunks for a given sample rate, rounded
/// **up** so the effective silence never falls short of `TURN_HANGOVER_MS`
/// (93.75 chunks at 48 kHz would finalize at 1984 ms; 94 lands on 2005 ms).
pub(crate) fn silence_chunks_for(sample_rate: u32, hop_size: usize) -> usize {
    let samples = sample_rate as u64 * TURN_HANGOVER_MS / 1000;
    let hop = (hop_size as u64).max(1);
    ((samples + hop - 1) / hop).max(1) as usize
}

/// One step of the resettable hangover: any speech restarts the countdown.
pub(crate) fn next_silence_count(current: usize, is_speech: bool) -> usize {
    if is_speech {
        0
    } else {
        current + 1
    }
}

#[cfg(test)]
mod utterance_prepare_tests {
    use super::*;

    const SR: u32 = 48_000;

    #[test]
    fn too_short_is_discarded() {
        // min_speech_chunks = 10 chunks ≈ 213 ms of speech at 48 kHz/1024.
        let buffer = vec![0.5f32; 5 * 1024];
        assert_eq!(prepare_utterance(&buffer, 0, 5, 10, SR), None);
    }

    #[test]
    fn trailing_silence_is_trimmed_but_a_150ms_tail_is_kept() {
        // 40 chunks of speech + 20 chunks of trailing silence; the trim keeps
        // exactly 0.15 s (7200 samples at 48 kHz) of that silence.
        let mut buffer = vec![0.5f32; 40 * 1024];
        buffer.extend(std::iter::repeat(0.0f32).take(20 * 1024));
        let out = prepare_utterance(&buffer, 20 * 1024, 40, 10, SR).expect("prepared");
        assert_eq!(out.len(), 40 * 1024 + 7200);
    }

    #[test]
    fn flush_on_stop_keeps_the_whole_open_utterance() {
        // The flush path passes the CURRENT silence accumulation as the trim;
        // mid-utterance that is smaller than the kept tail, so nothing but
        // actual trailing silence is cut — the words the user heard are all
        // there when the flushed utterance reaches the transcript.
        let speech = vec![0.5f32; 30 * 1024];
        let out = prepare_utterance(&speech, 3 * 1024, 30, 10, SR).expect("flush prepared");
        assert_eq!(out.len(), 30 * 1024);
    }
}

#[cfg(test)]
mod turn_boundary_tests {
    use super::*;

    /// Chunks a wall-clock pause covers at `sample_rate`/`hop_size`.
    fn pause_chunks(pause_ms: u64, sample_rate: u32, hop_size: usize) -> u64 {
        pause_ms * sample_rate as u64 / (1000 * hop_size as u64)
    }

    /// Drive the exact loop rule over a timeline of (is_speech, chunks)
    /// stretches and count finalized blocks: silence advances the counter, any
    /// speech restarts it, a block ends when the counter reaches the threshold.
    fn blocks_for(timeline: &[(bool, u64)], needed: usize) -> usize {
        let mut silence_chunks = 0usize;
        let mut in_speech = false;
        let mut blocks = 0usize;
        for &(is_speech, chunks) in timeline {
            for _ in 0..chunks {
                silence_chunks = next_silence_count(silence_chunks, is_speech);
                if is_speech {
                    in_speech = true;
                } else if in_speech && silence_chunks >= needed {
                    blocks += 1;
                    in_speech = false;
                    silence_chunks = 0;
                }
            }
        }
        blocks
    }

    const SR: u32 = 48000;
    const HOP: usize = 1024;

    #[test]
    fn hangover_is_derived_at_48k() {
        // ceil(57600 / 1024) = 57 chunks = 1216 ms: never short of 1200 ms.
        assert_eq!(silence_chunks_for(48000, 1024), 57);
    }

    #[test]
    fn hangover_is_derived_at_44_1k() {
        // 51.68 chunks rounds up to 52 = 1207 ms: never short of 1200 ms.
        assert_eq!(silence_chunks_for(44100, 1024), 52);
    }

    #[test]
    fn a_900ms_pause_yields_one_block() {
        // Below the 1200 ms hangover AND below the 1 s UX contract: mid-
        // sentence thinking pauses must not split the turn.
        let needed = silence_chunks_for(SR, HOP);
        let timeline = [
            (true, pause_chunks(2000, SR, HOP)),
            (false, pause_chunks(900, SR, HOP)),
            (true, pause_chunks(2000, SR, HOP)),
            (false, pause_chunks(30000, SR, HOP)),
        ];
        assert_eq!(blocks_for(&timeline, needed), 1);
    }

    #[test]
    fn a_2500ms_pause_yields_two_blocks() {
        let needed = silence_chunks_for(SR, HOP);
        let timeline = [
            (true, pause_chunks(2000, SR, HOP)),
            (false, pause_chunks(2500, SR, HOP)),
            (true, pause_chunks(2000, SR, HOP)),
            (false, pause_chunks(30000, SR, HOP)),
        ];
        assert_eq!(blocks_for(&timeline, needed), 2);
    }

    #[test]
    fn speech_restarts_the_pending_finalize() {
        // 1.1 s of silence stays below the 1.216 s threshold (but above the
        // 1 s contract, so the margin is real); resuming speech must cancel
        // the pending finalize instead of splitting the turn.
        let needed = silence_chunks_for(SR, HOP);
        let timeline = [
            (true, pause_chunks(2000, SR, HOP)),
            (false, pause_chunks(1100, SR, HOP)),
            (true, pause_chunks(400, SR, HOP)),
            (false, pause_chunks(30000, SR, HOP)),
        ];
        assert_eq!(blocks_for(&timeline, needed), 1);
    }

    #[test]
    fn after_a_cancelled_finalize_a_full_pause_still_splits() {
        // The 1.1 s pause adds no block (cancelled), the 2.1 s one does, and
        // the trailing recording closes the second block: two in total.
        let needed = silence_chunks_for(SR, HOP);
        let timeline = [
            (true, pause_chunks(2000, SR, HOP)),
            (false, pause_chunks(1100, SR, HOP)),
            (true, pause_chunks(400, SR, HOP)),
            (false, pause_chunks(2100, SR, HOP)),
            (true, pause_chunks(2000, SR, HOP)),
            (false, pause_chunks(30000, SR, HOP)),
        ];
        assert_eq!(blocks_for(&timeline, needed), 2);
    }
}

/// Pure utterance preparation shared by the three emit sites (the natural
/// silence path, the 30 s cap, and flush-on-stop): enforce the minimum speech
/// duration, trim trailing silence down to a kept ~0.15 s tail, and
/// normalize. Returns the utterance samples, or None when the buffer is too
/// short to be speech. Unit-tested because the flush-on-stop path depends on
/// exactly these rules.
fn prepare_utterance(
    buffer: &[f32],
    trim_samples: usize,
    speech_chunks: usize,
    min_speech_chunks: usize,
    sample_rate: u32,
) -> Option<Vec<f32>> {
    if speech_chunks < min_speech_chunks || buffer.is_empty() {
        return None;
    }

    let keep_silence_samples = (sample_rate as usize) * 15 / 100; // 0.15s
    let trim_amount = trim_samples.saturating_sub(keep_silence_samples);
    let trimmed_len = buffer.len().saturating_sub(trim_amount);
    Some(normalize_audio_level(&buffer[..trimmed_len.max(1)], 0.1))
}

/// Emit one utterance: prepare it (see `prepare_utterance`), encode, and send
/// as `speech-detected`. Returns true when an utterance was emitted; a buffer
/// that is too short sends `speech-discarded` instead so the UI knows why
/// nothing appeared.
fn emit_utterance(
    app: &AppHandle,
    sr: u32,
    trim_samples: usize,
    speech_chunks: usize,
    min_speech_chunks: usize,
    buffer: &[f32],
) -> bool {
    if buffer.is_empty() {
        return false;
    }
    match prepare_utterance(
        buffer,
        trim_samples,
        speech_chunks,
        min_speech_chunks,
        sr,
    ) {
        Some(normalized) => {
            // The final goes to the provider at the same 16 kHz the partials
            // use — the upload is 3× smaller and the provider resamples
            // internally anyway.
            let normalized_16k = resample_to_stt_rate(&normalized, sr);
            if let Ok(b64) = samples_to_wav_b64(STT_SAMPLE_RATE, &normalized_16k) {
                let _ = app.emit("speech-detected", b64);
                true
            } else {
                error!("Failed to encode speech to WAV");
                let _ = app.emit("audio-encoding-error", "Failed to encode speech");
                false
            }
        }
        None => {
            let _ = app.emit(
                "speech-discarded",
                "Audio too short (likely background noise)",
            );
            false
        }
    }
}

async fn run_vad_capture(
    app: AppHandle,
    stream: impl StreamExt<Item = f32> + Unpin,
    sr: u32,
    config: VadConfig,
    stop: Arc<AtomicBool>,
) {
    let mut stream = stream;
    let mut buffer: VecDeque<f32> = VecDeque::new();
    let mut pre_speech: VecDeque<f32> =
        VecDeque::with_capacity(config.pre_speech_chunks * config.hop_size);
    let mut speech_buffer = Vec::new();
    // speech_buffer length at the last partial emit; drives the ~2s cadence.
    let mut last_partial_mark = 0usize;
    let mut in_speech = false;
    let mut silence_chunks = 0;
    let mut speech_chunks = 0;
    // Phase 4 R1: the turn-finalization threshold, derived from
    // TURN_HANGOVER_MS and the live sample rate rather than read from the
    // config, so 44.1 and 48 kHz hangover is the same wall-clock span.
    let silence_needed = silence_chunks_for(sr, config.hop_size);
    // Adaptive VAD state: a slow estimate of this room's noise floor, and a
    // decaying reference of the recent speech level. Together they give a
    // speech/silence threshold that tracks the actual signal instead of
    // comparing against fixed constants.
    let mut noise_floor = 0.0f32;
    let mut speech_ref = 0.0f32;
    let mut energy_init = false;
    let max_samples = sr as usize * 30; // 30s safety cap per utterance

    // A fresh session always starts with the cooperative stop cleared: the
    // previous stop set it and nothing else resets it between captures.
    stop.store(false, Ordering::Release);

    // Stop checking happens per chunk (~21 ms at 48 kHz), so a stop pressed
    // mid-utterance flushes within one hop instead of waiting out the 2 s
    // hangover — or, worse, being aborted and dropping the tail entirely.
    'vad_loop: while let Some(sample) = stream.next().await {
        buffer.push_back(sample);

        // Process in fixed chunks for VAD analysis
        while buffer.len() >= config.hop_size {
            if stop.load(Ordering::Acquire) {
                break 'vad_loop;
            }

            let mut mono = Vec::with_capacity(config.hop_size);
            for _ in 0..config.hop_size {
                if let Some(v) = buffer.pop_front() {
                    mono.push(v);
                }
            }

            // Apply noise gate BEFORE VAD (critical for accuracy)
            let mono = apply_noise_gate(&mono, config.noise_gate_threshold);

            // Streaming STT (Tier 2): feed the hop to the live WebSocket
            // session, resampled to the 16 kHz s16le rate the streaming
            // protocols speak. The gating decision below still runs — turn
            // tracking stays VAD-driven — but in streaming mode the
            // transcripts arrive as `stt-stream-*` TEXT events, so the
            // frontend skips the batch STT round trip entirely.
            if let Ok(streaming_guard) = app.state::<crate::AudioState>().stt_streaming.try_lock() {
                if let Some(session) = streaming_guard.as_ref() {
                    let down = resample_to_stt_rate(&mono, sr);
                    let _ = session.audio_tx.send(down);
                }
            }

            let (rms, peak) = calculate_audio_metrics(&mono);

            // Speech/silence decision, relative to what is actually playing.
            //
            // This used to be `rms > sensitivity_rms || peak > peak_threshold`,
            // and that `||` was why Auto never sent anything. `peak` is the
            // loudest single sample in a 21ms chunk, so any bed under the
            // speech — background music, a game, a fan — clears 0.035 in
            // nearly every chunk. `is_speech` was therefore true continuously,
            // `silence_chunks` was reset before it could ever reach
            // `config.silence_chunks`, and a gap was never reported. Speech was
            // still transcribed (the 2s partials kept coming), but
            // `speech-detected` never fired, so Auto never called the model —
            // only a hard mute, or the 30s safety cap, got anything through.
            let energy = rms;
            if !energy_init {
                noise_floor = energy;
                speech_ref = energy;
                energy_init = true;
            }
            // The floor chases quiet quickly and loud only very slowly, so
            // sustained speech cannot inflate it into the threshold.
            if energy < noise_floor {
                noise_floor += (energy - noise_floor) * FLOOR_FALL;
            } else {
                noise_floor += (energy - noise_floor) * FLOOR_RISE;
            }
            // The reference adopts a louder level instantly and forgets loud
            // passages gradually, so an old shout does not lock the threshold.
            if energy > speech_ref {
                speech_ref = energy;
            } else {
                speech_ref *= REF_DECAY;
            }

            let span = (speech_ref - noise_floor).max(0.0);

            // Voice sensitivity (0.0-1.0) bends both terms of the decision, so
            // one slider spans the whole useful range:
            //
            //   drop   — how far energy must fall from the speech reference
            //            before the utterance counts as paused. A sensitive
            //            setting accepts a smaller drop, so it pauses sooner.
            //   floor  — the threshold a quiet room sits on, derived from
            //            `sensitivity_rms` rather than a second constant.
            //
            // At 0.5 both land exactly on the tuned values (DROP_RATIO and
            // `sensitivity_rms * 0.5`), so the default is unchanged and the
            // ends of the range merely halve and roughly double it. The clamps
            // keep the extremes usable: below ~0.10 the drop is inside the
            // noise floor's own wobble, and above ~0.90 ordinary speech never
            // recedes far enough to end.
            let sensitivity = config.voice_sensitivity.clamp(0.0, 1.0);
            let drop_ratio = (DROP_RATIO * (1.5 - sensitivity)).clamp(0.10, 0.90);
            let rms_floor = config.sensitivity_rms * (1.0 - sensitivity).max(0.15);

            let threshold = (noise_floor + span * drop_ratio)
                .max(noise_floor * 1.6) // never trip on the floor's own wobble
                .max(rms_floor); // floor for a quiet room

            // The peak term only ever *ends* a stretch: a digitally silent
            // buffer (a paused video renders exact zeros) is silence whatever
            // the floor estimate is doing. It no longer keeps speech alive.
            let is_speech = energy > threshold && peak > config.noise_gate_threshold;

            if is_speech {
                if !in_speech {
                    // Speech START detected
                    in_speech = true;
                    speech_chunks = 0;
                    last_partial_mark = 0;

                    // Include pre-speech buffer for natural sound
                    speech_buffer.extend(pre_speech.drain(..));

                    let _ = app.emit("speech-start", ());
                }

                speech_chunks += 1;
                speech_buffer.extend_from_slice(&mono);
                silence_chunks = next_silence_count(silence_chunks, true); // resettable hangover

                // Emit a live DELTA partial every PARTIAL_INTERVAL_MS of new
                // speech so the running transcript stays sub-second behind
                // the voice. The payload is ONLY the audio since the last
                // partial: the old whole-buffer emit re-uploaded everything
                // on every tick (a 30 s utterance re-uploaded ~30 s of audio
                // each time), which is what made the live transcript lag
                // worse the longer someone spoke. The frontend accumulates
                // the delta texts in PartialTracker; the flushed/finalized
                // utterance is always the authoritative whole-buffer
                // transcript. The delta is already noise-gated (the gate ran
                // per-chunk before the VAD check), so only normalize before
                // encoding.
                if speech_buffer.len()
                    >= last_partial_mark
                        + (sr as usize) * (PARTIAL_INTERVAL_MS as usize) / 1000
                {
                    let delta = &speech_buffer[last_partial_mark..];
                    last_partial_mark = speech_buffer.len();
                    let partial_normalized = normalize_audio_level(delta, 0.1);
                    let partial_16k = resample_to_stt_rate(&partial_normalized, sr);
                    if let Ok(partial_b64) = samples_to_wav_b64(STT_SAMPLE_RATE, &partial_16k) {
                        let _ = app.emit("speech-partial", partial_b64);
                    }
                }

                // Safety cap: force emit if exceeds 30s
                if speech_buffer.len() > max_samples {
                    emit_utterance(
                        &app,
                        sr,
                        0,
                        speech_chunks,
                        config.min_speech_chunks,
                        &speech_buffer,
                    );
                    speech_buffer.clear();
                    in_speech = false;
                    speech_chunks = 0;
                    last_partial_mark = 0;
                }
            } else {
                // Silence detected
                if in_speech {
                    silence_chunks = next_silence_count(silence_chunks, false);

                    // Continue collecting during silence (important for natural speech)
                    speech_buffer.extend_from_slice(&mono);

                    // Check if silence duration exceeds threshold
                    if silence_chunks >= silence_needed {
                        // Trim trailing silence (keep ~0.15s for natural ending)
                        let silence_duration_samples = silence_chunks * config.hop_size;
                        emit_utterance(
                            &app,
                            sr,
                            silence_duration_samples,
                            speech_chunks,
                            config.min_speech_chunks,
                            &speech_buffer,
                        );

                        // Reset for next speech detection
                        speech_buffer.clear();
                        in_speech = false;
                        silence_chunks = 0;
                        speech_chunks = 0;
                        last_partial_mark = 0;
                    }
                } else {
                    // Not in speech yet - maintain rolling pre-speech buffer
                    pre_speech.extend(mono.into_iter());

                    // Trim excess (maintain fixed size)
                    while pre_speech.len() > config.pre_speech_chunks * config.hop_size {
                        pre_speech.pop_front();
                    }

                    // Periodically shrink capacity to prevent memory bloat
                    if pre_speech.len() == config.pre_speech_chunks * config.hop_size {
                        pre_speech.shrink_to_fit();
                    }
                }
            }
        }
    }

    // Flush-on-stop: the loop exited because a stop was requested while an
    // utterance was still open. Emit what has been buffered — this is the
    // tail that used to vanish when the task was aborted mid-speech, which
    // is why the LLM received roughly half of what the transcript showed.
    // The natural path's 1200 ms hangover does not apply here: the user ended
    // the turn explicitly.
    if in_speech && !speech_buffer.is_empty() {
        let silence_duration_samples = silence_chunks * config.hop_size;
        emit_utterance(
            &app,
            sr,
            silence_duration_samples,
            speech_chunks,
            config.min_speech_chunks,
            &speech_buffer,
        );
    }

    // Tell the frontend the flush decision is final, event-driven. The stop
    // path used to sit behind a 600 ms grace timer because the UI could not
    // distinguish "flushed" from "nothing was open"; this event removes that
    // guess. Fires on every loop exit (flushed, natural finalize, stream
    // end) — the frontend only acts on it while a stop is pending and no
    // flushed utterance has been seen, so it is a no-op otherwise.
    let _ = app.emit("capture-stopped", ());
}

// Continuous capture (VAD disabled)
async fn run_continuous_capture(
    app: AppHandle,
    stream: impl StreamExt<Item = f32> + Unpin,
    sr: u32,
    config: VadConfig,
) {
    let mut stream = stream;
    let max_samples = (sr as u64 * config.max_recording_duration_secs) as usize;

    // Pre-allocate buffer to prevent reallocations
    let mut audio_buffer = Vec::with_capacity(max_samples);
    let start_time = Instant::now();
    let max_duration = Duration::from_secs(config.max_recording_duration_secs);

    // Atomic flag for manual stop
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_for_listener = stop_flag.clone();

    // Listen for manual stop event
    let stop_listener = app.listen("manual-stop-continuous", move |_| {
        stop_flag_for_listener.store(true, Ordering::Release);
    });

    // Phase 4 cleanup: `continuous-recording-start`, `recording-progress` and
    // `continuous-recording-stopped` are no longer emitted. Their only
    // listeners went away with the vestigial continuous-mode frontend path, so
    // nothing in the app could observe them. `manual-stop-continuous` (below)
    // and `speech-partial` are still live.
    // Accumulate audio - check stop flag on EVERY sample for immediate response
    loop {
        // Check stop flag FIRST on every iteration for immediate stopping
        if stop_flag.load(Ordering::Acquire) {
            break;
        }

        tokio::select! {
            sample_opt = stream.next() => {
                match sample_opt {
                    Some(sample) => {
                        if stop_flag.load(Ordering::Acquire) {
                            break;
                        }

                        audio_buffer.push(sample);

                        let elapsed = start_time.elapsed();

                        // Partial-transcript cadence, once per second of audio
                        if audio_buffer.len() % (sr as usize) == 0 {
                            // Emit a partial transcript roughly every 2 seconds so the UI can
                            // show a real-time running transcript while the user is still talking.
                            // We only do this once we have at least 2 seconds of audio so the
                            // STT engine has something meaningful to work with.
                            if audio_buffer.len() >= (sr as usize) * 2
                                && audio_buffer.len() % (sr as usize * 2) == 0
                            {
                                let partial_cleaned = apply_noise_gate(
                                    &audio_buffer,
                                    config.noise_gate_threshold,
                                );
                                let partial_normalized =
                                    normalize_audio_level(&partial_cleaned, 0.1);
                                if let Ok(partial_b64) =
                                    samples_to_wav_b64(sr, &partial_normalized)
                                {
                                    let _ = app.emit("speech-partial", partial_b64);
                                }
                            }
                        }

                        // Check size limit (safety)
                        if audio_buffer.len() >= max_samples {
                            break;
                        }

                        // Check time limit
                        if elapsed >= max_duration {
                            break;
                        }
                    },
                    None => {
                        warn!("Audio stream ended unexpectedly");
                        break;
                    }
                }
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(10)) => {
            }
        }
    }

    // Clean up event listener (CRITICAL)
    app.unlisten(stop_listener);

    // Process and emit audio
    if !audio_buffer.is_empty() {
        // let duration = start_time.elapsed().as_secs_f32();

        // Apply noise gate
        let cleaned_audio = apply_noise_gate(&audio_buffer, config.noise_gate_threshold);
        let cleaned_audio = normalize_audio_level(&cleaned_audio, 0.1);

        match samples_to_wav_b64(sr, &cleaned_audio) {
            Ok(b64) => {
                let _ = app.emit("speech-detected", b64);
            }
            Err(e) => {
                error!("Failed to encode continuous audio: {}", e);
                let _ = app.emit("audio-encoding-error", e);
            }
        }
    } else {
        warn!("No audio captured in continuous mode");
        let _ = app.emit("audio-encoding-error", "No audio recorded");
    }
}

// Apply noise gate
fn apply_noise_gate(samples: &[f32], threshold: f32) -> Vec<f32> {
    const KNEE_RATIO: f32 = 3.0; // Compression ratio for soft knee

    samples
        .iter()
        .map(|&s| {
            let abs = s.abs();
            if abs < threshold {
                s * (abs / threshold).powf(1.0 / KNEE_RATIO)
            } else {
                s
            }
        })
        .collect()
}

// Calculate RMS and peak (optimized)
fn calculate_audio_metrics(chunk: &[f32]) -> (f32, f32) {
    let mut sumsq = 0.0f32;
    let mut peak = 0.0f32;

    for &v in chunk {
        let a = v.abs();
        peak = peak.max(a);
        sumsq += v * v;
    }

    let rms = (sumsq / chunk.len() as f32).sqrt();
    (rms, peak)
}

fn normalize_audio_level(samples: &[f32], target_rms: f32) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }

    let sum_squares: f32 = samples.iter().map(|&s| s * s).sum();
    let current_rms = (sum_squares / samples.len() as f32).sqrt();

    if current_rms < 0.001 {
        return samples.to_vec();
    }

    let gain = (target_rms / current_rms).min(10.0);

    samples
        .iter()
        .map(|&s| {
            let amplified = s * gain;
            if amplified.abs() > 1.0 {
                amplified.signum() * (1.0 - (-amplified.abs()).exp())
            } else {
                amplified
            }
        })
        .collect()
}

/// Linear-interpolation resampler down to `STT_SAMPLE_RATE`. 48 kHz → 16 kHz
/// is exactly 3:1 and 44.1 kHz lands on fractional steps; either way the
/// speech band (< 8 kHz) survives intact for transcription, while the WAV
/// payload crossing the IPC bridge and the upload shrinks 3×.
fn resample_to_stt_rate(samples: &[f32], sr: u32) -> Vec<f32> {
    if samples.is_empty() || sr == STT_SAMPLE_RATE {
        return samples.to_vec();
    }
    let out_len = ((samples.len() as u64 * STT_SAMPLE_RATE as u64) / sr as u64).max(1) as usize;
    let step = f64::from(sr) / f64::from(STT_SAMPLE_RATE);
    let mut out = Vec::with_capacity(out_len);
    let last = samples.len() - 1;
    for i in 0..out_len {
        let pos = i as f64 * step;
        let idx = (pos as usize).min(last);
        let frac = (pos - pos as usize as f64) as f32;
        let a = samples[idx];
        let b = samples[(idx + 1).min(last)];
        out.push(a + (b - a) * frac);
    }
    out
}

// Convert samples to WAV base64 (with proper error handling)
fn samples_to_wav_b64(sample_rate: u32, mono_f32: &[f32]) -> Result<String, String> {
    // Validate sample rate
    if !(8000..=96000).contains(&sample_rate) {
        error!("Invalid sample rate: {}", sample_rate);
        return Err(format!(
            "Invalid sample rate: {}. Expected 8000-96000 Hz",
            sample_rate
        ));
    }

    // Validate buffer
    if mono_f32.is_empty() {
        return Err("Empty audio buffer".to_string());
    }

    let mut cursor = Cursor::new(Vec::new());
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer = WavWriter::new(&mut cursor, spec).map_err(|e| {
        error!("Failed to create WAV writer: {}", e);
        e.to_string()
    })?;

    for &s in mono_f32 {
        let clamped = s.clamp(-1.0, 1.0);
        let sample_i16 = (clamped * i16::MAX as f32) as i16;
        writer.write_sample(sample_i16).map_err(|e| e.to_string())?;
    }

    writer.finalize().map_err(|e| e.to_string())?;

    Ok(B64.encode(cursor.into_inner()))
}

#[tauri::command]
pub async fn stop_system_audio_capture(app: AppHandle) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();

    // Cooperative stop FIRST: the VAD loop checks the flag per chunk and
    // flushes the in-flight utterance before exiting, so the tail the user
    // heard is transcribed instead of vanishing with the aborted task.
    state
        .stop_requested
        .store(true, std::sync::atomic::Ordering::Release);

    // Give the task up to ~1.5 s to finish on its own (flush + WAV encode),
    // then abort as the backstop for a stalled stream.
    let task = {
        let mut guard = state
            .stream_task
            .lock()
            .map_err(|e| format!("Failed to acquire task lock: {}", e))?;
        guard.take()
    };

    if let Some(task) = task {
        for _ in 0..150 {
            if task.is_finished() {
                break;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
        }
        if !task.is_finished() {
            task.abort();
        }
    }

    stop_reference_tap(&state);

    // Tear down the streaming-STT session: dropping the audio sender closes
    // the WebSocket politely from the task side, and the status event tells
    // the frontend to fall back to batch mode.
    if let Ok(mut session) = state.stt_streaming.lock() {
        if let Some(session) = session.take() {
            session.engine.task.abort();
            session.forwarder.abort();
            let _ = app.emit("stt-stream-status", serde_json::json!({ "active": false }));
        }
    }

    // Short cleanup windows (the old 300 ms + 200 ms blind sleeps were the
    // floor of the stop latency; the join above replaces their real work).
    tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;

    // Mark as not capturing
    *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to update capturing state: {}", e))? = false;
    *state
        .capture_sample_rate
        .lock()
        .map_err(|e| format!("Failed to clear capture sample rate: {}", e))? = None;

    // Additional cleanup delay (CRITICAL for mic indicator)
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    // Emit stopped event
    let _ = app.emit("capture-stopped", ());
    Ok(())
}

/// Manual stop for continuous recording.
///
/// The only listener for `manual-stop-continuous` lives inside
/// `run_continuous_capture`, so emitting it while no capture is running used to
/// silently "succeed" and leave the UI stuck in its processing state. Confirm
/// the capture first: it must be running AND in continuous (non-VAD) mode.
#[tauri::command]
pub async fn manual_stop_continuous(app: AppHandle) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();

    let is_capturing = *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to read capturing state: {}", e))?;
    if !is_capturing {
        return Err("No capture is running".to_string());
    }

    let vad_enabled = state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to read VAD config: {}", e))?
        .enabled;
    if vad_enabled {
        return Err("Capture is in VAD mode, not continuous".to_string());
    }

    let _ = app.emit("manual-stop-continuous", ());

    tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;

    Ok(())
}

#[tauri::command]
pub fn check_system_audio_access(_app: AppHandle) -> Result<bool, String> {
    match SpeakerInput::new() {
        Ok(_) => Ok(true),
        Err(e) => {
            error!("System audio access check failed: {}", e);
            Ok(false)
        }
    }
}

#[tauri::command]
pub async fn request_system_audio_access(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.shell()
            .command("open")
            .args(["x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture"])
            .spawn()
            .map_err(|e| {
                error!("Failed to open system preferences: {}", e);
                e.to_string()
            })?;
    }
    #[cfg(target_os = "windows")]
    {
        app.shell()
            .command("ms-settings:sound")
            .spawn()
            .map_err(|e| {
                error!("Failed to open sound settings: {}", e);
                e.to_string()
            })?;
    }
    #[cfg(target_os = "linux")]
    {
        let commands = ["pavucontrol", "gnome-control-center sound"];
        let mut opened = false;

        for cmd in &commands {
            if app.shell().command(cmd).spawn().is_ok() {
                opened = true;
                break;
            }
        }

        if !opened {
            warn!("Failed to open audio settings on Linux");
        }
    }

    Ok(())
}

// VAD Configuration Management
#[tauri::command]
pub async fn get_vad_config(app: AppHandle) -> Result<VadConfig, String> {
    let state = app.state::<crate::AudioState>();
    let config = state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to get VAD config: {}", e))?
        .clone();
    Ok(config)
}

#[tauri::command]
pub async fn update_vad_config(app: AppHandle, config: VadConfig) -> Result<(), String> {
    // Validate config
    if config.sensitivity_rms < 0.0 || config.sensitivity_rms > 1.0 {
        return Err("Invalid sensitivity_rms: must be 0.0-1.0".to_string());
    }
    if !(0.0..=1.0).contains(&config.voice_sensitivity) {
        return Err("Invalid voice_sensitivity: must be 0.0-1.0".to_string());
    }
    if config.max_recording_duration_secs > 3600 {
        return Err("Invalid max_recording_duration_secs: must be <= 3600 (1 hour)".to_string());
    }

    let state = app.state::<crate::AudioState>();
    *state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to update VAD config: {}", e))? = config;

    Ok(())
}

#[tauri::command]
pub async fn get_capture_status(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<crate::AudioState>();
    let is_capturing = *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to get capture status: {}", e))?;
    Ok(is_capturing)
}

#[tauri::command]
pub fn get_audio_sample_rate(_app: AppHandle) -> Result<u32, String> {
    let input = SpeakerInput::new().map_err(|e| {
        error!("Failed to create speaker input: {}", e);
        format!("Failed to access system audio: {}", e)
    })?;

    let stream = input.stream();
    let sr = stream.sample_rate();

    Ok(sr)
}

#[tauri::command]
pub fn get_input_devices() -> Result<Vec<AudioDevice>, String> {
    crate::speaker::list_input_devices().map_err(|e| {
        error!("Failed to get input devices: {}", e);
        format!("Failed to get input devices: {}", e)
    })
}

#[tauri::command]
pub fn get_output_devices() -> Result<Vec<AudioDevice>, String> {
    crate::speaker::list_output_devices().map_err(|e| {
        error!("Failed to get output devices: {}", e);
        format!("Failed to get output devices: {}", e)
    })
}
