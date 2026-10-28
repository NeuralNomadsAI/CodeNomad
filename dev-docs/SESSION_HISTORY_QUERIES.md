# Full-history queries and technical cleanup

## Entry points

The non-modal transcript search window (Ctrl/Cmd+F or the header toggle) can
query the entire session or workspace. Conversation scope uses a literal phrase
and chronological result pages. Workspace scope sends one debounced ranked request
and displays up to 40 results in returned order, with all query terms highlighted.
Opening a ranked result in its conversation carries those term highlights to the
destination transcript. The command palette's
remove-tools-and-reasoning command plans against the same stored history. Navigation:
[SESSION_HISTORY_NAVIGATION.md](SESSION_HISTORY_NAVIGATION.md).

Both paths use the bundled `codenomad-session-pruning` plugin's authenticated RPC,
with fixed CodeNomad routes:

- `POST /api/workspaces/:id/session-history/query` → `history`
- `POST /api/workspaces/:id/session-history/ranked` → version-1 `historyRanked`
- `POST /api/workspaces/:id/session-history/prune` → `pruneBatch`

Never expose generic RPC, caller-supplied SQL, a database filename, replacement
content or a caller-selected directory. The normal daemon and plugin provisioning
lifecycle governs the plugin. The plugin performs a fresh `ctx.storage` challenge
to bind a read-only SQLite connection to this daemon; that challenge writes only
temporary plugin KV state.

Agents use the same bundle's `codenomad.session_search` Code Mode tool to find
past discussions. Native tool permissions govern execution. Backend presence
owns both the tool and RPC registrations.

## Scope and resource limits

Session queries validate the session's current full native location and project.
Workspace queries enumerate the validated local worktree inventory, preserving
execution-host paths, and scan directory descendants without duplicate nested
worktree scans. A directory boundary and native workspace identity are always
required. Workspace scans include the current native project and migrated
`global` history in that directory tree, excluding other projects/independent
clones. Session-specific queries retain the session's actual project identity.
Each native page carries broker-only per-session location/count provenance. Before
publishing counts or excerpts the broker validates every contributing location
against the local repository/worktree ownership rules, including independent
clones that share a native project ID. This provenance is stripped from HTTP output.

Content counts and pruning pages examine at most 32 rows. Search and message-only
counts examine up to 1024 rows, stopping at 32 matching messages or 32 contributing
sessions. All scans yield to the native event loop between rows and end the page
after roughly 40 ms of processing; a running SQLite statement or JSON parse
finishes first. JSON is materialized one message at a time, limited to 16 MiB.
Oversized or unsupported content is counted as skipped and reported to the UI.
Never add an index, trigger, FTS table or persistent transcript copy.

Cursors bind scope and query; the broker also binds the authorized directory
inventory. A rowid horizon excludes new rows appended during each location scan.
The search window never starts a separate statistics traversal, and an empty
query scans nothing. Its progress (visible results and messages scanned for the
current page) updates as batches arrive and resets on pagination or a new search.
The technical-content switch changes only the search, never triggering a
tools/reasoning count.
The separate stats RPC serves explicit callers; message-only stats read metadata
without decoding JSON. A traversal spans many reads: concurrent
edits/deletes/moves can affect later pages, and different locations start at
different times.

Conversation search is literal and case-insensitive, with one matching excerpt per message
(up to 320 characters), in stored row order. It searches text, reasoning, tool
names/arguments/text output/errors and readable native user/system/synthetic/
skill/shell/compaction text, skipping attachments and opaque continuation state.
With the technical-content switch off, SQLite reads/parses the stored JSON
but projects only readable text into JavaScript, retaining original part positions.
For conversation scope the UI combines scan batches until it has at least 32 results or reaches the end,
displaying partial results as they arrive. It retains one bounded result page
(at most 63 hits, to retain the final transport batch without losing its cursor).
The next-results action advances by result page, independently of scanned rows.
Ownership checks are shared by identical locations only within each broker request
and revalidated on subsequent requests. Closing the window,
changing query/scope or leaving the session cancels obsolete UI work. Resident matches scroll to their existing row without a network read.

