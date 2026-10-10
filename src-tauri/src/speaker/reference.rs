//! Non-blocking tap for raw loopback samples.
//!
//! The capture stream only copies samples into a bounded FIFO. Resampling and
//! Tauri IPC happen on this module's worker thread, outside the system VAD path.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tracing::{info, warn};

const TARGET_SAMPLE_RATE: u32 = 16_000;
const FRAME_SAMPLES: usize = 320; // 20 ms at 16 kHz
const CAPTURE_BATCH_SAMPLES: usize = 1024;
const FIFO_CAPACITY: usize = 16;
const SINC_TAPS: i64 = 129;
const SINC_RADIUS: i64 = SINC_TAPS / 2;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceFrame {
    pub seq: u64,
    pub ts_ns: u64,
    pub sample_rate: u32,
    pub samples: Vec<f32>,
}

struct RawChunk {
    sequence: u64,
    capture_ts_ns: u64,
    samples: Vec<f32>,
}

struct TapInner {
    sender: SyncSender<RawChunk>,
    active: Arc<AtomicBool>,
    queue_depth: Arc<AtomicUsize>,
    dropped_chunks: Arc<AtomicU64>,
    started_at: Instant,
    worker: Mutex<Option<JoinHandle<()>>>,
}

/// Cloneable handle shared by the stream tee and AudioState. `stop` is
/// idempotent and joins only the worker thread; it never runs on the capture
/// thread.
#[derive(Clone)]
pub struct ReferenceTap(Arc<TapInner>);

impl ReferenceTap {
    pub fn start(channel: Channel<ReferenceFrame>, input_sample_rate: u32) -> Self {
        let (sender, receiver) = mpsc::sync_channel(FIFO_CAPACITY);
        let active = Arc::new(AtomicBool::new(true));
        let queue_depth = Arc::new(AtomicUsize::new(0));
        let dropped_chunks = Arc::new(AtomicU64::new(0));
        let started_at = Instant::now();

        let worker_active = Arc::clone(&active);
        let worker_depth = Arc::clone(&queue_depth);
        let worker_dropped = Arc::clone(&dropped_chunks);
        let worker = thread::Builder::new()
            .name("hyperly-aec-reference".into())
            .spawn(move || {
                run_reference_worker(
                    receiver,
                    channel,
                    input_sample_rate,
                    worker_active,
                    worker_depth,
                    worker_dropped,
                );
            })
            .expect("failed to start AEC reference worker");

        Self(Arc::new(TapInner {
            sender,
            active,
            queue_depth,
            dropped_chunks,
            started_at,
            worker: Mutex::new(Some(worker)),
        }))
    }

    /// Copy a raw chunk into the bounded FIFO without waiting for the worker.
    pub fn try_send(&self, sequence: u64, samples: Vec<f32>) {
        if !self.0.active.load(Ordering::Acquire) || samples.is_empty() {
            return;
        }

        let capture_ts_ns = self
            .0
            .started_at
            .elapsed()
            .as_nanos()
            .min(u64::MAX as u128) as u64;
        self.0.queue_depth.fetch_add(1, Ordering::AcqRel);
        let chunk = RawChunk {
            sequence,
            capture_ts_ns,
            samples,
        };

        if let Err(error) = self.0.sender.try_send(chunk) {
            self.0.queue_depth.fetch_sub(1, Ordering::AcqRel);
            match error {
                TrySendError::Full(_) => {
                    self.0.dropped_chunks.fetch_add(1, Ordering::Relaxed);
                }
                TrySendError::Disconnected(_) => {
                    self.0.active.store(false, Ordering::Release);
                }
            }
        }
    }

    pub fn stop(&self) {
        self.0.active.store(false, Ordering::Release);
        if let Ok(mut worker) = self.0.worker.lock() {
            if let Some(worker) = worker.take() {
                if worker.thread().id() != thread::current().id() {
                    let _ = worker.join();
                }
            }
        }
    }
}

impl Drop for TapInner {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        if let Ok(worker) = self.worker.get_mut() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }
}

