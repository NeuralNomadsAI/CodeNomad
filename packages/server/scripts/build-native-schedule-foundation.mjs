import path from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { nativePluginBuild } from "./native-plugin-build.mjs"

/** Caller-owned packaging directory. Qualification entry is opt-in and separate
 * from the product plugin; the durable mapping owner controls installation. */
export async function buildNativeScheduleFoundation(directory, { qualification = false } = {}) {
  if (!path.isAbsolute(directory)) throw new Error("Absolute native artifact directory required")
  const entries = {
    provider: "native-schedule-carrier-provider.ts",
    runtime: "native-schedule-carrier-runtime.ts",
    ...(qualification ? { qualification: "native-schedule-carrier-native-fixture.ts", observer: "native-schedule-carrier-clock-fixture.ts" } : {}),
  }
  const result = await build({ ...nativePluginBuild, outdir: directory, outExtension: { ".js": ".mjs" }, metafile: true,
    entryPoints: Object.fromEntries(Object.entries(entries).map(([key, file]) => [["qualification", "observer"].includes(key) ? `${key}/index` : key,
      fileURLToPath(new URL(`../src/opencode/missions/${file}`, import.meta.url))])) })
  if (Object.keys(result.metafile.inputs).some(file => /node_modules[/\\](effect|@opencode[/\\]plugin)[/\\]/.test(file)))
    throw new Error("Native Effect/plugin runtime embedded")
  if (qualification) for (const part of ["qualification", "observer"]) await writeFile(path.join(directory, part, "package.json"), JSON.stringify({
    name: `codenomad-native-schedule-${part}`, version: "1.0.0", type: "module", exports: { ".": "./index.mjs" },
    peerDependencies: { effect: "^4.0.0" },
  }))
  return Object.fromEntries(await Promise.all(Object.keys(entries).map(async key => {
    const file = path.join(directory, ["qualification", "observer"].includes(key) ? `${key}/index.mjs` : `${key}.mjs`)
    return [key, { file, sha256: createHash("sha256").update(await readFile(file)).digest("hex") }]
  })))
}
