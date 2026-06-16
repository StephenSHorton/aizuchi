//! Canvas document model + pure file I/O + effect application.
//!
//! The canvas replaces the "one OS window per sticky note" model. A
//! *canvas document* is a node-graph board persisted as a single JSON file
//! at `~/.aizuchi/canvas/<projectId>.json`. The scratch pad is project
//! `scratch-pad`; agent-work boards are their own projects. Topology
//! (`nodes`/`edges`) and geometry (`positions`/`pinned`) are deliberately
//! separated — agents emit topology only; the app owns geometry — which is
//! what makes drag-vs-AI-write races structurally impossible (the lesson
//! ported from agility-platform's scratch pad).
//!
//! This module is PURE: structs, the effect applier, and file ops keyed off
//! a `base: &Path`. No Tauri, no lock — so it unit-tests exactly like
//! `meetings.rs`. The `Mutex` + compare-and-swap live in `canvas_store.rs`.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::log;

/// On-disk schema version. Bump only for breaking shape changes; the loader
/// is otherwise lenient (every field is `#[serde(default)]`) so a document
/// written by a newer build still loads rather than blanking the board.
pub const SUPPORTED_SCHEMA_VERSION: u32 = 1;

fn default_kind() -> String {
    "scratch_pad".to_string()
}

// ---------------------------------------------------------------------------
// Wire structs (camelCase — the TS client + MCP mirror these 1:1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasSize {
    pub width: f64,
    /// Set only once the user manually resizes height; otherwise height is
    /// content-driven (auto).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMeta {
    /// Free-text steer the user attaches for the AI (never part of the
    /// AI-authored payload).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note_for_ai: Option<String>,
    /// True when the user hand-placed this node (mirrors the doc-level
    /// `pinned` set; carried here for convenience).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasNode {
    /// Agent-chosen stable slug (e.g. `auth_design`). Doubles as the
    /// cross-agent address: two agents target the same node by reusing the
    /// id, no out-of-band uuid exchange. Collisions upsert.
    pub id: String,
    /// Node kind. LOOSE on purpose (forward-migration) — the closed
    /// vocabulary is enforced in the TS MCP-tool layer, not here.
    pub node_type: String,
    /// Flat per-kind body; server-opaque.
    #[serde(default)]
    pub payload: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_meta: Option<UserMeta>,
    /// Provenance: which agent/session created this node (work-graph value).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    /// Relation. LOOSE for the same forward-migration reason as `node_type`.
    pub relation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub animated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasDocument {
    pub schema_version: u32,
    pub project_id: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub nodes: Vec<CanvasNode>,
    #[serde(default)]
    pub edges: Vec<CanvasEdge>,
    /// id → last-settled coordinate. CLIENT-OWNED geometry the AI never sees
    /// or writes; only the local app's whole-doc PUT touches this.
    #[serde(default)]
    pub positions: HashMap<String, CanvasPosition>,
    /// Node ids the user hand-placed (force-sim pins; re-applied on hydrate).
    #[serde(default)]
    pub pinned: Vec<String>,
    /// id → user-set card size. CLIENT-OWNED geometry like `positions`; the AI
    /// never sets it. Height is always content-driven, so only width is stored.
    #[serde(default)]
    pub sizes: HashMap<String, CanvasSize>,
    /// Monotonic compare-and-swap counter. Bumped on every successful
    /// mutation; doubles as the cursor for the (later) observe channel.
    #[serde(default)]
    pub version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
}

impl CanvasDocument {
    /// A fresh, empty document — returned by GET for a project that doesn't
    /// exist yet (get-or-empty, so the canvas always loads).
    pub fn empty(project_id: &str, kind: &str, title: &str) -> Self {
        CanvasDocument {
            schema_version: SUPPORTED_SCHEMA_VERSION,
            project_id: project_id.to_string(),
            kind: kind.to_string(),
            title: title.to_string(),
            nodes: Vec::new(),
            edges: Vec::new(),
            positions: HashMap::new(),
            pinned: Vec::new(),
            sizes: HashMap::new(),
            version: 0,
            updated_at: None,
            updated_by: None,
        }
    }
}

/// Lightweight project listing entry — derived by reading only the top
/// fields of each file (like `meetings::list_snapshots`), never the whole
/// node/edge arrays.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub project_id: String,
    pub kind: String,
    pub title: String,
    pub node_count: usize,
    pub edge_count: usize,
    pub version: u64,
    pub updated_at: Option<String>,
}

