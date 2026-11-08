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

## Semantic reads

Regenerate the fixed reader and extracted Electron fixtures, then build the read child:

```sh
node --import tsx scripts/build-webkit-read.ts
npx --no-install esbuild packages/tauri-app/tests/browser-parent/read-fixture.ts --bundle --platform=node --format=esm --outfile=.tmp/read-fixture.mjs
```

Pass that child as `--fixture` to the same native harness. It saves each fixture's tree and shared-renderer snapshot, and `read-result.json`. Checks include stable same-document refs, fragment/pushState preservation, removal/reinsertion, recreation, cross-document navigation, scope/query and visibility/closure fences. Fixture-only mutations use fixed scripts in the example. Read identities and semantic traversal stay inside the production isolated-world program. The document-start closed-root hook weakly associates roots with hosts; the isolated reader validates native reference-event endpoints against their exact host and document. Declarative closed roots are opaque to this public-DOM capture path.

Run `node --import tsx scripts/compare-webkit-read.ts <comparison-output> <native-artifact-parent> <optional-folder-prefix>` to assert rendered control parity and produce a side-by-side table for each fixture. The native parent contains `<prefix>macos`, `<prefix>x11` and `<prefix>wayland` folders; the default prefix is `p3-read-`. Frame contents are compared explicitly; native date-editor internals are filtered by the production snapshot renderer.

## Native actions

```sh
npx --no-install esbuild packages/tauri-app/tests/browser-parent/action-fixture.ts --bundle --platform=node --format=esm --sourcemap=inline --outfile=.tmp/p4-action-fixture.mjs
node --import tsx scripts/compare-webkit-actions.ts .tmp/p4-comparison
```

Run the native harness with that action child as `--fixture` on macOS, Linux X11 and private Wayland. The shared `action-scenarios.ts` drives the production BrowserPage/PageDriver over real parent pipes and the direct CDP driver over Chromium. HTML input/form/preview fixtures are extracted from the Electron tests. Additional cases cover captured closed-root click/text/contenteditable/select, same-origin frame click/text, forged root endpoints, native ten-step drags, special input append/validation, modal/hidden/covered refusal, waits and declarative parser boundaries. Fixed observation/control programs belong only to the example host.

`action-result.json` records assertions, DOM event trust/modifiers and engine limitations. Native-only timeout cases cover both an expired unsent insertion and an admitted pointer whose handler blocks the page: each down appears once, exact-lease cleanup releases buttons/keys, and the insertion stays unsent. macOS traces can be enabled with `CN_INPUT_TRACE=1`; preserve the standalone-hover and Meta-equivalent event differences alongside the normalized state comparison.

## Device profiles

```sh
npx --no-install esbuild packages/tauri-app/tests/browser-parent/mobile-fixture.ts --bundle --platform=node --format=esm --outfile=.tmp/mobile-fixture.mjs
node --import tsx scripts/compare-webkit-mobile.ts .tmp/mobile-comparison
```

Pass `mobile-fixture.mjs` to the graphical harness on macOS, GTK X11 and `--nested-kde` Wayland; repeat X11 with `GDK_SCALE=2`. `mobile-result.json` reports all six CSS viewports, HTTP/JS user-agent identity, screen/orientation, density, media and touch support. Assertions cover renderer zoom 1.5, native trusted click/touch, unchanged-profile no-op, invalid-profile refusal, resize/replacement lifetime, desktop reset and independent renderer/preview state. The Chromium comparison uses the same HTML and production Electron emulation adapter and records `chromium-mobile.json`.

Build `mobile-trial.ts` the same way for isolated page-zoom, DPR override, layout/view-scale and native GDK-touch experiments. Trial controls compile only into this qualification executable; profile application uses the production modules. The native WebKit limitations and optional macOS density selector are specified in `dev-docs/BROWSER_DEVICE_EMULATION.md`.
