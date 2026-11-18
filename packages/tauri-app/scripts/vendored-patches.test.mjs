// Every vendored crate selected by [patch.crates-io] must be the one Cargo.lock
// resolves. A dependency update past a vendored version leaves the patch unused
// and silently builds the unpatched registry crate instead.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = file => readFileSync(path.join(workspace, file), "utf8").replaceAll("\r\n", "\n")

export function patchedCrates(manifest) {
  const section = manifest.match(/^\[patch\.crates-io\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)
  assert.ok(section, "missing [patch.crates-io]")
  return [...section[1].matchAll(/^([\w-]+)\s*=\s*\{\s*path\s*=\s*"([^"]+)"\s*\}/gm)].map(([, name, dir]) => ({ name, dir }))
}

export function packageIdentity(manifest) {
  const section = manifest.match(/^\[package\]\n([\s\S]*?)(?=^\[)/m)?.[1] ?? ""
  return { name: section.match(/^name = "([^"]+)"/m)?.[1], version: section.match(/^version = "([^"]+)"/m)?.[1] }
}

export function lockedPackages(lock, name) {
  return lock.split("\n[[package]]\n").slice(1)
    .map(entry => ({
      name: entry.match(/^name = "([^"]+)"/m)?.[1],
      version: entry.match(/^version = "([^"]+)"/m)?.[1],
      source: entry.match(/^source = "([^"]+)"/m)?.[1],
    }))
    .filter(entry => entry.name === name)
}

test("vendored crates are the resolved implementations", () => {
  const lock = read("Cargo.lock")
  assert.doesNotMatch(lock, /^\[\[patch\.unused\]\]/m, "Cargo.lock records an unused vendored patch")
  const patches = patchedCrates(read("Cargo.toml"))
  assert.ok(patches.length > 0)
  for (const { name, dir } of patches) {
    const identity = packageIdentity(read(path.join(dir, "Cargo.toml")))
    assert.equal(identity.name, name)
    assert.equal(path.basename(dir), `${name}-${identity.version}`, `${dir} must be named after its crate version`)
    assert.deepEqual(lockedPackages(lock, name), [{ name, version: identity.version, source: undefined }],
      `${name} must resolve only to ${dir}; re-vendor it for the dependency update (vendor/README.md)`)
  }
})

test("an update past the vendored version is detected", () => {
  const lock = '\n[[package]]\nname = "tao"\nversion = "9.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n'
  assert.deepEqual(lockedPackages(lock, "tao"), [{ name: "tao", version: "9.0.0", source: "registry+https://github.com/rust-lang/crates.io-index" }])
  assert.deepEqual(patchedCrates('[patch.crates-io]\ntao = { path = "vendor/tao-1.0.0" }\n'), [{ name: "tao", dir: "vendor/tao-1.0.0" }])
})

test("GLib string variant iterators preserve borrowed strings in optimized builds", { skip: process.platform !== "linux" }, () => {
  const target = mkdtempSync(path.join(tmpdir(), "codenomad-glib-regression-"))
  try {
    const result = spawnSync("cargo", ["test", "--release", "--locked", "--jobs", "1", "--target-dir", target,
      "-p", "codenomad-glib-variant-str-regression"], { cwd: workspace, encoding: "utf8", windowsHide: true, timeout: 120_000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("preview runtime fence separates app IPC, scripts and protocols from browser globals", () => {
  const runtime = read("vendor/tauri-runtime-wry-2.12.3/src/lib.rs")
  assert.match(runtime, /let browser_guest = label\.starts_with\("browser-"\);/)
  assert.match(runtime, /if !browser_guest \{\s*webview_builder = webview_builder\.with_ipc_handler/)
  assert.match(runtime, /for \(scheme, protocol\) in uri_scheme_protocols \{[\s\S]*?if browser_guest\s*\{\s*continue;\s*\}/)
  assert.doesNotMatch(read("src-tauri/src/embedded_view.rs"), /\.clipboard\(true\)/)
})

test("WK preview print and beforeunload callbacks retain native completion and app policy", () => {
  const delegate = read("vendor/wry-0.57.1/src/wkwebview/class/wry_web_view_ui_delegate.rs")
  assert.match(delegate, /method\(_webView:printFrame:pdfFirstPageSize:completionHandler:\)/)
  assert.match(delegate, /if self\.ivars\(\)\.preview_dialogs \{ preview_print\(webview\); \}\s*completion\.call\(\(\)\)/)
  assert.match(delegate, /fn before_unload[\s\S]*?if !self\.ivars\(\)\.preview_dialogs \{ completion\.call\(\(true\.into\(\),\)\); return; \}/)
  assert.match(delegate, /webview\.printOperationWithPrintInfo\(&info\)/)
  assert.match(delegate, /operation\.runOperation\(\)/)
})

test("GTK pointer consent preserves the requesting surface and cancels on navigation", () => {
  const source = read("src-tauri/src/embedded_view/linux.rs")
  assert.match(source, /if kind == "pointer-lock"[\s\S]*?pointer_lock_consent\([\s\S]*?return true/)
  assert.match(source, /gtk::InfoBar::new\(\)/)
  assert.match(source, /button\.set_focus_on_click\(false\)/)
  assert.match(source, /LoadEvent::Started[\s\S]*?bar\.response\(gtk::ResponseType::Cancel\)/)
  assert.match(source, /allowed\s*&& epoch\.get\(\) == captured/)
  assert.match(source, /&& answer_policy\.current\(&answer_label, token\)/)
})

test("native popup closure runs each engine's beforeunload path", () => {
  assert.match(read("src-tauri/src/embedded_view/browser.rs"), /CloseRequested \{ api, \.\. \}[\s\S]*?api\.prevent_close\(\)/)
  assert.match(read("src-tauri/src/embedded_view/linux.rs"), /native\.inner\(\)\.try_close\(\)/)
  assert.match(read("src-tauri/src/embedded_view/macos.rs"), /msg_send!\[view, _tryClose\]/)
  const windows = read("src-tauri/src/embedded_view/windows.rs")
  assert.match(windows, /CoTaskMemPWSTR::from\("Page.close"\)/)
  assert.doesNotMatch(windows, /view\.eval\("window.close/)
  assert.match(windows, /policy.current\(&label, token\)/)
})
