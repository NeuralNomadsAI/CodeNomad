import { fileURLToPath } from "node:url"
import { runNativeFixture } from "./native-fixture-diagnostics.mjs"

const result = await runNativeFixture(fileURLToPath(new URL("./test-session-pruning-native.mjs", import.meta.url)), process.argv.slice(2))
process.exitCode = result.exitCode
