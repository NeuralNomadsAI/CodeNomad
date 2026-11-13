import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { test } from "node:test"

test("the default native profile flow and dialog body retain their reviewed bodies", () => {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex")
  const current = (file: string) => readFileSync(new URL(file === "components/remote-server-dialog.tsx" ? "../../components/remote-server-dialog.tsx" : "./use-remote-server-profiles.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n")
  const hook = "lib/hooks/use-remote-server-profiles.ts", dialog = "components/remote-server-dialog.tsx"
  // Pin complete bodies, including the awaitable removal/error handling and flag guards.
  assert.equal(hash(current(hook).split("export function useRemoteServerProfiles()")[1]), "f3a2529d17a441bcdacddc5386dc59a1909f5745756c4a8e3cb754d2f682c230")
  assert.equal(hash(current(dialog).split("const LegacyRemoteServerDialog: Component<RemoteServerDialogProps> = (props) => {")[1]), "3e9395841fdf5944248e43c9854970e1430edafc2d9429bede47c95d66ea431f")
})
