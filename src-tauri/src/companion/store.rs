//! On-disk schema for paired devices.
//!
//! File: `~/.aizuchi/paired-devices.json`, mode 0600.
//!
//! Schema (v1):
//! ```json
//! {
//!   "version": 1,
//!   "devices": [
//!     {
//!       "deviceId": "550e8400-e29b-41d4-a716-446655440000",
//!       "label": "Stephen's iPhone",
//!       "pubkeyFingerprint": "ab12cd34ef567890",
//!       "pairedAt": "2026-05-16T18:42:00Z",
//!       "lastSeenAt": "2026-05-16T18:42:00Z",
//!       "revoked": false
//!     }
//!   ]
//! }
//! ```
//!
//! The device key itself is NOT stored — it's deterministically
//! re-derived from the root key + `deviceId` every time the desktop
//! needs to validate a request. (One less secret to spill.)

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const PAIRED_DEVICES_FILENAME: &str = "paired-devices.json";
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub device_id: String,
    pub label: String,
    /// Hex-encoded SHA-256(public-key) truncated to 8 bytes. The pub key
    /// itself is supplied by the phone at pairing time (X25519 / Ed25519)
    /// and isn't needed for the current symmetric-key flow — we keep the
    /// fingerprint as a UX signal ("did I really pair with that device?").
    pub pubkey_fingerprint: String,
    pub paired_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    #[serde(default)]
    pub revoked: bool,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct OnDisk {
    version: u32,
    devices: Vec<PairedDevice>,
}

pub struct PairedDeviceStore {
    base: PathBuf,
    inner: Mutex<Vec<PairedDevice>>,
}

impl PairedDeviceStore {
    pub fn load(base: &Path) -> Result<Self, String> {
        fs::create_dir_all(base).map_err(|e| format!("create dir: {e}"))?;
        let path = base.join(PAIRED_DEVICES_FILENAME);

        let devices = if path.exists() {
            let raw = fs::read_to_string(&path).map_err(|e| format!("read store: {e}"))?;
            let parsed: OnDisk =
                serde_json::from_str(&raw).map_err(|e| format!("parse store: {e}"))?;
            if parsed.version != SCHEMA_VERSION {
                return Err(format!(
                    "unsupported paired-devices schema: {}",
                    parsed.version
                ));
            }
            parsed.devices
        } else {
            Vec::new()
        };

        Ok(Self {
            base: base.to_path_buf(),
            inner: Mutex::new(devices),
        })
    }

    pub fn list(&self) -> Vec<PairedDevice> {
        self.inner.lock().unwrap().clone()
    }

    pub fn find(&self, device_id: &str) -> Option<PairedDevice> {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .find(|d| d.device_id == device_id)
            .cloned()
    }

    /// Insert a new device record. Returns Err if a device with the
    /// same id already exists (caller should mint a new id).
    pub fn insert(&self, dev: PairedDevice) -> Result<(), String> {
        let mut g = self.inner.lock().unwrap();
        if g.iter().any(|d| d.device_id == dev.device_id) {
            return Err(format!("device {} already paired", dev.device_id));
        }
        g.push(dev);
        self.flush(&g)?;
        Ok(())
    }

    /// Mark a device as revoked. Persists immediately. Returns Err if
    /// the id isn't known.
    pub fn revoke(&self, device_id: &str) -> Result<(), String> {
        let mut g = self.inner.lock().unwrap();
        let dev = g
            .iter_mut()
            .find(|d| d.device_id == device_id)
            .ok_or_else(|| format!("device {device_id} not found"))?;
        dev.revoked = true;
        self.flush(&g)?;
        Ok(())
    }

    pub fn touch_last_seen(&self, device_id: &str) -> Result<(), String> {
        let mut g = self.inner.lock().unwrap();
        if let Some(dev) = g.iter_mut().find(|d| d.device_id == device_id) {
            dev.last_seen_at = Utc::now();
            self.flush(&g)?;
        }
        Ok(())
    }

    /// True if the device exists and is not revoked.
    pub fn is_active(&self, device_id: &str) -> bool {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .any(|d| d.device_id == device_id && !d.revoked)
    }

    fn flush(&self, devices: &Vec<PairedDevice>) -> Result<(), String> {
        let path = self.base.join(PAIRED_DEVICES_FILENAME);
        let tmp = path.with_extension("tmp");
        let on_disk = OnDisk {
            version: SCHEMA_VERSION,
            devices: devices.clone(),
        };
        let json = serde_json::to_vec_pretty(&on_disk)
            .map_err(|e| format!("serialise store: {e}"))?;
        fs::write(&tmp, &json).map_err(|e| format!("write tmp store: {e}"))?;
        #[cfg(unix)]
        {
            let mut perms = fs::metadata(&tmp)
                .map_err(|e| format!("stat tmp store: {e}"))?
                .permissions();
            perms.set_mode(0o600);
            fs::set_permissions(&tmp, perms)
                .map_err(|e| format!("chmod tmp store: {e}"))?;
        }
        fs::rename(&tmp, &path).map_err(|e| format!("rename tmp store: {e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn fresh_base(name: &str) -> PathBuf {
        let mut base = env::temp_dir();
        base.push(format!(
            "aizuchi-companion-store-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn sample(id: &str, label: &str) -> PairedDevice {
        PairedDevice {
            device_id: id.to_string(),
            label: label.to_string(),
            pubkey_fingerprint: "abcd1234".repeat(2),
            paired_at: Utc::now(),
            last_seen_at: Utc::now(),
            revoked: false,
        }
    }

    #[test]
    fn empty_store_loads() {
        let base = fresh_base("empty");
        let s = PairedDeviceStore::load(&base).unwrap();
        assert!(s.list().is_empty());
    }

    #[test]
    fn insert_persists() {
        let base = fresh_base("insert");
        let s = PairedDeviceStore::load(&base).unwrap();
        s.insert(sample("dev-1", "iPhone")).unwrap();
        let reloaded = PairedDeviceStore::load(&base).unwrap();
        assert_eq!(reloaded.list().len(), 1);
        assert_eq!(reloaded.list()[0].device_id, "dev-1");
    }

    #[test]
    fn revoke_blocks_is_active() {
        let base = fresh_base("revoke");
        let s = PairedDeviceStore::load(&base).unwrap();
        s.insert(sample("dev-1", "iPhone")).unwrap();
        assert!(s.is_active("dev-1"));
        s.revoke("dev-1").unwrap();
        assert!(!s.is_active("dev-1"));
        // Reload still revoked.
        let reloaded = PairedDeviceStore::load(&base).unwrap();
        assert!(!reloaded.is_active("dev-1"));
    }

    #[test]
    fn duplicate_insert_rejected() {
        let base = fresh_base("dup");
        let s = PairedDeviceStore::load(&base).unwrap();
        s.insert(sample("dev-1", "iPhone")).unwrap();
        assert!(s.insert(sample("dev-1", "iPhone")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn store_file_is_0600() {
        let base = fresh_base("perms");
        let s = PairedDeviceStore::load(&base).unwrap();
        s.insert(sample("dev-1", "iPhone")).unwrap();
        let mode = fs::metadata(base.join(PAIRED_DEVICES_FILENAME))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}