Ranked workspace results retain rank order, with only consecutive hits sharing a
session header. Each header names its
conversation and the worktree (label, normally its branch) that currently holds
the session's native location; never label hits with a commit (messages have
none). Titles and locations come from the session store, or from one
`session.get` per distinct unloaded session (older catalog pages, collapsed
subsessions), at most four in flight. These display reads never add sessions
to the list. Queued reads follow the visible results: a new query or page drops
sessions it no longer shows, session scope and closing abort them, and a
reconnect discards resolved labels. Only a not-found session is labelled
unavailable; other read failures retry on the next result update. The
preview's "Open in session" hydrates only that session and its parents, stores
the hit as its transcript anchor, selects it and returns its central surface to
chat, so the destination restores the bounded window around the message
through its normal anchor path.

### Workspace ranked broker and UI

The ranked route uses the authenticated shared connection and its current-client
fence. It enumerates validated execution-host worktree directories, deduplicates
nested roots and checks every contributing native location through the same
request-local ownership helper as literal history. Deletion snapshots include
service paths and resolved worktree identities, including WSL identities; root,
connection, deletion and request-cancellation checks fence asynchronous reads.
Before publication every contributing location is revalidated and all displayed
counts are reconstructed from owned provenance. Native titles, locations, session
provenance and technical cap sources stay inside the broker.

Each disjoint authorized root supplies up to 40 native ranked hits. The broker
interleaves local rank ordinals in stable directory order, takes each session's
first hit, then fills repeats by that order. A request covers at most 32 disjoint
roots under one 15-second deadline; omitted roots set the capped notice. The UI
shows one bounded list with best-result progress and compact cap/exclusion notes.
**Search further back** replaces it with the next older window's best 40 results.
Each location examines at most 16,384 more owned messages, retaining the first
request's newest rowid horizon. Windows have independent IDF weights and rank;
the UI displays only the current window rather than comparing scores across windows.
The note names the most recent examined count on the first window and examined
message ordinals on later windows. Across locations these ordinals count the sum
of owned messages examined so far, with newest-first traversal within each location.
Query, scope and technical-toggle changes, close and session deactivation reset
continuations and cancel obsolete reads. Conversation scope retains its literal pages.
An expired continuation or changed horizon produces `status: "restart_required"`.
The UI discards that cursor, explains the expired window and offers **Start fresh
search**, an explicit return to the newest window with the same query/options.
Backend cursor rejection, native issuer-key expiration, plugin re-registration and
unavailable ranked capability during continuation share this recovery. Ordinary
transport/read failures retain **Retry** and the current cursor.
Ranked preview blocks use the shared
excerpt renderer and native query terms, preserving their original text while
highlighting the same Unicode terms as excerpts and the destination transcript.
Preview and Open in session retain their bounded reads and navigation fences;
ranked destination highlights are
ephemeral and exact-instance/session-owned, cleared on close or leaving that view.

The first actual RPC response negotiates ranked capability for its authenticated
connection. A declared `rpc.method_not_found` yields `status: "unsupported"`,
retained for that connection; a replacement connection negotiates afresh. The
window explicitly explains this state and leaves conversation scope available.
Other failures use the shared blocked/error handling. Never fall back from ranked
workspace search to literal traversal or expose a generic RPC proxy.

## Ranked agent search

`codenomad.session_search({ query, since?, until?, limit?, includeTechnical? })`
searches the calling session's Location directory tree, native workspace identity,
and current project plus `global` history. The calling session's exact Location
and project are checked before and after the read. Scope comes from the plugin's
native Location. The read-only connection uses the fresh storage binding above.
Before collecting candidates, the plugin checks each contributing directory's
physical Git common directory against that Location. The shared filesystem-only
`checkout-identity.ts` reader follows administrative files, linked worktrees and
plain subfolders. Independent nested clones are excluded, including `global`
history. Missing, unreadable, ambiguous and environment-overridden identities fail
closed. A verified non-Git Location owns its physical root and plain descendants
whose bounded discovery reaches that root without finding a checkout or bare/separate
Git directory. This includes temporary and directory-only projects. Physical path,
device/inode and discovery identity bind the root across final revalidation;
unrelated folders and nested repositories stay excluded.
Request-local directory checks are bounded to 600 directories and 128
ancestor levels, with yielding and cancellation. The 128-level bound belongs to
plugin discovery; workspace filesystem discovery keeps its full ancestor walk.
Fresh ownership passes bracket body judging, independently of its time budget.
An uncached root/common-directory fence follows the final directory pass immediately
before publication. Both physical directories' device/inode identities are bound;
any observed root replacement invalidates the request. These checks filter returned
titles, hits, provenance and counts. `exclusions` reports
`foreign_directory`/`unknown_directory` reasons without rejected directory details.

