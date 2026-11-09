import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { test } from "node:test"

test("the default native profile flow and dialog body remain byte-for-byte equivalent to the admitted base", () => {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex")
  const current = (file: string) => readFileSync(new URL(file === "components/remote-server-dialog.tsx" ? "../../components/remote-server-dialog.tsx" : "./use-remote-server-profiles.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n")
  const hook = "lib/hooks/use-remote-server-profiles.ts", dialog = "components/remote-server-dialog.tsx"
  assert.equal(hash(current(hook).split("export function useRemoteServerProfiles()")[1]), "848cb0680a9913871138d923febc15e8d6f0a77081ce6d8bcf48e39ad626f673")
  assert.equal(hash(current(dialog).split("const LegacyRemoteServerDialog: Component<RemoteServerDialogProps> = (props) => {")[1]), "36b01636d3d3e2ea6d84e46e0790c19b43ddedf47054a472221e306716f6290b")
})
