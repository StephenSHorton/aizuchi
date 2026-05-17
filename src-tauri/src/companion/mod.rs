//! AIZ-58 — Companion-mode pairing + Opus streaming (spike).
//!
//! This module is gated on the `companion-pairing` feature. Default
//! builds do not compile it, so the existing release pipeline is
//! unaffected. Production code paths (the IPC HTTP dispatcher, the
//! P2P transport) are NOT modified by this spike — the integration
//! points are documented in `docs/spikes/aiz-58/desktop-prototype.patch`.
//!
//! Goals validated here:
//!   * Token derivation (root → device → meeting) is deterministic,
//!     constant-time-comparable, and HKDF-based.
//!   * One-shot pairing tokens are 256-bit, single-use, TTL-bounded.
//!   * The paired-devices store has a sound on-disk schema.
//!   * Per-meeting tokens can be revoked by deleting the device row.
//!
//! NOT yet hooked into the running server. See AIZ-58 follow-ups —
//! the integration patch lives at
//! `docs/spikes/aiz-58/desktop-prototype.patch`.

// The spike compiles into a library without wiring into the dispatcher,
// so every item here is technically unused. Suppress dead-code for the
// whole module — these will all become live once the patch lands.
#![allow(dead_code)]

pub mod keys;
pub mod pairing;
pub mod store;
pub mod tokens;
pub mod wire;

pub use keys::{DeviceKey, MeetingToken, RootKey};
pub use pairing::{burn_one_shot, mint_one_shot, OneShotToken, PendingStore};
pub use store::{PairedDevice, PairedDeviceStore};
pub use tokens::{derive_meeting_token, verify_meeting_token, MeetingTokenError};
pub use wire::{PairRequest, PairResponse, QrPayload};
