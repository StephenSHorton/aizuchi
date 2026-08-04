// swift-tools-version:5.3
// SPDX-License-Identifier: AGPL-3.0-or-later

import PackageDescription

let package = Package(
    name: "tauri-plugin-aizuchi-audio",
    platforms: [
        // iOS 15 is the floor: `AVAudioApplication` (the modern record-
        // permission API) only exists from iOS 17; we keep the floor at
        // 15 and #available-gate that one call site. macOS is listed so
        // the `desktop` cfg target still parses, even though the Swift
        // module isn't actually compiled on macOS.
        .iOS(.v15),
        .macOS(.v11),
    ],
    products: [
        .library(
            name: "tauri-plugin-aizuchi-audio",
            type: .static,
            targets: ["tauri-plugin-aizuchi-audio"])
    ],
    dependencies: [
        // Same path the official Tauri plugins use — `tauri build ios`
        // populates `../.tauri/tauri-api/` with the Swift API bindings.
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-aizuchi-audio",
            dependencies: [
                .byName(name: "Tauri")
            ],
            path: "Sources")
    ]
)
