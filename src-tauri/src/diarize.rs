//! On-device speaker diarization (#109 / AIZ-50).
//!
//! Replaces tinydiarize's turn flags — a *turn detector* with no concept of
//! speaker identity — with real embedding-based speaker IDs. The pipeline is:
//!
//! ```text
//!   audio window (mono 16kHz f32)
//!     → SpeakerEmbedder::embed  (ECAPA/wespeaker ONNX, or Null fallback)
//!     → SpeakerRegistry::assign (online cosine clustering, session-scoped)
//!     → speaker index → "Speaker A" / "Speaker B" / …
//! ```
//!
//! Two layers, split so the load-bearing logic is unit-testable without a
//! model or a microphone:
//!
//! * [`SpeakerRegistry`] — pure online clustering over embedding vectors.
//!   Greedy nearest-centroid with a cosine-similarity threshold and a
//!   running-sum centroid. This is the piece the #73 regression lives or
//!   dies on (over-segmentation = threshold too tight / no cross-chunk
//!   state), so it is exercised directly by the tests at the bottom of this
//!   file on synthetic embeddings.
//! * [`Diarizer`] — orchestration: owns an embedder + a registry, plus the
//!   energy/duration gating that stops pauses, breaths and filler tokens
//!   from spawning phantom speakers (#73 acceptance #3).
//!
//! The embedder is abstracted behind [`SpeakerEmbedder`]. The real
//! on-device implementation ([`OnnxEmbedder`], `onnx-diarize` feature) runs
//! a small speaker-embedding model via ONNX Runtime; when that feature is
//! off, or the model file is absent, [`build_embedder`] falls back to
//! [`NullEmbedder`], which collapses every window into a single cluster —
//! i.e. exactly #73's "one Speaker A" behaviour, with zero over-segmentation
//! risk. So the default build is behaviourally identical to today; turning on
//! `onnx-diarize` + shipping the model is what lights up multi-speaker IDs.

use std::path::{Path, PathBuf};

/// Default cosine-similarity threshold for the online registry. Embeddings
/// from ECAPA-TDNN / wespeaker land same-speaker pairs around 0.5–0.9 and
/// different-speaker pairs around 0.0–0.4, so a boundary in the middle
/// separates them. Leaning slightly permissive (merge-happy) is the correct
/// bias here: #73's failure mode is *over*-segmentation (one human → several
/// IDs), so we would rather occasionally merge two quiet speakers than split
/// one. NEEDS EMPIRICAL TUNING against the chosen model on real meeting audio
/// — the value that satisfies #73 acceptance #1/#2 depends on the model's
/// embedding geometry and the mic/gain of the capture path.
pub const DEFAULT_SIMILARITY_THRESHOLD: f32 = 0.65;

/// Minimum window length (in 16kHz samples) we'll try to embed. Below ~0.5s
/// there isn't enough voiced signal for a stable speaker embedding, so we
/// reuse the previous speaker rather than mint a probably-wrong cluster.
/// 0.5s * 16_000 = 8_000.
pub const MIN_EMBED_SAMPLES_16K: usize = 8_000;

/// RMS energy gate. Windows quieter than this are treated as silence /
/// non-speech (breaths, keyboard, room tone) and reuse the previous speaker.
/// This is the direct defence for #73 acceptance #3 ("≥3s pause → no new ID
/// on resume"): a near-silent whisper segment never reaches the clusterer.
pub const MIN_RMS: f32 = 0.005;

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

/// L2-normalize `v` in place. Returns `false` (leaving `v` untouched) when the
/// vector is all-zero / non-finite, which the caller treats as a degenerate
/// embedding to be skipped.
fn l2_normalize(v: &mut [f32]) -> bool {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if !norm.is_finite() || norm <= f32::EPSILON {
        return false;
    }
    for x in v.iter_mut() {
        *x /= norm;
    }
    true
}