Queries contain literal Unicode letter/number/underscore words of at least two
characters. The six longest distinct case-insensitive terms drive the search.
Tokens retain their original spelling and deduplicate by `/iu` equivalence, keeping
dotted-capital-I exact self-matches intact.
JavaScript judges complete Unicode words, including accented French text. Optional
`since`/`until` are real `YYYY-MM-DD` UTC dates with inclusive day bounds. `limit`
defaults to 10 and accepts 1–20. Readable text is the default;
`includeTechnical: true` also examines the shared history tool/reasoning projection.

The scan starts at a captured global rowid horizon and walks stored messages
newest first. Appends after the horizon are excluded. At most 16,384 owned messages
form its deterministic recent window; unusually expensive work can still end it
early under the time budget. Repeated idle searches therefore normally cover the
same newest window. Recency remains the score tie-break.

Ranked continuations authenticate the original horizon, next descending rowid and
examined count, bound to directory/project/workspace/session, query, dates,
technical option and result limit. HMAC-authenticated tokens use process-local
secrets; restarting their issuer requires a fresh search. The horizon also carries
the SHA-256 identity of its message ID. Point reads verify that identity at the
start of each continuation and immediately before publication; a deleted/replaced
horizon row requires a fresh search so SQLite rowid reuse cannot admit new messages
into an older window. A metadata-only bounded
lookahead checks for older owned rows. A lookahead deadline retains a conservative
continuation, allowing the next bounded read to resolve a sparse foreign tail.
Ownership revalidation and the final physical root fence guard cursor publication.

Candidate statements pin the message table as the outer loop with `CROSS JOIN`,
seek descending integer rowids and cover at most 128 raw rowid positions. A cheap
predecessor seek skips deletion holes; wholly foreign ranges still yield and
continue to older owned messages. The plan returns each classified row
incrementally in integer-rowid order.
The loop yields between ranges and after roughly 40 ms, observing cancellation.

The scalar receives bounded raw UTF-8 bytes, avoiding JS strings and JSON work for
negative rows. Each term supplies a necessary ASCII anchor (at most two letters,
digits or underscores) with its ASCII case forms; Kelvin/long-s crossings and
escaped letters/surrogates conservatively enter exact decoding. Wholly non-ASCII
terms and technical numeric/null canonicalization also retain exact decoding.
Prose control escapes such as ANSI `\u001b` preserve raw word anchors. Exact decoded
masks exclusively supply presence bits, scores and document frequencies. Property checks compare
it against the exact mask/judge across Unicode case forms, escapes and surrogate
pairs, including the host's complete ASCII Unicode case crossings.

Only possible matches pay for JSON decoding and the judge's shared readable-part
extraction. With technical content off, raw rows above 64 KiB enter the readable
SQL projection before the candidate scalar. This bounds JavaScript decoding by
readable prose even when ignored tool metadata fills a large stored row. Smaller
rows retain raw byte classification. Technical searches decode the bounded raw
row, retaining the complete shared readable technical extraction. Body reads use
the bounded SQL text projection for prose-only queries. Raw-negative metadata keeps its lightweight
classification; obvious unsupported shapes and attempted decode failures are
reported as skipped. Native JSON decoding preserves Unicode
escapes, surrogate pairs, control characters and literal backslashes exactly.
An escaped `/giu` alternation scans decoded strings for overlapping substrings;
complete-word boundaries belong to the body judge.

