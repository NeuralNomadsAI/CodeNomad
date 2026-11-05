import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

// Literal expectations checked against origin/feat/multi-backend's api-client,
// panel-extensions-api, tool-content and sdk-manager. Each process imports the
// real local singletons with a fresh injected base; no module-cache substitution.
const cases = [
  { base: undefined, events: "/api/events", panel: "/api/panel-extensions", resource: "", http: "/api/meta" },
  { base: "", events: "/api/events", panel: "/api/panel-extensions", resource: "", http: "/api/meta" },
  { base: "/relay", events: "/relay/api/events", panel: "/relay/api/panel-extensions", resource: "/relay", http: "TypeError" },
  { base: "/relay/", events: "/relay//api/events", panel: "/relay//api/panel-extensions", resource: "/relay", http: "TypeError" },
  { base: "https://local.invalid", events: "https://local.invalid/api/events", panel: "https://local.invalid/api/panel-extensions", resource: "https://local.invalid", http: "https://local.invalid/api/meta" },
  { base: "https://local.invalid/tenant/", events: "https://local.invalid/tenant//api/events", panel: "https://local.invalid/tenant//api/panel-extensions", resource: "https://local.invalid/tenant", http: "https://local.invalid/api/meta" },
]
const moduleUrl = (file: string) => JSON.stringify(new URL(file, import.meta.url).href)

test("injected local URL joins match the integration baseline character for character and exit naturally", () => {
  for (const row of cases) {
    const result = spawnSync(process.execPath, ["--conditions=browser", "--import", "tsx", "--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      const row = ${JSON.stringify(row)};
      ${row.base === undefined ? "" : 'globalThis.window = { __CODENOMAD_API_BASE__: row.base, location: { origin: "https://page.invalid" } };'}
      const requests = [];
      globalThis.fetch = async input => { requests.push(String(input)); return Response.json({}); };
      const { localTransport } = await import(${moduleUrl("./backend-transport.ts")});
      const { panelExtensionsApi } = await import(${moduleUrl("./panel-extensions-api.ts")});
      const { toolImageSource } = await import(${moduleUrl("./tool-content.ts")});
      const { buildInstanceBaseUrl, SDKManager } = await import(${moduleUrl("./sdk-manager.ts")});
      assert.equal(localTransport.eventsUrl, row.events);
      await panelExtensionsApi.list();
      assert.deepEqual(requests, [row.panel]);
      const uri = "/api/workspaces/w/session-media/s/m/0/0/" + "a".repeat(64);
      assert.equal(toolImageSource({ type: "file", mime: "image/png", uri }), row.resource + uri);
      if (row.base !== undefined && !row.base.startsWith("https://")) {
        assert.equal(toolImageSource({ type: "file", mime: "image/png", uri }, row.base), row.resource + uri);
      }
      assert.equal(buildInstanceBaseUrl("/workspaces/w/instance"), row.resource + "/workspaces/w/instance/");
      let http;
      try { http = localTransport.url("/api/meta"); } catch (error) { http = error.name; }
      assert.equal(http, row.http);
      if (row.resource.startsWith("https://")) {
        await new SDKManager().createClient("w", "/workspaces/w/instance").session.prompt({ sessionID: "s", text: "fixture" });
        assert.equal(requests.at(-1), row.resource + "/workspaces/w/instance/api/session/s/prompt");
      }
    `], { encoding: "utf8", timeout: 30_000, windowsHide: true })
    assert.ifError(result.error)
    assert.equal(result.signal, null, result.stderr)
    assert.equal(result.status, 0, `${row.base}: ${result.stdout}\n${result.stderr}`)
  }
})
