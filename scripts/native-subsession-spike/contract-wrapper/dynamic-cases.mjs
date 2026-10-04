import assert from 'node:assert/strict'

// These helpers drive real model -> native Tool -> plugin/journal execution.
// Only provider answers and deliberate provider holds are deterministic.
export async function runDynamicContractCases(h) {
  const { client, create, seed, control, inspect, value, ref, sub, report, task, plans, taskPlans, holds, until, release, wait, prompt, primary, messages, tools, events, sessions } = h
  const revise = change => control({ action: 'revise', change })
  const missionFrom = (proof, id) => proof.snapshot.missions.find(mission => mission.id === id)
  const beforeAfterRefusal = async change => {
    const before = await inspect()
    await assert.rejects(() => revise(change))
    const after = await inspect()
    assert.deepEqual(after.snapshot.missions, before.snapshot.missions)
    assert.deepEqual(after.entries, before.entries)
  }
  const execution = { agent: 'recursive_sub', model: { providerID: 'fixture', id: 'selected', variant: 'careful' } }
  const nativeChoice = { agent: execution.agent, model: 'fixture/selected#careful' }
  const root = await create('dynamic-native-contract-root'), missionID = 'private_dynamic'
  const investigate = { ...task('investigate'), role: 'business-research', execution }
  await seed(root, missionID, [investigate, task('obsolete'), task('waiting'), task('nested-obsolete'), task('foundation')])
  const badChoices = [sub(ref(missionID, 'investigate'), { model: nativeChoice.model }), sub(ref(missionID, 'investigate'), { agent: execution.agent, model: 'fixture/fixture' })]
  await prompt(root, [badChoices])
  let proof = await inspect()
  const choiceParts = tools(await messages(root))
  assert(badChoices.every(call => choiceParts.find(part => part.id === call.id)?.state.status === 'error'))
  assert(!value(proof, 'owner/' + missionID + '/investigate'))
  assert(!events.some(event => event.type === 'session.created' && event.data.parentID === root))

  taskPlans.set(missionID + '/foundation', [{ answer: report(ref(missionID, 'foundation')) }, { answer: 'FOUNDATION_NATIVE_FINAL' }])
  await prompt(root, [sub(ref(missionID, 'foundation'))])

  taskPlans.set(missionID + '/investigate', [{ hold: 'dynamic-investigate', answer: sub(ref(missionID, 'nested-new', 2), { agent: 'recursive_sub' }) }, { answer: report(ref(missionID, 'investigate')) }, { answer: 'DYNAMIC_INVESTIGATION_NATIVE_FINAL' }])
  taskPlans.set(missionID + '/nested-new', [{ answer: report(ref(missionID, 'nested-new', 2)) }, { answer: 'NEW_GENERATION_NESTED_NATIVE_FINAL' }])
  plans.set(root, [{ answer: sub(ref(missionID, 'investigate'), nativeChoice) }, { answer: 'INVESTIGATION_RESULT_CONSUMED' }])
  await client.session.prompt({ sessionID: root, text: 'Start exact selected native agent/model/variant with a distinct business role' })
  await until(() => holds.has('dynamic-investigate'))
  proof = await inspect()
  const oldOwner = value(proof, 'owner/' + missionID + '/investigate'), childID = oldOwner.childID
  sessions.add(childID)
  assert.equal(primary(childID)[0].actual.agent, execution.agent)
  assert.deepEqual(primary(childID)[0].actual.model, execution.model)
  const boundTask = missionFrom(proof, missionID).tasks.find(task => task.key === 'investigate')
  assert.equal(boundTask.actorSessionId, childID)
  assert.equal(boundTask.admissionId, undefined, 'Parent assistant message must not masquerade as child inbox ACK')
  assert.equal(boundTask.delivery, undefined)
  assert.equal(boundTask.nativeBinding.parentMessageID, oldOwner.messageID)
  assert.equal(boundTask.nativeBinding.toolCallID, oldOwner.callID)
  assert.equal(boundTask.nativeBinding.generation, 1)
  assert.equal(boundTask.nativeBinding.nativeReturned, undefined)

  const implement = { ...task('implement', null, ['investigate']), execution, reuseFromTaskKey: 'investigate', replacesTaskKey: 'obsolete' }
  const nested = { ...task('nested-new', 'investigate'), replacesTaskKey: 'nested-obsolete' }
  const change = { missionID, coordinatorID: root, requestID: 'dynamic-replace-1', expectedRevision: 1, reason: 'Replace unused tasks while independent investigation runs', retireTasks: [{ taskKey: 'obsolete', replacementTaskKey: 'implement' }, { taskKey: 'nested-obsolete', replacementTaskKey: 'nested-new' }], addTasks: [implement, nested], dependencyUpdates: [{ taskKey: 'waiting', blockedBy: ['investigate'] }] }
  const changed = await revise(change), afterChange = await inspect()
  assert.deepEqual(await revise(change), changed, 'Exact revision request retry returns original receipt')
  const afterRetry = await inspect()
  assert.deepEqual(afterRetry.entries, afterChange.entries)
  assert.deepEqual(afterRetry.snapshot.missions, afterChange.snapshot.missions)
  await revise({ missionID, coordinatorID: root, requestID: 'nested-generation-2', expectedRevision: 2, reason: 'Update only the unassigned nested task contract', dependencyUpdates: [{ taskKey: 'nested-new', blockedBy: ['foundation'] }] })
  const foreign = await create('foreign-dynamic-contract-root')
  await beforeAfterRefusal({ missionID, coordinatorID: foreign, requestID: 'foreign-change', expectedRevision: 3, reason: 'Foreign coordinator cannot revise a valid unassigned task', dependencyUpdates: [{ taskKey: 'waiting', blockedBy: [] }] })
  await beforeAfterRefusal({ ...change, reason: 'Conflicting request identity' })
  await beforeAfterRefusal({ missionID, coordinatorID: root, requestID: 'dependency-cycle', expectedRevision: 3, reason: 'Invalid self dependency', dependencyUpdates: [{ taskKey: 'waiting', blockedBy: ['waiting'] }] })
  release('dynamic-investigate'); await wait(root)
  proof = await inspect()
  const investigationReport = value(proof, 'report/' + missionID + '/investigate')
  assert.equal(investigationReport.outcome, 'completed')
  assert.equal(investigationReport.contract.revision, 1, 'Unrelated plan/journal revisions do not revoke this admitted task')
  assert.equal(primary(childID).length, 3)
  const nestedOwner = value(proof, 'owner/' + missionID + '/nested-new')
  sessions.add(nestedOwner.childID)
  assert.equal(nestedOwner.parentID, childID)
  assert.equal(nestedOwner.revision, 2, 'New child generation need not equal its unaffected parent generation')
  assert.equal(missionFrom(proof, missionID).tasks.find(task => task.key === 'investigate').nativeBinding.nativeReturned, true)
  assert.equal(missionFrom(proof, missionID).tasks.find(task => task.key === 'implement').status, 'ready')

  const stale = [sub(ref(missionID, 'obsolete')), sub(ref(missionID, 'waiting'))]
  if (!h.baseline) stale.push(sub(ref(missionID, 'implement'), nativeChoice))
  const births = events.filter(event => event.type === 'session.created').length
  await prompt(root, [stale])
  const staleParts = tools(await messages(root))
  assert(stale.every(call => staleParts.find(part => part.id === call.id)?.state.status === 'error'))
  assert.equal(events.filter(event => event.type === 'session.created').length, births)

  plans.set(childID, [{ hold: 'dynamic-external-busy', answer: 'EXTERNAL_BUSY_NATIVE_FINAL' }])
  await client.session.prompt({ sessionID: childID, text: 'Actual independent native turn holds this existing child busy' })
  await until(() => holds.has('dynamic-external-busy'))
  const busyCall = sub(ref(missionID, 'implement'), { ...nativeChoice, sessionID: childID })
  const busyBefore = await inspect(), busyRequests = primary(childID).length
  await prompt(root, [busyCall])
  const busyPart = tools(await messages(root)).find(part => part.id === busyCall.id)
  assert.equal(busyPart.state.status, 'error')
  assert.equal(primary(childID).length, busyRequests, 'Busy rejection cannot send or switch the child')
  const busyAfter = await inspect()
  assert.deepEqual(busyAfter.snapshot.missions, busyBefore.snapshot.missions)
  assert.deepEqual(busyAfter.entries, busyBefore.entries)
  release('dynamic-external-busy'); await wait(childID)

  taskPlans.set(missionID + '/implement', [{ answer: report(ref(missionID, 'investigate')) }, { answer: report(ref(missionID, 'implement')) }, { answer: 'DYNAMIC_IMPLEMENTATION_NATIVE_FINAL' }])
  const reuse = sub(ref(missionID, 'implement'), { ...nativeChoice, sessionID: childID })
  const reuseStart = primary(childID).length
  await prompt(root, [reuse, 'IMPLEMENTATION_RESULT_CONSUMED'])
  proof = await inspect()
  const newOwner = value(proof, 'owner/' + missionID + '/implement')
  assert.equal(newOwner.childID, childID)
  assert.equal(events.filter(event => event.type === 'session.created').length, births)
  assert.deepEqual(value(proof, 'report/' + missionID + '/investigate'), investigationReport, 'Old task report remains immutable')
  const firstImplementation = primary(childID)[reuseStart]
  assert.equal(firstImplementation.binding.taskKey, 'implement')
  assert.equal(firstImplementation.binding.revision, 1, 'New task generation is independent of plan document revision')
  assert.deepEqual(firstImplementation.actual, { agent: execution.agent, model: execution.model })
  assert.equal(firstImplementation.task.task.reuseFromTaskKey, 'investigate')
  const reports = missionFrom(proof, missionID).reports
  assert.equal(reports.filter(report => report.taskKey === 'investigate').length, 1)
  assert.equal(reports.filter(report => report.taskKey === 'implement').length, 1)
  assert(reports.every(report => report.notificationStatus === 'pending'), 'Native result references are not forged coordinator notification receipts')
  assert(primary(root).some(request => JSON.stringify(request.body.messages).includes('DYNAMIC_IMPLEMENTATION_NATIVE_FINAL')))

  const retireRoot = await create('retire-in-flight-native-root'), retireMission = 'private_retired'
  await seed(retireRoot, retireMission, [task('inflight')])
  taskPlans.set(retireMission + '/inflight', [{ hold: 'retire-in-flight', answer: report(ref(retireMission, 'inflight')) }, { answer: 'MUST_NOT_REACH_REVOKED_PROVIDER' }])
  plans.set(retireRoot, [{ answer: sub(ref(retireMission, 'inflight')) }, { answer: 'RETIREMENT_NATIVE_RESULT_OBSERVED' }])
  await client.session.prompt({ sessionID: retireRoot, text: 'Retire work with one actual native provider request in flight' })
  await until(() => holds.has('retire-in-flight'))
  const retirementBefore = await inspect(), retiringOwner = value(retirementBefore, 'owner/' + retireMission + '/inflight')
  sessions.add(retiringOwner.childID)
  await revise({ missionID: retireMission, coordinatorID: retireRoot, requestID: 'retire-native-1', expectedRevision: 1, reason: 'Withdraw admitted task without replaying it', retireTasks: [{ taskKey: 'inflight', replacementTaskKey: 'replacement' }], addTasks: [{ ...task('replacement'), replacesTaskKey: 'inflight' }] })
  const withdrawn = missionFrom(await inspect(), retireMission).tasks.find(task => task.key === 'inflight')
  assert.equal(withdrawn.status, 'withdrawn')
  assert.equal(withdrawn.outstandingExecution, true)
  release('retire-in-flight'); await wait(retireRoot)
  const retirementAfter = await inspect(), retiredMap = missionFrom(retirementAfter, retireMission)
  const late = retiredMap.tasks.find(task => task.key === 'inflight')
  assert.equal(late.status, 'withdrawn')
  assert.equal(late.report, undefined)
  assert.equal(late.lateReports.length, 1)
  assert.equal(late.lateReports[0].late, true)
  assert.equal(late.outstandingExecution, false)
  assert.equal(retiredMap.tasks.find(task => task.key === 'replacement').status, 'ready')
  assert.equal(primary(retiringOwner.childID).length, 1, 'Revoked task cannot issue the next provider request')
  assert(!value(retirementAfter, 'owner/' + retireMission + '/replacement'))
  assert.equal(retirementAfter.snapshot.discardedEvents, 0)
  return { missionID, rootID: root, childID, changed, actualExecution: firstImplementation.actual, investigationReport, implementReport: value(proof, 'report/' + missionID + '/implement'), nativeBinding: boundTask.nativeBinding, nestedOwner, busyRejectedCall: busyCall.id, reuseCall: reuse.id, retirement: { before: retirementBefore, after: retirementAfter, childID: retiringOwner.childID }, gates: ['native-choice-mismatch-before-birth', 'actual-agent-model-variant', 'business-role-independent', 'truthful-binding-not-inbox-ACK', 'unrelated-revision-retains-task-generation', 'different-parent-child-generations', 'coordinator-only-change', 'immutable-exact-retry', 'stale-generation-refusal', 'busy-child-no-send-or-switch', 'authorized-exact-child-cross-task-reuse', 'old-report-preserved', 'retired-late-report-no-replacement-completion', 'revoked-provider-fenced'] }
}
