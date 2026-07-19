import type { PluginInput } from "@opencode-ai/plugin"
import { createCodeNomadClient, getCodeNomadConfig } from "./lib/client.js"
import { createBackgroundProcessTools } from "./lib/background-process.js"
import { createGitHubTool } from "./lib/github.js"
import { loadGithubModeCommands } from "./lib/commands.js"

let voiceModeEnabled = false

export async function CodeNomadPlugin(input: PluginInput): Promise<{
  tool: ReturnType<typeof createBackgroundProcessTools> & Record<string, unknown>
  "chat.message": CodeNomadChatMessageHook
  config: (cfg: any) => Promise<void>
  "permission.ask": (permission: any, output: any) => Promise<void>
  event: CodeNomadEventHook
}> {
  const config = getCodeNomadConfig()
  const client = createCodeNomadClient(config)
  const backgroundProcessTools = createBackgroundProcessTools(config, { baseDir: input.directory })
  const githubMode = (process.env.CODENOMAD_MODE ?? "").toLowerCase() === "github"
  const githubTool = githubMode ? createGitHubTool(config, { directory: input.directory }) : null

  await client.startEvents((event) => {
    if (event.type === "codenomad.ping") {
      void client.postEvent({
        type: "codenomad.pong",
        properties: {
          ts: Date.now(),
          pingTs: (event.properties as any)?.ts,
        },
      }).catch(() => {})
      return
    }

    if (event.type === "codenomad.voiceMode") {
      voiceModeEnabled = Boolean((event.properties as { enabled?: unknown } | undefined)?.enabled)
    }
  })

  return {
    tool: {
      ...backgroundProcessTools,
      ...(githubTool ? { github: githubTool } : {}),
    },
    config: async (cfg: any) => {
      if (!cfg || typeof cfg !== "object") return
      if (!cfg.command || typeof cfg.command !== "object") cfg.command = {}
      const commandMap = cfg.command as Record<string, any>
      for (const name of Object.keys(commandMap)) {
        if (name.startsWith("codenomad-github-")) delete commandMap[name]
      }
      if (!githubMode) return
      for (const [name, def] of Object.entries(loadGithubModeCommands())) {
        commandMap[name] = {
          template: def.template,
          ...(def.description ? { description: def.description } : {}),
          ...(def.agent ? { agent: def.agent } : {}),
          ...(def.model ? { model: def.model } : {}),
          ...(typeof def.subtask === "boolean" ? { subtask: def.subtask } : {}),
        }
      }
    },
    "permission.ask": async (permission: any, output: any) => {
      if (!githubMode) return
      const kind = permission?.type
      if (kind === "external_directory" || kind === "question") {
        output.status = "deny"
        return
      }
      output.status = "allow"
    },
    async "chat.message"(_input: { sessionID: string }, output: { message: { system?: string } }) {
      if (githubMode) {
        output.message.system = [
          output.message.system,
          "You are running in GitHub mention automation mode.",
          "Do not ask interactive questions. Make reasonable assumptions and proceed.",
          "If you change files and want to open a PR, commit changes to the current branch before calling the github tool.",
        ].filter(Boolean).join("\n\n")
      }

      if (!voiceModeEnabled) {
        return
      }

      output.message.system = [output.message.system, buildVoiceModePrompt()].filter(Boolean).join("\n\n")
    },
    async event(input: { event: any }) {
      const opencodeEvent = input?.event
      if (!opencodeEvent || typeof opencodeEvent !== "object") return

    },
  }
}

type CodeNomadChatMessageHook = (
  _input: { sessionID: string },
  output: { message: { system?: string } },
) => Promise<void>

type CodeNomadEventHook = (input: { event: any }) => Promise<void>

function buildVoiceModePrompt(): string {
  return [
    "Voice conversation mode is enabled.",
    "Prepend your reply with a fenced code block using language `spoken`.",
    "The `spoken` block should be the natural conversational reply you would say out loud to the user. It should be a concise spoken gist of the full response in 2 to 4 natural sentences.",
    "In the spoken block, summarize the main outcome, recommendation, or next step. Sound conversational and natural, not like a document summary.",
    "Do not include code, bullet lists, markdown formatting, or long technical detail in the spoken block.",
    "Do not add generic phrases about whether the user should read more.",
    "Only mention additional written detail when there is something specific that may matter for the user's next response, such as a tradeoff, caveat, risk, open question, exact diff, or test result.",
    "When referring to that written detail, say `below` or `in the message` rather than `detailed section`.",
    "After the `spoken` block, continue with your normal detailed response.",
    "Example:",
    "```spoken\nI implemented the relay-based voice-mode flow and it works with the current plugin bridge. The reconnect caveat is explained below.\n```",
  ].join("\n\n")
}
