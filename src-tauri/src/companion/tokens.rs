//! Per-meeting capability-token derivation + validation.
//!
//! The phone derives `token = HKDF(device_key, "<info>:<meeting_id>")`
//! locally and sends it as `Authorization: Bearer <hex>` when opening
//! the audio WebSocket. The desktop re-derives the expected token from
//! the stored device key and compares in constant time.
//!
//! Because the token is a pure function of `(device_key, meeting_id)`,
//! revocation works by deleting the device key — every subsequent
//! request will fail the device-lookup step.

use subtle::ConstantTimeEq;

use super::keys::{DeviceKey, MeetingToken};
use super::store::PairedDeviceStore;

#[derive(Debug, PartialEq)]
pub enum MeetingTokenError {
    /// Authorization header missing or not `Bearer <hex>`.
    Malformed,
    /// Device id unknown or revoked.
    DeviceUnknown,
    /// Token doesn't match the expected derivation.
    TokenMismatch,
}

/// Pure derivation — exposed so tests + the phone-side stub can call
/// it without touching the store.
pub fn derive_meeting_token(device_key: &DeviceKey, meeting_id: &str) -> MeetingToken {
    device_key.derive_meeting_key(meeting_id)
}

/// Validate a supplied per-meeting token against the paired-device
/// store. Caller has already extracted `(device_id, meeting_id,
/// supplied_token_hex)` from the request.
pub fn verify_meeting_token(
    store: &PairedDeviceStore,
    root: &super::keys::RootKey,
    device_id: &str,
    meeting_id: &str,
    supplied_hex: &str,
) -> Result<(), MeetingTokenError> {
    if !store.is_active(device_id) {
        return Err(MeetingTokenError::DeviceUnknown);
    }
    let dev = root.derive_device_key(device_id);
    let expected = derive_meeting_token(&dev, meeting_id);
    let expected_hex = expected.to_hex();
    if expected_hex.len() != supplied_hex.len() {
        return Err(MeetingTokenError::TokenMismatch);
    }
    let ok: bool = expected_hex
        .as_bytes()
        .ct_eq(supplied_hex.as_bytes())
        .into();
    if !ok {
        return Err(MeetingTokenError::TokenMismatch);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::keys::RootKey;
    use super::super::store::{PairedDevice, PairedDeviceStore};
    use chrono::Utc;
    use std::env;
    use std::path::PathBuf;

    fn fresh_base(name: &str) -> PathBuf {
        let mut base = env::temp_dir();
        base.push(format!(
            "aizuchi-companion-tokens-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    fn paired_device(id: &str) -> PairedDevice {
        PairedDevice {
            device_id: id.to_string(),
            label: "iPhone".into(),
            pubkey_fingerprint: "00".repeat(8),
            paired_at: Utc::now(),
            last_seen_at: Utc::now(),
            revoked: false,
        }
    }

    #[test]
    fn happy_path_validates() {
        let base = fresh_base("happy");
        let root = RootKey::load_or_generate(&base).unwrap();
        let store = PairedDeviceStore::load(&base).unwrap();
        store.insert(paired_device("dev-1")).unwrap();

        // Simulate the phone: derive device key + meeting token locally.
        let dev = root.derive_device_key("dev-1");
        let token = derive_meeting_token(&dev, "meeting-42").to_hex();

        assert_eq!(
            verify_meeting_token(&store, &root, "dev-1", "meeting-42", &token),
            Ok(())
        );
    }

    #[test]
    fn wrong_meeting_rejected() {
        let base = fresh_base("wrong-meeting");
        let root = RootKey::load_or_generate(&base).unwrap();
        let store = PairedDeviceStore::load(&base).unwrap();
        store.insert(paired_device("dev-1")).unwrap();
        let dev = root.derive_device_key("dev-1");
        let token = derive_meeting_token(&dev, "meeting-42").to_hex();
        assert_eq!(
            verify_meeting_token(&store, &root, "dev-1", "meeting-OTHER", &token),
            Err(MeetingTokenError::TokenMismatch)
        );
    }

    #[test]
    fn wrong_device_rejected() {
        let base = fresh_base("wrong-device");
        let root = RootKey::load_or_generate(&base).unwrap();
        let store = PairedDeviceStore::load(&base).unwrap();
        store.insert(paired_device("dev-1")).unwrap();
        let dev_other = root.derive_device_key("dev-2");
        let token = derive_meeting_token(&dev_other, "meeting-42").to_hex();
        // dev-2 isn't paired:
        assert_eq!(
            verify_meeting_token(&store, &root, "dev-2", "meeting-42", &token),
            Err(MeetingTokenError::DeviceUnknown)
        );
    }

    #[test]
    fn revoked_device_rejected() {
        let base = fresh_base("revoked");
        let root = RootKey::load_or_generate(&base).unwrap();
        let store = PairedDeviceStore::load(&base).unwrap();
        store.insert(paired_device("dev-1")).unwrap();
        let dev = root.derive_device_key("dev-1");
        let token = derive_meeting_token(&dev, "meeting-42").to_hex();
        // Pre-revocation: ok.
        assert_eq!(
            verify_meeting_token(&store, &root, "dev-1", "meeting-42", &token),
            Ok(())
        );
        store.revoke("dev-1").unwrap();
        // Post-revocation: same token, now rejected.
        assert_eq!(
            verify_meeting_token(&store, &root, "dev-1", "meeting-42", &token),
            Err(MeetingTokenError::DeviceUnknown)
        );
    }

    #[test]
    fn token_length_mismatch_rejected() {
        let base = fresh_base("len");
        let root = RootKey::load_or_generate(&base).unwrap();
        let store = PairedDeviceStore::load(&base).unwrap();
        store.insert(paired_device("dev-1")).unwrap();
        assert_eq!(
            verify_meeting_token(&store, &root, "dev-1", "m", "deadbeef"),
            Err(MeetingTokenError::TokenMismatch)
        );
    }
}
