import assert from 'node:assert/strict'

export async function runCorrectionCases(h) {
  const { client, create, seed, control, inspect, value, ref, sub, task, plans, taskPlans, holds, until, release, wait, prompt, primary, messages, tools, events, sessions, baseline, record } = h
  const mission = (proof, id) => proof.snapshot.missions.find(mission => mission.id === id)
  const returnedRoot = await create('bound-error-continuation-root'), returnedMission = 'private_bound_error'
  await seed(returnedRoot, returnedMission, [task('error-task')])
  const faultCall = sub(ref(returnedMission, 'error-task'), { prompt: 'PRIVATE_BOUND_PROGRESS_FAILURE' })
  await prompt(returnedRoot, [faultCall])
  const failedProof = await inspect(), owner = value(failedProof, 'owner/' + returnedMission + '/error-task')
  assert(owner); sessions.add(owner.childID)
  assert.equal(tools(await messages(returnedRoot)).find(part => part.id === faultCall.id).state.status, 'error')
  assert.equal(mission(failedProof, returnedMission).tasks[0].nativeBinding.nativeReturned, undefined)
  const resumedCall = sub(ref(returnedMission, 'error-task'), { sessionID: owner.childID })
  taskPlans.set(returnedMission + '/error-task', [{ answer: 'EXPLICIT_SAME_TASK_NATIVE_RETURN_NO_REPORT' }])
  await prompt(returnedRoot, [resumedCall])
  assert.equal(tools(await messages(returnedRoot)).find(part => part.id === resumedCall.id).state.status, 'completed')
  assert.equal(events.filter(event => event.type === 'session.created' && event.data.parentID === returnedRoot).length, 1)
  const continuedProof = await inspect()
  assert(value(continuedProof, 'returned/' + returnedRoot + '/' + resumedCall.id).nativeReturned)
  assert(!value(continuedProof, 'report/' + returnedMission + '/error-task'))
  await control({ action: 'revise', change: { missionID: returnedMission, coordinatorID: returnedRoot, expectedRevision: 1, requestID: 'retire-after-explicit-return', reason: 'Retire after explicit successful continuation without a business report', retireTasks: [{ taskKey: 'error-task' }] } })
  const retiredProof = await inspect(), retired = mission(retiredProof, returnedMission).tasks[0]
  assert.equal(retired.status, 'withdrawn')
  assert.equal(retired.nativeBinding.nativeReturned, undefined, 'Failed original invocation must not be relabeled as successful return')
  if (!baseline) {
    assert.equal(retired.outstandingExecution, false)
    assert.equal(retired.nativeExecution.binding.toolCallID, resumedCall.id)
    assert.equal(retired.nativeExecution.ended, 'returned')
  } else assert.equal(retired.outstandingExecution, true, 'Retain actual R2 baseline mismatch')
  record({ failedProof, continuedProof, retiredProof })

  const busyRoot = await create('same-task-busy-root'), busyMission = 'private_same_busy'
  await seed(busyRoot, busyMission, [task('busy-task')])
  taskPlans.set(busyMission + '/busy-task', [{ hold: 'same-task-busy-original', answer: 'ORIGINAL_SAME_TASK_NATIVE_RETURN' }])
  plans.set(busyRoot, [{ answer: sub(ref(busyMission, 'busy-task')) }, { answer: 'ORIGINAL_BUSY_RESULT_CONSUMED' }])
  await client.session.prompt({ sessionID: busyRoot, text: 'Hold actual same-task child while another valid declared child requests its continuation' })
  await until(() => holds.has('same-task-busy-original'))
  const busyOwner = value(await inspect(), 'owner/' + busyMission + '/busy-task')
  sessions.add(busyOwner.childID)
  // OpenCode queues a second root prompt while the original call is active;
  // an independent child turn exercises actual native busy admission instead.
  release('same-task-busy-original'); await wait(busyRoot)
  plans.set(busyOwner.childID, [{ hold: 'same-task-independent-busy', answer: 'INDEPENDENT_NATIVE_TURN_FINISHED' }])
  await client.session.prompt({ sessionID: busyOwner.childID, text: 'Independent actual native turn holds the owned exact child busy' })
  await until(() => holds.has('same-task-independent-busy'))
  const busyCall = sub(ref(busyMission, 'busy-task'), { sessionID: busyOwner.childID })
  const beforeBusy = await inspect(), beforeRequests = primary(busyOwner.childID).length
  await prompt(busyRoot, [busyCall])
  assert.equal(tools(await messages(busyRoot)).find(part => part.id === busyCall.id).state.status, 'error')
  assert.equal(primary(busyOwner.childID).length, beforeRequests)
  const afterBusy = await inspect()
  assert.deepEqual(afterBusy.entries, beforeBusy.entries)
  assert.deepEqual(afterBusy.snapshot.missions, beforeBusy.snapshot.missions)
  release('same-task-independent-busy'); await wait(busyOwner.childID)
  if (!baseline) {
    const overlapping = [sub(ref(busyMission, 'busy-task'), { sessionID: busyOwner.childID }), sub(ref(busyMission, 'busy-task'), { sessionID: busyOwner.childID })]
    plans.set(busyOwner.childID, [{ hold: 'same-task-overlapping', answer: 'OVERLAPPING_SINGLE_NATIVE_RETURN' }])
    plans.set(busyRoot, [{ answer: overlapping }, { answer: 'OVERLAP_ERRORS_NATIVE_CONSUMED' }])
    await client.session.prompt({ sessionID: busyRoot, text: 'Two real exact-child continuation requests in one native model response' })
    // Native message.list publishes this assistant's full Tool parts only when
    // both calls settle. A private read-only observer records actual rejected
    // wrapper promises; it never invokes a Tool or mutates contract authority.
    await until(async () => holds.has('same-task-overlapping') && (await control({ action: 'toolFailures' })).failures.some(failure => overlapping.some(call => call.id === failure.callID)), 'Busy same-task continuation rejects while enclosing invocation remains held')
    const heldFailures = (await control({ action: 'toolFailures' })).failures.filter(failure => overlapping.some(call => call.id === failure.callID))
    assert.equal(heldFailures.length, 1)
    assert.match(heldFailures[0].error, /native call in flight/)
    record({ failedProof, continuedProof, retiredProof, heldFailures })
    release('same-task-overlapping'); await wait(busyRoot)
    const completedParts = tools(await messages(busyRoot))
    assert.equal(overlapping.filter(call => completedParts.find(part => part.id === call.id)?.state.status === 'completed').length, 1)
  }

  const capRoot = await create('native-actor-cap-root'), capMission = 'private_actor_cap'
  const capTasks = Array.from({ length: 9 }, (_, i) => task('cap-' + i))
  await seed(capRoot, capMission, capTasks)
  for (let i = 0; i < 6; i++) await prompt(capRoot, [sub(ref(capMission, 'cap-' + i))])
  const beforeCap = await inspect()
  assert.equal(mission(beforeCap, capMission).actors.length, 7)
  taskPlans.set(capMission + '/cap-6', [{ hold: 'cap-last-slot', answer: 'LAST_SLOT_NATIVE_RETURN' }])
  taskPlans.set(capMission + '/cap-7', [{ hold: 'cap-last-slot', answer: 'LAST_SLOT_NATIVE_RETURN' }])
  const capCalls = [sub(ref(capMission, 'cap-6')), sub(ref(capMission, 'cap-7'))]
  plans.set(capRoot, [{ answer: capCalls }, { answer: 'CAP_SIBLING_RESULTS_CONSUMED' }])
  await client.session.prompt({ sessionID: capRoot, text: 'Two real sibling calls compete for exactly one remaining Mission actor slot' })
  if (!baseline) {
    await until(() => holds.has('cap-last-slot'))
    release('cap-last-slot')
  }
  await wait(capRoot)
  const afterCap = await inspect(), capParts = tools(await messages(capRoot))
  record({ failedProof, continuedProof, retiredProof, beforeCap, afterCap })
  for (const event of events.filter(event => event.type === 'session.created' && event.data.parentID === capRoot)) sessions.add(event.data.sessionID)
  if (baseline) {
    assert(afterCap.snapshot.discardedEvents > 0)
    assert.equal(events.filter(event => event.type === 'session.created' && event.data.parentID === capRoot).length, 8)
    assert(value(afterCap, 'owner/' + capMission + '/cap-7'), 'Retain R1 ghost private owner baseline')
    return { baselineReproduced: { R1: true, R2: true }, failedProof, continuedProof, retiredProof, beforeCap, afterCap }
  }
  assert.equal(capCalls.filter(call => capParts.find(part => part.id === call.id)?.state.status === 'completed').length, 1)
  assert.equal(capCalls.filter(call => capParts.find(part => part.id === call.id)?.state.status === 'error').length, 1)
  assert.equal(afterCap.snapshot.discardedEvents, 0)
  assert.equal(mission(afterCap, capMission).actors.length, 8)
  assert.equal(events.filter(event => event.type === 'session.created' && event.data.parentID === capRoot).length, 7)
  assert.equal(['cap-6', 'cap-7'].filter(key => value(afterCap, 'owner/' + capMission + '/' + key)).length, 1)
  const beforeDenied = await inspect(), births = events.filter(event => event.type === 'session.created').length
  const denied = sub(ref(capMission, 'cap-8'))
  await prompt(capRoot, [denied])
  assert.equal(tools(await messages(capRoot)).find(part => part.id === denied.id).state.status, 'error')
  const afterDenied = await inspect()
  assert.deepEqual(afterDenied.entries, beforeDenied.entries)
  assert.deepEqual(afterDenied.snapshot.missions, beforeDenied.snapshot.missions)
  assert.equal(events.filter(event => event.type === 'session.created').length, births)
  const firstChild = value(afterDenied, 'owner/' + capMission + '/cap-0').childID
  const atCapContinuation = sub(ref(capMission, 'cap-0'), { sessionID: firstChild })
  await prompt(capRoot, [atCapContinuation])
  assert.equal(tools(await messages(capRoot)).find(part => part.id === atCapContinuation.id).state.status, 'completed', 'Existing native actor continuation remains allowed at capacity')
  return { failedProof, continuedProof, retiredProof, beforeBusy, afterBusy, busyCall: busyCall.id, beforeCap, afterCap, beforeDenied, afterDenied, gates: ['R1-no-ghost-child-at-cap', 'R1-last-slot-concurrent-reservation', 'R1-cap-refusal-zero-journal-private-effects', 'R1-existing-child-at-cap', 'R2-error-observed-without-false-return', 'R2-explicit-no-report-continuation-return', 'R2-retirement-current-invocation-not-original-return', 'same-task-native-busy-refusal'] }
}
