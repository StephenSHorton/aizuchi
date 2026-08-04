// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared payloads. These are the wire types between:
//   Swift (Decodable / serialized via `invoke.resolve` and `trigger`)
//   Rust  (Serialize/Deserialize for `run_mobile_plugin` + `Channel<T>`)
//   JS    (TypeScript bindings in guest-js/, follow-up issue)

use serde::{Deserialize, Serialize};

/// Parameters for `start_capture`. 16 kHz mono PCM is the target — it's
/// what whisper.cpp expects and what the existing macOS path in
/// `src-tauri/src/audio.rs` already feeds the model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCaptureOptions {
    /// Sample rate in Hz. Whisper wants 16000. Higher rates force a
    /// resample on the Swift side via `AVAudioConverter`; we default to
    /// 16000 to skip that.
    #[serde(default = "default_sample_rate")]
    pub sample_rate: u32,
    /// Channel count. Whisper is mono.
    #[serde(default = "default_channels")]
    pub channels: u16,
    /// Frame size (samples per channel) per emitted chunk. At 16 kHz,
    /// 1600 samples = 100 ms, which matches the granularity AIZ-57's
    /// acceptance criteria call out ("no audio gaps >100 ms").
    #[serde(default = "default_frame_samples")]
    pub frame_samples: u32,
    /// When `true`, the Swift side runs a simple energy-threshold VAD
    /// and skips emitting frames classified as silence. Default `false`
    /// — see docs/spikes/aiz-57/report.md "VAD placement" for why.
    #[serde(default)]
    pub silence_gate: bool,
}

fn default_sample_rate() -> u32 {
    16_000
}
fn default_channels() -> u16 {
    1
}
fn default_frame_samples() -> u32 {
    1_600
}

impl Default for StartCaptureOptions {
    fn default() -> Self {
        Self {
            sample_rate: default_sample_rate(),
            channels: default_channels(),
            frame_samples: default_frame_samples(),
            silence_gate: false,
        }
    }
}

/// One streamed PCM chunk. We send signed 16-bit little-endian samples,
/// already interleaved if `channels > 1`. The `Vec<i16>` serializes to
/// JSON as an array — *not* what we want for the binary path. See
/// `AudioFrame::into_binary` and `docs/spikes/aiz-57/report.md` ("Frame
/// delivery") for the binary-channel plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum AudioEvent {
    /// PCM audio frame.
    Frame {
        /// Monotonic frame counter, useful for detecting gaps on the
        /// Rust side without parsing timestamps.
        seq: u64,
        /// Capture-clock timestamp in milliseconds since `start_capture`.
        timestamp_ms: u64,
        /// Sample rate of *this* frame, in Hz. Repeated per-frame to
        /// keep route-change semantics explicit — if `AVAudioEngine`
        /// reconfigures after an AirPods swap, the downstream consumer
        /// sees the new rate without polling.
        sample_rate: u32,
        /// Channel count.
        channels: u16,
        /// Signed 16-bit interleaved PCM samples.
        samples: Vec<i16>,
    },
    /// AVAudioSession interruption (phone call, Siri, etc.).
    Interruption {
        /// `true` = interruption began, capture is paused.
        /// `false` = interruption ended, capture has been resumed.
        began: bool,
        /// When `began == false`, indicates whether iOS told us we *can*
        /// resume (the `.shouldResume` option on the ended event).
        should_resume: Option<bool>,
    },
    /// Route change (built-in mic <-> AirPods <-> headset).
    RouteChange {
        /// Human-readable reason (`newDeviceAvailable`,
        /// `oldDeviceUnavailable`, `categoryChange`, etc.).
        reason: String,
        /// New input port name, if any (e.g. "MacBook Pro Microphone",
        /// "AirPods Pro").
        new_input: Option<String>,
    },
    /// Terminal capture error — the engine could not be restarted.
    Error { message: String },
}

/// Response from `start_capture`. The actual frame stream is delivered
/// via the `Channel<AudioEvent>` argument; this just hands back a handle
/// so JS can call `stop_capture(handle)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureHandle {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopCaptureOptions {
    pub id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    /// One of `"granted"`, `"denied"`, `"prompt"`, `"prompt-with-rationale"`.
    /// Matches the Tauri permission-state convention used by other plugins
    /// like `tauri-plugin-notification`.
    pub microphone: String,
}
