# Watched-conversation passage inputs (offline implementation)

> Superseded for recurring missions by [MISSIONS_RECURRING_SIMPLE.md](MISSIONS_RECURRING_SIMPLE.md) (2026-10-08). Historical content is retained; unrelated one-time receipts remain in scope.

PR #866's daily-review source cursor use case now uses the actual acquired native
`Session.messages`/`Session.message` methods from `native-service-adapter.ts`.
No native service, database fixture, installed product, or live Mission was used
to validate this change. Full NSIS remains the prerequisite for private native
qualification; these offline checks do not claim native product acceptance.

## Admission and authority

- `recurrenceReadBudget(count, budgets)` is the shared UI/native preflight: fixed
  create/start/message requires three effects, plus exactly one read per watch.
  Inbox minimum is one message per watch. Each watch reserves
  `min(32, floor(inboxMessages / count))` messages; unused remainder is not borrowed.
  No human ceiling is enlarged. Admission rejects insufficient budgets before
  reserving a child, creating a root, or reading a source.
- `recurrenceInputBudget(config)` computes worst-case **whole** input capacity
  (exact signed root strings, watch IDs, bounded future cursor/workspace IDs and
  bounded exact-reference room per watch). CREATE/UI must use its
  `instructionsMaximum`/`sufficient`, not just a base consigne ceiling. Native
  signed authorization rejects oversized inputs; the runner returns an explicit
  `rejected-before-effect` preflight status without reserving a pending passage,
  calling authority/native admission, or advancing calendar/history. It is not a
  fabricated archived passage or an automatic consigne rewrite. Template/recipe
  instructions remain in the existing native business hook, not this message.
- Only configured exact IDs are resolved through native `get`, with the signed
  same-project/allowed-root check and an exact directory/workspace placement
  check. There is no session list, ancestry discovery, prefix authority, HTTP
  fallback, credentials lookup, or full-history read.
- The durable `inbox-read` reservation records directory, optional workspace,
  original cursor, batch limit and remaining source-context limit before native anchor/message access. The
  messages request uses ascending order and an exclusive `next` ID cursor. A
  missing anchor cannot masquerade as an empty page. A full batch is a bounded
  prefix, not a claim to have consumed every reply; the next passage starts after
  its final processed ID.
- Receipt evidence hashes the original effect and exact native returned message
  IDs/types/plain text. Only user/synthetic text and assistant text parts project;
  files/images, tools, skills, reasoning, provider state and credential metadata
  do not. A Location switch, missing/moved source, unreadable native record or
  lost receipt ACK leaves the original passage pending. No reservation is replayed.
- There is **no 1-KiB source-text ceiling**. `recurrenceSourceContextLimit` gives
  complete stable replies the remaining deterministic 16,384-character whole-input
  allowance after the unchanged consigne and worst-case reference envelope.
  Both the actual admission and signed effect validator consume this helper.
  Quiet earlier sources release unused text space for later watches; signed
  effect/message ceilings do not grow. Complete 2–8-KiB replies are included
  verbatim when they fit. Source descriptors retain a 48-KiB byte bound and receipts
  a 64-KiB byte bound, independently of the whole-input character bound.
- Reserve 1 KiB of **reference headroom**, not a text cap, for each remaining watch
  and the next possible oversized reply. A genuinely oversized stable reply is
  represented by its exact source/message ID, native digest/completion timestamp
  and `needsDecision: "source-input-capacity"`, with no copied/shortened text.
  This bounded reference enters the ordinary coordinator input and truthful read
  receipt; it is not a fabricated native Form, publication or processed-message
  claim. Its cursor is never consumed, even if the finite passage archives.
  Whole-input configurations unable to reserve even reference space fail before
  any passage/read/root reservation. No alternate reader/workflow API is added.
- The exact original native anchor is read again after the asynchronous bounded
  query, compared using its full encoded native message bytes, and its current
  project/Location checked again. Revert/deletion cannot turn a missing cursor's
  empty result into an applied read receipt. Deleted/rewritten/moved anchors park
  the same reservation without cursor advance or query retry.
