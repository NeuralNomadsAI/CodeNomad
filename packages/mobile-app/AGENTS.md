# Mobile native dependency corrections

- This package has a separate Cargo workspace. Its Tauri 2.12.1 path patch belongs only here; do not add it to desktop/root Cargo configuration or mutate shared Cargo/Swift caches.
- Preserve `src-tauri/vendor/tauri-2.12.1` upstream licenses, `Cargo.toml.orig`, archive/file receipts and exact local diff. See `IOS_ABI.md` before changing this override.
- Native iOS compilation must run the vendored pre-link ABI hash/version guard, and the app must validate `DEP_TAURI_IOS_LIBRARY_PATH` against the owned vendor path. Do not bypass these checks or silently regenerate receipts on dependency drift.
- `ios:init`/`ios:build` preflight uses `scripts/verify-ios-abi.mjs`. Preserve SwiftRs's exact reviewed Swift commit and Rust lock/checksum; a Cargo version is not a SwiftPM tag.
- SwiftRs buffer lifetime warnings are not fixed by this command ABI correction. Never silence them or claim full Rust/Swift runtime qualification from Swift component/LLVM IR compilation alone.
