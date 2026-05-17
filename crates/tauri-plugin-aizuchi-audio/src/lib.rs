// SPDX-License-Identifier: AGPL-3.0-or-later
//
//! Aizuchi iOS audio capture plugin.
//!
//! Provides streaming 16 kHz mono PCM from `AVAudioEngine` to Rust, with
//! correct `AVAudioSession` configuration for background-audio survival
//! (screen-lock, phone-call interruption, AirPods route changes).
//!
//! See `docs/spikes/aiz-57/report.md` for the full design rationale.
//!
//! ## Usage from a Tauri host
//!
//! ```ignore
//! tauri::Builder::default()
//!     .plugin(tauri_plugin_aizuchi_audio::init())
//!     // ... rest of the builder
//! ```

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use error::{Error, Result};
pub use models::*;

mod commands;
mod error;
mod models;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

#[cfg(desktop)]
pub use desktop::AizuchiAudio;
#[cfg(mobile)]
pub use mobile::AizuchiAudio;

/// Extension trait — `app_handle.aizuchi_audio().start_capture(...)`.
pub trait AizuchiAudioExt<R: Runtime> {
    fn aizuchi_audio(&self) -> &AizuchiAudio<R>;
}

impl<R: Runtime, T: Manager<R>> AizuchiAudioExt<R> for T {
    fn aizuchi_audio(&self) -> &AizuchiAudio<R> {
        self.state::<AizuchiAudio<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("aizuchi-audio")
        .invoke_handler(tauri::generate_handler![
            commands::start_capture,
            commands::stop_capture,
            commands::check_permissions,
            commands::request_permissions,
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let plugin = mobile::init(app, api)?;
            #[cfg(desktop)]
            let plugin = desktop::init(app, api)?;
            app.manage(plugin);
            Ok(())
        })
        .build()
}