The substring mask covers at most 64 KiB of projected readable text per message.
Larger projections have unknown term presence. Unknown rows contribute to neither
the IDF corpus size nor document frequencies and receive no candidate score.
They are queued after known candidates within the existing judge/time budgets.
Returned hits take each session's best hit first, known-source before
unknown-source, then fill by the same order; an unknown-source hit from another
session can therefore precede a second known-source hit of one session. `prefilterBypassed`
reports unknown rows globally and per session, and the tool prints their count.
Each weight is `log(1 + N / max(df, 1))` over known collected candidates and
their term-presence bits. Known candidate rank uses the sum of present-term weights
and recency, across the scanned scope before choosing bodies.

The judge reads at most 600 candidate bodies, one materialized message at a time,
under the shared 16 MiB message bound. The shared readable-part extraction retains
native part indexes and excludes attachments and opaque state. Final scores sum
the weights of complete terms found across the message's prose, with an exact
case-insensitive query-phrase bonus equal to the sum of query-term weights.
Technical matches fill messages with no prose match when requested. Prose ranks
first within each known/unknown group, then score, then message recency. Results first take one hit per session,
then fill by rank without duplicating messages. Excerpts, at most 320 characters,
center on the rarest matched term in the selected readable part.

Collection stops at the 16,384-message recent window, 30,000 candidates,
600 contributing sessions or approximately
1.5 seconds; the complete
collection/body-judging operation has a 2-second processing budget; the bounded
ownership validation completes independently so verified partial results survive
judge-budget exhaustion. A running SQLite statement, JSON parse
or single-message judge finishes first. The response identifies collection,
judgement and time caps, so match counts and ranking explicitly describe the
examined subset. The capped note reports how many recent messages were examined,
newest first per project location; the agent tool also names the cap reasons.
`message_limit` identifies the fixed recent-window boundary. Oversized and
unsupported decoded rows contribute to `skipped`.
The verified session count covers all matched judged messages, including matches
beyond the returned hit limit. The compact tool output gives that count and cap
notice, followed by date, folder name, session ID, title, role and excerpt per hit.
It treats excerpts as untrusted data and gives the native full-session read command.

The plugin also exposes `historyRanked` with required `version: 1`, the same query
options, an optional opaque continuation, a 1–40 result limit (default 10), ranked
hits carrying the history hit fields plus `createdAt`, and bounded
per-session directory/workspace/count provenance with titles for every scanned
session, including rows that produce no match. Per-session candidate, judged and
matched-message counts let an ownership-validating broker reconstruct totals.
Its discriminant is `status: "ranked"`; blocked reads use the
shared pruning blocked result. This RPC is available to native callers. The
600-body judge budget and 320-character excerpts bound each 40-hit response.
The agent tool validates its own 1–20 limit (default 10) and query-only inputs.
The broker requests 40 per location, authenticates its own opaque envelope of
native per-location cursors against workspace, authorized directory inventory,
query/options and connection identity, and resumes only locations with remaining
history. The public `cursor` and `examinedBefore` retain continuation state and
owned examined ordinals. Per-request provenance reconstruction and all ownership,
deletion, cancellation and connection fences apply to each window. Tokens contain
binding digests and opaque native cursors; native paths remain broker-only.
The
CodeNomad HTTP broker uses the ranked method for workspace search and the literal
history contract for conversation search; generic RPC proxy access stays closed.

## Cleanup semantics

Planning returns compact message IDs, content hashes and technical-part counts;
it never downloads transcripts. The confirmation reports eligible
tools/reasoning and explicitly reports skipped content. Execution sends at most
16 candidates per RPC. Each message independently uses the synchronous
write transaction, fresh DB challenge, durable native claim/ownership checks,
content revision comparison and atomic receipt. Part indexes are computed from
the authorized stored content inside that transaction.

Text and message/session metadata remain intact. A changed message is refused
rather than silently expanding what the user confirmed. Pre-compaction messages
are included; active/incomplete content is skipped. Whole-session cleanup commits
per message: a later conflict leaves earlier successful messages pruned.
Progress and cancellation are displayed above the transcript. Cancellation stops
future batches; an already dispatched batch may commit. Ambiguous acknowledgments
invalidate the active window; identical retries use the same durable receipts.
The ordinary custom pruning events coalesce native-window refreshes in other
clients. Cleanup never creates or resumes generation.

