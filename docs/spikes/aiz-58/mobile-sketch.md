# Mobile-side sketch — AIZ-58 Companion mode (iOS, Swift)

Conceptual outline. This is enough to prove the protocol is implementable;
the full client is a separate ticket. Cross-references AIZ-57 for the
audio capture path.

## State (Keychain)

```swift
struct PairedDesktop: Codable {
    let serverFingerprint: String   // 16-hex from PairResponse
    let deviceId: String            // UUID v4 from PairResponse
    let deviceKey: Data             // 32 bytes; never leaves Keychain
    let advertisementKey: Data      // 32 bytes; predicts mDNS instance name
    let lastKnownIp: String         // fallback if mDNS is muted
    let lastKnownPort: UInt16
}

// Stored as kSecClassGenericPassword:
//   service:  "tools.aizuchi.companion"
//   account:  "\(serverFingerprint):\(deviceId)"
//   value:    JSON-encoded PairedDesktop above
//   access:   kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
//   sync:     none — explicitly NOT iCloud-synced (security)
```

## Pairing — happens once per (phone, desktop) pair

```swift
// 1) User scans the QR code with AVCaptureSession + Vision (VNDetectBarcodesRequest).
let qrString: String = ...                                           // base64url-of-JSON
let payload = try QrPayload.decode(qrString)                         // mirror of wire.rs

// 2) Mint a fresh X25519 keypair for the fingerprint slot.
let pubkey = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation
let pubkeyHex = pubkey.map { String(format: "%02hhx", $0) }.joined()

// 3) POST to the desktop. NB: in v0 we use http:// (LAN, self-signed TLS is worse UX).
//    Once we ship a per-install self-signed cert with a stable fingerprint
//    we switch to wss://; the device key becomes its TOFU anchor.
let req = PairRequest(
    oneShotToken: payload.token,
    deviceLabel: UIDevice.current.name,                              // "Stephen's iPhone"
    devicePubkey: pubkeyHex
)
var urlReq = URLRequest(url: URL(string: "http://\(payload.ip):\(payload.port)/v1/pair")!)
urlReq.httpMethod = "POST"
urlReq.httpBody = try JSONEncoder().encode(req)
urlReq.setValue("application/json", forHTTPHeaderField: "Content-Type")
let (data, resp) = try await URLSession.shared.data(for: urlReq)
guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
    throw PairingError.serverRejected
}
let pairResp = try JSONDecoder().decode(PairResponse.self, from: data)

// 4) Persist to Keychain.
try Keychain.save(PairedDesktop(
    serverFingerprint: pairResp.serverPubkeyFingerprint,
    deviceId: pairResp.deviceId,
    deviceKey: Data(hex: pairResp.devicePairingKey)!,
    advertisementKey: Data(hex: pairResp.mdnsAdvertisementKey)!,
    lastKnownIp: payload.ip,
    lastKnownPort: payload.port
))
```

## Discovery — every launch

```swift
// Try mDNS first (requires com.apple.developer.networking.multicast).
let expectedInstance = "aizuchi-" + sha256(adv).prefix(8).hex            // matches desktop derivation
let browser = NWBrowser(for: .bonjour(type: "_aizuchi-companion._tcp", domain: nil), using: .tcp)
browser.browseResultsChangedHandler = { results, _ in
    for r in results where r.endpoint.debugDescription.contains(expectedInstance) {
        connect(to: r.endpoint, paired: paired); return
    }
}
browser.start(queue: .main)

// Fallback after 2s — connect to lastKnownIp:lastKnownPort directly.
DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
    if !connected { connect(to: NWEndpoint.hostPort(host: paired.lastKnownIp,
                                                   port: paired.lastKnownPort)) }
}
```

## Per-meeting WebSocket

```swift
// Phone derives the meeting token locally — no round-trip.
let meetingToken = hkdfSha256(
    key: paired.deviceKey,
    info: "aizuchi-companion-v1/meeting-key:\(meetingId)".data(using: .utf8)!,
    length: 32
)
let meetingTokenHex = meetingToken.map { String(format: "%02hhx", $0) }.joined()

let url = URL(string: "ws://\(paired.lastKnownIp):\(paired.lastKnownPort)/v1/meeting/\(meetingId)/stream")!
var req = URLRequest(url: url)
req.setValue("Bearer \(meetingTokenHex)", forHTTPHeaderField: "Authorization")
req.setValue(paired.deviceId, forHTTPHeaderField: "X-Aizuchi-Device-Id")

let ws = URLSession.shared.webSocketTask(with: req)
ws.resume()
```

## Audio capture + encode + send (cross-ref AIZ-57)

```swift
// AVAudioEngine tap from AIZ-57 — already produces 16 kHz mono Float32 PCM.
audioEngine.inputNode.installTap(onBus: 0, bufferSize: 320, format: format16k) { buffer, _ in
    // 320 frames at 16 kHz = 20 ms.
    let pcm = pcmFloat32(from: buffer)                              // [Float]
    let pcm16: [Int16] = pcm.map { Int16(max(-1, min(1, $0)) * 32767) }
    let opusPacket = try opusEncoder.encode(pcm16)                  // Opus.framework, libopus
    var frame = Data()
    frame.append(0x01)                                              // type: Audio
    frame.append(UInt64(sequenceNumber).leData)
    frame.append(UInt64(captureTimeMs).leData)
    frame.append(opusPacket)
    sequenceNumber += 1
    Task { try await ws.send(.data(frame)) }
}
audioEngine.start()
```

## Return channel — GraphDiff

```swift
Task {
    while ws.state == .running {
        let message = try await ws.receive()
        switch message {
        case .string(let json):
            // Text frame -> JSON tagged union. Dispatch on "type".
            let env = try JSONDecoder().decode(ServerEnvelope.self, from: Data(json.utf8))
            switch env.type {
            case "GraphDiff":    graphState.apply(env.graphDiff!)
            case "Cursor":       cursors.show(env.cursor!)
            case "MeetingEnded": ws.cancel(with: .normalClosure, reason: nil); return
            default: break
            }
        case .data:
            // Reserved for future server-pushed audio cues. Ignore for now.
            break
        @unknown default: break
        }
    }
}
```

## Lifecycle / background

- `URLSessionWebSocketTask` does NOT keep running when the app suspends. v0 assumes the phone is foreground (it's literally being used as a mic on the table).
- For "phone in pocket" mode, switch the connection to `NWConnection` over `BGProcessingTaskRequest` and accept the latency hit. Out of scope.

## Errors the user sees

| Server response | UI |
| --- | --- |
| 401 `pairing_expired` | "This pairing code has expired. On your Mac, click 'Pair phone' again." |
| 401 `pairing_burned` | "Already paired. If this is a new phone, ask your Mac to revoke the old one." |
| 401 `auth_invalid` on WebSocket | "This phone is no longer paired with this Mac." -> wipe Keychain entry. |
| Connection refused | "Can't find your Mac on this Wi-Fi. Make sure both devices are on the same network." |
