import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { crc32, inflateSync } from "node:zlib"

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8")

test("WKWebView permission classification reaches the native delegate before construction", () => {
  const builder = read("../src-tauri/src/embedded_view.rs")
  const runtime = read("../vendor/tauri-runtime-wry-2.12.3/src/lib.rs")
  const webview = read("../vendor/wry-0.57.1/src/wkwebview/mod.rs")
  const delegate = read("../vendor/wry-0.57.1/src/wkwebview/class/wry_web_view_ui_delegate.rs")
  const policy = read("../src-tauri/src/embedded_view/browser.rs")
  assert.match(builder, /\.on_permission_request\([\s\S]*?current\(&permission_label, token\)[\s\S]*?browser::permission\(view, kind\)[\s\S]*?PermissionResponse::Deny/)
  assert.match(policy, /K::Camera \| K::Microphone \| K::Geolocation \| K::Notifications => R::Deny/)
  assert.match(policy, /K::ClipboardRead[\s\S]*?K::Autoplay => R::Default/)
  assert.match(policy, /_ => \{\s*unknown_permission[\s\S]*?R::Deny/)
  assert.match(runtime, /with_permission_handler[\s\S]*?permission_request_handler\(kind\)/)
  assert.match(webview, /WryWebViewUIDelegate::new\([\s\S]*?attributes.permission_handler/)
  assert.match(delegate, /request_media_capture_permission[\s\S]*?self.ivars\(\).permission_handler[\s\S]*?PermissionResponse::Deny => WKPermissionDecision::Deny/)
})

test("WK native context-menu downloads share navigation download policy", () => {
  const delegate = read("../vendor/wry-0.57.1/src/wkwebview/class/wry_navigation_delegate.rs")
  const download = read("../vendor/wry-0.57.1/src/wkwebview/download.rs")
  assert.match(delegate, /method\(_webView:contextMenuDidCreateDownload:\)[\s\S]*?attach_download_delegate\(self, download\)/)
  assert.equal((download.match(/attach_download_delegate\(this, download\)/g) ?? []).length, 2)
  assert.match(download, /fn attach_download_delegate[\s\S]*?download.setDelegate/)
})

test("native download image fixture has valid PNG chunks and a decoded RGBA pixel", () => {
  const fixture = read("./webkit-capabilities/fixture.py")
  const png = Buffer.from(fixture.match(/PNG_BASE64 = '([^']+)'/)[1], "base64")
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a")
  const compressed = []
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset)
    const body = png.subarray(offset + 4, offset + 8 + size)
    assert.equal(crc32(body), png.readUInt32BE(offset + 8 + size))
    if (body.subarray(0, 4).toString() === "IDAT") compressed.push(body.subarray(4))
    offset += size + 12
  }
  assert.deepEqual(inflateSync(Buffer.concat(compressed)), Buffer.from([0, 255, 0, 255, 255]))
})

test("Linux denies protected and unidentified requests and fences classified consent", () => {
  const adapter = read("../src-tauri/src/embedded_view/linux.rs")
  assert.match(adapter, /connect_permission_request\(move \|page, request\|[\s\S]*?!policy.current\(view.label\(\), token\)[\s\S]*?request.deny\(\)/)
  for (const kind of ["GeolocationPermissionRequest", "NotificationPermissionRequest", "UserMediaPermissionRequest", "DeviceInfoPermissionRequest"]) assert.ok(adapter.includes(kind))
  assert.match(adapter, /PointerLockPermissionRequest[\s\S]*?WebsiteDataAccessPermissionRequest/)
  assert.match(adapter, /allowed\s*&& epoch.get\(\) == captured[\s\S]*?answer_policy.current\(&answer_label, token\)[\s\S]*?request.allow\(\)/)
  assert.match(adapter, /request.deny\(\);\s*super::browser::unknown_permission/)
})

test("WebKit guest zoom stays native and precedes primary-window menu fallback", () => {
  const main = read("../src-tauri/src/main.rs")
  assert.match(main, /on_menu_event\(\|app_handle, event\|[\s\S]*?embedded_view::zoom::focused[\s\S]*?match event.id/)
  const zoom = read("../src-tauri/src/embedded_view/zoom.rs")
  assert.match(zoom, /label.starts_with\("browser-"\)/)
  assert.match(zoom, /guard.current\(&label, token\)/)
  assert.doesNotMatch(zoom, /initialization_script|\.eval\(|tauri::command/)
  assert.match(read("../src-tauri/src/embedded_view/zoom_macos.m"), /firstResponder[\s\S]*?isDescendantOf:view/)
  assert.match(read("../src-tauri/src/embedded_view/zoom_linux.c"), /gtk_window_get_focus[\s\S]*?webkit_web_view_set_zoom_level/)
})