// ---------------------------------------------------------------------------
// Effect union — the closed mutation vocabulary agents + the canvas apply.
// Internally tagged on `op`; geometry ops are absent BY DESIGN.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum CanvasEffect {
    /// Upsert a node by id (idempotent — re-`add` replaces).
    Add { node: CanvasNode },
    /// Upsert an edge by id.
    Connect { edge: CanvasEdge },
    /// Shallow-merge a payload object into an existing node's payload.
    Update {
        id: String,
        #[serde(default)]
        payload: serde_json::Value,
    },
    /// Change an existing edge's relation.
    SetRelation { id: String, relation: String },
    /// Remove a node and any edges touching it (+ its geometry/pin).
    Remove { id: String },
    /// Remove a single edge by id.
    RemoveEdge { id: String },
    /// Drop all nodes + edges + geometry (keeps project identity).
    Clear,
}

/// Apply one effect to a document IN PLACE. Pure topology mutation — does
/// NOT bump `version` (the store owns that). Returns the primary affected
/// id for changelog/ack purposes.
pub fn apply_effect(doc: &mut CanvasDocument, effect: CanvasEffect) -> Result<String, String> {
    match effect {
        CanvasEffect::Add { node } => {
            let id = node.id.clone();
            match doc.nodes.iter_mut().find(|n| n.id == id) {
                Some(existing) => *existing = node,
                None => doc.nodes.push(node),
            }
            Ok(id)
        }
        CanvasEffect::Connect { edge } => {
            let id = edge.id.clone();
            match doc.edges.iter_mut().find(|e| e.id == id) {
                Some(existing) => *existing = edge,
                None => doc.edges.push(edge),
            }
            Ok(id)
        }
        CanvasEffect::Update { id, payload } => {
            let node = doc
                .nodes
                .iter_mut()
                .find(|n| n.id == id)
                .ok_or_else(|| format!("node not found: {id}"))?;
            merge_payload(&mut node.payload, payload);
            Ok(id)
        }
        CanvasEffect::SetRelation { id, relation } => {
            let edge = doc
                .edges
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or_else(|| format!("edge not found: {id}"))?;
            edge.relation = relation;
            Ok(id)
        }
        CanvasEffect::Remove { id } => {
            doc.nodes.retain(|n| n.id != id);
            doc.edges.retain(|e| e.from != id && e.to != id);
            doc.positions.remove(&id);
            doc.sizes.remove(&id);
            doc.pinned.retain(|p| *p != id);
            Ok(id)
        }
        CanvasEffect::RemoveEdge { id } => {
            doc.edges.retain(|e| e.id != id);
            Ok(id)
        }
        CanvasEffect::Clear => {
            doc.nodes.clear();
            doc.edges.clear();
            doc.positions.clear();
            doc.sizes.clear();
            doc.pinned.clear();
            Ok(String::new())
        }
    }
}

/// Shallow-merge `patch` object keys into `target` object. Non-object
/// patches replace wholesale (matches the loose, lenient posture).
fn merge_payload(target: &mut serde_json::Value, patch: serde_json::Value) {
    match (target.as_object_mut(), patch) {
        (Some(obj), serde_json::Value::Object(patch_obj)) => {
            for (k, v) in patch_obj {
                obj.insert(k, v);
            }
        }
        (_, other) => *target = other,
    }
}

// ---------------------------------------------------------------------------
// File I/O — atomic (tmp + rename + sync) so a mid-write read can't truncate.
// ---------------------------------------------------------------------------

fn canvas_dir(base: &Path) -> PathBuf {
    base.join("canvas")
}

/// Reject ids that could escape the canvas dir or collide with the tmp
/// sentinel. Slugs only (the TS layer enforces the stricter slug regex).
pub fn validate_project_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.starts_with('.')
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
    {
        return Err(format!("Invalid project id: {id}"));
    }
    Ok(())
}

