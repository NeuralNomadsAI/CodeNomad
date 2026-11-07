# WebKit private parent-channel regression

Build the Node side from the checkout root:

```sh
npx --no-install esbuild packages/tauri-app/tests/browser-parent/fixture.ts --bundle --platform=node --format=esm --outfile=.tmp/browser-parent-fixture.mjs
```

On a macOS or Linux graphical session:

```sh
python3 packages/tauri-app/scripts/test-browser-parent-webkit.py \
  --fixture /path/to/browser-parent-fixture.mjs \
  --output /path/to/artifacts --target /path/to/owned-cargo-target \
  --node /absolute/path/to/node
```

Requirements: Rust, Node, OpenSSL, and the host's native development libraries (GTK 3 / WebKitGTK 4.1, version 2.40+ for isolated-world `evaluate_javascript`, on Linux). Linux inherits display/session variables from the user manager; `GDK_BACKEND=x11` or `wayland` selects the engine display backend. `--nested-kde` owns a separate virtual KWin Wayland compositor alongside an existing desktop and terminates only that compositor. The Cargo target is caller-owned and reusable. The initial offline build reuses the checkout lockfile's resolved versions and the production native build helper; it has a five-minute bound. Native execution is bounded to 150 seconds. Output includes `parent-result.json` and the native `parent-capture.png`.

The harness compiles production `BrowserController`, `EmbeddedViews`, local-window identity validation, native adapters and `native_request::dispatch`. Its child uses production `NativeParent`, real prefixed stdout requests and piped stdin responses. The owning-window inventory and renderer's open-claim callback are fixture-supplied; the existing application UI subscription has its own regression. The harness starts its own fixture child and HTTP/self-signed TLS servers. Keep its temporary data profile separate from application profiles. The public automation capability stays disabled while private requests are exercised directly.

The fixed fixture-only operations control visibility, a renderer dialog, duplicate ownership, close/reopen, response delay and backend retirement. Native capture-completion tests revoke authority at the callback guard's acceptance boundary, after the real engine has produced its result. The controller's native navigation and capture operations remain unchanged by the fixture. These operations belong only to this example executable, never renderer IPC or the application parent-method allowlist.
