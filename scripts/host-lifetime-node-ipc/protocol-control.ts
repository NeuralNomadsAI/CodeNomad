// Baseline only. The combined native proof runs this suite inside the runtime Job.
import { BackendHarness, exerciseProtocol } from "./protocol-suite"
const deadline = setTimeout(() => process.exit(1), 25_000)
const harness = new BackendHarness(process.argv[2])
try {
  const protocol = await exerciseProtocol(harness)
  console.log(JSON.stringify({ ...protocol, nativeContainment: false }))
} catch { process.exitCode = 1 } finally {
  try { await harness.cleanup() } catch { process.exitCode = 1 }
  clearTimeout(deadline)
}
