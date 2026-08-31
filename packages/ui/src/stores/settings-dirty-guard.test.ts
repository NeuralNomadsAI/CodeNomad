import assert from "node:assert/strict"
import test from "node:test"
import { confirmSettingsDiscard, registerSettingsDirtyGuard } from "./settings-dirty-guard"

test("serializes overlapping dirty confirmations", async () => {
  const pending: Array<(value: boolean) => void> = []
  const unregister = registerSettingsDirtyGuard(() => new Promise<boolean>((resolve) => pending.push(resolve)))
  try {
    const first = confirmSettingsDiscard()
    const second = confirmSettingsDiscard()
    await Promise.resolve()
    assert.equal(pending.length, 1)
    pending[0](true)
    assert.equal(await first, true)
    await Promise.resolve()
    assert.equal(pending.length, 2)
    pending[1](false)
    assert.equal(await second, false)
  } finally {
    unregister()
  }
})
