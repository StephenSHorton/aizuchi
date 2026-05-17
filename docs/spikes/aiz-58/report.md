# Spike AIZ-58 — Companion mode: QR pairing + Opus audio streaming over LAN

**Status:** Spike complete. Prototype code feature-flagged behind `companion-pairing`. Default builds untouched.
**Linear:** [AIZ-58](https://linear.app/aizuchi/issue/AIZ-58)
**Worktree:** `~/projects/aizuchi-aiz-58` on `spike/aiz-58-companion-pairing`

---

## 1. Existing-transport audit (file:line)

What this spike layers on top of:

| Capability | Location | Notes |
| --- | --- | --- |
| IPC HTTP server (hyper, http1, 127.0.0.1:0) | `src-tauri/src/cli_server/mod.rs:61-120` | Routes mounted under `/v1/`. |
| Bearer-token auth + constant-time compare | `src-tauri/src/cli_server/auth.rs:62-76` + `cli_server/routes.rs:68-85` | 32-random-byte hex token at `~/.aizuchi/cli-token` mode 0600. |
| Route dispatcher (no router framework) | `src-tauri/src/cli_server/routes.rs:98-175` | Hand-rolled `(method, &[segments])` match. Companion adds new arms here. |
| Error envelope + status mapping | `src-tauri/src/cli_server/error.rs:13-90` | `IpcError` enum, `auth_invalid` etc. We add `pairing_burned`, `pairing_expired`. |
| Discovery files (port + cli.json) | `src-tauri/src/cli_server/discovery.rs:28-48` | `~/.aizuchi/cli.port`, `~/.aizuchi/cli.json`. Atomic + 0600. |
| P2P protocol (Hello/Note/Retract/Heartbeat/Sync) | `src-tauri/src/network/protocol.rs:36-54` | Length-prefixed JSON over TCP. Companion does NOT extend this — it uses its own WebSocket path. |
| `scope: Local \| Team \| Group(String)` + `intent` | `src-tauri/src/network/protocol.rs:18-34` | Unmodified by this spike. |
| Room-code encoding (IPv4+port -> `XXXX-XXXX-XX` base36) | `src-tauri/src/network/room.rs:16-58` | 10-char code, round-trip tested. Companion reuses the IP-resolve helper but ships its own QR payload. |
| mDNS browse/register `_aizuchi._tcp.local.` | `src-tauri/src/network/discovery.rs:42-156` | Service registered, browse channel **dropped** (`std::mem::forget(_daemon)`) in `network/mod.rs:118-136` — no auto-connect. Companion re-enables a *different* service type (`_aizuchi-companion._tcp.local.`) gated to paired-device fingerprints. |

The existing system is the right substrate: bearer-auth on hyper, an `IpcCtx` we can extend, a P2P transport with mDNS already wired (just intentionally muted for note-sharing). We do not redesign it.

---

## 2. Pairing flow

### 2.1 QR payload format

**Recommendation: compact JSON wrapped in base64url, no padding.** ~210 bytes encoded for a 256-bit one-shot token. Fits comfortably in a QR v6 / EC level M code (272-byte byte-mode budget).

```jsonc
// Decoded payload (the QR holds the base64url of this):
{
  "v":   1,                          // schema version
  "ip":  "192.168.1.42",             // desktop's LAN IPv4
  "port": 50321,                     // IPC HTTP server port (cli.port)
  "token": "<64-hex>",               // one-shot pairing token, 256 bits
  "fpr": "<16-hex>",                 // root-key fingerprint (sha256 trunc)
  "exp": 1716000000                  // unix seconds — same TTL the desktop holds
}
```

Why not CBOR: ~15-25% smaller, costs an extra dep (`ciborium`), breaks `pbpaste | jq`. The size budget isn't tight, so JSON wins on debuggability. Why base64url over raw JSON in the QR: JSON forces QR byte mode anyway; base64url avoids the QR-scanner edge case where dumb scanners refuse JSON-looking strings — we always get an opaque blob to decode.

Wire types live in `src-tauri/src/companion/wire.rs:7-23`. Encode/decode + size assertion in tests.

### 2.2 One-shot pairing token

- **Length:** 32 bytes, hex-encoded (64 chars on the wire). Same budget as the existing `cli-token`.
- **Entropy:** `getrandom::getrandom()` — already in tree for `cli-token` generation (`cli_server/auth.rs:54-58`).
- **TTL:** 5 minutes (`DEFAULT_ONESHOT_TTL_SECS = 300`). Embedded as `exp` in the QR; enforced server-side too.
- **Storage:** in-memory only (`pairing::PendingStore`). `Mutex<HashMap<String, OneShotToken>>` keyed by the token.
- **Burn semantics:** constant-time compare across the (small) map of pending tokens, then `HashMap::remove` under the same lock. Second burn returns `NotFound`.

Tests (`companion/pairing.rs:131-178`): happy path, single-use, unknown, expired, distinctness.

### 2.3 Per-device pairing key

- **Derivation:** HKDF-SHA256 over a desktop-local root key (`~/.aizuchi/companion-root.key`, 32 bytes, mode 0600, lazily generated).
  `device_key = HKDF(root, salt="aizuchi-companion-v1", info="aizuchi-companion-v1/device-key:<device_id>", L=32)`
  `device_id` is a server-minted UUID v4 returned in the pair response.
- **Storage on desktop:** **the key itself is not stored.** Only the device row is persisted (`paired-devices.json`). Validation re-derives the key from root + device_id every time. One less secret to spill if the file leaks.
- **Storage on phone:** iOS Keychain item, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, service tag `tools.aizuchi.companion.devicekey`, account = `<server_fingerprint>:<device_id>`. Not backed up to iCloud (sync would require physical re-pair after restore — better than silent credential migration).

`paired-devices.json` schema (`companion/store.rs:18-45`):

```json
{
  "version": 1,
  "devices": [{
    "deviceId":          "550e8400-e29b-41d4-a716-446655440000",
    "label":             "Stephen's iPhone",
    "pubkeyFingerprint": "ab12cd34ef567890",
    "pairedAt":          "2026-05-16T18:42:00Z",
    "lastSeenAt":        "2026-05-16T18:42:00Z",
    "revoked":           false
  }]
}
```

`devicePubkey` is captured at pairing time (X25519/Ed25519, 32 bytes hex) and reduced to the fingerprint for the UX. We don't run an asymmetric handshake yet — see "Risks" § 7.2. The fingerprint is shown in the "Paired devices" list so the user can spot a swap.

### 2.4 Per-meeting capability token

- **Derivation:** `meeting_token = HKDF(device_key, "aizuchi-companion-v1/meeting-key:<meeting_id>", L=32)`.
- **Where:** both sides derive it locally — no "issue token" round-trip. Phone sends `Authorization: Bearer <hex>` on the WebSocket upgrade.
- **Validation (desktop):** `companion::tokens::verify_meeting_token` -> lookup device row (rejects if revoked or unknown), re-derive expected token, constant-time compare.
- **Revocation:** flip `revoked=true` in `paired-devices.json`. Subsequent requests fail device-active check within 5s (the WebSocket layer should sample the store on each ASR frame batch, not just at connect-time).

Coverage: `companion/tokens.rs:81-160` — happy path, wrong meeting id, wrong device, revoked device, wrong-length token. All pass.

### 2.5 Threat model — "user posts QR to Slack at 4-min mark"

Scenario: user clicks "Pair phone" at T=0. QR shows. User accidentally screenshots and pastes into a public Slack channel at T+4 min.

| Adversary action | Outcome |
| --- | --- |
| Decode QR -> `{ip: 192.168.1.42, port: 50321, token: ..., exp: T+5min}` | Reveals: a) we're on this LAN, b) the IPC port. Both already discoverable by any nmap scan; no new info. |
| Hit `/v1/pair` from outside the LAN | `ip` is RFC-1918; not routable. Slack viewer at home can't reach it. |
| Hit `/v1/pair` from inside the LAN (coworker on the same Wi-Fi within the 1-minute window) | **Succeeds.** They get a real device key. This is the real attack surface. |
| Hit `/v1/pair` after T+5min | `burn_one_shot` returns `Expired` -> 403 `pairing_expired`. |
| Hit `/v1/pair` after the legitimate phone has already paired | `burn_one_shot` returns `NotFound` -> 403 `pairing_burned`. Legitimate phone wins the race; attacker has no other path. |

