import { tool } from "@opencode-ai/plugin/tool"
import { createCodeNomadRequester, type CodeNomadConfig } from "./request"

type SessionRenameResponse = {
  sessionID: string
  title: string
}

export function createSessionTools(config: CodeNomadConfig) {
  const requester = createCodeNomadRequester(config)

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    return requester.requestJson<T>(path, init)
  }

  return {
    rename_session: tool({
      description:
        "Rename the current session when the user asks to change the chat title. Use a short descriptive title that reflects the current task.",
      args: {
        title: tool.schema
          .string()
          .describe("New session title, kept short and descriptive, for example 'Fix login bug' or 'Add session rename tool'"),
      },
      async execute(args, context) {
        const sessionID = context.sessionID
        if (!sessionID) {
          return "Error: No active session is available for renaming."
        }

        const trimmedTitle = args.title.trim()
        if (!trimmedTitle) {
          return "Error: Session title cannot be empty."
        }

        const result = await request<SessionRenameResponse>("/session/title", {
          method: "POST",
          body: JSON.stringify({
            sessionID,
            directory: context.directory,
            title: trimmedTitle,
          }),
        })

        return `Renamed session ${result.sessionID} to \"${result.title}\".`
      },
    }),
  }
}
