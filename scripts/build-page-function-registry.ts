/** Generated native resources; functions.ts and diagnostic-events.ts are the only authored program
 * sources. The application registry serves the trusted window's in-host engine; preview guests
 * never receive it. `engine.cases.json` holds the TS engine's outputs that its Rust port in the
 * Tauri host must match. */
import { writeFileSync } from "node:fs"
import { engineCases } from "../packages/server/src/automation/page/engine-cases"
import { nativeDeveloperPrograms } from "../packages/server/src/automation/developer-programs"
import { nativeFunctionRegistry } from "../packages/server/src/automation/page/functions"
import { DIAGNOSTICS } from "../packages/server/src/automation/page/diagnostic-events"
const write = (file: string, value: unknown) =>
  writeFileSync(new URL(`../packages/server/src/automation/page/${file}`, import.meta.url), JSON.stringify(value, null, 2) + "\n")
write("functions.generated.json", nativeFunctionRegistry())
write("functions.application.generated.json", nativeFunctionRegistry(true))
write("developer.generated.json", nativeDeveloperPrograms())
write("diagnostic-events.generated.json", DIAGNOSTICS)
void engineCases().then(cases => write("engine.cases.json", cases))
