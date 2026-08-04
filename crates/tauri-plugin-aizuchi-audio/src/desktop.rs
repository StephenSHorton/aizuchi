// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Desktop stub. The desktop capture path lives in
// `src-tauri/src/audio.rs` (cpal + whisper-rs). We do *not* duplicate it
// here — this crate exists for iOS. The desktop impl is a no-op so the
// same Tauri host code can register this plugin unconditionally without
// `#[cfg(mobile)]` branches at every call site.

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<AizuchiAudio<R>> {
    // `fn() -> R` makes the PhantomData unconditionally `Send + Sync`,
    // so `Manager::manage` accepts it without leaking a Send+Sync bound
    // up onto `R`. This is the standard workaround for "generic
    // parameter never actually held".
    Ok(AizuchiAudio {
        _marker: std::marker::PhantomData,
    })
}

pub struct AizuchiAudio<R: Runtime> {
    _marker: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> AizuchiAudio<R> {
    pub fn start_capture(
        &self,
        _options: StartCaptureOptions,
        _channel: tauri::ipc::Channel<AudioEvent>,
    ) -> crate::Result<CaptureHandle> {
        Err(crate::Error::SessionConfig(
            "desktop capture is handled by src-tauri/src/audio.rs (cpal); \
             this plugin is iOS-only"
                .to_string(),
        ))
    }

    pub fn stop_capture(&self, _options: StopCaptureOptions) -> crate::Result<()> {
        Ok(())
    }

    pub fn check_permissions(&self) -> crate::Result<PermissionStatus> {
        // On desktop the existing `ensure_microphone_access()` in
        // src-tauri/src/audio.rs handles this via objc2 (macOS) /
        // platform stub (other). Report "granted" so the unified API
        // doesn't gate the desktop UI on a permission check this plugin
        // doesn't perform.
        Ok(PermissionStatus {
            microphone: "granted".to_string(),
        })
    }

    pub fn request_permissions(&self) -> crate::Result<PermissionStatus> {
        self.check_permissions()
    }
}
