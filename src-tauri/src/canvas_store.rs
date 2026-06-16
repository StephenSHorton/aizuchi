//! Concurrency boundary for the canvas documents.
//!
//! The file on disk (`canvas::read_document`/`write_document`, atomic via
//! tmp+rename) is the single source of truth. `CanvasStore` serializes all
//! WRITES through one `Mutex` and does read-modify-write against disk per
//! operation, so there is no in-memory cache to desync from the file. This
//! is the local analog of agility-platform's kahe-owned conditional write:
//!
//! - **effects** (`apply_effects`) are append/upsert style and just bump
//!   `version`; the lock serializes concurrent agents — no version token
//!   needed from the caller.
//! - **whole-doc PUT** (`put`) is the geometry-owning local app's path and
//!   uses compare-and-swap on `version`; a stale write returns
//!   `StoreError::Conflict` (→ HTTP 409), surfaced to the caller rather than
//!   silently clobbering.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use chrono::Utc;
use tokio::sync::Notify;

use crate::canvas::{self, CanvasDocument, CanvasEffect, ProjectMeta};

pub struct CanvasStore {
    base: PathBuf,
    /// Serializes all canvas writes. The unit value is intentional — the
    /// real shared state lives on disk; this only orders mutators.
    write_lock: Mutex<()>,
    /// Woken on every successful mutation. Powers the long-poll observe
    /// channel (added in the multi-agent phase).
    pub notify: Arc<Notify>,
}

#[derive(Debug)]
pub enum StoreError {
    /// Whole-doc PUT version mismatch — someone wrote since the caller read.
    Conflict {
        current_version: u64,
        updated_by: Option<String>,
    },
    /// An effect targeted a node/edge that doesn't exist.
    NotFound(String),
    /// Malformed effect / payload.
    Invalid(String),
    /// Disk or serialization failure.
    Io(String),
}

impl CanvasStore {
    pub fn new(base: PathBuf) -> Self {
        CanvasStore {
            base,
            write_lock: Mutex::new(()),
            notify: Arc::new(Notify::new()),
        }
    }

    /// Default project metadata for get-or-empty. The two well-known boards
    /// get friendly titles; anything else defaults to a scratch-pad-kind
    /// board titled after its id.
    fn default_meta(project_id: &str) -> (&'static str, String) {
        match project_id {
            "scratch-pad" => ("scratch_pad", "Scratch Pad".to_string()),
            "work" => ("agent_work", "Agent Work".to_string()),
            other => ("scratch_pad", other.to_string()),
        }
    }

    fn load_or_empty(&self, project_id: &str) -> Result<CanvasDocument, StoreError> {
        match canvas::read_document(&self.base, project_id).map_err(StoreError::Io)? {
            Some(doc) => Ok(doc),
            None => {
                let (kind, title) = Self::default_meta(project_id);
                Ok(CanvasDocument::empty(project_id, kind, &title))
            }
        }
    }

    /// Read a project's document (get-or-empty so the canvas always loads).
    /// Lock-free: writes are atomic, so any read sees a consistent file.
    pub fn get(&self, project_id: &str) -> Result<CanvasDocument, StoreError> {
        self.load_or_empty(project_id)
    }

    pub fn list(&self) -> Result<Vec<ProjectMeta>, StoreError> {
        canvas::list_projects(&self.base).map_err(StoreError::Io)
    }

