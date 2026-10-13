import assert from "node:assert/strict"

export function verifyNativeWindowResult(result, baseline = false) {
  const output = result.stdout + result.stderr
  assert.equal(result.error, undefined, String(result.error))
  assert.equal(result.signal, null, output)
  if (!baseline) {
    assert.equal(result.status, 0, output)
    assert.match(result.stdout, /PASS: read-only zoom checks/)
    return
  }
  assert.ok(result.status === 2 || result.status === 101, output)
  assert.match(result.stdout, /BEGIN: borderless getter feedback probe/)
  if (result.status === 101) {
    assert.match(result.stderr, /normal reads generated geometry events/)
  } else {
    const evidence = result.stderr.match(/FAIL: getter event feedback watchdog: phase=1 captures=(\d+)/)
    assert.ok(evidence && Number(evidence[1]) >= 100, output)
  }
}
