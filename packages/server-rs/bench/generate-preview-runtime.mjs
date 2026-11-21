// The Rust server embeds the reference's runtime bridge, including its storage shim.
import { writeFile } from "node:fs/promises"
import { fromDist } from "./fixtures.mjs"
const { buildPreviewRuntimeBridge } = await fromDist("previews/runtime-bridge.js")
const source = buildPreviewRuntimeBridge("__CN_PREVIEW_BASE__", "__CN_PREVIEW_ORIGIN__")
await writeFile(new URL("../src/previews/runtime.html", import.meta.url), source)
