// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Thin command shims exposed to the webview. Each one delegates to the
// `AizuchiAudioExt` trait on the AppHandle, which `lib.rs` implements
// for any `Manager<R>`.

use tauri::{AppHandle, Runtime};

use crate::models::*;
use crate::AizuchiAudioExt;
use crate::Result;

#[tauri::command]
pub(crate) async fn start_capture<R: Runtime>(
    app: AppHandle<R>,
    options: Option<StartCaptureOptions>,
    on_event: tauri::ipc::Channel<AudioEvent>,
) -> Result<CaptureHandle> {
    app.aizuchi_audio()
        .start_capture(options.unwrap_or_default(), on_event)
}

#[tauri::command]
pub(crate) async fn stop_capture<R: Runtime>(
    app: AppHandle<R>,
    options: StopCaptureOptions,
) -> Result<()> {
    app.aizuchi_audio().stop_capture(options)
}

#[tauri::command]
pub(crate) async fn check_permissions<R: Runtime>(app: AppHandle<R>) -> Result<PermissionStatus> {
    app.aizuchi_audio().check_permissions()
}

#[tauri::command]
pub(crate) async fn request_permissions<R: Runtime>(
    app: AppHandle<R>,
) -> Result<PermissionStatus> {
    app.aizuchi_audio().request_permissions()
}