**Mitigations applied:**
1. The IPC HTTP server already binds `127.0.0.1:0` (`cli_server/mod.rs:67`). For companion we **must** rebind to `0.0.0.0` or the LAN interface — and that's the moment the threat model widens. Explicit and intentional; called out in open questions.
2. 5-minute TTL is a soft limit. The "Pair phone" UI should countdown visibly and offer "Cancel pairing" that calls `burn_one_shot` itself.
3. **Recommended hardening for v1:** the QR-displaying window also requires a 4-digit code typed on the desktop AFTER the phone scans. Puts the attack window into "attacker is in the room, watching the screen." Out-of-scope for this spike — called out in § 7.

**Threat-model verdict:** acceptable for v0 on a trusted home/office LAN. Not acceptable on coffee-shop Wi-Fi without the extra 4-digit-confirm step. UI must label this: "Companion mode works on your home or office Wi-Fi. Don't pair on public networks." Default-off the 0.0.0.0 bind; users opt in.

---

## 3. Desktop prototype (Rust)

Code committed under `#[cfg(feature = "companion-pairing")]` so the default build (and the release pipeline) is unchanged.

| File | What it does |
| --- | --- |
| `src-tauri/src/companion/keys.rs` | `RootKey` (load-or-generate, fingerprint), `DeviceKey`, `MeetingToken`, HKDF derivations. 7 tests. |
| `src-tauri/src/companion/pairing.rs` | One-shot tokens + `PendingStore` (mint/burn, TTL, single-use). 5 tests. |
| `src-tauri/src/companion/store.rs` | `paired-devices.json` schema, atomic 0600 writes, revoke. 5 tests. |
| `src-tauri/src/companion/tokens.rs` | Per-meeting token verification against the store. 5 tests. |
| `src-tauri/src/companion/wire.rs` | `QrPayload` (base64url JSON), `PairRequest`, `PairResponse`. 4 tests. |
| `src-tauri/Cargo.toml` | Optional deps: `hmac`, `sha2`, `hkdf`, `base64`. Feature: `companion-pairing`. |

