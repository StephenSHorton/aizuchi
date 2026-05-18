//! Key material: the desktop root key (long-lived, 32 random bytes
//! persisted at `~/.aizuchi/companion-root.key` mode 0600), per-device
//! pairing keys (HKDF-derived from the root + the device id), and the
//! per-meeting capability key (HKDF-derived from the device key +
//! meeting id).
//!
//! The root key never leaves the desktop. Device keys are returned
//! once at pairing time, then stored only in the phone's Keychain.
//! Meeting keys are derived on demand on both sides — they're a pure
//! function of (device_key, meeting_id), so there is no separate
//! "issue token" round-trip.

use std::fs;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use hkdf::Hkdf;
use sha2::Sha256;

/// Filename used inside `~/.aizuchi/`.
pub const ROOT_KEY_FILENAME: &str = "companion-root.key";

/// 32 bytes of high-entropy material kept on disk in `~/.aizuchi/`.
pub const ROOT_KEY_BYTES: usize = 32;

/// Per-device pairing key length. 32 bytes is overkill for HMAC-SHA256
/// but matches the root key and keeps everything 256-bit.
pub const DEVICE_KEY_BYTES: usize = 32;

/// Per-meeting capability key length.
pub const MEETING_KEY_BYTES: usize = 32;

/// HKDF info string for device-key derivation. Bump if the derivation
/// rule changes — old phones will then need to re-pair.
const DEVICE_KEY_INFO: &[u8] = b"aizuchi-companion-v1/device-key";

/// HKDF info string for meeting-key derivation.
const MEETING_KEY_INFO: &[u8] = b"aizuchi-companion-v1/meeting-key";

/// Desktop-local root key. Never sent to the phone — only the derived
/// device key crosses the wire.
#[derive(Clone)]
pub struct RootKey(pub [u8; ROOT_KEY_BYTES]);

impl RootKey {
    /// Load the root key from `base/companion-root.key`, generating it
    /// if it doesn't exist yet. Mode 0600 is enforced on Unix.
    pub fn load_or_generate(base: &Path) -> Result<Self, String> {
        fs::create_dir_all(base).map_err(|e| format!("create root key dir: {e}"))?;
        let path = root_key_path(base);

        if path.exists() {
            let raw = fs::read(&path).map_err(|e| format!("read root key: {e}"))?;
            if raw.len() == ROOT_KEY_BYTES {
                #[cfg(unix)]
                ensure_mode_0600(&path);
                let mut k = [0u8; ROOT_KEY_BYTES];
                k.copy_from_slice(&raw);
                return Ok(RootKey(k));
            }
            // Malformed — regenerate. (Same policy as cli-token.)
        }

        let mut k = [0u8; ROOT_KEY_BYTES];
        getrandom::getrandom(&mut k).map_err(|e| format!("getrandom: {e}"))?;
        write_atomic_0600(&path, &k)?;
        Ok(RootKey(k))
    }

    /// Derive a per-device key. `device_id` should be a stable opaque
    /// identifier (we use a UUID v4 minted at pairing time).
    pub fn derive_device_key(&self, device_id: &str) -> DeviceKey {
        let hk = Hkdf::<Sha256>::new(Some(b"aizuchi-companion-v1"), &self.0);
        let mut out = [0u8; DEVICE_KEY_BYTES];
        // info = b"<DEVICE_KEY_INFO>:<device_id>"
        let mut info = Vec::with_capacity(DEVICE_KEY_INFO.len() + 1 + device_id.len());
        info.extend_from_slice(DEVICE_KEY_INFO);
        info.push(b':');
        info.extend_from_slice(device_id.as_bytes());
        hk.expand(&info, &mut out)
            .expect("HKDF expand fits in one block");
        DeviceKey(out)
    }

    /// Public fingerprint of the root key. Shown in the QR payload so
    /// the phone can later detect a "different desktop" without
    /// trial-and-error. SHA-256 of the root key, truncated to 8 bytes,
    /// hex-encoded. NOT an authenticator — just a stable identifier.
    pub fn fingerprint(&self) -> String {
        use sha2::Digest;
        let digest = Sha256::digest(self.0);
        hex::encode(&digest[..8])
    }
}

/// Per-device pairing key. Held on the desktop (in
/// `paired-devices.json`) and on the phone (in the iOS Keychain).
#[derive(Clone)]
pub struct DeviceKey(pub [u8; DEVICE_KEY_BYTES]);

