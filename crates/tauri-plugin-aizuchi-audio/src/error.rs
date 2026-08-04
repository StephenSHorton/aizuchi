// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Error/Result types follow the pattern from `tauri-plugin-haptics`:
// one variant per failure surface, all `Serialize` so the JS bridge can
// turn them into JS errors.

use serde::{ser::Serializer, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),

    #[error("microphone permission denied")]
    PermissionDenied,

    #[error("capture is already running")]
    AlreadyRunning,

    #[error("audio engine error: {0}")]
    AudioEngine(String),

    #[error("session configuration failed: {0}")]
    SessionConfig(String),

    #[error("invalid capture parameters: {0}")]
    InvalidParams(String),
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