**Test results:** `cargo test --no-default-features --features companion-pairing --lib companion::` -> **27 passed, 0 failed.** Default build (no feature) -> **74 passed** unchanged.

What is *not* yet in committed code: the actual `/v1/pair`, `/v1/devices`, and `/v1/meeting/{id}/stream` routes. The dispatcher edits and WebSocket upgrade live as a patch in `docs/spikes/aiz-58/desktop-prototype.patch`. Reason: applying them couples the spike to choices the rest of the team should sign off on first (e.g., binding to 0.0.0.0, which crate to use for tungstenite, where to thread `RootKey + PairedDeviceStore + PendingStore` into `IpcCtx`).

### 3.1 Sketched routes

```
POST   /v1/pair                       — { oneShotToken, deviceLabel, devicePubkey }
                                       -> { deviceId, devicePairingKey, serverPubkeyFingerprint }
GET    /v1/devices                    — [ PairedDevice, ... ]
DELETE /v1/devices/{deviceId}         — { revoked: true }
GET    /v1/meeting/{id}/stream        — WebSocket upgrade, Authorization: Bearer <meeting-token>
```

`/v1/pair` is the only **unauth** new endpoint (gated by the one-shot token). Others ride the existing bearer-token check.

### 3.2 Auth flow inside `/v1/meeting/{id}/stream`

1. Parse `Authorization: Bearer <hex>` from the upgrade request.
2. Read `device_id` from a custom `X-Aizuchi-Device-Id: <uuid>` header (phone keeps the bearer hex and the device-id together in Keychain).
3. `verify_meeting_token(store, root, device_id, meeting_id_from_path, supplied_hex)` -> 401 on `DeviceUnknown` or `TokenMismatch`.
4. On success: upgrade to WebSocket, push connection into the per-meeting fan-out.

The validation function is in committed code (`tokens.rs:30-58`); the upgrade glue is in the patch.

---

## 4. mDNS scoped to paired devices

### 4.1 Service name

`_aizuchi-companion._tcp.local.` — separate service type from `_aizuchi._tcp.local.` (existing peer-share service). Different consumer profile.

**Instance name** is the SHA-256-truncated fingerprint of the device-specific advertisement key:

```
adv_key       = HKDF(root_key, info="aizuchi-companion-v1/mdns-adv", L=32)
instance_name = "aizuchi-" + hex(SHA-256(adv_key)[..8])      // e.g. "aizuchi-c7f0a2..."
```

