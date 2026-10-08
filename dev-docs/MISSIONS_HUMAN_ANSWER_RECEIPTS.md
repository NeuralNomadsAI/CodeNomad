# Native human-answer receipts (2026-10-08)

This is the bounded producer/consumer source tranche on assembly `25c5f03b`,
not live OpenCode, NSIS or installed-Mission qualification.

## Native source contract

OpenCode tag `v2.0.24`, `packages/core/src/form.ts`, exposes `get(id)`,
`state(id)` and `reply({ id, answer })` through `@opencode/Form`. Pending entries
do not expire; terminal entries expire after ten minutes. Replies have no native
human principal and Form events are not the durable session tool log.
`packages/core/src/tool/plugin/question.ts` produces indexed `qN` fields with
option descriptions and retains the original answer arrays in question metadata.
No upstream edit or invented API is needed for these reads.

The producer therefore captures the exact pending native Form, native question
call/input and answer **before** replying. It does not retrofit a principal onto
an arbitrary completed question after its Form cache has expired.

## Admission and state

- The dock captures the originating trusted submit-button **click** or submit
  **keydown**, bound to that exact request/schema and answer. A one-use local
  token is consumed at the SDK send boundary in the same input task. A trusted
  `SubmitEvent` alone is insufficient: Chromium's `element.click()` and
  `requestSubmit()` can produce one without human input. Explicit first-party
  developer automation is marked nonhuman; its ordinary native reply still works.
  Ordinary SDK, synthetic events, Auto/Yolo and permissions do not acquire proof.
- The normal owned-session proxy and deletion/request/connection fences remain
  in front of `replyMissionHumanAnswer`. Non-recurring/non-Mission/global Forms
  retain ordinary forwarding. The marker is stripped before ordinary forwarding.
- The real `AuthManager` cookie session, selected Settings profile and owned
  Location are verified through the existing authenticated root bridge. No new
  authentication store, user consent dialog, principal supplied by a model,
  additional gesture or generic browser RPC is introduced.
- Fixed `codenomad.missions.human-answer` methods are `binding`, `reply`,
  `reconcile` and `verify`. Native binding selects the actual ancestry, current
  signed ledger, passage/grant/epoch, namespace, physical Git root and native
  database identity. This is the same per-profile Ed25519 key used by simple Play:
  `authority-v2/recurrence-signer/<profile>`. Missing keys are never generated here.
- Passage selection does **not** require `Session.metadata.recurrence`: the
  actual creator records only mission ID/kind/role. It derives the exact child
  grant from the signed native ledger, bounded actual ancestry and the original
  synthetic lifecycle message plus its durable native inbox-enqueued event.
  A suspected passage with a missing/wrong ledger or source cannot silently
  ordinary-forward. The fixture calls the actual `admitNativeRecurrencePassage`
  producer and asserts its unmodified metadata rather than inventing a marker.
- A native IMMEDIATE transaction signs and stores `reserved` under a stable
  Form/passage identity before invoking native Form.reply. Another invocation
  with that identity can only reconcile, never reply again or change the answer.
- The backend reuses the existing admitted/uncertain creation-hold protocol for
  the original physical deletion permit. Preparation retains normal observer
  cancellation; **after dispatch** the actual native RPC is directly awaited
  without the HTTP observer's signal or `requestAdmission.wait` race. Disconnect
  cannot free a running answer. Lost ACKs park the original permit without expiry;
  exact positive receipt-only reconciliation may release it, never send again.
- Only a positive native reply return **and** matching actual native answered
  state can record `replied`. An unknown native return remains `reserved`, even
  when another call subsequently completes with identical text.
- The final native IMMEDIATE frame holds session/grant/epoch identity through
  Form.reply and witness publication. Native Form.reply has no SQLite writes.
  The proxy acknowledges a witnessed `replied` state without pretending that the
  asynchronous durable tool success is already available; only `reserved`/unknown
  retains a pending response. This does not turn reply ACK into consumption proof.
- Only the exact durable question success, matching input, answer metadata and
  native content can record `settled`. Neither HTTP ACK nor this question receipt
  proves that a later model consumed the answer or that the Mission finished.

