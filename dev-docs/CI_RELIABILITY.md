# Native fixture and artifact workflow reliability

## Windows pruning/UI boundary

PR #825 recorded a Windows native/UI process exiting immediately after
`Playwright loaded; loading Vite`, without an exception or the failing fixture's
logs. Its first, non-UI phase had completed. A later run at the same SHA passed;
that does not establish a cause for the intermittent failure.

On Windows, the late-import path was reproduced locally with CI's Node 24.20.0
and an isolated official OpenCode 2.0.21 runtime. A new parent runner retained
native exit status **3221226356 / 0xC0000374 (heap corruption)** and the last
durable stage `ui-import-vite`. No JavaScript error/exit hook ran. This identifies
a native process failure, not the component which originally corrupted memory;
it does not prove that historical CI exits have the same cause.

The UI dependency loader now runs before the long native/SQLite preamble and
before starting the isolated server. It memoizes the same Playwright, Vite, Solid
and Fastify imports; it does not change the UI scenario, runtime or assertions.
This is an **import-order harness workaround**, not a claim that an underlying
Node/addon heap defect has been fixed. No dependency bump, test skip or retry is
introduced. Non-UI fixtures do not load the browser dependencies.

`scripts/run-session-pruning-native.mjs` runs the fixture in a separate Node
child, forwarding argv without a shell and retaining stdout, stderr, child stage
receipts and actual exit code/signal under `os.tmpdir()/opencode/`. A zero exit
without an explicit completion receipt is a failure, not a successful test.
The child synchronously snapshots its synthetic server log before imports and
cleanup boundaries. Monitoring uncaught errors does not handle or suppress them.
Failure-capture errors do not replace the primary UI scenario error.

CI uploads both parent run directories and isolated fixture logs on failure.
The parent can retain evidence even if native termination prevents JavaScript
`finally`/exit handlers from running. Platform/job termination can still kill the
parent; no guarantee of cleanup after an OS crash is implied. The runner has no
shared-service discovery or user-database operations.

## Artifact announcements

`Comment PR Artifacts` is triggered by completion of `PR Build Validation`, not
by a PR event plus bounded polling. Tests and builds can exceed the old nominal
30-minute polling budget without creating a spurious helper timeout.

A failed/cancelled validation stays red in the validation workflow; the artifact
helper is skipped rather than duplicating that failure. A successful run with no
active artifacts is not advertised. Real GitHub API/helper errors still fail.

This privileged workflow checks out **only the trusted default branch** with
credentials persistence disabled. It never checks out PR source, executes
artifact contents or interpolates their names as code. Its tested helper checks
the originating workflow/event, PR authorization and current head; runs with no
PR association use GitHub's commit association API and then the same checks.
Reruns update only the bot-owned marker comment. Markdown display names are escaped.

`workflow_run` uses the default-branch workflow, so event delivery is not validated
by a branch-local unit test or an older run passing. Actual GitHub delivery must
be observed after the workflow change reaches the default branch.

## Local checks

```powershell
node --test scripts/native-fixture-diagnostics.test.mjs .github/scripts/comment-pr-artifacts.test.cjs
node scripts/run-session-pruning-native.mjs C:/isolated-install/opencode.exe --ui
```

The unit suite covers normal completion, early zero/nonzero exits, original
exceptions, unsettled top-level await, failures before fixture creation, exact
space/Unicode/quote argv, stale/draft/unauthorized PRs, expired artifacts, bot-only
updates, display escaping and API failures. Full native/UI qualification uses a
private runtime/config/database and local synthetic provider, never the shared
OpenCode daemon or an installed desktop application.
