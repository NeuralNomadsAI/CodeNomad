import assert from "node:assert/strict"
import { test } from "node:test"
import { serverApi } from "../lib/api-client"

serverApi.fetchConfigOwner = async <T>() => ({} as T)
serverApi.fetchStateOwner = async <T>() => ({} as T)
serverApi.fetchWorkspaces = async () => { throw new Error("Profile edits must not fetch inventory") }

const { alertDialogState, dismissAlertDialog } = await import("./alerts")
const { confirmRemoteServerChange } = await import("./remote-server-usage")

test("an unavailable saved profile reaches the ordinary confirmation without contacting it", async () => {
  const flight = confirmRemoteServerChange("offline")
  assert.equal(alertDialogState()?.type, "confirm")
  alertDialogState()?.resolve?.(true)
  assert.equal(await flight, true)
  dismissAlertDialog()
})
