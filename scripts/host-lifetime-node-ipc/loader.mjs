// PRIVATE in-process TS compilation only. No compiler subprocess or IPC shim.
import { readFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath } from "node:url"
import ts from "typescript"

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context) } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND" || !/^\.\.?\//.test(specifier)
        || /\.[a-z]+$/i.test(specifier)) throw error
      return nextResolve(`${specifier}.ts`, context)
    }
  },
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return nextLoad(url, context)
    const fileName = fileURLToPath(url)
    const result = ts.transpileModule(readFileSync(fileName, "utf8"), { fileName,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
    return { format: "module", source: result.outputText, shortCircuit: true }
  },
})