impl DeviceKey {
    /// Derive the per-meeting capability key.
    pub fn derive_meeting_key(&self, meeting_id: &str) -> MeetingToken {
        let hk = Hkdf::<Sha256>::new(None, &self.0);
        let mut out = [0u8; MEETING_KEY_BYTES];
        let mut info = Vec::with_capacity(MEETING_KEY_INFO.len() + 1 + meeting_id.len());
        info.extend_from_slice(MEETING_KEY_INFO);
        info.push(b':');
        info.extend_from_slice(meeting_id.as_bytes());
        hk.expand(&info, &mut out)
            .expect("HKDF expand fits in one block");
        MeetingToken(out)
    }

    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }

    pub fn from_hex(s: &str) -> Result<Self, String> {
        let bytes = hex::decode(s).map_err(|e| format!("device key hex: {e}"))?;
        if bytes.len() != DEVICE_KEY_BYTES {
            return Err(format!(
                "device key wrong length: expected {DEVICE_KEY_BYTES}, got {}",
                bytes.len()
            ));
        }
        let mut k = [0u8; DEVICE_KEY_BYTES];
        k.copy_from_slice(&bytes);
        Ok(DeviceKey(k))
    }
}

/// Per-meeting capability key. The phone sends this as the bearer
/// token on the WebSocket connection; the desktop re-derives it from
/// the paired device's key + the meeting id and compares.
#[derive(Clone)]
pub struct MeetingToken(pub [u8; MEETING_KEY_BYTES]);

impl MeetingToken {
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }
}

fn root_key_path(base: &Path) -> PathBuf {
    base.join(ROOT_KEY_FILENAME)
}

fn write_atomic_0600(path: &Path, data: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data).map_err(|e| format!("write tmp root key: {e}"))?;
    #[cfg(unix)]
    {
        let mut perms = fs::metadata(&tmp)
            .map_err(|e| format!("stat tmp root key: {e}"))?
            .permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&tmp, perms)
            .map_err(|e| format!("chmod tmp root key: {e}"))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("rename tmp root key: {e}"))?;
    Ok(())
}

#[cfg(unix)]
fn ensure_mode_0600(path: &Path) {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return,
    };
    let mode = meta.permissions().mode() & 0o777;
    if mode == 0o600 {
        return;
    }
    let mut perms = meta.permissions();
    perms.set_mode(0o600);
    let _ = fs::set_permissions(path, perms);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn fresh_base(name: &str) -> PathBuf {
        let mut base = env::temp_dir();
        base.push(format!(
            "aizuchi-companion-keys-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn root_key_persists_across_loads() {
        let base = fresh_base("persist");
        let a = RootKey::load_or_generate(&base).unwrap();
        let b = RootKey::load_or_generate(&base).unwrap();
        assert_eq!(a.0, b.0);
    }

    #[test]
    fn device_key_is_deterministic() {
        let base = fresh_base("derive-dev");
        let root = RootKey::load_or_generate(&base).unwrap();
        let k1 = root.derive_device_key("device-abc");
        let k2 = root.derive_device_key("device-abc");
        assert_eq!(k1.0, k2.0);
    }

    #[test]
    fn device_key_differs_by_id() {
        let base = fresh_base("derive-diff");
        let root = RootKey::load_or_generate(&base).unwrap();
        let k1 = root.derive_device_key("device-a");
        let k2 = root.derive_device_key("device-b");
        assert_ne!(k1.0, k2.0);
    }

    #[test]
    fn meeting_token_is_deterministic() {
        let base = fresh_base("meeting-det");
        let root = RootKey::load_or_generate(&base).unwrap();
        let dev = root.derive_device_key("device-a");
        let t1 = dev.derive_meeting_key("m-123");
        let t2 = dev.derive_meeting_key("m-123");
        assert_eq!(t1.0, t2.0);
    }

    #[test]
    fn meeting_token_differs_by_meeting() {
        let base = fresh_base("meeting-diff");
        let root = RootKey::load_or_generate(&base).unwrap();
        let dev = root.derive_device_key("device-a");
        let t1 = dev.derive_meeting_key("m-1");
        let t2 = dev.derive_meeting_key("m-2");
        assert_ne!(t1.0, t2.0);
    }

    #[test]
    fn fingerprint_is_stable_and_short() {
        let base = fresh_base("fpr");
        let root = RootKey::load_or_generate(&base).unwrap();
        let fpr = root.fingerprint();
        assert_eq!(fpr.len(), 16); // 8 bytes hex
        assert_eq!(fpr, RootKey::load_or_generate(&base).unwrap().fingerprint());
    }

    #[test]
    fn device_key_hex_round_trip() {
        let base = fresh_base("hex");
        let root = RootKey::load_or_generate(&base).unwrap();
        let dev = root.derive_device_key("device-a");
        let hex = dev.to_hex();
        let back = DeviceKey::from_hex(&hex).unwrap();
        assert_eq!(dev.0, back.0);
    }

    #[cfg(unix)]
    #[test]
    fn root_key_file_is_0600() {
        let base = fresh_base("perms");
        RootKey::load_or_generate(&base).unwrap();
        let mode =
            fs::metadata(root_key_path(&base)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