The instance name is opaque — a passive observer learns "some aizuchi app is here" (same info `_aizuchi._tcp.local.` already leaks today; not new) but can't tell which user/device. Only paired phones know the desktop's `adv_key` and can predict the instance name.

### 4.2 Phone-side discovery

The phone stores `serverPubkeyFingerprint` from the pair response. To predict the instance name it also needs `adv_key`. Solution: ship `mdnsAdvertisementKey` in `PairResponse`:

```json
"mdnsAdvertisementKey": "<32-byte-hex>"
```

This key is the same for every paired device (it identifies the *desktop*, not the device). Revoking a device doesn't rotate it — revoked devices keep knowing the mDNS name but can't establish a session because the per-meeting token check fails server-side.

Flow:
1. Compute expected `instance_name` locally from the stored `adv_key`.
2. Browse `_aizuchi-companion._tcp.local.` and filter to the matching instance name.
3. Resolve SRV record -> IP + port -> open a WebSocket -> present a per-meeting token.

### 4.3 Why this doesn't leak presence

| Observer | Sees | Doesn't see |
| --- | --- | --- |
| Random LAN scanner | `_aizuchi-companion._tcp.local.` exists; one instance with opaque name `aizuchi-c7f0a2...` | Whose laptop. Whether anyone is paired. Whether anyone is connected. |
| Already-paired phone | The expected instance name -> can resolve and connect. | Other paired devices (different mDNS service per desktop). |

TXT record carries only the IPC port and protocol version. No user-identifying fields. The existing `_aizuchi._tcp.local.` browse already leaks `name` and `node_id` (`network/discovery.rs:60-65`); we intentionally do *not* mirror that for companion mode.

### 4.4 iOS multicast entitlement

mDNS on iOS 14+ requires `com.apple.developer.networking.multicast`. Apple grants it case-by-case via the dev portal — **not automatic.** The application must explain why ("discover the user's own paired desktop on their LAN"). Without it, `Network.framework`'s `NWBrowser` returns no results.

Workaround for v0 / before-entitlement:
- After pairing, persist desktop IP from the QR payload in the phone's Keychain.
- On launch, try connecting to that IP first; fall back to mDNS only if it fails.
- DHCP-rotation will sometimes break this — known limitation for v0.

---

## 5. Audio streaming protocol

### 5.1 Opus encoding parameters

| Knob | Recommendation | Why |
| --- | --- | --- |
| Bitrate | **24 kbps** | Sweet spot for speech. Whisper transcribes 24 kbps Opus at parity with PCM. |
| Frame size | **20 ms** | Lowest jitter without runaway packet rate. 50 packets/sec at 24 kbps ~ 60 bytes/packet. |
| Channels | **Mono** | Single mic capture. Stereo doubles bandwidth for nothing. |
| Application | **VOIP** | `OPUS_APPLICATION_VOIP` enables speech-tuned codec path. |
| Sample rate | **16 kHz** | Whisper native. Avoids a resample on desktop. |
| FEC | **Off** | LAN WebSocket on TCP; in-order delivery guaranteed. FEC only useful on lossy UDP. |
| DTX | **On** | Silence frames compress to ~2 bytes. |

Total LAN bandwidth: ~24 kbps + WebSocket framing ≈ **3-4 KB/s**.

### 5.2 WebSocket framing

Binary frames only:

```
| 1 byte  | type tag        — 0x01 Audio, 0x02 Heartbeat, 0x03 Control
| 8 bytes | sequence number — u64 LE, monotonic per-connection
| 8 bytes | capture time    — u64 LE, milliseconds since stream start
| N bytes | Opus packet     — raw, no container
```

ASR pipeline tolerates frame drops, so we don't ACK individual audio frames. Sequence number lets us detect skips for debug logs only.

### 5.3 Return-channel design (GraphDiff to the phone)

**Pick: same WebSocket, text frames for JSON.** Splitting onto a second connection costs another auth round-trip + complicates iOS lifecycle (background WebSocket handling on iOS is already painful with one).

```
| TEXT  | { "type": "GraphDiff", "v": 1, "added": [...], "removed": [...], "ts": 1716000000123 }
| TEXT  | { "type": "Cursor",    "user": "stephen", "nodeId": "n-42" }
| TEXT  | { "type": "MeetingEnded", "reason": "stopped" }
```

