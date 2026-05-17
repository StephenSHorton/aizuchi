// swift-tools-version: 6.0
// AIZ-55 — Foundation Models GraphDiff fit-check harness.
//
// This package targets iOS 26 / macOS 26 because that's where the
// FoundationModels framework ships. The harness is structured as a
// library + a small executable so the user can either drop it into an
// Xcode iOS app target or run it on a Mac (M-series) for quick local
// iteration. It will not build outside the iOS-26-era Xcode toolchain.

import PackageDescription

let package = Package(
    name: "AIZ55Harness",
    platforms: [
        .iOS(.v26),
        .macOS(.v26),
    ],
    products: [
        .library(name: "Harness", targets: ["Harness"]),
        .executable(name: "harness-cli", targets: ["HarnessCLI"]),
    ],
    targets: [
        .target(name: "Harness"),
        .executableTarget(
            name: "HarnessCLI",
            dependencies: ["Harness"]
        ),
    ]
)
