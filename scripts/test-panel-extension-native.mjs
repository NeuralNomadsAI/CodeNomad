// No CodeNomad backend/profile, shared daemon or desktop instance is involved.
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { spawn, spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { tsImport } from "tsx/esm/api"

assert.equal(process.platform, "win32", "Run the WebView2 regression on Windows")
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workspace = path.join(root, "packages/tauri-app")
const target = path.resolve(process.env.CARGO_TARGET_DIR || path.join(workspace, "target"))
const env = { ...process.env, CARGO_TARGET_DIR: target }
delete env.NODE_OPTIONS
delete env.CODENOMAD_NATIVE_PARENT
const build = spawnSync("cargo", ["build", "-p", "codenomad-panel-extension-fixture"], {
  cwd: workspace, env, encoding: "utf8", timeout: 300_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
})
assert.equal(build.error, undefined, String(build.error))
assert.equal(build.status, 0, build.stdout + build.stderr)
const { panelExtensionDocument } = await tsImport(new URL("../packages/ui/src/components/panel-extensions/frame-document.ts", import.meta.url).href, import.meta.url)
const document = panelExtensionDocument(`<h1>External panel</h1><p id="session"></p><script>
  const results = { parent: 'unknown', network: 'unknown', context: null, nativeGlobal: typeof window.__TAURI_INTERNALS__ };
  try { parent.document; results.parent = 'allowed'; } catch { results.parent = 'blocked'; }
  codenomad.onContext(context => { results.context = context.sessionId; document.querySelector('#session').textContent = context.sessionId; });
  fetch('/api/forbidden').then(() => results.network = 'allowed').catch(() => results.network = 'blocked');
  // On Windows Tauri globals may be injected. Their presence is not permission.
  if (window.__TAURI_INTERNALS__) {
    __TAURI_INTERNALS__.invoke('probe', { role: 'child' }).catch(() => {});
    __TAURI_INTERNALS__.ipc({ cmd: 'probe', callback: 1, error: 2, payload: { role: 'raw-child' } });
  }
  parent.postMessage({ cmd: 'probe', role: 'message-child' }, '*');
  setTimeout(() => parent.postMessage({ type: 'results', results }, '*'), 1500);
</script>`, "fixture-handshake")
const reports = []
const server = createServer((request, response) => {
  if (request.url === "/report") {
    let body = ""
    request.on("data", chunk => { body += chunk })
    request.on("end", () => { reports.push(JSON.parse(body)); response.end("ok") })
    return
  }
  response.setHeader("Content-Type", "text/html")
  response.end(`<script>
    window.addEventListener('message', e => { if (e.data?.type === 'results') fetch('/report', { method: 'POST', body: JSON.stringify(e.data.results) }); });
    window.addEventListener('DOMContentLoaded', () => __TAURI_INTERNALS__.invoke('probe', { role: 'parent' }));
    function initialize(frame) {
      const channel = new MessageChannel();
      channel.port1.onmessage = e => { if (e.data?.handshake === 'fixture-handshake') channel.port1.postMessage({ type: 'context', context: { apiVersion: 1, sessionId: 'native-session', locale: 'en', appearance: 'light' } }); };
      frame.contentWindow.postMessage({ type: 'codenomad:init' }, '*', [channel.port2]);
    }
  </script><iframe sandbox="allow-scripts" onload="initialize(this)" srcdoc="${document.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}"></iframe>`)
})
const profile = await mkdtemp(path.join(process.env.TEMP || os.tmpdir(), "opencode-panel-native-"))
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const child = spawn(path.join(target, "debug/codenomad-panel-extension-fixture.exe"), [
    `http://127.0.0.1:${server.address().port}`, profile,
  ], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  child.stdout.on("data", chunk => { output += chunk })
  child.stderr.on("data", chunk => { output += chunk })
  const status = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve) })
  assert.equal(status, 0, output)
  assert.match(output, /NATIVE:parent/, "Positive native control must succeed")
  assert.doesNotMatch(output, /NATIVE:(?:child|raw-child|message-child)/, "Author code must not reach native commands")
  assert.equal(reports.length, 1, JSON.stringify(reports))
  assert.equal(reports[0].parent, "blocked")
  assert.equal(reports[0].network, "blocked")
  assert.equal(reports[0].context, "native-session")
  console.log(JSON.stringify({ nativeParent: "allowed", nativeChild: "blocked", ...reports[0] }, null, 2))
} finally {
  await new Promise(resolve => server.close(resolve))
  // WebView2 releases its child-process lock shortly after the host exits.
  await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
}
