import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { test } from "node:test"

test("the default native profile flow and dialog body remain byte-for-byte equivalent to the admitted SSH base", () => {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex")
  const current = (file: string) => readFileSync(new URL(file === "components/remote-server-dialog.tsx" ? "../../components/remote-server-dialog.tsx" : "./use-remote-server-profiles.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n")
  const hook = "lib/hooks/use-remote-server-profiles.ts", dialog = "components/remote-server-dialog.tsx"
  // The admitted SSH base keeps its flag-off behavior; pin both complete bodies, including its flag guards.
  assert.equal(hash(current(hook).split("export function useRemoteServerProfiles()")[1]), "2acadb487cf3a640398d45c69d6fe701fb885f8d05924110c10a3db1f509517b")
  assert.equal(hash(current(dialog).split("const LegacyRemoteServerDialog: Component<RemoteServerDialogProps> = (props) => {")[1]), "3e9395841fdf5944248e43c9854970e1430edafc2d9429bede47c95d66ea431f")
})