/// Stream adapter which returns each original sample unchanged while copying
/// fixed-size chunks into the reference FIFO.
pub struct ReferenceStream<S> {
    source: S,
    tap_slot: Arc<Mutex<Option<ReferenceTap>>>,
    pending_samples: Vec<f32>,
    chunk_sequence: u64,
    flushed: bool,
}

impl<S> ReferenceStream<S> {
    pub fn new(source: S, tap_slot: Arc<Mutex<Option<ReferenceTap>>>) -> Self {
        Self {
            source,
            tap_slot,
            pending_samples: Vec::with_capacity(CAPTURE_BATCH_SAMPLES),
            chunk_sequence: 0,
            flushed: false,
        }
    }

    fn flush_chunk(&mut self) {
        if self.pending_samples.is_empty() {
            return;
        }
        let samples = std::mem::take(&mut self.pending_samples);
        self.pending_samples = Vec::with_capacity(CAPTURE_BATCH_SAMPLES);
        if let Ok(slot) = self.tap_slot.lock() {
            if let Some(tap) = slot.as_ref() {
                tap.try_send(self.chunk_sequence, samples);
            }
        }
        self.chunk_sequence = self.chunk_sequence.wrapping_add(1);
    }
}

impl<S> futures_util::Stream for ReferenceStream<S>
where
    S: futures_util::Stream<Item = f32> + Unpin,
{
    type Item = f32;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        let this = self.as_mut().get_mut();
        match std::pin::Pin::new(&mut this.source).poll_next(cx) {
            std::task::Poll::Ready(Some(sample)) => {
                this.pending_samples.push(sample);
                if this.pending_samples.len() >= CAPTURE_BATCH_SAMPLES {
                    this.flush_chunk();
                }
                std::task::Poll::Ready(Some(sample))
            }
            std::task::Poll::Ready(None) => {
                if !this.flushed {
                    this.flush_chunk();
                    this.flushed = true;
                }
                std::task::Poll::Ready(None)
            }
            std::task::Poll::Pending => std::task::Poll::Pending,
        }
    }
}

struct SincResampler {
    input_rate: f64,
    samples: VecDeque<f32>,
    base_index: i64,
    total_input: i64,
    next_output: u64,
    epoch_ts_ns: u64,
}

impl SincResampler {
    fn new(input_rate: u32, epoch_ts_ns: u64) -> Self {
        Self {
            input_rate: input_rate as f64,
            samples: VecDeque::new(),
            base_index: 0,
            total_input: 0,
            next_output: 0,
            epoch_ts_ns,
        }
    }

    fn push(&mut self, chunk: &[f32]) -> Vec<f32> {
        self.samples.extend(chunk.iter().copied());
        self.total_input += chunk.len() as i64;

        let step = self.input_rate / TARGET_SAMPLE_RATE as f64;
        let cutoff = (TARGET_SAMPLE_RATE as f64 / self.input_rate).min(1.0) * 0.94;
        let mut output = Vec::new();

        loop {
            let position = self.next_output as f64 * step;
            let center = position.floor() as i64;
            if center + SINC_RADIUS >= self.total_input {
                break;
            }

            let mut weighted = 0.0f64;
            let mut weight_sum = 0.0f64;
            for index in (center - SINC_RADIUS + 1)..=(center + SINC_RADIUS) {
                let distance = index as f64 - position;
                let absolute_distance = distance.abs();
                if absolute_distance > SINC_RADIUS as f64 {
                    continue;
                }

                let sinc = if distance.abs() < f64::EPSILON {
                    cutoff
                } else {
                    (std::f64::consts::PI * cutoff * distance).sin()
                        / (std::f64::consts::PI * distance)
                };
                let window = 0.5
                    + 0.5
                        * (std::f64::consts::PI * distance / SINC_RADIUS as f64).cos();
                let weight = sinc * window;
                let sample = if index < 0 || index < self.base_index {
                    0.0
                } else {
                    self.samples
                        .get((index - self.base_index) as usize)
                        .copied()
                        .unwrap_or(0.0) as f64
                };
                weighted += sample * weight;
                weight_sum += weight;
            }

            output.push(if weight_sum.abs() > f64::EPSILON {
                (weighted / weight_sum) as f32
            } else {
                0.0
            });
            self.next_output = self.next_output.wrapping_add(1);
        }

        let next_position = self.next_output as f64 * step;
        let discard_before = (next_position.floor() as i64 - SINC_RADIUS).max(0);
        while self.base_index < discard_before && !self.samples.is_empty() {
            self.samples.pop_front();
            self.base_index += 1;
        }
        output
    }

