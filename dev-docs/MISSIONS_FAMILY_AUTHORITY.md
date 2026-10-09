# Physical family authority claim

> PR scope (2026-10-09): host-lifetime, `packages/native-host-lifetime`, the durable host/plugin and their fixtures were moved out of this tree to the local branch `experiment/host-lifetime-foundation-20261009`; spikes and experiments are preserved on `preserve/missions-full-20261009`. References below are historical.

`packages/server/src/workspaces/family-authority-claim.ts` supplies a conservative
cross-process claim for the physical Git common directory. It is implemented and
unit-qualified. The unactivated canonical durable-host composition now consumes
explicit held claims before admission and rechecks exact roots after preparation;
it does not acquire claims on reads or provide native synchronous qualification.
**Startup and all family mutation backends do not participate yet.**

- Read identity only after `WorkspaceManager` directory authorization, through
  `readFamilyAuthorityIdentity`. Registered linked worktrees share one physical
  key. Git-free conversations cannot infer sibling/family authority here.
- Preprovision one private shared claim root outside profile/daemon state. Hash
  only the physical Git identity: another profile, channel or native database
  cannot justify a second owner of that same family.
- `FamilyAuthorityStore.acquire` creates an atomic exclusive directory, verifies
  native process start identity and private storage, then writes and fsyncs one
  immutable owner marker. Its random release capability stays in private storage,
  not model context or a native journal. Errors never expose native file contents.
- Same store references share one owned marker and retain it until the last
  reference releases. Admission callers must hold their reference and recheck
  `assertCurrent` after asynchronous preparation, immediately before effects.
- Release removes only the exact still-owned marker and an empty directory.
  Changed, unfamiliar, oversized, malformed or additional files refuse cleanup;
  the module never recursively deletes someone else's work.
- Crash, partial publication, failed privacy verification and an unknown/dead
  historical PID do not authorize takeover. Explicit offline repair or a future
  native crash-released lock remains required. Availability is deliberately
  sacrificed rather than creating split-brain.

## Integration gates

Every participating admission and family mutation backend must use the same
store. This module alone does not fence an old/nonparticipating backend, an
arbitrary native client, external Git or an already running tool process.
Protected root provisioning, execution-host/WSL mapping, managed old-writer
exclusion and connection/send/deletion-fence wiring remain open. Same-user/admin
replacement attacks and filesystem power-loss durability are not qualified.
Windows defaults require actual native owner/DACL/reparse verification; the unit
fixture's explicit leaf policy is **not** a production ACL bypass or qualification.

## Validation

`node --import tsx --test packages/server/src/workspaces/family-authority-claim.test.ts`

Six private tests pass: same-store reference retention, cross-profile/host conflict,
exact marker corruption refusal, unknown identity/privacy/partial-publication
failure, unfamiliar-file release refusal and retry, crashed private owner refusal,
and ordinary registered linked-worktree Git identity. No shared daemon, application,
user profile or existing directory ACL is changed.