- A busy watched source is not required to become idle. Incomplete assistant,
  Shell or compaction messages stop the readable prefix: neither that ID nor any
  later ID becomes processed. Complete messages require an exact native point
  read with unchanged encoded bytes; changed bytes defer that ID and later IDs.
  Receipts retain only stable prefix IDs/text, their native message digest, and
  the native assistant completion timestamp. An empty stable prefix is an applied
  bounded read with no cursor update, not a claim that the source had no activity.
  The final reply under the same ID is read next passage, and its cursor advances
  only after that passage archives. No full transcript, native active-state or
  broad session read is used. A point-read deletion remains unknown, never nochange.
- `recurrenceInput(child)` is shared by admission, actual invocation validation
  and settlement. It preserves the signed consigne verbatim and appends bounded
  canonical quoted reference data, never altering source/model prose.
- Publication stays disabled. No `publish` effect or publication receipt is
  fabricated, and non-disabled policies remain pending/blocked.

## Settlement and integration handoff

Native settlement now accepts the three exact fixed applied effects plus one
acknowledged bounded read for each watch. It validates the admitted input and
source placement again at archive commit. Read ACKs alone never advance cursors.
`recurrenceSourceCursors(archive)` extracts them only from a positively completed
archive. Calendar finish persists the message ID **and exact source Location digest**
(directory + optional workspace, keeping the original bounded cursor headroom);
removed sources keep those cursors and receive no future read. Readding a moved
source fails closed rather than resetting its high-water.

A positively qualified **failed/stopped** archive retires the old passage and its
charged read effects but returns no processed source cursors. The shared calendar
finish path independently refuses to advance cursors for those outcomes, even if
a caller supplies read-ID cursor claims. Source read, ENV and admission ACKs do
not imply provider/model consumption or handled work. Archive-only recovery can
finish already committed failed/stopped archives without replaying effects; this
does not broaden the native terminal observer's supported failure evidence.
The offline provider-no-route-before-model stand-in proves that read replies remain
available from the old cursor in the next completed passage, with immutable charged
read receipts in the failed archive. Oversized `needsDecision` references remain
unprocessed even on completed passage archival.

The independently owned `missions-due-composition-20261008` worktree was consulted
read-only. Its due reconcile must remove the blanket zero-watch rejection, keep
the disabled-publication guard, feed `recurrenceSourceCursors(archive)` into
calendar finish (only for completed archive), and recheck archived source
placement inside its finish fence via `recurrenceSources(archive.child)` and
`provider.assertSourcePlacement`. This worktree deliberately does not edit that
composition. CREATE/UI join should import `recurrenceReadBudget` for validation
and dynamic minimum feedback plus `recurrenceInputBudget` for whole-input room,
never silently increase the selected ceilings or shorten the standing consigne.

Independent-review P2 handoff: the due owner must call the executable shared
`assertRecurrenceDispatchFeasible(parent.config, parent.budgets)` in authenticated
dispatch `authorize`, before calendar reservation, and repeat it against the fresh
`latest.parent.body` in that authorizer's final synchronous fence. Do not call it
for settlement. The sources branch retains the root-level check and has an
offline signed-budget/preparation-race check proving the original calendar
high-water and `pending=null` survive refusal. The separate due worktree remains
read-only here; until its owner wires both calls, root-level budget refusal alone
does **not** prove the actual due path avoids a pending no-effect passage.

Offline checks: real-shaped acquired native adapter, signed-authority two-passage
admission/settlement, next-day cursor progression, moved source, removed/readded
watch, zero-inbox/default-three-effect budgets, unknown read receipt ACK and no
replay, post-query anchor deletion/rewrite, changed completion bytes, and a partial
assistant followed by final same-ID output in the next passage exactly once.
Full-text 2/4/8-KiB admission checks and oversized needsDecision archival preserve
the prior source cursor without trimming output. The checks use only isolated
temporary Git folders and in-memory native graph/storage stand-ins.
Failure-after-read-before-model and stopped-outcome checks retain old cursors,
charge the original effects, deny replay, and permit next-day completed processing.
