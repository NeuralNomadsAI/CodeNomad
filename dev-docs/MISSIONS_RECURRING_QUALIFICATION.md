# Native schedules — qualification fixtures

The fixtures below qualify the contract of [`MISSIONS_RECURRING.md`](MISSIONS_RECURRING.md)
against a real isolated OpenCode service and the shipped Missions bundle.

## Unified native schedules

Unified documents use the protocols in
[schedule transport](MISSIONS_NATIVE_SCHEDULE_TRANSPORT.md#native-document-composition-and-packaging), with
their [consumed native contracts](MISSIONS_NATIVE_CONTRACTS.md#schedule-integration-qualification).
Run only against owned isolated runtimes and fresh scratch directories:

```sh
node --import tsx scripts/test-native-mission-schedule-product.mjs <absolute-cli> <fresh-scratch> --parent-ready --kinds=at,in
node --import tsx scripts/test-native-mission-schedule-product.mjs <absolute-cli> <fresh-scratch> --parent-ready --kinds=paused-manual --controlled-settlement --existing-coordinator
node scripts/test-missions-terminal-native.mjs <absolute-isolated-cli>
```

The product fixture's `--parent-ready` requires the coordinator's explicit final-ready
handoff. Its `--kinds=every --natural-every` exercises the real minimum 15-minute
interval. The fixture checks Code Mode rows and runtime-only installation.
Product checks cover authenticated paused creation, activation/control receipts,
backend closure and managed-service restart. Terminal checks require original-input
correlation and whole-family/background-delivery quiescence before settlement.
The paused manual case with an existing coordinator verifies agent-authored
self-selection, one original input per passage, and two archives in the same conversation.
Desktop packaging and host-login gates require their own evidence.
After a cold-first-admission failure, a disposable ten-second worker records timestamped HTTP status/PID and the expected version only after exact PID/version correlation, shared-incarnation log sizes/truncation within a 256 KiB read budget and targeted read-only SQL within 512 KiB. Both cold and authenticated current-incarnation SQL exports use an explicit metadata projection: numeric counters/timestamps, booleans, finite schema states, SHA-256 opaque identifiers and text digests, schedule-proof identity correlation and overflow/omission markers. Hashes cover complete bounded values before any truncation; oversized SQL values are omitted with retained size evidence where collected. Configuration, objectives, message bodies, nested metadata, database keys, maintenance event text, logs and errors are omitted; maintenance retains its count. Diagnostic, receipt and cleanup failures preserve the original qualification error and failed verdict; a receipt write failure also fails an otherwise successful qualification. The entrypoint emits a fixed safe failure category.

UI qualification uses the real Solid/HTTP fixtures under
`packages/ui/tests/browser/` with `npm run test:browser --workspace @codenomad/ui`:
verify Create/Edit H9 locks, explicit activation, uncertain original receipts,
pagination, diagnostics and carrier links across locales.
Read-only native capture replay uses
`npm run qualify:browser:native-mission-replay --workspace @codenomad/ui` with the
captured run's `NATIVE_MISSION_CAPTURE` and its own `NATIVE_MISSION_OUTPUT`.
Record results and unexecuted platform gates in delivery evidence.

## Coverage elsewhere

Paths below are under `packages/server/src/` unless stated.

- The 4,096-session family ceiling and above-ceiling coverage:
  `opencode/missions/native-recurrence-family-bound.test.ts`.
- One-time Wayfinder decisions: `scripts/test-missions-native-trajectory.mjs`
  (`MISSIONS.md` §Validation).
- `scripts/test-missions-terminal-native.mjs` qualifies the production terminal
  reader on an isolated runtime: old inactive claim through repeated observations,
  native resume under the original input, seq-correlated idle, unrelated old
  failures and an outstanding native background-child delivery.
