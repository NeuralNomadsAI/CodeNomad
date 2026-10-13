# Provider accounts: direct selection and opt-in rotation

Implemented UX and bounded backend behavior for #793. The browser sandbox uses
real Settings and account components with synthetic credentials and quota data;
preview percentages are not native measurements. Production auto-selection is
opt-in per integration and supports subscription accounts with quota windows
(see "Supported integrations"); pay-as-you-go keys, balances and credits never
rotate.

## Visible accounts

- Show an Active account dropdown below the provider name, styled like the
  native Web search default selector. Opening its menu lists saved accounts;
  choosing an option activates it. No Accounts disclosure or checkbox rows.
- Keep a text Manage models button on the provider header. Add/rename/remove
  icons beside the dropdown target its provider/account. Add opens the exact
  same native Connect flow with the provider preselected; it is not a second
  connection mechanism.
- Keep all account actions visible without hover. Separate the provider header
  from account controls with a faint rule, using a softer account label and
  aligned dropdown/actions. At narrow card widths, place the label above the
  dropdown while retaining the actions beside it.
- Use native labels as-is, including a login/email if supplied. Explicit aliases
  must not be overwritten by a refresh. Environment connections are read-only.
- Preserve rename drafts across native refreshes, account switches and failed
  writes. Selection remains service-wide, not session-specific.

## Login-derived names

The pinned 2.0.22 `ConnectionCredentialInfo` exposes ID, label, method and optional
auth status, not a login. Native labels are preferred; only the native fallback
`default` is enriched with a sanitized Codex OAuth email when available. The
server-only `usage/codex-credential.ts` reads native credential exports and uses
the same selected-token identity rules as the existing quota adapter. It returns
only the bounded display email through the owned account settings route, never
tokens, account IDs, claims or credential values. Claims are display hints, not
authorization. No credential is automatically renamed; explicit aliases survive.

Other providers and API keys retain their native labels; OpenCode Console and
Anthropic OAuth `default` labels are enriched the same way from a sanitized
native metadata email. An upstream sanitized identity field is preferable for
extending provider coverage. Display metadata is fetched only while Settings is
mounted; it is not persisted as a catalog.

## Supported integrations

`provider-accounts/adapters.ts` is the selection-adapter registry, keyed by
native integration ID (models.dev providers use their provider ID; plugins
declare their own). Each adapter projects one explicit, possibly inactive,
native credential (secrets stay on the server stack, identity is an irreversible
digest), reads its quota without activating it and never refreshes or
exchanges tokens.

| Integration | Credentials | Quota reader | Unknown candidate |
| --- | --- | --- | --- |
| `openai` (ChatGPT/Codex) | OAuth | `usage/native-codex.ts` strict selection parser | rejected |
| `opencode-go` | Go API key | `usage/opencode-go-quota.ts` | accepted unless marked |
| `opencode` (Console, `opencode-go` provider only) | OAuth `device`, service-account key | same, with `x-org-id` | accepted unless marked |
| `anthropic` (Claude Pro/Max) | OpenCode Anthropic OAuth only | Usage tab Claude reader | accepted unless marked |
| `github-copilot` | OAuth (github.com only) | Usage tab Copilot reader (premium requests) | rejected |
| `zai-coding-plan`, `zhipuai-coding-plan` | plan key | Usage tab token-limit reader (MCP tool allowance ignored) | rejected |
| `kimi-for-coding` | plan key | Usage tab Kimi reader | rejected |
| `minimax-coding-plan`, `minimax-cn-coding-plan` | plan key | Usage tab MiniMax reader | rejected |

Pay-as-you-go integrations (`zai`, `minimax`, OpenRouter, DeepInfra, Kilo,
ZenMux, DeepSeek, credit providers), the Console's Zen provider and readers that
need unrelated environment cookies/tokens (Cursor, Ollama, the Go web scrape)
are not registered. Claude Code's own login (`claude-code`) is never a rotation
credential and never a fallback for `anthropic`.

Usage-backed adapters reuse the Usage tab readers with a one-entry projection
(`usage/native-credentials.ts` `projectCredential`) and a small selection view
that keeps only plan windows with a positive duration. Those readers keep their
display transport (15-second timeout, no response-size cap); Codex and Go use
the bounded credential-free transport in `usage/bounded-fetch.ts` (64 KiB,
redirects rejected, abortable). Readers keep the upstream HTTP status, and any
definite client error (4xx except 408/429, e.g. a Zen key answering 402 or a
missing endpoint) rejects a candidate, including for reactive adapters, so an
unrelated account (or Zen billing account) is never activated. Only reads not
performed, transport failures, timeouts, rate limits and 5xx stay unknown.
Inactive Anthropic/Console OAuth tokens near or past expiry, enterprise Copilot
tokens and self-hosted Console credentials (OAuth tokens and service-account
keys alike) are left unread (unknown) rather than refreshed or sent to the
public endpoint. The Usage tab sends native Go credentials only for the
`opencode-go` provider (ID or canonical); pay-as-you-go Zen sessions keep the
env-cookie behaviour.

