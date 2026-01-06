import type { PluginInput } from "@opencode-ai/plugin"
import { createCodeNomadClient, getCodeNomadConfig } from "./lib/client"
import { createBackgroundProcessTools } from "./lib/background-process"

export async function CodeNomadPlugin(input: PluginInput) {
  const config = getCodeNomadConfig()
  const client = createCodeNomadClient(config)
  const backgroundProcessTools = createBackgroundProcessTools(config, { baseDir: input.directory })

  await client.startEvents((event) => {
    if (event.type === "codenomad.ping") {
      void client.postEvent({
        type: "codenomad.pong",
        properties: {
          ts: Date.now(),
          pingTs: (event.properties as any)?.ts,
        },
      }).catch(() => {})
    }
  })

  return {
    tool: {
      ...backgroundProcessTools,
    },
    async event(input: { event: any }) {
      const opencodeEvent = input?.event
      if (!opencodeEvent || typeof opencodeEvent !== "object") return

    },
  }
}