    fn timestamp_for_output(&self, output_index: u64) -> u64 {
        let offset = output_index as u128 * 1_000_000_000u128
            / TARGET_SAMPLE_RATE as u128;
        self.epoch_ts_ns
            .saturating_add(offset.min(u64::MAX as u128) as u64)
    }
}

fn run_reference_worker(
    receiver: Receiver<RawChunk>,
    channel: Channel<ReferenceFrame>,
    input_sample_rate: u32,
    active: Arc<AtomicBool>,
    queue_depth: Arc<AtomicUsize>,
    dropped_chunks: Arc<AtomicU64>,
) {
    let resample_ratio = input_sample_rate as f64 / TARGET_SAMPLE_RATE as f64;
    let mut resampler: Option<SincResampler> = None;
    let mut frame_samples = Vec::with_capacity(FRAME_SAMPLES);
    let mut frame_start_output = 0u64;
    let mut next_frame_sequence = 0u64;
    let mut previous_chunk_sequence: Option<u64> = None;
    let mut frames_sent = 0u64;
    let mut last_log = Instant::now();

    loop {
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(chunk) => {
                queue_depth.fetch_sub(1, Ordering::AcqRel);
                let gap = previous_chunk_sequence
                    .map(|previous| chunk.sequence != previous.wrapping_add(1))
                    .unwrap_or(false);
                if gap {
                    let previous = previous_chunk_sequence.unwrap_or(chunk.sequence);
                    let missing_chunks = chunk.sequence.wrapping_sub(previous).saturating_sub(1);
                    let samples_per_frame = input_sample_rate as f64 * 0.020;
                    let skipped_frames = (missing_chunks as f64
                        * CAPTURE_BATCH_SAMPLES as f64
                        / samples_per_frame)
                        .round() as u64;
                    next_frame_sequence = next_frame_sequence.saturating_add(skipped_frames);
                    frame_samples.clear();
                    resampler = None;
                }
                previous_chunk_sequence = Some(chunk.sequence);

                if resampler.is_none() {
                    resampler = Some(SincResampler::new(
                        input_sample_rate,
                        chunk.capture_ts_ns,
                    ));
                    frame_start_output = 0;
                }

                let resampled = resampler
                    .as_mut()
                    .expect("resampler initialized above")
                    .push(&chunk.samples);
                for sample in resampled {
                    frame_samples.push(sample);
                    if frame_samples.len() == FRAME_SAMPLES {
                        let timestamp = resampler
                            .as_ref()
                            .expect("resampler remains initialized")
                            .timestamp_for_output(frame_start_output);
                        let frame = ReferenceFrame {
                            seq: next_frame_sequence,
                            ts_ns: timestamp,
                            sample_rate: TARGET_SAMPLE_RATE,
                            samples: std::mem::take(&mut frame_samples),
                        };
                        frame_samples = Vec::with_capacity(FRAME_SAMPLES);
                        if let Err(error) = channel.send(frame) {
                            warn!("AEC reference Channel closed: {error}");
                            active.store(false, Ordering::Release);
                            return;
                        }
                        frames_sent = frames_sent.saturating_add(1);
                        next_frame_sequence = next_frame_sequence.saturating_add(1);
                        frame_start_output = frame_start_output
                            .saturating_add(FRAME_SAMPLES as u64);
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if !active.load(Ordering::Acquire) {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }

        if last_log.elapsed() >= Duration::from_secs(1) {
            info!(
                frames_sent,
                resample_ratio,
                fifo_depth = queue_depth.load(Ordering::Acquire),
                dropped_chunks = dropped_chunks.load(Ordering::Relaxed),
                "AEC reference tap"
            );
            last_log = Instant::now();
        }
    }

    info!(frames_sent, "AEC reference tap stopped");
}
