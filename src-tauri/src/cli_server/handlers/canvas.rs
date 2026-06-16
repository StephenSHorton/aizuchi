//! Canvas IPC handlers — the local "propose → apply → emit → ack" path.
//!
//! Each mutating handler takes the `CanvasStore` lock (in `canvas_store.rs`),
//! mutates the document, persists atomically, emits a `canvas:changed` Tauri
//! event so the live canvas window applies the change, and returns a rich
//! ack. There are NO geometry-setting effect endpoints — positions are
//! app-owned and only travel through the whole-doc `PUT` (the local app's
//! own save), never through an agent effect.

use std::sync::Arc;

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::{Response, StatusCode};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::canvas::{CanvasDocument, CanvasEffect};
use crate::canvas_store::{CanvasStore, StoreError};
use crate::cli_server::error::{json_response, no_content, IpcError};
use crate::cli_server::IpcCtx;

fn store(ctx: &Arc<IpcCtx>) -> Result<tauri::State<'_, CanvasStore>, IpcError> {
    ctx.app
        .try_state::<CanvasStore>()
        .ok_or_else(|| IpcError::Internal("CanvasStore missing".into()))
}

fn parse_body<T: for<'de> Deserialize<'de>>(body: &Bytes) -> Result<T, IpcError> {
    if body.is_empty() {
        return Err(IpcError::ValidationError(
            "Request body must be a JSON object".into(),
        ));
    }
    serde_json::from_slice(body).map_err(|e| IpcError::ValidationError(format!("body: {e}")))
}

fn map_store_err(e: StoreError) -> IpcError {
    match e {
        StoreError::Conflict {
            current_version, ..
        } => IpcError::Conflict(format!(
            "The canvas changed under you (now at version {current_version}). Re-read with the latest version and retry."
        )),
        StoreError::NotFound(m) => IpcError::ValidationError(m), // 400 with the message; bare NotFound is 404 w/o detail
        StoreError::Invalid(m) => IpcError::ValidationError(m),
        StoreError::Io(m) => IpcError::Internal(m),
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CanvasChanged {
    project_id: String,
    version: u64,
}

fn emit_changed(ctx: &Arc<IpcCtx>, project_id: &str, version: u64) {
    let _ = ctx.app.emit(
        "canvas:changed",
        CanvasChanged {
            project_id: project_id.to_string(),
            version,
        },
    );
}

// ---------------------------------------------------------------------------
// GET /v1/projects
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ProjectList {
    projects: Vec<crate::canvas::ProjectMeta>,
}

pub async fn list_projects(ctx: &Arc<IpcCtx>) -> Result<Response<Full<Bytes>>, IpcError> {
    let projects = store(ctx)?.list().map_err(map_store_err)?;
    Ok(json_response(StatusCode::OK, &ProjectList { projects }))
}

// ---------------------------------------------------------------------------
// DELETE /v1/projects/:id
// ---------------------------------------------------------------------------

pub async fn delete_project(
    ctx: &Arc<IpcCtx>,
    project_id: &str,
) -> Result<Response<Full<Bytes>>, IpcError> {
    store(ctx)?.delete(project_id).map_err(map_store_err)?;
    Ok(no_content())
}

// ---------------------------------------------------------------------------
// GET /v1/canvas/:id  — get-or-empty so the canvas always loads
// ---------------------------------------------------------------------------

pub async fn get_canvas(
    ctx: &Arc<IpcCtx>,
    project_id: &str,
) -> Result<Response<Full<Bytes>>, IpcError> {
    let doc = store(ctx)?.get(project_id).map_err(map_store_err)?;
    Ok(json_response(StatusCode::OK, &doc))
}

// ---------------------------------------------------------------------------
// PUT /v1/canvas/:id  — whole-doc save with version CAS (the app's geometry path)
// ---------------------------------------------------------------------------

pub async fn put_canvas(
    ctx: &Arc<IpcCtx>,
    project_id: &str,
    body: &Bytes,
) -> Result<Response<Full<Bytes>>, IpcError> {
    let mut incoming: CanvasDocument = parse_body(body)?;
    // The path id is authoritative; ignore any mismatched body id.
    incoming.project_id = project_id.to_string();
    let saved = store(ctx)?.put(incoming, None).map_err(map_store_err)?;
    emit_changed(ctx, project_id, saved.version);
    Ok(json_response(StatusCode::OK, &saved))
}

// ---------------------------------------------------------------------------
// POST /v1/canvas/:id/effects  — the agent + canvas mutation path
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EffectsBody {
    effects: Vec<CanvasEffect>,
    #[serde(default)]
    author: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EffectsAck {
    version: u64,
    applied: usize,
    affected: Vec<String>,
}

pub async fn apply_effects(
    ctx: &Arc<IpcCtx>,
    project_id: &str,
    body: &Bytes,
) -> Result<Response<Full<Bytes>>, IpcError> {
    let payload: EffectsBody = parse_body(body)?;
    if payload.effects.is_empty() {
        return Err(IpcError::ValidationError("effects[] must be non-empty".into()));
    }
    let applied = payload.effects.len();
    let (doc, affected) = store(ctx)?
        .apply_effects(project_id, payload.effects, payload.author)
        .map_err(map_store_err)?;
    emit_changed(ctx, project_id, doc.version);
    Ok(json_response(
        StatusCode::OK,
        &EffectsAck {
            version: doc.version,
            applied,
            affected,
        },
    ))
}

// ---------------------------------------------------------------------------
// GET /v1/canvas/:id/changes?since=N  — long-poll observe channel
//
// Lets a second agent block (up to ~25s) until the board advances past the
// version it last saw, instead of busy-polling. The store's `Notify` wakes
// waiters on every mutation (fast path); a 1s re-check bounds the worst case
// against any missed wakeup. The agent loops: read a version, observe, re-read.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangesResp {
    version: u64,
    changed: bool,
}

fn parse_since(query: &str) -> u64 {
    for pair in query.split('&') {
        if let Some(v) = pair.strip_prefix("since=") {
            return v.parse().unwrap_or(0);
        }
    }
    0
}

pub async fn changes(
    ctx: &Arc<IpcCtx>,
    project_id: &str,
    query: &str,
) -> Result<Response<Full<Bytes>>, IpcError> {
    let since = parse_since(query);
    // Own the Notify handle so we never hold the Tauri State across an await.
    let notify = store(ctx)?.notify.clone();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(25);
    loop {
        let version = store(ctx)?.get(project_id).map_err(map_store_err)?.version;
        if version > since {
            return Ok(json_response(
                StatusCode::OK,
                &ChangesResp {
                    version,
                    changed: true,
                },
            ));
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Ok(json_response(
                StatusCode::OK,
                &ChangesResp {
                    version,
                    changed: false,
                },
            ));
        }
        let wait = (deadline - now).min(std::time::Duration::from_secs(1));
        tokio::select! {
            _ = notify.notified() => {}
            _ = tokio::time::sleep(wait) => {}
        }
    }
}
