import assert from 'node:assert/strict'
import {test} from 'node:test'
import {correlateClock, observation} from './rune.mjs'
import {budgetReport} from './budget-report.mjs'

test('clock correlation intersects measured round-trip intervals and rejects incompatible clocks',()=>{
  const clock=correlateClock([{before:100,after:104,remote:12},{before:110,after:112,remote:21}])
  assert.equal(clock.offsetMs,-90)
  assert.equal(clock.uncertaintyMs,1)
  assert.equal(clock.minimumRoundTripMs,2)
  assert.deepEqual(observation({paintedFrames:1,shown:{MKAA010000K:20}},clock),{shown:{MKAA010000K:110}})
  assert.throws(()=>correlateClock([{before:100,after:102,remote:12},{before:110,after:112,remote:90}]),/incompatible/)
  assert.throws(()=>correlateClock([{before:100,after:99,remote:12}]),/Invalid/)
})
test('marker observations require a painted frame and actual protocol marker identity',()=>{
  const clock=correlateClock([{before:100,after:102,remote:12}])
  assert.throws(()=>observation({paintedFrames:0,shown:{MKAA010000K:20}},clock),/painted frames/)
  assert.throws(()=>observation({paintedFrames:1,shown:{bodyText:20}},clock),/Invalid Rune painted marker/)
  assert.throws(()=>observation({paintedFrames:1,shown:{MKAA010000K:NaN}},clock),/Invalid Rune painted marker/)
})
test('latency report reuses committed ceilings without fabricating Solid counters',()=>{
  const budgets={counters:{solid:{max:1}},latency:{8:{finalMarker:{max:1.15}}}}
  const {report,failures}=budgetReport(budgets,undefined,{8:{finalMarker:{cn:60,tui:50,ratio:1.2}}},{clientName:'Rune CPU buffer'})
  assert.equal(failures.length,1)
  assert.match(report,/Rune CPU buffer\/TUI \(50 ms floor\)/)
  assert.doesNotMatch(report,/solid|JavaScript calls/)
})
