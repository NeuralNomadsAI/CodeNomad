# iOS command C ABI correction — Tauri 2.12.1

Scope: the separate `packages/mobile-app/src-tauri` Cargo workspace in the
mission-owned Windows worktree. No desktop/root dependency override, Android
source edit, cache edit, full app build, signing, runtime/device test or publication.

## Production mismatch and fix

The actual Rust declaration in vendored `src/ios.rs` takes an `i32` request ID
and `unsafe extern "C" fn(c_int, c_int, *const c_char)` response callback.
`src/plugin/mobile.rs` allocates IDs through `AtomicI32`, removes pending calls
by that ID, and treats success as `success == 1`. Recovery's production
`run_mobile_plugin` calls reach this path.

Upstream Swift `run_plugin_command` instead used `Int` and an `(Int, Bool, …)`
callback. On both reviewed 64-bit targets this is a genuine C signature mismatch.
The local Swift export now takes `Int32`, its callback takes `(Int32, Int32, …)`,
and its response closure passes `success ? 1 : 0`. Rust's existing contract is
unchanged. `Invoke` internally already uses independent `UInt64` callback/error
IDs `0`/`1`; no request-ID conversion or change to `Invoke` is necessary.

## Owned dependency inputs and provenance

The official cached Tauri crate was SHA256-verified before safe extraction:

- Version: **2.12.1**; archive **324,974 bytes**, **142 files**, **1,472,118 bytes** unpacked.
- Official source: `https://static.crates.io/crates/tauri/tauri-2.12.1.crate`.
- Archive SHA256: `ed99ee9694a2deb776d91cae48ac7411ddfc89ecae2f9b5041111d8c88f2ace9`.
- `src-tauri/vendor/tauri-2.12.1-upstream.json`: exact original per-file hashes/sizes.
- Upstream `LICENSE-MIT`, `LICENSE-APACHE-2.0`, `Cargo.toml.orig`, VCS identity and copyright headers remain present.
- `src-tauri/vendor/tauri-2.12.1-local.json`: exact modified/added hashes and dependency identities.
- `src-tauri/vendor/tauri-2.12.1-codenomad.patch`: complete local diff, including the added native guard and receipt.
- Diff SHA256: `7416bbd978eb088706ad61439b5ac06a2632512c13aa7ebb4794c4138c9f300e`.
- Vendored bytes use package-local `.gitattributes` `-text` to preserve archive/receipt identity across checkout platforms.

Only four upstream files differ: Swift command signature/response conversion,
Swift Package dependency pin, Tauri Cargo manifest (existing locked SHA-256
crate added as a build dependency), and `build.rs` (pre-link guard hook).
Two new files implement the guard and its 13-input receipt. All original Rust
ABI/caller and Android files match the archive. The local patch is reusable and
idempotent: no build-time copy/patch of a registry cache or network acquisition.

SwiftPM now requests the exact reviewed SwiftRs **1.0.7** commit
`f64a4514de07f450ec5b6aa297624cd3479d9579`, not an unconstrained version range.
Its `src-swift/lib.swift` SHA256 is
`d666f824f48ed780eddefc213c3def0faa8b9cf017ea0febbde3829f4efd58e3`.
Rust remains locked to **swift-rs 1.0.8**, archive checksum
`e45c444e496845d3f2a351146bff59aae4975b2280238df1dfaa0c7d1846f38e`.
The reviewed call/retain/Drop semantics are compatible; this is not a claim of
a linked/runtime ABI test or a fabricated SwiftPM 1.0.8 release.

The pin uses the tools-5.3-compatible named package requirement
`.package(name: "SwiftRs", url: "…", .revision("…"))`, retaining the original
target dependency name. Real `swift package dump-package` accepted this final
manifest and returned the exact revision requirement, without fetching packages.
The newer labeled `revision:` overloads require PackageDescription 5.5 and were
rejected by the real manifest compiler; those failed attempts are retained as
`SWIFTPM-PIN-r1.json`/`r2.json`, with final success in `r3.json`. Do not restore
those overloads while keeping `swift-tools-version:5.3`.

The final application Cargo lock changes **one package entry only**: Tauri loses
its registry source/checksum because it is a path package, and gains the already
locked `sha2` dependency. No other versions/checksums were changed. An initial
Windows offline update attempted unrelated downgrades because of incomplete
local caches; those were discarded from this task's changes. The independently
reviewed frozen lock was retained with only the intended local Tauri delta.

## Exact native/generated build route

1. The app/recovery still require `tauri = "=2.12.1"`. The mobile workspace's
   `[patch.crates-io] tauri = { path = "vendor/tauri-2.12.1" }` resolves both to
   the source-owned crate; `exclude` prevents accidental vendor workspace membership.
2. `ios:init` and `ios:build` first run `ios:verify`. It checks all 142 original
   files against original/patched identities, the new guard inputs, exact diff,
   lock identities, real Rust callers/Swift export and native guard ordering.
3. On an iOS target, vendored Tauri `build.rs` runs the hash/version guard **before**
   its unchanged `tauri_utils::build::link_apple_library("Tauri", &lib_path)`.
   `lib_path` is its own `CARGO_MANIFEST_DIR/mobile/ios-api`; no registry location
   or generated-project fallback is used. Its metadata publishes `ios_library_path`.
4. `tauri-plugin 2.7.1`'s real iOS build integration consumes
   `DEP_TAURI_IOS_LIBRARY_PATH` and copies that package to
   `recovery/.tauri/tauri-api` before building Recovery's Swift package.
   Recovery's unchanged `../.tauri/tauri-api` dependency therefore receives the
   **same corrected Swift source and exact SwiftRs commit pin**.