The private cookie exists only in the transient private proof envelope; native
records retain its non-reversible digest and authenticated username, not the
cookie, bridge secret or private key. Cookie fields are covered by existing
recursive redaction. This is the same authenticated account principal boundary
as Play, not an independent physical-person/hardware attestation.

## Consumers and limits

`MissionControl`'s authenticated native report path calls the construction-owned
`humanGate`; completion rechecks current decision reports. The native Effect
entry passes the real gate through the Promise adapter explicitly (extra context
properties would be lost by that adapter). Native recurrence due/admission also
passes the gate to its separately owned passage control. The native verifier
checks the exact stored signature plus Form/session/message/question and actual
delegation parent/message/tool/child provenance. Model `approved` flags and prose
remain irrelevant; missing gates retain the old fail-closed behavior.

The stronger `verifyNativeDecisionEvidence` reader can use that gate rather than
the expired Form cache while still checking the full bounded durable log and its
native authority fence. Stored settled receipts remain readable after the backend
closes and passage archival; readout does not reacquire send privilege.

Bounds: 32 ancestry levels, 64 live schedule candidates, 512 native tool events
per actor, 256 retained receipts per project and 128/256 KiB native records.
Overflow refuses rather than deleting provenance or guessing. Long-lived projects
will need an explicit archive/read policy before relaxing the 256-receipt ceiling.
Unknown native outcomes are never TTL-expired or automatically replayed.

This tranche does not relax coordinator-authored readout into native task/report
authority. The ordinary non-passage one-shot producer remains unqualified unless
it uses the same current signed native passage/key contract. Parent assembly must
preserve the gate when composing its newer passage-owned controls.

## Offline checks

- Server and UI typechecks pass.
- Review corrections: **15/15** focused offline checks (eleven human receipt cases
  using the actual passage producer, including disconnect, parked lost-ACK
  reconciliation and missing lifecycle/ledger refusal, plus four hold regressions).
- Actual Chromium origin regression passes all five paths: DOM `click()`,
  `requestSubmit()` and marked automation reply ordinarily with no human marker;
  real pointer and keyboard input qualify. No claim of general anti-OS-automation
  or hardware/person attestation is made.
- Expanded server regression run: **153/154** before switching this producer to
  the existing fresh filesystem family fence; the sole failure was the shared
  conservative 3-second synchronous Git routing probe under load. No timeout was
  raised and no identity guard was bypassed. The existing fence still rereads
  physical/config/discovery inputs and retains that exact Git fallback when
  needed. The subsequent **15/15** focused correction run and both typechecks pass.
- Serial server run: **118/118** (seven real AuthManager/HTTP bridge/proxy,
  offline SQLite/native-shaped Form/Tool fixtures before review corrections, existing native observation,
  native report and proxy regressions).
- UI Form/pending-request regressions: **25/25**.
- One stressed concurrent server run returned conservative HTTP 409 in the human
  proxy fixture (**117/118**); the serial repeat passes. This is retained as an
  unresolved stressed-fixture/runtime-qualification observation, not hidden as
  successful live admission.

Run the bounded source checks with:

```powershell
node --import tsx --test --test-concurrency=1 packages/server/src/opencode/missions/native-human-answer.test.ts packages/server/src/missions/native-human-evidence.test.ts packages/server/src/missions/native-report-control.test.ts packages/server/src/server/__tests__/instance-proxy.test.ts
node --import tsx --test --test-concurrency=1 packages/server/src/opencode/missions/native-human-answer.test.ts packages/server/src/server/routes/mission-creation-holds.test.ts
npm run typecheck --workspace @neuralnomads/codenomad
npm run typecheck --workspace @codenomad/ui
node --import tsx --conditions=browser --test packages/ui/src/stores/forms.test.ts packages/ui/src/stores/instances-pending-requests.test.ts
cd packages/ui
node --import tsx --test --test-name-pattern="human answer origin" tests/browser/interruption-dock.test.ts
```

No private/live native fixture, OpenCode modification, shared-daemon mutation,
install, NSIS build, commit, push or write to another worktree was performed.
