// swift-tools-version:5.3
import PackageDescription

let package = Package(
    name: "tauri-plugin-mobile-recovery",
    platforms: [.iOS("15.0")],
    products: [.library(name: "tauri-plugin-mobile-recovery", type: .static,
                        targets: ["tauri-plugin-mobile-recovery"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-mobile-recovery",
                      dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