## Validation

SQLite/plugin and route regressions cover pagination beyond 200 messages, project/
directory/legacy identity isolation, cursor binding, scan horizon, unsupported
payload reporting, active claims, rollback and batch receipt validation. UI store
tests cover compact planning, changed-content refusal, cancellation and late pages.
The Chromium fixture exercises the real search window with HTTP responses and
asserts that searches/counts and selected previews never page the transcript.

`scripts/test-session-history-native.mjs` runs only inside the isolated pruning
fixture: 241 imported synthetic messages, counts, search, cleanup and exact batch
replays against a real daemon; a second session verifies all 242 text-only
workspace matches and ranked search with three diverse hits and exact two-session
provenance. Pure ranking tests cover Unicode terms, frequency weights, phrase
bonuses, diversity, dates and cap formatting. Synthetic SQLite/filesystem tests cover
physical clone/worktree ownership, unknown identities and adversarial large-row
first-yield responsiveness, tool-heavy rarity ranking, exact control/Unicode
escape decoding and IDF isolation from unknown projections. The native fixture also checks dotted-capital-I and
mixed-accent/Kelvin/long-s scalar matching, plus large-row bypass reporting.
Synthetic SQLite tests cover scope,
prefilter supersets and selectivity, multiline rarity ranking, bounded materialization, cancellation, yielding and time/candidate
caps; registration tests exercise the tool, RPC, storage challenge and caller fences.
The parent fixture also checks active-generation refusal and
pre-compaction discovery. Never point it at a user's DB or shared daemon; report
native Windows, browser rendering and other platforms as separate validation claims.

`node scripts/benchmark-session-history.mjs [baseline-ref]` compares local scan
cost (synthetic in-memory database, excluding broker/RPC) with a Git revision,
HEAD by default.

`node scripts/benchmark-ranked-history.mjs [baseline-ref]` measures three searches
per implementation on 40,000 synthetic multiline assistant/tool messages with
accents, ANSI output and native-style project/session indexes. It reports coverage,
rows/second, exact-decode count, first-row latency, longest synchronous scan step,
query plan and first hit. The fixture uses its own in-memory database and isolated synthetic inputs.

## Agent conventions

- Ranked search belongs in `history-ranked-store.ts`, with pure ranking in `history-ranking.ts` and the necessary byte predicate in `history-ranked-prefilter.ts`; share scope SQL, readable extraction, text projection and message bounds through `history-content.ts`. Preserve newest-first bounded streaming, deterministic recent-window coverage and the raw-predicate superset property; use native-style indexes in latency regressions. Compute masks only from decoded shared readable sources; unknown projections stay outside IDF and behind known candidates. Preserve the literal `history` RPC contract. Keep Unicode/control-escape selectivity, dotted-I self-matches, tool-heavy rarity/unknown ordering, large-projection responsiveness/reporting, partial results at the judge deadline and verified-match provenance tests whenever ranking changes. `history-ranked-ownership.ts` owns request-local physical ownership and the uncached publication fence; bind both root and common-directory device/inode identities. The shared filesystem reader stays inside the packable plugin and is imported by workspace discovery; keep depth limits explicit at plugin calls. Never add Git process spawns to ranked ownership, caller scope selectors, caller-supplied regular-expression execution, transcript indexes or generic RPC routes. Tool registration and disposal follow the pruning bundle's backend presence.
- Full-history search/counts use the bundled pruning plugin's bounded queries, outside the transcript store. Current-session results and the global timeline navigate through bounded anchor windows; other-session previews fetch one native message only. Search/results/progress styles live in `styles/components/history-search.css`. Workspace results preserve rank with consecutive-session headers via `components/history-search-results.tsx`; unloaded labels and Open in session live in `stores/history-search-sessions.ts`. Reuse native `searchTerms` through `lib/ranked-search.ts` for excerpts and destination highlighting; conversation highlights retain literal semantics. Keep ranked capability connection-scoped and unsupported explicit. Older ranked windows replace the bounded list and label their examined range; reuse the existing tertiary action. Never show raw native IDs in results, regroup away ranking, compare scores across independently weighted windows or re-scan earlier windows for continuation.
