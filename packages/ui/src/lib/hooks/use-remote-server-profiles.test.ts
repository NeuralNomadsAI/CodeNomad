import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { test } from "node:test"

test("the default native profile flow and dialog body retain their reviewed bodies", () => {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex")
  const current = (file: string) => readFileSync(new URL(file === "components/remote-server-dialog.tsx" ? "../../components/remote-server-dialog.tsx" : "./use-remote-server-profiles.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n")
  const hook = "lib/hooks/use-remote-server-profiles.ts", dialog = "components/remote-server-dialog.tsx"
  // Pin complete bodies, including the awaitable removal/error handling and flag guards.
  assert.equal(hash(current(hook).split("export function useRemoteServerProfiles()")[1]), "2de3710f0f4f95a1eaf659fe08232b86cd27d4e6e9264ef5fc0a3dea88e34e6a")
  assert.equal(hash(current(dialog).split("const LegacyRemoteServerDialog: Component<RemoteServerDialogProps> = (props) => {")[1]), "f4dd32e555e3a38eba19755d5afb31e5211ef23457debbcb94f89e6c1cc13772")
})