The Go usage endpoint (`GET https://opencode.ai/zen/go/v1/usage`) is
unversioned and only partly verified: the parser accepts the current
`usage.{rolling,weekly,monthly}` and older `*Usage` shapes, and treats anything
else as unknown. Console OAuth usage with `x-org-id` is unverified upstream.

## Auto-select account: implemented backend behavior

- Opt-in per integration, persisted under CodeNomad's
  `providerAccounts.autoSelect.<integrationID>` config owner (the historical
  `openai` key is unchanged). Settings asks the server for every integration
  with saved credentials; the control is visible only when the server reports
  two eligible accounts. Native credential export support (2.0.20+) is needed;
  this feature does not raise the global technical minimum. Selection is native
  and service-wide, not session-specific. Environment, external and
  pay-as-you-go connections are never automatic fallback candidates. The route
  refuses writes for unregistered integrations or unsupported catalogs.
- The only switch condition is a full current account: a quota read at 100% of
  an applicable window, or a reactive mark (below) when its read is not
  "available". Choose the next usable account of the same integration in stable
  order. Exclude exhausted, rejected, marked or needs-auth accounts; a fresh
  "available" read clears a mark.
- Candidates must read "available". Reactive adapters (Go, Console, Claude),
  whose inactive credentials are often unreadable, also accept an unknown
  candidate that is not marked; their next send may therefore land on an
  account that turns out to be full, which marks it in turn.
- If no account is acceptable, retain the current selection and
  let the ordinary native send report its result. Do not loop, create credentials, change models or
  silently fall back to another provider.
- At most 20 candidates are considered within a 15-second preflight, without
  temporarily activating candidates. No quota display cache is used for an
  activation decision. For Codex, selection rejects every malformed declared
  window, missing/past resets, duplicate durations, out-of-range percentages and
  contradictory availability flags before any normalization can omit or clamp
  them.

## Reactive quota marks

`provider-accounts/quota-observer.ts` listens to native events already routed to
owned workspaces (`instance.event`), synchronously and without blocking the
relay. A `session.step.failed`/`session.execution.failed` whose structured
error type is `provider.quota` is deduplicated, queued per connection (at most
8 pending, dropped beyond) and attributed off the relay: session → provider →
registered adapter with an enabled policy → the integration's active
credential. The mark is skipped when a credential switch (native
`credential.switched`, our own activation or a manual change) happened since the
failing step started (or within 60 seconds when its start was not observed).
Because `credential.switched` can arrive late through another relay queue, the
switch watermark is captured when the failure is received; after the attribution
reads the backend waits a short settle bound (500 ms), re-reads the selection
and the active credential's identity, and skips the mark if any switch was
observed after receipt, the selection or identity changed, or the selection
differs from the credential last observed active when the step started.

Marks live in memory per connection (at most 256), keyed by integration and
credential ID. Go's `metadata.limitName` sets the lifetime: `5 hour` marks last
5 hours; weekly, monthly and unknown limits are rechecked after 24 hours, since
OpenCode keeps no reset time. A manual account change clears all marks. Failure
details are never logged: native errors may contain request bodies.
- Persist only the opt-in policy. Keep native
  exports on the server stack, redact failures, and never expose tokens through
  the account catalog, browser, logs or persisted display cache.
- Apply decisions before the next prompt/custom-command admission,
  independent of an open Settings window. Shell, `/btw`,
  tools, autonomous native steps and already queued requests are not replayed
  or intercepted. Serialize decisions across this backend's workspaces, freshly verify
  connection/ownership/deletion fences and current credential before activation.
  A local manual mutation or policy change racing a quota read wins, including
  away-and-back selection; stale responses cannot switch it. Native selection,
  credential fingerprints, session model/location and ownership are reread before
  activation. An ambiguous activation failure blocks that send with a redacted
  error, without retrying another candidate or the prompt.
- Do not automatically replay a failed prompt, custom command or tool operation.
  In-flight OpenCode steps may retain a previously acquired account; seamless
  mid-generation failover needs a proven upstream contract, not a UI promise.
- Native activation has no compare-and-set contract: a TUI/other backend can
  still change selection after the last read. The local serialization fence does
  not claim distributed locking or atomic selection against external clients.
- Validation: server policy/ownership/admission regressions, real Chromium
  controls and `scripts/test-provider-account-selection-native.mjs` against an
  isolated 2.0.22 CLI/database, with synthetic OAuth and injected quota responses.
  The native fixture covers concurrency, exhaustion, alias preservation and a
  fresh read of persisted YAML. Adapter, Go parser, reactive-mark and per-integration
  rotation regressions (`provider-accounts/*.test.ts`, `usage/opencode-go-quota.test.ts`)
  use fake daemons and stubbed fetch. No real credentials or remote generation.

## Preview variants

`/preview` is manual; `/preview?auto` starts with simulated rotation enabled;
`/preview?single` omits the option. `?light` renders the light palette.
The separate preview toolbar's Simulate 100% button exhausts the current mock
account. Production controls do not contain a simulation action.
