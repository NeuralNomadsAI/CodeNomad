/** Generated native resources; functions.ts is the only authored program source. The application
 * registry serves the trusted window's in-host engine; preview guests never receive it.
 * `engine.cases.json` holds the TS engine's outputs that its Rust port in the Tauri host must match. */
import { writeFileSync } from "node:fs"
import { engineCases } from "../packages/server/src/automation/page/engine-cases"
import { nativeFunctionRegistry } from "../packages/server/src/automation/page/functions"
const write = (file: string, value: unknown) =>
  writeFileSync(new URL(`../packages/server/src/automation/page/${file}`, import.meta.url), JSON.stringify(value, null, 2) + "\n")
write("functions.generated.json", nativeFunctionRegistry())
write("functions.application.generated.json", nativeFunctionRegistry(true))
void engineCases().then(cases => write("engine.cases.json", cases))
