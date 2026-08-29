import { randomBytes } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const AUTOMATION_BRIDGE_PATH = "/api/opencode-plugin/automation"
const PLUGIN_FILENAME = "codenomad-automation.ts"
const REQUEST_TIMEOUT_MS = 95_000
const DISCOVERY_TIMEOUT_MS = 35_000
const SKILL_ID = "codenomad-automation"
const SKILL_CONTENT = `# CodeNomad Automation

When a desktop build is connected in Advanced Settings, use \`codenomad.inspect\` to read its accessibility tree, runtime diagnostics, and recent launch logs. Use refs only from the latest inspection with \`codenomad.act\`, and use \`codenomad.screenshot\` for visual evidence. After changing the desktop implementation, call \`codenomad.act\` with \`restart\`, wait for readiness, and inspect again.
`

export type DeveloperAction =
  | { action: "inspect" }
  | { action: "click"; ref: string }
  | { action: "type"; ref: string; text: string }
  | { action: "restart" }
  | { action: "screenshot" }

export interface AutomationBridgeRegistration {
  version: 1
  url: string
  token: string
  pid: number
  startedAt: number
}

interface ToolContext {
  readonly sessionID: string
}

interface ToolDraft {
  add(tool: {
    name: string
    description: string
    input: Record<string, unknown>
    options: { namespace: string; codemode: false }
    execute(input: unknown, context: ToolContext): Promise<{ content: string | Array<Record<string, string>> }>
  }): void
}

interface AutomationPluginContext {
  location: { directory: string; workspaceID?: string }
  skill: {
    transform(callback: (draft: {
      add(skill: {
        id: string
        name: string
        description: string
        slash: boolean
        autoinvoke: boolean
        location: string
        content: string
      }): void
    }) => void): Promise<unknown>
  }
  tool: {
    transform(callback: (draft: ToolDraft) => void): Promise<unknown>
  }
}

interface BridgeResponse {
  result?: unknown
  error?: string
}

export function automationBridgeDirectory(): string {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "CodeNomad", "automation-bridges")
  }
  if (process.env.XDG_RUNTIME_DIR) return path.join(process.env.XDG_RUNTIME_DIR, "codenomad", "automation-bridges")
  return path.join(os.homedir(), ".config", "codenomad", "automation-bridges")
}

export function createAutomationBridgeRegistration(url: string): AutomationBridgeRegistration {
  return {
    version: 1,
    url: new URL(AUTOMATION_BRIDGE_PATH, url).href,
    token: randomBytes(32).toString("base64url"),
    pid: process.pid,
    startedAt: Date.now(),
  }
}

export async function installAutomationPlugin(): Promise<void> {
  const configRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  const pluginDirectory = path.join(configRoot, "opencode", "plugins")
  const pluginPath = path.join(pluginDirectory, PLUGIN_FILENAME)
  const implementation = pathToFileURL(fileURLToPath(import.meta.url)).href
  const source = `export { default } from ${JSON.stringify(implementation)}\n`
  await mkdir(pluginDirectory, { recursive: true })
  await writeAtomic(pluginPath, source)
  await Promise.all([
    rm(path.join(pluginDirectory, "codenomad-browser.ts"), { force: true }),
    rm(path.join(pluginDirectory, "codenomad-browser.mjs"), { force: true }),
    rm(path.join(configRoot, "opencode", "skills", "codenomad-browser"), { recursive: true, force: true }),
  ])
}

export async function publishAutomationBridge(registration: AutomationBridgeRegistration): Promise<() => Promise<void>> {
  const directory = automationBridgeDirectory()
  const target = path.join(directory, `${registration.pid}-${registration.token.slice(0, 12)}.json`)
  await mkdir(directory, { recursive: true })
  await writeAtomic(target, `${JSON.stringify(registration)}\n`)
  return () => rm(target, { force: true })
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 })
  await rename(temporary, target)
}

export function parseDeveloperAction(input: unknown): DeveloperAction {
  if (!input || typeof input !== "object") throw new Error("Developer automation input must be an object")
  const value = input as Record<string, unknown>
  switch (value.action) {
    case "inspect":
    case "restart":
    case "screenshot":
      return { action: value.action }
    case "click":
      if (typeof value.ref !== "string") throw new Error("click requires ref from the latest inspection")
      return { action: "click", ref: value.ref }
    case "type":
      if (typeof value.ref !== "string" || typeof value.text !== "string") throw new Error("type requires ref and text")
      return { action: "type", ref: value.ref, text: value.text }
    default:
      throw new Error("Unsupported developer automation action")
  }
}

