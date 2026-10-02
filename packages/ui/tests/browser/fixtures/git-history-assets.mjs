import { fileURLToPath } from "node:url"
import { copyMonacoPublicAssets } from "../../../scripts/monaco-public-assets.js"

export function prepareGitPrototypeAssets() {
  const source = fileURLToPath(new URL("../../../../../node_modules/monaco-editor/min/vs", import.meta.url))
  const renderer = fileURLToPath(new URL("../../../src/renderer", import.meta.url))
  copyMonacoPublicAssets({ uiRendererRoot: renderer, sourceRoots: [source] })
}
