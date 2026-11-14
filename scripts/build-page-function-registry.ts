/** Generated native resource; functions.ts is the only authored program source. */
import { writeFileSync } from "node:fs"
import { nativeFunctionRegistry } from "../packages/server/src/automation/page/functions"
writeFileSync(new URL("../packages/server/src/automation/page/functions.generated.json", import.meta.url), JSON.stringify(nativeFunctionRegistry(), null, 2) + "\n")
