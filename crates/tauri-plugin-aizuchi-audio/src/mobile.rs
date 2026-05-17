// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mobile dispatch — Rust-side handle that forwards to the Swift class
// via `PluginHandle::run_mobile_plugin`. Pattern lifted from
// `plugins-workspace/plugins/haptics/src/mobile.rs`.

use serde::de::DeserializeOwned;
use serde::Serialize;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_aizuchi_audio);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<AizuchiAudio<R>> {
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_aizuchi_audio)?;
    #[cfg(not(target_os = "ios"))]
    let handle: PluginHandle<R> = {
        // Android isn't wired yet — fall through so a `cargo check` on
        // android still compiles the dispatcher without panicking. The
        // commands below will return a PluginInvoke error.
        let _ = api;
        unreachable!("aizuchi-audio mobile.rs reached on non-iOS mobile target")
    };
    Ok(AizuchiAudio(handle))
}

pub struct AizuchiAudio<R: Runtime>(PluginHandle<R>);

/// Channel-bearing payload. We pass the Channel<AudioEvent> *down* into
/// the Swift plugin so it can call `channel.send(...)` from the
/// AVAudioEngine tap thread. Tauri serializes `Channel<T>` to a marker
/// the iOS plugin layer resolves back to a callable function pointer in
/// the host webview.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartCapturePayload {
    #[serde(flatten)]
    options: StartCaptureOptions,
    on_event: tauri::ipc::Channel<AudioEvent>,
}

impl<R: Runtime> AizuchiAudio<R> {
    pub fn start_capture(
        &self,
        options: StartCaptureOptions,
        on_event: tauri::ipc::Channel<AudioEvent>,
    ) -> crate::Result<CaptureHandle> {
        self.0
            .run_mobile_plugin("startCapture", StartCapturePayload { options, on_event })
            .map_err(Into::into)
    }

    pub fn stop_capture(&self, options: StopCaptureOptions) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("stopCapture", options)
            .map_err(Into::into)
    }

    pub fn check_permissions(&self) -> crate::Result<PermissionStatus> {
        self.0
            .run_mobile_plugin("checkPermissions", ())
            .map_err(Into::into)
    }

    pub fn request_permissions(&self) -> crate::Result<PermissionStatus> {
        self.0
            .run_mobile_plugin("requestPermissions", ())
            .map_err(Into::into)
    }
}