WebSocket's binary/text discriminator gives us a clean split without inventing a tagged-union framing for the return direction.

### 5.4 Latency budget (LAN, mic -> phone shows diff)

| Stage | Budget |
| --- | --- |
| Mic capture (iOS, 20ms frame fill) | 20 ms |
| Opus encode (phone) | 5 ms |
| WebSocket send + LAN traversal | 5-20 ms |
| ASR partial emit (existing Whisper streaming) | 300-600 ms (dominant; bounded by Whisper) |
| Graph synthesis on desktop | 100-400 ms |
| GraphDiff WebSocket back to phone | 5-20 ms |
| Phone render | 16 ms (1 frame at 60 fps) |
| **Total** | **~0.5-1.1 s** |

Acceptance bar is <1.5 s on LAN. We have ~400 ms of slack.

---

## 6. Mobile-side sketch

Lives in `docs/spikes/aiz-58/mobile-sketch.md`. Brief outline:

1. **Capture (cross-references AIZ-57's audio path):** `AVAudioEngine` tap on the input node -> 16 kHz Float32 PCM -> ring buffer.
2. **Encode:** `libopus` via `Opus.framework` -> 20-ms frames -> 60-byte Opus packets.
3. **Send:** `URLSessionWebSocketTask` to `wss://<desktop-ip>:<port>/v1/meeting/<id>/stream`, headers `Authorization: Bearer <meeting-token>`, `X-Aizuchi-Device-Id: <uuid>`.
4. **Receive:** same task, alternating `.string` (GraphDiff JSON) and `.data` (currently unused — reserved for future server-pushed audio cues).
5. **Keychain:** `kSecClassGenericPassword`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, stores `(device_id, device_key)`.

---

## 7. Risks + open questions

### 7.1 Binding to 0.0.0.0
The IPC HTTP server currently binds `127.0.0.1`. Companion mode needs a LAN-reachable interface. This widens the surface from "anything on this machine" to "anything on this LAN." Protocol-level mitigations (per-meeting tokens, paired-device gating) are sound, but the *one-shot pairing endpoint* is unauthenticated by design.
**Open question:** should companion run on a **second** hyper server bound to LAN, while the existing CLI server stays on loopback? Probably yes — keeps the CLI threat model unchanged. Filed as follow-up.

### 7.2 Asymmetric handshake punted
Current flow is symmetric-key once paired. `devicePubkey` is captured but only used for its UX fingerprint. Upgrading to a Noise IK / X25519 handshake at session-establish time would harden against device-key-leaks. Out of scope for v0; the spike's HKDF derivation is compatible with a Noise upgrade (device key becomes Noise's pre-shared key).

### 7.3 mDNS entitlement gate
`com.apple.developer.networking.multicast` is Apple-granted. Until granted, phone falls back to "remember last IP" — fragile across DHCP rotation. Apply for the entitlement now; ship v0 demo with the fallback.

### 7.4 Revocation latency
Re-check `is_active(device_id)` on every audio batch (cheap, ~1µs per check). Meets the AIZ-58 acceptance criterion (<=5s).

### 7.5 Multi-desktop / "wrong desktop" UX
If the user has two installs (personal + work), the `serverPubkeyFingerprint` lets us name them on the phone — make the device list UI deliberate.

### 7.6 Battery cost of always-on Opus encode
Not measured. The acceptance criterion of "≥30 min without gaps" is the real-world test. Expected <5%/hour on modern iPhones.

### 7.7 Bonjour service-name collisions
SHA-256 truncated to 8 bytes -> 1 in 2^64 collision. Not worth engineering around.

### 7.8 Biggest unknown
**The 0.0.0.0 bind decision** is load-bearing. Everything else is incremental. Once we commit to LAN-reachable, the threat-model conversation must happen with the whole team, and we should add the "4-digit code on desktop after phone scans" hardening before we ship.

---

## 8. Pointers

- Prototype Rust code: `src-tauri/src/companion/` (compile with `cargo check --features companion-pairing`).
- Integration patch (route table + WebSocket upgrade): `docs/spikes/aiz-58/desktop-prototype.patch`.
- Mobile-side sketch: `docs/spikes/aiz-58/mobile-sketch.md`.
- Tests: `cargo test --no-default-features --features companion-pairing --lib companion::` -> 27 pass.
- Default-build sanity: `cargo test --no-default-features --lib` -> 74 pass, no change.