5. The application `build.rs` additionally canonicalizes and asserts that
   `DEP_TAURI_IOS_LIBRARY_PATH` is the owned vendor package. Selecting an unpatched
   dependency fails closed rather than silently linking it.

This is normal Cargo/Tauri native build wiring, not a custom runtime shim.
Both Windows and Mac `cargo pkgid --offline --locked -p tauri` actually selected
the vendor package. `cargo metadata --offline --locked --no-deps` succeeded on
both. **No `tauri ios init`, generated Xcode app build or native linker was run**;
the future generated app/link/runtime gate remains outstanding.

Full offline metadata/fresh application dependency checking remains blocked:
Windows lacks `android_system_properties 0.1.6`; the copied, owned Mac Cargo
cache lacks `core-foundation 0.10.1` (and inventory shows further missing archives).
No dependencies were downgraded to make that check pass and no download occurred.
Do not use `--no-deps` metadata as proof of a complete freshly resolved/buildable graph.

## Regression and compiler evidence

From the repository root:

```text
npm run ios:verify --workspace @codenomad/mobile-app
npm run test --workspace @codenomad/mobile-app
npm run typecheck --workspace @codenomad/mobile-app
```

From `packages/mobile-app`, the native guard's production Rust module is exercised
directly by the separate, offline test fixture (no copied contract implementation):

```text
cargo test --offline --locked --manifest-path tests/native/ios-abi-guard/Cargo.toml --target-dir test-results/ios-abi/guard-target -j 1
```

- Mobile JavaScript tests: **16 passed, 1 existing JDK-dependent Android XML check skipped**.
- Native Rust guard: **3 passed**; real sources pass, version drift fails, original
  Swift export and arbitrary Rust source drift fail. JavaScript checks also reject
  each original ID/success/callback mismatch and a changed Cargo patch route.
- Mobile TypeScript checking passed.
- Mac probe `ios-abi-patch-20261005-8f3061-r2` compiled genuine **SwiftRs, Tauri,
  Recovery modules and objects** for `x86_64-apple-ios15.0-simulator` and
  `arm64-apple-ios15.0`, SDK **26.2**, Swift language mode **5**, serial backend.
- **16 compiler commands succeeded**: 12 module/object commands plus 4 LLVM IR
  commands (corrected and unmodified upstream sources on each target).
- A separate final SwiftPM manifest compilation/dump also passed; this validates
  the supported manifest API and exact resolver requirement, not package resolution
  or an application link. The reproducible probe now includes this gate.
- Corrected LLVM IR on both targets:
  `define hidden void @run_plugin_command(i32 …, ptr …)` and the actual response
  closure's indirect `call void %4(i32 %5, i32 %14, ptr %46)`.
- The actual original sources compile to `@run_plugin_command(i64 …)` and do not
  pass the same callback gate: a negative control with the real upstream compiler,
  not merely a source regex or invented ABI model.
- Corrected IR SHA256: Intel `2aad274ba81813e6fbef7427d502d1dffced06d4b172078593801b96c3f931a6`;
  ARM64 `783e584d09071a94884c662bfb786aa51bd42fa2ab09318680721c69c75a0980`.
- Original IR SHA256: Intel `3b28e57c9b77e7675fd099f24267f0189da53c6389790818df2409149c703c87`;
  ARM64 `6ef42d746d53aff67478ce00678750e290b518fe1b938772003a6ad250f6c188`.

Ignored `test-results/ios-abi/` retains transfer identity, `RESULT-r1.json`
(first driver-only multiple-output `-o` failure), successful `RESULT-r2.json`,
actual LLVM files/compiler logs under `native/`, download hashes,
`CARGO-RESULT.json` (bounded full-metadata failure), native `CARGO-ROUTE.json`,
lock delta and test logs. The corrected driver uses per-source output-file maps;
no production source changed to fix that compiler invocation.

## Safety and remaining qualification

Owned Mac copies only, including copied Cargo caches. Old frozen source, repo,
environment, shared Cargo archive/cache receipts, previous Swift outputs and
Xcode version hashes were unchanged. Process-only `DEVELOPER_DIR` selected the
authorized guarded Xcode; global CLT selection remains unchanged. Fresh `df`
checks retained a 13GiB reserve; aggregate added allocation remained under
512MiB (**436,461,568 bytes**, about 416MiB including both probes, copied Cargo
cache and SwiftPM manifest caches), serial compiler commands under the bounded
time watchdog. No signing,
device boot, accounts, services, sudo, installer, app link or FFI execution.

**SwiftRs's dangling pointer warnings remain visible and unfixed.** No examined
request/response caller reads its escaped generic buffer pointers through Rust;
that narrows this path's reachability, not the safety of SwiftRs's general API.
Unchanged Any?/UIButton warnings also remain. Necessary later work: complete
the exact locked native graph in an owned cache, generated app link, real
Rust→Tauri→Recovery round trips including extreme `i32` IDs, success/reject,
async lifetime/pool-drain checks and WKWebView recovery/device tests. Release/LTO
and memory diagnostics remain untested.

Size warnings: locally modified vendor `build.rs` is **505 lines**. Vendoring
necessarily retains upstream large modules (e.g. `src/app.rs` 2,833,
`src/webview/webview_window.rs` 2,874, `src/window/mod.rs` 2,620 lines).
The complete 24-file >500-line inventory is in `oversized-vendor.json`; these
upstream files were not refactored merely to meet local size guidelines.
