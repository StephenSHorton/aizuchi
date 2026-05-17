//! Wire types: the QR payload, the `/v1/pair` request/response.
//!
//! The QR is compact JSON encoded via base64url (no padding). We
//! considered CBOR; the byte-savings (~15-25%) didn't justify the
//! extra dep and the loss of "paste-this-into-jq" debuggability.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct QrPayload {
    /// Schema version. Bump if the field set changes.
    pub v: u8,
    /// IPv4 of the desktop's LAN interface, e.g. "192.168.1.42".
    pub ip: String,
    /// IPC HTTP server port.
    pub port: u16,
    /// One-shot pairing token (hex, 64 chars).
    pub token: String,
    /// Root-key fingerprint (hex, 16 chars). Lets the phone notice if
    /// the desktop was reinstalled / rotated.
    pub fpr: String,
    /// Token expiry, unix seconds. Same value the desktop holds.
    pub exp: u64,
}

impl QrPayload {
    /// Encode the QR payload as compact JSON wrapped in base64url
    /// without padding. Typical size ~140-160 bytes — well within
    /// QR v5 capacity at error-correction level M.
    pub fn encode(&self) -> Result<String, String> {
        let bytes = serde_json::to_vec(self).map_err(|e| format!("serialise QR: {e}"))?;
        Ok(URL_SAFE_NO_PAD.encode(&bytes))
    }

    /// Inverse of [`encode`].
    pub fn decode(s: &str) -> Result<Self, String> {
        let bytes = URL_SAFE_NO_PAD
            .decode(s.as_bytes())
            .map_err(|e| format!("decode QR base64: {e}"))?;
        serde_json::from_slice(&bytes).map_err(|e| format!("parse QR JSON: {e}"))
    }
}

/// POST `/v1/pair` request body.
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    /// The one-shot token taken from the QR.
    pub one_shot_token: String,
    /// Human label for the device, e.g. "Stephen's iPhone".
    pub device_label: String,
    /// X25519 or Ed25519 public key (32 bytes, hex). Currently used
    /// only for its fingerprint — full asymmetric handshake is a
    /// later upgrade (see report § "Risks").
    pub device_pubkey: String,
}

/// POST `/v1/pair` response body.
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    /// Server-assigned device id. The phone stores this alongside the
    /// device key.
    pub device_id: String,
    /// Per-device pairing key, hex-encoded (64 chars).
    pub device_pairing_key: String,
    /// Server pubkey fingerprint — opaque hex, 16 chars. Used to
    /// derive the mDNS service name.
    pub server_pubkey_fingerprint: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qr_round_trip() {
        let p = QrPayload {
            v: 1,
            ip: "192.168.1.42".into(),
            port: 50321,
            token: "a".repeat(64),
            fpr: "0123456789abcdef".into(),
            exp: 1_716_000_000,
        };
        let s = p.encode().unwrap();
        // Should be URL-safe — no '+', '/', or '=' chars.
        assert!(!s.contains('+'));
        assert!(!s.contains('/'));
        assert!(!s.contains('='));
        let back = QrPayload::decode(&s).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn qr_size_within_budget() {
        let p = QrPayload {
            v: 1,
            ip: "192.168.1.42".into(),
            port: 50321,
            token: "a".repeat(64),
            fpr: "0123456789abcdef".into(),
            exp: 1_716_000_000,
        };
        let s = p.encode().unwrap();
        // Base64url-encoded JSON is treated as byte mode in QR. QR
        // v8 / EC level M holds 365 bytes, v6 holds 272. Staying
        // under 256 bytes keeps us comfortably inside v6 — small,
        // fast to scan even from a webcam.
        assert!(
            s.len() < 256,
            "QR payload {} bytes — bigger than expected",
            s.len()
        );
    }

    #[test]
    fn pair_request_parses() {
        let raw = r#"{"oneShotToken":"abcd","deviceLabel":"iPhone","devicePubkey":"00"}"#;
        let p: PairRequest = serde_json::from_str(raw).unwrap();
        assert_eq!(p.one_shot_token, "abcd");
        assert_eq!(p.device_label, "iPhone");
    }

    #[test]
    fn pair_response_serialises_camel_case() {
        let r = PairResponse {
            device_id: "dev-1".into(),
            device_pairing_key: "ff".repeat(32),
            server_pubkey_fingerprint: "00".repeat(8),
        };
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains("deviceId"));
        assert!(s.contains("devicePairingKey"));
        assert!(s.contains("serverPubkeyFingerprint"));
    }
}