/// Cosine similarity. For two already-L2-normalized vectors this is just the
/// dot product; we don't assume normalization here so the helper is safe to
/// reuse, but the hot path passes normalized inputs.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return -1.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    let denom = (na.sqrt()) * (nb.sqrt());
    if denom <= f32::EPSILON {
        return -1.0;
    }
    dot / denom
}

/// Root-mean-square amplitude of a PCM window — the energy gate input.
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

// ---------------------------------------------------------------------------
// Online speaker registry (the tested core)
// ---------------------------------------------------------------------------

/// One speaker cluster. We keep the running *sum* of member embeddings (not a
/// pre-normalized mean) so the centroid is an exact mean of all embeddings
/// ever assigned — `normalize(sum)`. Storing the sum makes the incremental
/// update trivial and exact, and keeps the centroid stable as more of a
/// speaker's audio accrues (#73 acceptance #1/#4: the longer a solo speaker
/// talks, the more anchored their single cluster becomes).
struct Cluster {
    sum: Vec<f32>,
    count: usize,
}

impl Cluster {
    fn centroid(&self) -> Vec<f32> {
        let mut c = self.sum.clone();
        // Sum of ≥1 unit vectors can only be zero in pathological antipodal
        // cases; if it happens, `l2_normalize` returns false and `cosine`
        // against the raw (zero) vector yields -1.0, so the cluster simply
        // never wins — safe.
        l2_normalize(&mut c);
        c
    }
}

/// Session-scoped online speaker clusterer. Greedy single-pass agglomerative:
/// each embedding is compared (cosine) against every existing cluster
/// centroid; it joins the best match above `threshold`, otherwise it starts a
/// new cluster. Because the registry persists for the whole capture session,
/// the same speaker keeps the same index across chunks and windows — the
/// cross-chunk consistency #73 acceptance #4 requires, which the per-chunk
/// tinydiarize path never had.
pub struct SpeakerRegistry {
    threshold: f32,
    clusters: Vec<Cluster>,
    /// Embedding dimensionality, locked to the first embedding seen. Mismatched
    /// later embeddings are rejected rather than silently mis-clustered.
    dim: Option<usize>,
}

impl SpeakerRegistry {
    pub fn new(threshold: f32) -> Self {
        Self {
            threshold,
            clusters: Vec::new(),
            dim: None,
        }
    }

    /// Number of distinct speakers discovered so far.
    pub fn cluster_count(&self) -> usize {
        self.clusters.len()
    }

