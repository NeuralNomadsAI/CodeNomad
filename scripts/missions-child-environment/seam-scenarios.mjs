import assert from "node:assert/strict"
import path from "node:path"
import { mkdir, readFile } from "node:fs/promises"
import { atomicJSON } from "../missions-authority-spike/broker.mjs"

// Native scenarios compose the existing runner helpers; no general tool driver.
export async function explicitSeam({ root, backend, provider, running, evidence, parent, prepare, binding, finish, wait, until,
  primary, messages, tools, rpc, cleanRoot, readProbe, probeCommand, toolCall, options, profile, gate }) {
  const admission = backend.admission
  admission.setMode("explicit")
  const fileA = path.join(root, "profile-A.json"), fileB = path.join(root, "profile-B.json")
  const write = async (file, marker, retired) => {
    await profile(marker, retired)
    await atomicJSON(file, JSON.parse(await readFile(path.join(root, "profile.json"), "utf8")))
  }
  const matches = (result, marker, retired = null) => {
    cleanRoot(result.shell)
    assert.equal(result.shell.marker, marker)
    assert.equal(result.shell.retired, retired)
    assert.deepEqual(result.shell.pathBins, [marker])
  }
  const rejection = async (parentID, callID, previousModelCount = 0) => {
    await wait(parentID)
    const { binding: bound } = await rpc("proof", { parentID, callID })
    assert(bound, "Native born-child binding is preserved even on denied admission")
    assert.equal(tools(await messages(parentID)).find(part => part.id === callID).state.status, "error")
    assert.equal(primary(bound.childID).length, previousModelCount, "No new child model request on denied admission")
    assert.equal(primary(bound.childID).filter(record => record.callID === callID).length, 0)
    return bound
  }
  evidence.explicit = { firstModelEnvironment: false, failClosedBeforeModel: false, rejected: {} }
  const a = await parent("Explicit profile A"), b = await parent("Explicit profile B")
  admission.approveRoot(a, fileA); admission.approveRoot(b, fileB)
  await write(fileA, "A1", "only-A1")
  provider.holdNext.add(a)
  const owner = await prepare(a, "explicit_A", {}, [toolCall("shell", { command: probeCommand("explicit-A") }, "explicit_probe_A")], true)
  await until(() => provider.holds.has(a))
  await write(fileA, "A2") // Root already has A1; fresh CHILD admission must use A2.
  await write(fileB, "B1", "only-B1")
  provider.holdNext.add(b)
  await prepare(b, "explicit_B", {}, [toolCall("shell", { command: probeCommand("explicit-B") }, "explicit_probe_B")], true)
  await until(() => provider.holds.has(b))
  provider.release(a); provider.release(b)
  const boundA = await binding(a, "explicit_A"), boundB = await binding(b, "explicit_B")
  await until(() => provider.holds.has(boundA.childID) && provider.holds.has(boundB.childID))
  assert((await running.client.session.active({}, options()))[boundA.childID])
  assert((await running.client.session.active({}, options()))[boundB.childID])
  const writesBeforeEdit = admission.trace.filter(entry => entry.operation === "environment-dispatch").length
  await write(fileA, "A1", "next-round-only") // Editing settings alone must not mutate the child.
  provider.release(boundA.childID); provider.release(boundB.childID)
  evidence.explicit.initial = { A: await finish(a, "explicit_A", "explicit-A"), B: await finish(b, "explicit_B", "explicit-B") }
  matches(evidence.explicit.initial.A, "A2"); matches(evidence.explicit.initial.B, "B1", "only-B1")
  assert.equal(admission.trace.filter(entry => entry.operation === "environment-dispatch").length, writesBeforeEdit)
  await running.client.session.shell({ sessionID: a, command: probeCommand("explicit-root-A") }, options())
  evidence.explicit.oldRoot = cleanRoot(await readProbe("explicit-root-A"))
  assert.equal(evidence.explicit.oldRoot.marker, "A1"); assert.equal(evidence.explicit.oldRoot.retired, "only-A1")
  await prepare(a, "explicit_continue", { sessionID: boundA.childID }, [toolCall("shell", { command: probeCommand("explicit-continue") }, "explicit_probe_continue")], false, owner)
  evidence.explicit.continuation = await finish(a, "explicit_continue", "explicit-continue")
  matches(evidence.explicit.continuation, "A1", "next-round-only")
  assert.equal(evidence.explicit.continuation.binding.childID, boundA.childID)
  await write(fileA, "A2")
  await prepare(a, "explicit_new", {}, [toolCall("shell", { command: probeCommand("explicit-new") }, "explicit_probe_new")])
  evidence.explicit.newChild = await finish(a, "explicit_new", "explicit-new")
  matches(evidence.explicit.newChild, "A2")
  assert.notEqual(evidence.explicit.newChild.binding.childID, boundA.childID)
  evidence.explicit.firstModelEnvironment = true
  evidence.explicitAdmission = true
  gate("explicit progress admission installs fresh separate cleaned child profiles before first native model shell; continuation/new-child reapply")

  const apiReject = await parent("Native environment API rejection")
  await prepare(apiReject, "reject_environment", {}, [], false, { fault: "reject-real-api" })
  evidence.explicit.rejected.api = await rejection(apiReject, "reject_environment")
  const failedPath = `/api/session/${evidence.explicit.rejected.api.childID}/environment`
  await until(() => running.logs.split("\n").some(line => line.includes(failedPath) && line.includes("http.status=404")), "real native environment HTTP 404")
  evidence.explicit.nativeEnvironmentRejection = { path: failedPath, status: 404 }
  assert(admission.trace.some(entry => entry.callID === "reject_environment" && entry.operation === "environment-dispatch"))
  assert(!admission.trace.some(entry => entry.callID === "reject_environment" && entry.operation === "environment-written"))
  assert(admission.trace.some(entry => entry.callID === "reject_environment" && entry.operation === "native-environment-rejected"))
  const deleting = await parent("Deletion-fenced child admission")
  provider.holdNext.add(deleting)
  await prepare(deleting, "deletion_blocked")
  await until(() => provider.holds.has(deleting))
  await admission.blockDeletion(async () => {
    provider.release(deleting)
    evidence.explicit.rejected.deletion = await rejection(deleting, "deletion_blocked")
    assert(!admission.trace.some(entry => entry.callID === "deletion_blocked" && entry.operation === "environment-dispatch"))
  })
  await prepare(deleting, "deletion_explicit_retry", {}, [toolCall("shell", { command: probeCommand("deletion-retry") }, "deletion_probe_retry")])
  evidence.explicit.retry = await finish(deleting, "deletion_explicit_retry", "deletion-retry")
  matches(evidence.explicit.retry, "A2")
  assert.notEqual(evidence.explicit.retry.binding.childID, evidence.explicit.rejected.deletion.childID)
  const scoped = await parent("Approved scope changed")
  provider.holdNext.add(scoped)
  await prepare(scoped, "scope_changed")
  await until(() => provider.holds.has(scoped))
  admission.approveRoot(scoped, fileB)
  provider.release(scoped)
  evidence.explicit.rejected.scope = await rejection(scoped, "scope_changed")
  assert(!admission.trace.some(entry => entry.callID === "scope_changed" && entry.operation === "environment-dispatch"))
  const stale = await parent("Old native connection rejected")
  provider.holdNext.add(stale)
  await prepare(stale, "stale_connection")
  await until(() => provider.holds.has(stale))
  backend.manager.invalidateSharedServiceConnection()
  provider.release(stale)
  evidence.explicit.rejected.connection = await rejection(stale, "stale_connection")
  assert(!admission.trace.some(entry => entry.callID === "stale_connection" && entry.operation === "environment-dispatch"))
  const movedChild = evidence.explicit.newChild.binding
  const beforeMove = primary(movedChild.childID).length
  const destination = path.join(root, "moved-child-location")
  await mkdir(destination)
  await running.client.session.move({ sessionID: movedChild.childID, directory: destination }, options())
  await until(async () => (await running.client.session.get({ sessionID: movedChild.childID }, options())).location.directory !== evidence.explicit.newChild.child.location.directory, "actual native child move")
  const moved = await running.client.session.get({ sessionID: movedChild.childID }, options())
  assert.notEqual(moved.location.directory, evidence.explicit.newChild.child.location.directory)
  await wait(movedChild.childID)
  const beforeMovedAdmission = primary(movedChild.childID).length
  await prepare(a, "moved_child", { sessionID: movedChild.childID }, [], false, movedChild)
  await wait(a)
  assert.equal(tools(await messages(a)).find(part => part.id === "moved_child").state.status, "error")
  assert.equal(primary(movedChild.childID).filter(record => record.callID === "moved_child").length, 0)
  evidence.explicit.rejected.moved = { childID: movedChild.childID, actualLocation: moved.location,
    requestsBeforeMove: beforeMove, requestsBeforeAdmission: beforeMovedAdmission, requestsAfterDenial: primary(movedChild.childID).length,
    binding: (await rpc("proof", { parentID: a, callID: "moved_child" })).binding }
  assert(!admission.trace.some(entry => entry.callID === "moved_child" && entry.operation === "environment-dispatch"))
  const noScope = await parent("No approved profile scope")
  admission.approveRoot(noScope, undefined)
  await prepare(noScope, "missing_profile_scope")
  evidence.explicit.rejected.missingScope = await rejection(noScope, "missing_profile_scope")
  assert(!admission.trace.some(entry => entry.callID === "missing_profile_scope" && entry.operation === "environment-dispatch"))
  const noShell = await parent("Explicit admission retains inherited shell deny", [{ action: "shell", resource: "*", effect: "deny" }])
  await prepare(noShell, "explicit_shell_denied", {}, ["NO_SHELL_WITH_EXPLICIT_ADMISSION"])
  await wait(noShell)
  const shellDeniedBinding = await binding(noShell, "explicit_shell_denied")
  evidence.explicit.permissions = { binding: shellDeniedBinding, tools: primary(shellDeniedBinding.childID)[0].tools }
  assert(!evidence.explicit.permissions.tools.includes("shell"))
  assert(admission.trace.some(entry => entry.callID === "explicit_shell_denied" && entry.operation === "admitted"))
  const lateConnection = await parent("Connection invalidated after native write")
  await prepare(lateConnection, "late_connection", {}, [], false, { fault: "hold-real-write-settlement" })
  await until(() => admission.holds.has("late_connection"))
  backend.manager.invalidateSharedServiceConnection()
  admission.holds.get("late_connection").release()
  evidence.explicit.rejected.lateConnection = await rejection(lateConnection, "late_connection")
  assert(!admission.trace.some(entry => entry.callID === "late_connection" && entry.operation === "admitted"))
  const revoke = await parent("Revoke during real write settlement")
  await prepare(revoke, "late_revoke", {}, [], false, { fault: "hold-real-write-settlement" })
  await until(() => admission.holds.has("late_revoke"))
  admission.revoke("late_revoke")
  const revoked = await rejection(revoke, "late_revoke")
  await running.client.session.shell({ sessionID: revoked.childID, command: probeCommand("revoked-snapshot") }, options())
  evidence.explicit.rejected.revocation = { binding: revoked, snapshot: cleanRoot(await readProbe("revoked-snapshot")) }
  assert.equal(evidence.explicit.rejected.revocation.snapshot.marker, "A2")
  assert(!admission.trace.some(entry => entry.callID === "late_revoke" && entry.operation === "admitted"))
  const seed = JSON.parse(await readFile(path.join(root, "child-admission-seed.json"), "utf8"))
  const request = { parentID: revoked.parentID, callID: revoked.callID, childID: revoked.childID, rootRequestID: revoked.rootRequestID,
    executionID: revoked.executionID, taskKey: revoked.taskKey, contractRequestID: revoked.contractRequestID }
  const writesBefore = admission.trace.filter(entry => entry.operation === "environment-dispatch").length
  for (const [cookie, body, status] of [["", request, 403], [seed.cookie, { ...request, variables: { PRIVATE_REJECTED_BODY: "not-a-profile" } }, 409],
    [seed.cookie, { ...request, callID: "unregistered-call" }, 409]]) {
    const response = await fetch(`${seed.url}/admit`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body), ...options() })
    assert.equal(response.status, status)
    const result = await response.json()
    assert(!JSON.stringify(result).includes("variables") && !JSON.stringify(result).includes("not-a-profile"))
  }
  assert.equal(admission.trace.filter(entry => entry.operation === "environment-dispatch").length, writesBefore)
  gate("real native API rejection, deletion fence, moved child/stale connection/scope, and late revocation deny child model; identity-only authenticated route rejects environment bodies")
  return { matches, rejection }
}
