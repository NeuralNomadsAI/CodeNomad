import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"

import { BackgroundProcessManager } from "./manager"
import type { WorkspaceManager } from "../workspaces/manager"
import type { EventBus } from "../events/bus"
import type { Logger } from "../logger"

const WORKSPACE_ID = "ws-test"
const SESSION_ID = "sess-1"
const INSTANCE_PORT = 9999
const AUTH_HEADER = "Basic test-auth"
const TERMINAL_TIMEOUT_MS = 3000

interface CapturedRequest {
  method: string
  url: string
  headers: Headers
  body: string
}

/**
 * Drives the real {@link BackgroundProcessManager} lifecycle (spawn a
 * fast-exiting command with notify enabled) against a mocked transport, so the
 * migrated `sendCompletionPrompt` path — factory + SDK client + `fetch` — is
 * exercised end to end without touching production wiring.
 *
 * The workspace temp directory is intentionally left in place (under
 * `os.tmpdir()`, OS-reaped): removing it from the test races the manager's
 * asynchronous finalization writes, which intermittently fail with ENOENT.
 */
async function runCompletionPrompt(
  fetchImpl: (input: Request, init: RequestInit | undefined) => Promise<Response>,
): Promise<{ requests: CapturedRequest[]; warned: boolean; directory: string }> {
  const requests: CapturedRequest[] = []
  const originalFetch = globalThis.fetch
  // Captured now but swapped in only inside the try below, so a failure during
  // setup (mkdtemp, manager construction) can't leak the mocked fetch.
  const fetchMock = (async (input: any, init: any) => {
    const req = input instanceof Request ? input : new Request(String(input), init)
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: await req.text(),
    })
    return fetchImpl(input instanceof Request ? input : req, init)
  }) as typeof fetch

  let warned = false
  const logger = {
    warn: () => { warned = true },
    debug: () => {},
    trace: () => {},
    info: () => {},
    error: () => {},
    fatal: () => {},
    isLevelEnabled: () => false,
    level: "info",
    child: () => logger,
  } as unknown as Logger

  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "bp-test-"))
  // Distinct from the workspace root so the directory-override assertion is
  // discriminating: if `sendCompletionPrompt` stops passing `notify.directory`,
  // the factory would fall back to `workspacePath` and the header check fails.
  const sessionDir = path.join(workspacePath, "session-worktree")

  // Resolve once the manager publishes a terminal (non-running) status update.
  let resolveTerminal: () => void = () => {}
  const terminal = new Promise<void>((resolve) => { resolveTerminal = resolve })
  const eventBus = {
    on: () => {},
    publish: (event: any) => {
      if (event?.type === "instance.event") {
        const type = event?.event?.type
        const status = event?.event?.properties?.process?.status
        if (type === "background.process.removed" || (status && status !== "running")) resolveTerminal()
      }
      return true
    },
  } as unknown as EventBus

  const workspaceManager = {
    get: () => ({ path: workspacePath }),
    getInstancePort: () => INSTANCE_PORT,
    getInstanceAuthorizationHeader: () => AUTH_HEADER,
  } as unknown as WorkspaceManager

  const manager = new BackgroundProcessManager({ workspaceManager, eventBus, logger })

  try {
    globalThis.fetch = fetchMock
    await manager.start(WORKSPACE_ID, "test-proc", "true", {
      notify: true,
      notification: { sessionID: SESSION_ID, directory: sessionDir },
    })
    // The terminal status update is published at the very end of finalize, so
    // resolving on it is a deterministic completion signal. Fail loudly rather
    // than racing a silent timeout that could mask a hang.
    let timeoutHandle: NodeJS.Timeout | undefined
    const reachedTerminal = await Promise.race([
      terminal.then(() => true),
      new Promise<boolean>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(false), TERMINAL_TIMEOUT_MS)
      }),
    ])
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (!reachedTerminal) {
      throw new Error("background process did not reach a terminal state in time")
    }
  } finally {
    globalThis.fetch = originalFetch
  }

  return { requests, warned, directory: sessionDir }
}

describe("BackgroundProcessManager.sendCompletionPrompt", () => {
  it("posts the synthetic completion prompt to the instance via the SDK route", async () => {
    const { requests, directory } = await runCompletionPrompt(async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    )

    const promptCall = requests.find((r) => r.url.includes("/prompt_async"))
    assert.ok(promptCall, "expected a prompt_async request")
    assert.equal(promptCall.method, "POST")
    assert.equal(
      promptCall.url,
      `http://127.0.0.1:${INSTANCE_PORT}/session/${SESSION_ID}/prompt_async`,
    )
    assert.equal(promptCall.headers.get("authorization"), AUTH_HEADER)
    // The prompt is scoped to the session's directory (a POST keeps the
    // directory as a header — the SDK only rewrites header→query for GET/HEAD).
    assert.equal(promptCall.headers.get("x-opencode-directory"), encodeURIComponent(directory))

    const body = JSON.parse(promptCall.body)
    assert.equal(body.parts.length, 1)
    assert.equal(body.parts[0].type, "text")
    assert.equal(body.parts[0].synthetic, true)
    assert.match(body.parts[0].text, /test-proc/)
  })

  it("swallows a failed prompt and logs it without aborting finalization", async () => {
    const { warned } = await runCompletionPrompt(async () =>
      new Response("boom", { status: 500 }),
    )
    assert.equal(warned, true)
  })
})