    /// Assign `embedding` to a speaker cluster, returning its 0-based index.
    /// The embedding need not be normalized — we normalize internally.
    /// Returns `None` for a degenerate (all-zero / wrong-dim / non-finite)
    /// embedding so the caller can fall back to the previous speaker rather
    /// than corrupt the registry.
    pub fn assign(&mut self, embedding: &[f32]) -> Option<usize> {
        // Reject degenerate embeddings BEFORE touching `dim` — otherwise an
        // empty or all-zero probe would lock the registry to the wrong
        // dimensionality and reject every real embedding that follows.
        if embedding.is_empty() {
            return None;
        }
        let mut norm = embedding.to_vec();
        if !l2_normalize(&mut norm) {
            return None;
        }

        // Lock or check dimensionality against the first valid embedding.
        match self.dim {
            None => self.dim = Some(embedding.len()),
            Some(d) if d == embedding.len() => {}
            Some(_) => return None,
        }

        // Find the best-matching existing cluster.
        let mut best_idx: Option<usize> = None;
        let mut best_sim = self.threshold;
        for (i, cluster) in self.clusters.iter().enumerate() {
            let sim = cosine(&norm, &cluster.centroid());
            if sim >= best_sim {
                best_sim = sim;
                best_idx = Some(i);
            }
        }

        match best_idx {
            Some(i) => {
                // Accumulate into the winning cluster's running sum.
                let cluster = &mut self.clusters[i];
                for (s, e) in cluster.sum.iter_mut().zip(norm.iter()) {
                    *s += *e;
                }
                cluster.count += 1;
                Some(i)
            }
            None => {
                self.clusters.push(Cluster {
                    sum: norm,
                    count: 1,
                });
                Some(self.clusters.len() - 1)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Speaker labels
// ---------------------------------------------------------------------------

/// Map a 0-based speaker index to a stable display label: `0 → "Speaker A"`,
/// `25 → "Speaker Z"`, `26 → "Speaker AA"`, … Bijective base-26 so the label
/// is unique per index. Index 0 is always `"Speaker A"`, so a solo speaker
/// keeps the exact string the #73 mitigation used (`compute_extraction_mode`
/// counts it as one named speaker → Substance mode, no regression).
pub fn speaker_label(index: usize) -> String {
    let mut n = index;
    let mut letters = Vec::new();
    loop {
        letters.push((b'A' + (n % 26) as u8) as char);
        if n < 26 {
            break;
        }
        n = n / 26 - 1;
    }
    let suffix: String = letters.iter().rev().collect();
    format!("Speaker {suffix}")
}

// ---------------------------------------------------------------------------
// Embedder abstraction
// ---------------------------------------------------------------------------

/// Extracts a fixed-dimension speaker embedding from a mono 16kHz f32 PCM
/// window. `Send` so the diarizer can be owned by the live-capture transcribe
/// thread and the whisper import worker thread.
pub trait SpeakerEmbedder: Send {
    /// Embed `samples_16k` (mono, 16kHz, roughly [-1.0, 1.0]) into a speaker
    /// vector. Scale/normalization is the registry's problem; return the raw
    /// model output. Errors are surfaced so the diarizer can fall back to the
    /// previous speaker for this one window instead of aborting the session.
    fn embed(&mut self, samples_16k: &[f32]) -> Result<Vec<f32>, String>;
}

/// Fallback embedder used when the ONNX model/feature is unavailable. Returns
/// a constant 1-D vector, so every window lands in cluster 0 and every segment
/// is labelled `"Speaker A"`. This is deliberately identical to the #73
/// mitigation: no embeddings, no over-segmentation, one speaker. It exists so
/// the whole diarizer pipeline (windowing, gating, labelling, extraction-mode
/// plumbing) is exercised and correct even in builds without a real model.
pub struct NullEmbedder;

impl SpeakerEmbedder for NullEmbedder {
    fn embed(&mut self, _samples_16k: &[f32]) -> Result<Vec<f32>, String> {
        Ok(vec![1.0])
    }
}

// ---------------------------------------------------------------------------
// Diarizer orchestration
// ---------------------------------------------------------------------------

/// Owns an embedder + a session-scoped registry and turns audio windows into
/// stable speaker indices, applying the energy/duration gating that keeps
/// #73's over-segmentation from coming back.
pub struct Diarizer {
    embedder: Box<dyn SpeakerEmbedder>,
    registry: SpeakerRegistry,
    /// Previous speaker index, reused when a window is gated out (too short /
    /// too quiet / degenerate embedding). Starts at 0 ("Speaker A") so a
    /// meeting that opens on silence still resolves to a sane default.
    last_speaker: usize,
    min_samples: usize,
    min_rms: f32,
}

impl Diarizer {
    /// Build a diarizer with the default threshold + gating. `embedder` is the
    /// real ONNX embedder or the Null fallback — see [`build_embedder`].
    pub fn new(embedder: Box<dyn SpeakerEmbedder>) -> Self {
        Self {
            embedder,
            registry: SpeakerRegistry::new(DEFAULT_SIMILARITY_THRESHOLD),
            last_speaker: 0,
            min_samples: MIN_EMBED_SAMPLES_16K,
            min_rms: MIN_RMS,
        }
    }

    /// Override the clustering threshold (mainly for tests / tuning).
    pub fn with_threshold(mut self, threshold: f32) -> Self {
        self.registry = SpeakerRegistry::new(threshold);
        self
    }

    /// Label a mono 16kHz segment, returning a 0-based speaker index. Gated
    /// segments (too short, too quiet, or an embedding failure) reuse the last
    /// speaker instead of forcing a new cluster.
    pub fn label(&mut self, samples_16k: &[f32]) -> usize {
        if samples_16k.len() < self.min_samples || rms(samples_16k) < self.min_rms {
            return self.last_speaker;
        }
        match self.embedder.embed(samples_16k) {
            Ok(embedding) => match self.registry.assign(&embedding) {
                Some(idx) => {
                    self.last_speaker = idx;
                    idx
                }
                None => self.last_speaker,
            },
            Err(e) => {
                crate::log(&format!(
                    "[diarize] embed failed, reusing last speaker: {e}"
                ));
                self.last_speaker
            }
        }
    }

    /// Convenience: label a segment and return the display string.
    pub fn label_string(&mut self, samples_16k: &[f32]) -> String {
        speaker_label(self.label(samples_16k))
    }

    /// Distinct speakers discovered so far this session.
    pub fn speaker_count(&self) -> usize {
        self.registry.cluster_count()
    }
}

// ---------------------------------------------------------------------------
// Embedder construction / model wiring
// ---------------------------------------------------------------------------

/// Filename for the cached speaker-embedding model, stored alongside the
/// whisper model under `~/.aizuchi/models/`.
pub const EMBED_MODEL_FILENAME: &str = "wespeaker_en_voxceleb_CAM++.onnx";

/// Redistribution URL for the embedding model. sherpa-onnx (Apache-2.0)
/// republishes the WeSpeaker CAM++ export here. NOTE: the WeSpeaker *code* is
/// Apache-2.0, but this checkpoint is trained on VoxCeleb, whose data licence
/// is research/non-commercial — flag for the commercial build. A drop-in,
/// commercially-cleaner alternative is 3D-Speaker's ERes2Net (Apache-2.0):
/// same 80-dim fbank input, same interface, just swap the URL + filename.
pub const EMBED_MODEL_URL: &str =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recognition-models/wespeaker_en_voxceleb_CAM++.onnx";

/// Lower bound for a complete embedding-model download (the CAM++ export is
/// ~28MB; guard against a truncated fetch the way the whisper path does).
pub const EMBED_MIN_MODEL_BYTES: u64 = 10_000_000;

/// Path the embedding model is cached at.
pub fn embedding_model_path() -> PathBuf {
    crate::notes_dir().join("models").join(EMBED_MODEL_FILENAME)
}

/// Build the best available embedder. With the `onnx-diarize` feature and a
/// present, valid model file → [`OnnxEmbedder`]; otherwise [`NullEmbedder`]
/// (single-speaker fallback). Never fails — a missing/broken model degrades to
/// the Null fallback and logs, so a diarizer is always constructible and live
/// capture is never blocked by diarization.
pub fn build_embedder(model_path: &Path) -> Box<dyn SpeakerEmbedder> {
    #[cfg(feature = "onnx-diarize")]
    {
        match OnnxEmbedder::load(model_path) {
            Ok(e) => {
                crate::log(&format!(
                    "[diarize] loaded ONNX speaker embedder from {}",
                    model_path.display()
                ));
                return Box::new(e);
            }
            Err(e) => {
                crate::log(&format!(
                    "[diarize] ONNX embedder unavailable ({e}); falling back to single-speaker"
                ));
            }
        }
    }
    #[cfg(not(feature = "onnx-diarize"))]
    {
        let _ = model_path;
    }
    Box::new(NullEmbedder)
}

/// Build a session diarizer, downloading + caching the embedding model first
/// when the `onnx-diarize` feature is on (mirrors `audio::ensure_model` for
/// the whisper model). In the default build this is a no-op that returns a
/// Null-backed diarizer.
pub fn build_session_diarizer() -> Diarizer {
    #[cfg(feature = "onnx-diarize")]
    {
        let path = embedding_model_path();
        if let Err(e) =
            crate::audio::ensure_model_sized(&path, EMBED_MODEL_URL, EMBED_MIN_MODEL_BYTES)
        {
            crate::log(&format!(
                "[diarize] embedding model download failed ({e}); single-speaker fallback"
            ));
        }
        return Diarizer::new(build_embedder(&path));
    }
    #[cfg(not(feature = "onnx-diarize"))]
    {
        Diarizer::new(build_embedder(&embedding_model_path()))
    }
}

// ---------------------------------------------------------------------------
// ONNX embedder (real on-device implementation, `onnx-diarize` feature)
// ---------------------------------------------------------------------------
//
// Gated behind `onnx-diarize` so the default `cargo build`/`cargo test` stay
// green and dependency-light while the real implementation ships in-tree.
// This path is NOT yet verified end-to-end (no redistributable multi-speaker
// fixture + no microphone in CI): the ort session wiring and tensor shapes
// follow the CAM++ model card, and the fbank frontend below implements the
// standard Kaldi-style 80-dim log-mel features the model expects, but the
// exact fbank conventions (window fn, dithering, mean-norm) and the cosine
// threshold both need a real-audio validation pass before this is trusted.
#[cfg(feature = "onnx-diarize")]
mod onnx {
    use super::SpeakerEmbedder;
    use std::path::Path;

    /// 80-dim log-mel fbank, 25ms window / 10ms shift @ 16kHz — the input
    /// WeSpeaker CAM++ / ECAPA exports consume.
    const N_MELS: usize = 80;
    const SAMPLE_RATE: f32 = 16_000.0;
    const FRAME_LEN: usize = 400; // 25ms
    const FRAME_SHIFT: usize = 160; // 10ms
    const FFT_LEN: usize = 512;

    pub struct OnnxEmbedder {
        session: ort::session::Session,
        mel_filters: Vec<Vec<f32>>, // [N_MELS][FFT_LEN/2 + 1]
    }

    impl OnnxEmbedder {
        pub fn load(model_path: &Path) -> Result<Self, String> {
            if !model_path.exists() {
                return Err(format!(
                    "embedding model missing at {}",
                    model_path.display()
                ));
            }
            let session = ort::session::Session::builder()
                .map_err(|e| format!("ort session builder: {e}"))?
                .commit_from_file(model_path)
                .map_err(|e| format!("ort load model: {e}"))?;
            Ok(Self {
                session,
                mel_filters: mel_filterbank(),
            })
        }

        /// Compute mean-normalized 80-dim log-mel fbank features: [frames][80].
        fn fbank(&self, samples: &[f32]) -> Vec<Vec<f32>> {
            compute_fbank(samples, &self.mel_filters)
        }
    }

    impl SpeakerEmbedder for OnnxEmbedder {
        fn embed(&mut self, samples_16k: &[f32]) -> Result<Vec<f32>, String> {
            let feats = self.fbank(samples_16k);
            if feats.is_empty() {
                return Err("no fbank frames".into());
            }
            let n_frames = feats.len();
            let mut flat = Vec::with_capacity(n_frames * N_MELS);
            for frame in &feats {
                flat.extend_from_slice(frame);
            }
            // CAM++ input: [batch=1, frames, 80].
            let input = ort::value::Tensor::from_array((
                [1usize, n_frames, N_MELS],
                flat.into_boxed_slice(),
            ))
            .map_err(|e| format!("build input tensor: {e}"))?;
            let outputs = self
                .session
                .run(ort::inputs!["feats" => input])
                .map_err(|e| format!("ort run: {e}"))?;
            let (_shape, data) = outputs[0]
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("extract embedding: {e}"))?;
            Ok(data.to_vec())
        }
    }

    /// Precompute a triangular mel filterbank over the FFT power-spectrum bins.
    fn mel_filterbank() -> Vec<Vec<f32>> {
        let n_fft_bins = FFT_LEN / 2 + 1;
        let mel = |f: f32| 1127.0 * (1.0 + f / 700.0).ln();
        let mel_inv = |m: f32| 700.0 * ((m / 1127.0).exp() - 1.0);
        let f_min = 0.0f32;
        let f_max = SAMPLE_RATE / 2.0;
        let m_min = mel(f_min);
        let m_max = mel(f_max);
        let mut points = Vec::with_capacity(N_MELS + 2);
        for i in 0..N_MELS + 2 {
            let m = m_min + (m_max - m_min) * i as f32 / (N_MELS + 1) as f32;
            let f = mel_inv(m);
            points.push(f / (SAMPLE_RATE / FFT_LEN as f32)); // → FFT bin index
        }
        let mut filters = vec![vec![0.0f32; n_fft_bins]; N_MELS];
        for m in 0..N_MELS {
            let (l, c, r) = (points[m], points[m + 1], points[m + 2]);
            for (bin, w) in filters[m].iter_mut().enumerate() {
                let b = bin as f32;
                *w = if b >= l && b <= c {
                    if (c - l).abs() < f32::EPSILON {
                        0.0
                    } else {
                        (b - l) / (c - l)
                    }
                } else if b > c && b <= r {
                    if (r - c).abs() < f32::EPSILON {
                        0.0
                    } else {
                        (r - b) / (r - c)
                    }
                } else {
                    0.0
                };
            }
        }
        filters
    }

    /// Naive DFT power spectrum for one frame. FFT_LEN is fixed and small
    /// (512); a real deployment should swap in `rustfft`, but a direct DFT
    /// keeps the feature dependency-free and is fine for validation.
    fn power_spectrum(frame: &[f32]) -> Vec<f32> {
        let n = FFT_LEN;
        let bins = n / 2 + 1;
        let mut out = vec![0.0f32; bins];
        for (k, o) in out.iter_mut().enumerate() {
            let mut re = 0.0f32;
            let mut im = 0.0f32;
            for (t, &x) in frame.iter().enumerate() {
                let ang = -2.0 * std::f32::consts::PI * (k as f32) * (t as f32) / n as f32;
                re += x * ang.cos();
                im += x * ang.sin();
            }
            *o = re * re + im * im;
        }
        out
    }

    /// Standard Kaldi-ish fbank: pre-emphasis, Povey window, power spectrum,
    /// mel projection, log, then per-utterance mean normalization (CMN).
    fn compute_fbank(samples: &[f32], mel_filters: &[Vec<f32>]) -> Vec<Vec<f32>> {
        if samples.len() < FRAME_LEN {
            return Vec::new();
        }
        // Povey window ( (0.5 - 0.5 cos)^0.85 ), matching Kaldi's default.
        let window: Vec<f32> = (0..FRAME_LEN)
            .map(|i| {
                let w = 0.5
                    - 0.5
                        * (2.0 * std::f32::consts::PI * i as f32 / (FRAME_LEN as f32 - 1.0)).cos();
                w.powf(0.85)
            })
            .collect();

        let n_frames = 1 + (samples.len() - FRAME_LEN) / FRAME_SHIFT;
        let mut feats: Vec<Vec<f32>> = Vec::with_capacity(n_frames);
        for f in 0..n_frames {
            let start = f * FRAME_SHIFT;
            let mut frame = vec![0.0f32; FFT_LEN];
            // Pre-emphasis (0.97) + window into a zero-padded FFT frame.
            let mut prev = samples[start];
            for i in 0..FRAME_LEN {
                let x = samples[start + i];
                let pe = if i == 0 { x } else { x - 0.97 * prev };
                prev = x;
                frame[i] = pe * window[i];
            }
            let power = power_spectrum(&frame);
            let mut mels = vec![0.0f32; N_MELS];
            for (m, filt) in mel_filters.iter().enumerate() {
                let mut acc = 0.0f32;
                for (bin, &w) in filt.iter().enumerate() {
                    acc += w * power[bin];
                }
                mels[m] = (acc.max(1e-10)).ln();
            }
            feats.push(mels);
        }
        // Cepstral (feature) mean normalization over the utterance.
        let mut mean = vec![0.0f32; N_MELS];
        for frame in &feats {
            for (m, v) in frame.iter().enumerate() {
                mean[m] += v;
            }
        }
        for v in mean.iter_mut() {
            *v /= feats.len() as f32;
        }
        for frame in feats.iter_mut() {
            for (m, v) in frame.iter_mut().enumerate() {
                *v -= mean[m];
            }
        }
        feats
    }
}

#[cfg(feature = "onnx-diarize")]
pub use onnx::OnnxEmbedder;

// ---------------------------------------------------------------------------
// Tests — the load-bearing clustering logic, on synthetic embeddings.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic pseudo-random unit-ish vector seeded by `seed`, jittered
    /// around a base direction by `noise`. Used to synthesize repeated
    /// utterances from the same / different speakers without a model.
    fn jitter(base: &[f32], noise: f32, seed: u64) -> Vec<f32> {
        let mut s = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let mut next = || {
            s = s
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((s >> 33) as f32 / (1u64 << 31) as f32) - 1.0 // ~[-1, 1)
        };
        base.iter().map(|&b| b + noise * next()).collect()
    }

    fn base_a() -> Vec<f32> {
        vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    }
    fn base_b() -> Vec<f32> {
        vec![0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]
    }

    #[test]
    fn label_maps_index_to_letters() {
        assert_eq!(speaker_label(0), "Speaker A");
        assert_eq!(speaker_label(1), "Speaker B");
        assert_eq!(speaker_label(25), "Speaker Z");
        assert_eq!(speaker_label(26), "Speaker AA");
        assert_eq!(speaker_label(27), "Speaker AB");
        assert_eq!(speaker_label(51), "Speaker AZ");
        assert_eq!(speaker_label(52), "Speaker BA");
    }

    /// #73 acceptance #1: one speaker, many noisy utterances → exactly ONE
    /// cluster. This is the regression that must not come back.
    #[test]
    fn solo_speaker_stays_one_cluster() {
        let mut reg = SpeakerRegistry::new(DEFAULT_SIMILARITY_THRESHOLD);
        let base = base_a();
        for i in 0..200 {
            let e = jitter(&base, 0.15, i);
            let id = reg.assign(&e).unwrap();
            assert_eq!(id, 0, "utterance {i} drifted to a new speaker");
        }
        assert_eq!(reg.cluster_count(), 1);
    }

    /// #73 acceptance #2: two well-separated speakers alternating → exactly
    /// TWO stable clusters, each speaker always mapping to the same index.
    #[test]
    fn two_speakers_stay_two_stable_clusters() {
        let mut reg = SpeakerRegistry::new(DEFAULT_SIMILARITY_THRESHOLD);
        let (a, b) = (base_a(), base_b());
        let mut id_a = None;
        let mut id_b = None;
        for i in 0..100 {
            let ea = jitter(&a, 0.15, i * 2);
            let eb = jitter(&b, 0.15, i * 2 + 1);
            let got_a = reg.assign(&ea).unwrap();
            let got_b = reg.assign(&eb).unwrap();
            match id_a {
                None => id_a = Some(got_a),
                Some(x) => assert_eq!(x, got_a, "speaker A id changed at {i}"),
            }
            match id_b {
                None => id_b = Some(got_b),
                Some(x) => assert_eq!(x, got_b, "speaker B id changed at {i}"),
            }
        }
        assert_eq!(reg.cluster_count(), 2);
        assert_ne!(id_a, id_b);
    }

    /// #73 acceptance #4: cross-chunk consistency — interleave the two
    /// speakers in an arbitrary order and confirm the mapping is stable and
    /// only ever two ids.
    #[test]
    fn interleaved_speakers_keep_stable_ids() {
        let mut reg = SpeakerRegistry::new(DEFAULT_SIMILARITY_THRESHOLD);
        let (a, b) = (base_a(), base_b());
        // Warm up one utterance each so ids are assigned deterministically.
        let ida = reg.assign(&jitter(&a, 0.1, 1000)).unwrap();
        let idb = reg.assign(&jitter(&b, 0.1, 2000)).unwrap();
        let pattern = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1];
        for (i, who) in pattern.iter().enumerate() {
            let (base, expected) = if *who == 0 { (&a, ida) } else { (&b, idb) };
            let got = reg.assign(&jitter(base, 0.12, 3000 + i as u64)).unwrap();
            assert_eq!(got, expected, "step {i} (speaker {who}) mis-assigned");
        }
        assert_eq!(reg.cluster_count(), 2);
    }

    #[test]
    fn threshold_governs_split_vs_merge() {
        // Two moderately-similar vectors. A permissive threshold merges them;
        // a strict threshold splits them.
        let v1 = vec![1.0, 0.5, 0.0, 0.0];
        let v2 = vec![1.0, 0.0, 0.5, 0.0]; // cosine ≈ 0.8 with v1

        let mut merge = SpeakerRegistry::new(0.5);
        merge.assign(&v1);
        merge.assign(&v2);
        assert_eq!(merge.cluster_count(), 1, "low threshold should merge");

        let mut split = SpeakerRegistry::new(0.95);
        split.assign(&v1);
        split.assign(&v2);
        assert_eq!(split.cluster_count(), 2, "high threshold should split");
    }

    #[test]
    fn degenerate_embeddings_are_rejected() {
        let mut reg = SpeakerRegistry::new(0.5);
        assert_eq!(reg.assign(&[]), None);
        assert_eq!(reg.assign(&[0.0, 0.0, 0.0]), None); // all-zero
                                                        // Dim mismatch after the first real embedding is rejected.
        assert_eq!(reg.assign(&[1.0, 0.0, 0.0]), Some(0));
        assert_eq!(reg.assign(&[1.0, 0.0]), None);
    }

    /// #73 acceptance #3: a pause (silent / too-short window) must not mint a
    /// new speaker — the diarizer reuses the last speaker. Driven through the
    /// full `Diarizer` with the Null embedder plus a spy embedder.
    #[test]
    fn silence_and_short_windows_reuse_last_speaker() {
        // A counting embedder that records how often it is invoked. If the
        // gate works, the silent / too-short windows never reach it — proving
        // it's the gate, not the clusterer, that protects against #73's
        // pause-spawns-a-speaker failure.
        struct CountingEmbedder {
            calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        }
        impl SpeakerEmbedder for CountingEmbedder {
            fn embed(&mut self, _s: &[f32]) -> Result<Vec<f32>, String> {
                self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(vec![1.0, 0.0, 0.0])
            }
        }
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut d = Diarizer::new(Box::new(CountingEmbedder {
            calls: calls.clone(),
        }));

        // A loud, long, voiced window → embedded, becomes Speaker A (0).
        let voiced = vec![0.3f32; MIN_EMBED_SAMPLES_16K + 100];
        assert_eq!(d.label(&voiced), 0);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);

        // A ≥3s silent window: below the RMS gate → NOT embedded, reuses A.
        let silence = vec![0.0f32; 16_000 * 3];
        assert_eq!(d.label(&silence), 0);
        // A too-short window (< 0.5s) → NOT embedded, reuses A.
        let tiny = vec![0.3f32; 1000];
        assert_eq!(d.label(&tiny), 0);
        // Still only the one embed call from the voiced window.
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);

        // Resume with a voiced window → same speaker, still one cluster.
        assert_eq!(d.label(&voiced), 0);
        assert_eq!(d.speaker_count(), 1);
    }

    /// End-to-end through the Diarizer with the Null embedder: everything is
    /// Speaker A, matching the default (no-model) build's #73 behaviour.
    #[test]
    fn null_embedder_collapses_to_single_speaker() {
        let mut d = Diarizer::new(Box::new(NullEmbedder));
        let voiced = vec![0.3f32; MIN_EMBED_SAMPLES_16K + 1];
        for _ in 0..10 {
            assert_eq!(d.label_string(&voiced), "Speaker A");
        }
        assert_eq!(d.speaker_count(), 1);
    }
}