async function registrations(): Promise<AutomationBridgeRegistration[]> {
  const directory = automationBridgeDirectory()
  const names = await readdir(directory).catch(() => [] as string[])
  const found: AutomationBridgeRegistration[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    try {
      const value = JSON.parse(await readFile(path.join(directory, name), "utf8")) as Partial<AutomationBridgeRegistration>
      if (value.version !== 1 || typeof value.url !== "string" || typeof value.token !== "string"
        || typeof value.pid !== "number" || typeof value.startedAt !== "number") continue
      const url = new URL(value.url)
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== AUTOMATION_BRIDGE_PATH) continue
      found.push(value as AutomationBridgeRegistration)
    } catch {
      // Stale or partially-written registrations are ignored.
    }
  }
  return found.sort((left, right) => right.startedAt - left.startedAt).slice(0, 64)
}

async function callBridge(
  registration: AutomationBridgeRegistration,
  body: Record<string, unknown>,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<{ status: number; body: BridgeResponse }> {
  const response = await fetch(registration.url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-codenomad-automation-token": registration.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  return { status: response.status, body: await response.json() as BridgeResponse }
}

function formatBridgeResult(resultValue: unknown) {
  const result = resultValue as { image?: { data: string; mime: string }; [key: string]: unknown } | undefined
  if (result?.image) {
    const content: Array<Record<string, string>> = [
      { type: "text", text: "Captured the connected CodeNomad build." },
      { type: "file", uri: `data:${result.image.mime};base64,${result.image.data}`, mime: result.image.mime, name: "codenomad.png" },
    ]
    return {
      content,
    }
  }
  return { content: JSON.stringify(result ?? null, null, 2) }
}

async function executeDeveloperTool(sessionID: string, command: DeveloperAction) {
  const active = await registrations()
  const probes = await Promise.all(active.map(async (registration) => {
    try {
      return (await callBridge(registration, { mode: "developer-probe", sessionID })).status === 200 ? registration : undefined
    } catch {
      return undefined
    }
  }))
  const targets = probes.filter((value): value is AutomationBridgeRegistration => Boolean(value))
  if (targets.length === 0) throw new Error("Developer Automation is not running for this CodeNomad session")
  if (targets.length > 1) throw new Error("Multiple CodeNomad instances expose Developer Automation for this session")
  const response = await callBridge(targets[0], { mode: "developer-execute", sessionID, command }, REQUEST_TIMEOUT_MS)
  if (response.status !== 200) throw new Error(response.body.error || `Developer automation failed (${response.status})`)
  return formatBridgeResult(response.body.result)
}

export async function setupAutomationPlugin(context: AutomationPluginContext): Promise<void> {
  await context.skill.transform((draft) => {
    draft.add({
      id: SKILL_ID,
      name: "CodeNomad Automation",
      description: "Inspect and control desktop builds connected through Developer Automation.",
      slash: false,
      autoinvoke: true,
      location: import.meta.url,
      content: SKILL_CONTENT,
    })
  })
  await context.tool.transform((draft) => {
    draft.add({
      name: "inspect",
      description: "Inspect the accessibility tree, runtime feedback, and connected target of the CodeNomad build running in Developer Automation.",
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { namespace: "codenomad", codemode: false },
      execute: (_input, tool) => executeDeveloperTool(tool.sessionID, { action: "inspect" }),
    })
    draft.add({
      name: "act",
      description: "Click or type using a ref from the latest codenomad.inspect result, or restart the connected CodeNomad build after changes.",
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["click", "type", "restart"] },
          ref: { type: "string", description: "Element ref from the latest inspection" },
          text: { type: "string", description: "Text for type" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      options: { namespace: "codenomad", codemode: false },
      execute: (input, tool) => executeDeveloperTool(tool.sessionID, parseDeveloperAction(input)),
    })
    draft.add({
      name: "screenshot",
      description: "Capture the visible page of the CodeNomad build running in Developer Automation.",
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { namespace: "codenomad", codemode: false },
      execute: (_input, tool) => executeDeveloperTool(tool.sessionID, { action: "screenshot" }),
    })
  })
}

export default {
  id: "codenomad.automation",
  setup: setupAutomationPlugin,
}