/// Read a document, or `None` if the file doesn't exist. A corrupt/partial
/// file surfaces as an `Err` (the store treats that as get-or-empty).
pub fn read_document(base: &Path, project_id: &str) -> Result<Option<CanvasDocument>, String> {
    validate_project_id(project_id)?;
    let path = canvas_dir(base).join(format!("{project_id}.json"));
    if !path.exists() {
        return Ok(None);
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let doc: CanvasDocument = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    Ok(Some(doc))
}

/// Write a document atomically: serialize to a tmp file in the same dir,
/// fsync, then rename over the target. Mirrors `discovery::write_atomic` and
/// `write_meeting_debug` — and is the fix for the sticky model's truncating
/// `fs::write`.
pub fn write_document(base: &Path, doc: &CanvasDocument) -> Result<(), String> {
    validate_project_id(&doc.project_id)?;
    let dir = canvas_dir(base);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", doc.project_id));
    let tmp = dir.join(format!(".{}.json.tmp", doc.project_id));
    let json = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    log(&format!("canvas: wrote {path:?} (v{})", doc.version));
    Ok(())
}

/// List projects by reading only the top fields of each file.
pub fn list_projects(base: &Path) -> Result<Vec<ProjectMeta>, String> {
    let dir = canvas_dir(base);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut metas: Vec<ProjectMeta> = vec![];
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                log(&format!("canvas list: skip entry: {e}"));
                continue;
            }
        };
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let data = match fs::read_to_string(&path) {
            Ok(d) => d,
            Err(e) => {
                log(&format!("canvas list: skip {path:?}: {e}"));
                continue;
            }
        };
        let value: serde_json::Value = match serde_json::from_str(&data) {
            Ok(v) => v,
            Err(e) => {
                log(&format!("canvas list: skip {path:?}: parse {e}"));
                continue;
            }
        };
        let project_id = match value.get("projectId").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        metas.push(ProjectMeta {
            project_id,
            kind: value
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("scratch_pad")
                .to_string(),
            title: value
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            node_count: value
                .get("nodes")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0),
            edge_count: value
                .get("edges")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0),
            version: value.get("version").and_then(|v| v.as_u64()).unwrap_or(0),
            updated_at: value
                .get("updatedAt")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        });
    }
    metas.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(metas)
}