    /// Apply a batch of effects atomically, bump `version` once, persist.
    /// Returns the saved document and the ids each effect touched.
    pub fn apply_effects(
        &self,
        project_id: &str,
        effects: Vec<CanvasEffect>,
        author: Option<String>,
    ) -> Result<(CanvasDocument, Vec<String>), StoreError> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|e| StoreError::Io(format!("lock: {e}")))?;
        let mut doc = self.load_or_empty(project_id)?;
        let mut affected = Vec::with_capacity(effects.len());
        for eff in effects {
            let id = canvas::apply_effect(&mut doc, eff).map_err(|e| {
                if e.contains("not found") {
                    StoreError::NotFound(e)
                } else {
                    StoreError::Invalid(e)
                }
            })?;
            affected.push(id);
        }
        doc.version += 1;
        doc.updated_at = Some(Utc::now().to_rfc3339());
        doc.updated_by = author;
        canvas::write_document(&self.base, &doc).map_err(StoreError::Io)?;
        self.notify.notify_waiters();
        Ok((doc, affected))
    }

    /// Whole-document save with compare-and-swap on `version`. This is the
    /// local app's geometry-owning path (positions/pinned). A version
    /// mismatch is a `Conflict` the caller resolves (the app refetches +
    /// re-saves last-write-wins; an agent would surface + retry).
    pub fn put(
        &self,
        mut incoming: CanvasDocument,
        author: Option<String>,
    ) -> Result<CanvasDocument, StoreError> {
        canvas::validate_project_id(&incoming.project_id).map_err(StoreError::Invalid)?;
        let _guard = self
            .write_lock
            .lock()
            .map_err(|e| StoreError::Io(format!("lock: {e}")))?;
        let current = self.load_or_empty(&incoming.project_id)?;
        if incoming.version != current.version {
            return Err(StoreError::Conflict {
                current_version: current.version,
                updated_by: current.updated_by.clone(),
            });
        }
        incoming.version = current.version + 1;
        incoming.updated_at = Some(Utc::now().to_rfc3339());
        incoming.updated_by = author;
        canvas::write_document(&self.base, &incoming).map_err(StoreError::Io)?;
        self.notify.notify_waiters();
        Ok(incoming)
    }

    pub fn delete(&self, project_id: &str) -> Result<(), StoreError> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|e| StoreError::Io(format!("lock: {e}")))?;
        canvas::delete_project(&self.base, project_id).map_err(|e| {
            if e.contains("not found") {
                StoreError::NotFound(e)
            } else {
                StoreError::Io(e)
            }
        })?;
        self.notify.notify_waiters();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canvas::{CanvasEdge, CanvasNode};
    use std::env;

    fn fresh_store(name: &str) -> CanvasStore {
        let mut base = env::temp_dir();
        base.push(format!("aizuchi-store-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        CanvasStore::new(base)
    }

    fn add(id: &str, kind: &str) -> CanvasEffect {
        CanvasEffect::Add {
            node: CanvasNode {
                id: id.to_string(),
                node_type: kind.to_string(),
                payload: serde_json::json!({ "title": id }),
                user_meta: None,
                created_by: None,
            },
        }
    }

    #[test]
    fn effects_bump_version_and_persist() {
        let store = fresh_store("effects");
        let (doc, affected) = store
            .apply_effects("scratch-pad", vec![add("a", "note"), add("b", "note")], None)
            .unwrap();
        assert_eq!(doc.version, 1);
        assert_eq!(doc.nodes.len(), 2);
        assert_eq!(affected, vec!["a", "b"]);
        // Persisted: a fresh get sees it.
        let again = store.get("scratch-pad").unwrap();
        assert_eq!(again.nodes.len(), 2);
        assert_eq!(again.version, 1);

        let (doc2, _) = store.apply_effects("scratch-pad", vec![add("c", "note")], None).unwrap();
        assert_eq!(doc2.version, 2);
        assert_eq!(doc2.nodes.len(), 3);
    }

    #[test]
    fn get_or_empty_for_unknown_project() {
        let store = fresh_store("empty");
        let doc = store.get("scratch-pad").unwrap();
        assert_eq!(doc.version, 0);
        assert_eq!(doc.kind, "scratch_pad");
        assert_eq!(doc.title, "Scratch Pad");
        assert!(doc.nodes.is_empty());
    }

    #[test]
    fn put_cas_accepts_matching_version_rejects_stale() {
        let store = fresh_store("cas");
        // Seed at v1 via an effect.
        store.apply_effects("scratch-pad", vec![add("a", "note")], None).unwrap();
        let mut doc = store.get("scratch-pad").unwrap();
        assert_eq!(doc.version, 1);

        // A matching PUT succeeds and bumps to v2.
        doc.positions
            .insert("a".into(), crate::canvas::CanvasPosition { x: 10.0, y: 20.0 });
        let saved = store.put(doc.clone(), None).unwrap();
        assert_eq!(saved.version, 2);
        assert_eq!(saved.positions["a"].x, 10.0);

        // A stale PUT (still at v1) is rejected as a conflict.
        let mut stale = doc; // version still 1
        stale.positions.insert(
            "a".into(),
            crate::canvas::CanvasPosition { x: 99.0, y: 99.0 },
        );
        match store.put(stale, None) {
            Err(StoreError::Conflict { current_version, .. }) => {
                assert_eq!(current_version, 2);
            }
            other => panic!("expected conflict, got {other:?}"),
        }
    }

    #[test]
    fn connect_then_remove_node_cleans_edges() {
        let store = fresh_store("connect");
        store
            .apply_effects(
                "scratch-pad",
                vec![
                    add("a", "note"),
                    add("b", "note"),
                    CanvasEffect::Connect {
                        edge: CanvasEdge {
                            id: "e1".into(),
                            from: "a".into(),
                            to: "b".into(),
                            relation: "relates_to".into(),
                            animated: None,
                            label: None,
                        },
                    },
                ],
                None,
            )
            .unwrap();
        let (doc, _) = store
            .apply_effects("scratch-pad", vec![CanvasEffect::Remove { id: "a".into() }], None)
            .unwrap();
        assert_eq!(doc.nodes.len(), 1);
        assert!(doc.edges.is_empty());
    }

    #[test]
    fn update_missing_node_is_not_found() {
        let store = fresh_store("update-missing");
        match store.apply_effects(
            "scratch-pad",
            vec![CanvasEffect::Update {
                id: "ghost".into(),
                payload: serde_json::json!({ "x": 1 }),
            }],
            None,
        ) {
            Err(StoreError::NotFound(_)) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
    }
}
