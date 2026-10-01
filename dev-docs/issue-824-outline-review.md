# Issue #824 — independent outline-reader review

Baseline reviewed: `366830f6`. Scope: the current `outline-index.ts` change,
its responsiveness regression test and profiler, and the related performance
claims. No product code was changed during this review.

## Verdict

Approved with no blocking finding. The patch addresses the demonstrated
event-loop starvation while preserving the outline protocol and its existing
correctness fences. The documentation correctly limits the result to improved
cooperation: it does not claim lower total CPU, a hard 8 ms deadline, or that
this defect alone explains issue #824.

## Correctness review

- `.all()` was replaced by iteration over the same header statement; the SQL,
  parameters, ordering and 512-row limit are unchanged. Projection likewise
  retains its existing SQL and response mapping.
- A direct baseline/current comparison produced byte-equivalent JSON results,
  including checkpoint digests, for an initial mixed outline, a persisted-known
  delta after delete/update/append, and an ownership/revert-bounded read.
- Existing navigation coverage still verifies the 16,384-entry page bound,
  cursor snapshot (`through`) behavior, deletion holes, tail checkpoint growth,
  pruning detection, tool metadata, ownership and staged-revert visibility.
- The read transaction still begins before ownership and bounds are read and is
  held across all cooperative yields, so a page observes one snapshot. An abort
  from either new loop rejects through `yieldTurn`; iterator cleanup is followed
  by the existing unconditional `ROLLBACK`. Both new tests observe
  `db.isTransaction === false` afterward.
- Each RPC obtains its own read-only `DatabaseSync` connection in
  `withHistoryDatabase`. Yielding with this transaction open therefore does not
  expose a shared connection to another RPC. It can retain a read snapshot for
  longer in wall-clock time, but work remains bounded and promptly cancellable.
- `EXPLAIN QUERY PLAN` for the header query, both with and without the revert
  `id < ?` predicate, uses
  `session_message_session_seq_idx (session_id=? AND seq>? AND seq<?)`. The
  patch does not change query plans or introduce a sort scan.

## Responsiveness evidence

The regression design is discriminating rather than timing-sensitive. Its real
SQLite view charges deterministic synthetic time whenever payload data is
accessed, while `setImmediate` supplies an actual pending cancellation.

- Current code: both header and projection cancellation cases passed.
- The same test copied outside the worktree with only `outline-index.ts`
  replaced by the exact `366830f6` source failed both cases: the header case
  consumed 896 expensive payload accesses before cancellation ran; the
  projection case consumed 384 after its 512 free header accesses.
- A smaller independent profile (`128` rows × `256 KiB`) observed current
  maximum turn gaps of `8/8/8 ms`, versus baseline `40/43/38 ms`. Total scan
  times were comparable (`43–45 ms` current, `39–43 ms` baseline), supporting
  the documented cooperation claim without implying throughput improvement.
- One SQLite iterator step remains synchronous. A single exceptionally costly
  row can exceed the 8 ms budget before JavaScript regains control; this
  limitation is explicitly documented in both code and investigation notes.

## Validation performed

```text
node --import tsx --test \
  packages/server/src/opencode/session-pruning/outline-responsiveness.test.ts \
  packages/server/src/opencode/session-pruning/navigation.test.ts
=> 11 passed, 0 failed

npm run typecheck --workspace @neuralnomads/codenomad
=> passed

git diff --check 366830f6 -- \
  packages/server/src/opencode/session-pruning/outline-index.ts
=> passed (only Git's existing LF/CRLF working-copy warning)
```

The coordinator's full isolated OpenCode 2.0.21 fixture result was not rerun in
this read-only review; the focused native-SQL and contract checks above are
independent of that reported qualification.

## Residual risk / next step

No adjustment is required for this patch. Retain the explicit limitation that
cooperative iteration cannot preempt one SQLite step. If real-session evidence
later shows individual JSON projection steps exceeding the acceptable latency,
the smallest follow-up is architectural (worker-thread/off-loop projection or a
less parse-intensive stored index), not a tighter JavaScript timer threshold.
