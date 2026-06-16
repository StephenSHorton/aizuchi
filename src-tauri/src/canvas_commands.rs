//! Tauri `#[command]` wrappers over `CanvasStore` for the in-app canvas
//! window. The webview can't reach the localhost IPC HTTP server (it has no
//! access to the bearer token file), so the frontend talks to the same
//! canonical `CanvasStore` through `invoke` — exactly how the sticky-note
//! window used `get_note`/`update_note_position`. External agents reach the
//! store via the IPC HTTP handlers; both serialize through the store lock.

use tauri::{AppHandle, Emitter, State};

use crate::canvas::{CanvasDocument, CanvasEffect};
use crate::canvas_store::{CanvasStore, StoreError};

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CanvasChanged {
    project_id: String,
    version: u64,
}

fn emit_changed(app: &AppHandle, project_id: &str, version: u64) {
    let _ = app.emit(
        "canvas:changed",
        CanvasChanged {
            project_id: project_id.to_string(),
            version,
        },
    );
}

/// Flatten a `StoreError` into a string for the JS boundary. A conflict is
/// prefixed `conflict:` so the frontend can detect it and refetch.
fn err_to_string(e: StoreError) -> String {
    match e {
        StoreError::Conflict {
            current_version, ..
        } => format!("conflict: canvas is at version {current_version}"),
        StoreError::NotFound(m) => format!("not_found: {m}"),
        StoreError::Invalid(m) => format!("invalid: {m}"),
        StoreError::Io(m) => format!("io: {m}"),
    }
}

#[tauri::command]
pub fn canvas_get(
    project_id: String,
    store: State<'_, CanvasStore>,
) -> Result<CanvasDocument, String> {
    store.get(&project_id).map_err(err_to_string)
}

/// List the existing canvas boards (meta only) — drives the in-window board
/// switcher sidebar.
#[tauri::command]
pub fn canvas_list_projects(
    store: State<'_, CanvasStore>,
) -> Result<Vec<crate::canvas::ProjectMeta>, String> {
    store.list().map_err(err_to_string)
}

#[tauri::command]
pub fn canvas_apply_effects(
    project_id: String,
    effects: Vec<CanvasEffect>,
    author: Option<String>,
    app: AppHandle,
    store: State<'_, CanvasStore>,
) -> Result<u64, String> {
    let (doc, _affected) = store
        .apply_effects(&project_id, effects, author)
        .map_err(err_to_string)?;
    emit_changed(&app, &project_id, doc.version);
    Ok(doc.version)
}

/// Whole-document save with version CAS — the geometry-owning path used by the
/// canvas window's debounced autosave (positions/pins). The path `project_id`
/// is authoritative.
#[tauri::command]
pub fn canvas_put(
    project_id: String,
    mut doc: CanvasDocument,
    app: AppHandle,
    store: State<'_, CanvasStore>,
) -> Result<CanvasDocument, String> {
    doc.project_id = project_id.clone();
    let saved = store.put(doc, None).map_err(err_to_string)?;
    emit_changed(&app, &project_id, saved.version);
    Ok(saved)
}