pub fn delete_project(base: &Path, project_id: &str) -> Result<(), String> {
    validate_project_id(project_id)?;
    let path = canvas_dir(base).join(format!("{project_id}.json"));
    if !path.exists() {
        return Err(format!("Project not found: {project_id}"));
    }
    fs::remove_file(&path).map_err(|e| e.to_string())?;
    log(&format!("canvas: deleted {path:?}"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn fresh_base(name: &str) -> PathBuf {
        let mut base = env::temp_dir();
        base.push(format!("aizuchi-canvas-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn node(id: &str, kind: &str) -> CanvasNode {
        CanvasNode {
            id: id.to_string(),
            node_type: kind.to_string(),
            payload: serde_json::json!({ "title": id }),
            user_meta: None,
            created_by: None,
        }
    }

    fn edge(id: &str, from: &str, to: &str, rel: &str) -> CanvasEdge {
        CanvasEdge {
            id: id.to_string(),
            from: from.to_string(),
            to: to.to_string(),
            relation: rel.to_string(),
            animated: None,
            label: None,
        }
    }

    #[test]
    fn round_trip_document() {
        let base = fresh_base("round-trip");
        let mut doc = CanvasDocument::empty("scratch-pad", "scratch_pad", "Scratch Pad");
        doc.nodes.push(node("auth_design", "note"));
        doc.positions
            .insert("auth_design".into(), CanvasPosition { x: 1.0, y: 2.0 });
        doc.version = 3;
        write_document(&base, &doc).unwrap();
        let loaded = read_document(&base, "scratch-pad").unwrap().unwrap();
        assert_eq!(loaded.project_id, "scratch-pad");
        assert_eq!(loaded.nodes.len(), 1);
        assert_eq!(loaded.nodes[0].id, "auth_design");
        assert_eq!(loaded.positions["auth_design"], CanvasPosition { x: 1.0, y: 2.0 });
        assert_eq!(loaded.version, 3);
    }

    #[test]
    fn read_missing_is_none() {
        let base = fresh_base("missing");
        assert!(read_document(&base, "nope").unwrap().is_none());
    }

    #[test]
    fn apply_add_is_idempotent_upsert() {
        let mut doc = CanvasDocument::empty("p", "scratch_pad", "");
        apply_effect(&mut doc, CanvasEffect::Add { node: node("a", "note") }).unwrap();
        apply_effect(&mut doc, CanvasEffect::Add { node: node("a", "task") }).unwrap();
        assert_eq!(doc.nodes.len(), 1);
        assert_eq!(doc.nodes[0].node_type, "task");
    }

    #[test]
    fn apply_update_merges_payload() {
        let mut doc = CanvasDocument::empty("p", "scratch_pad", "");
        apply_effect(&mut doc, CanvasEffect::Add { node: node("a", "task") }).unwrap();
        apply_effect(
            &mut doc,
            CanvasEffect::Update {
                id: "a".into(),
                payload: serde_json::json!({ "status": "done" }),
            },
        )
        .unwrap();
        // title (from add) preserved, status merged in.
        assert_eq!(doc.nodes[0].payload["title"], "a");
        assert_eq!(doc.nodes[0].payload["status"], "done");
    }

    #[test]
    fn apply_update_missing_node_errors() {
        let mut doc = CanvasDocument::empty("p", "scratch_pad", "");
        let err = apply_effect(
            &mut doc,
            CanvasEffect::Update {
                id: "ghost".into(),
                payload: serde_json::json!({}),
            },
        )
        .unwrap_err();
        assert!(err.contains("not found"), "got: {err}");
    }

    #[test]
    fn remove_node_drops_touching_edges_and_geometry() {
        let mut doc = CanvasDocument::empty("p", "scratch_pad", "");
        apply_effect(&mut doc, CanvasEffect::Add { node: node("a", "note") }).unwrap();
        apply_effect(&mut doc, CanvasEffect::Add { node: node("b", "note") }).unwrap();
        apply_effect(
            &mut doc,
            CanvasEffect::Connect { edge: edge("a-b", "a", "b", "relates_to") },
        )
        .unwrap();
        doc.positions.insert("a".into(), CanvasPosition { x: 5.0, y: 5.0 });
        doc.pinned.push("a".into());

        apply_effect(&mut doc, CanvasEffect::Remove { id: "a".into() }).unwrap();
        assert_eq!(doc.nodes.len(), 1);
        assert!(doc.edges.is_empty(), "edge touching removed node should drop");
        assert!(!doc.positions.contains_key("a"));
        assert!(doc.pinned.is_empty());
    }

    #[test]
    fn effect_deserializes_from_wire() {
        let wire = serde_json::json!({ "op": "add", "node": { "id": "x", "nodeType": "note", "payload": {} } });
        let eff: CanvasEffect = serde_json::from_value(wire).unwrap();
        let mut doc = CanvasDocument::empty("p", "scratch_pad", "");
        apply_effect(&mut doc, eff).unwrap();
        assert_eq!(doc.nodes[0].id, "x");
    }

    #[test]
    fn forward_migration_loads_unknown_node_type() {
        // A board written by a newer build with a kind this build doesn't
        // know must still load (loose node_type).
        let base = fresh_base("forward");
        let raw = serde_json::json!({
            "schemaVersion": 1,
            "projectId": "scratch-pad",
            "kind": "scratch_pad",
            "title": "",
            "nodes": [{ "id": "z", "nodeType": "future_kind_2099", "payload": { "x": 1 } }],
            "edges": [],
            "positions": {},
            "pinned": [],
            "version": 1
        });
        let dir = canvas_dir(&base);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("scratch-pad.json"), raw.to_string()).unwrap();
        let loaded = read_document(&base, "scratch-pad").unwrap().unwrap();
        assert_eq!(loaded.nodes[0].node_type, "future_kind_2099");
    }

    #[test]
    fn list_projects_reads_meta_only() {
        let base = fresh_base("list");
        let mut a = CanvasDocument::empty("scratch-pad", "scratch_pad", "Scratch Pad");
        a.nodes.push(node("n1", "note"));
        a.updated_at = Some("2026-06-15T00:00:00Z".into());
        write_document(&base, &a).unwrap();
        let mut b = CanvasDocument::empty("work", "agent_work", "Agent Work");
        b.updated_at = Some("2026-06-15T01:00:00Z".into());
        write_document(&base, &b).unwrap();

        let metas = list_projects(&base).unwrap();
        assert_eq!(metas.len(), 2);
        // Newest updatedAt first.
        assert_eq!(metas[0].project_id, "work");
        let sp = metas.iter().find(|m| m.project_id == "scratch-pad").unwrap();
        assert_eq!(sp.node_count, 1);
        assert_eq!(sp.kind, "scratch_pad");
    }

    #[test]
    fn rejects_path_traversal() {
        let base = fresh_base("traversal");
        assert!(validate_project_id("../etc").is_err());
        assert!(validate_project_id("a/b").is_err());
        assert!(validate_project_id(".hidden").is_err());
        assert!(validate_project_id("").is_err());
        assert!(validate_project_id("scratch-pad").is_ok());
        assert!(read_document(&base, "../secrets").is_err());
    }

    #[test]
    fn delete_removes_file() {
        let base = fresh_base("delete");
        let doc = CanvasDocument::empty("doomed", "scratch_pad", "");
        write_document(&base, &doc).unwrap();
        assert!(read_document(&base, "doomed").unwrap().is_some());
        delete_project(&base, "doomed").unwrap();
        assert!(read_document(&base, "doomed").unwrap().is_none());
        assert!(delete_project(&base, "doomed").is_err());
    }
}
