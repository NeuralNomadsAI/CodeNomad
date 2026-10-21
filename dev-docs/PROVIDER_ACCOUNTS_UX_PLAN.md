# Provider accounts: direct selection and opt-in rotation

## Visible accounts

Choosing a dropdown option activates that account service-wide, not per session;
the account label is softer than the provider name. Add opens the native Connect
flow with the provider preselected, not a second connection mechanism. Refreshes
never overwrite explicit aliases; rename drafts survive refreshes, account
switches and failed writes.

## Login-derived names

Native `ConnectionCredentialInfo` carries no login, so only the native fallback
label `default` is enriched: Codex OAuth through the server-only
`usage/codex-credential.ts` (native credential exports, same selected-token
identity rules as the quota adapter), OpenCode Console and Anthropic OAuth from a
sanitized native metadata email. The owned account settings route returns only
the bounded display email, never tokens, account IDs, claims or credential
values; claims are display hints, not authorization. No credential is renamed
automatically. Display metadata is fetched only while Settings is mounted and is
never persisted as a catalog.

## Supported integrations

`provider-accounts/adapters.ts` is the selection-adapter registry, keyed by
native integration ID (models.dev providers use their provider ID; plugins
declare their own). Each adapter projects one explicit, possibly inactive,
native credential (secrets stay on the server stack, identity is an irreversible
digest), reads its quota without activating it and never refreshes or
exchanges tokens.

| Integration | Credentials | Quota reader | Unknown candidate |
| --- | --- | --- | --- |
| `openai` (ChatGPT/Codex) | Codex browser/device OAuth | `usage/native-codex.ts` strict selection parser | rejected |
| `opencode-go` | Go API key | `usage/opencode-go-quota.ts` | accepted unless marked |
| `opencode` (Console, `opencode-go` provider only) | OAuth `device`, service-account key | same, with `x-org-id` | accepted unless marked |
| `anthropic` (Claude Pro/Max) | OpenCode Anthropic OAuth only, never Claude Code's `claude-code` login (not even as fallback) | Usage tab Claude reader | accepted unless marked |
| `github-copilot` | OAuth (github.com only) | Usage tab Copilot reader (premium requests) | rejected |
| `zai-coding-plan`, `zhipuai-coding-plan` | plan key | Usage tab token-limit reader (MCP tool allowance ignored) | rejected |
| `kimi-for-coding` | plan key | Usage tab Kimi reader | rejected |
| `minimax-coding-plan`, `minimax-cn-coding-plan` | plan key | Usage tab MiniMax reader | rejected |

OpenAI's `chatgpt-token-sharing` grant cannot read Codex usage ([confirmed by
OpenAI](https://github.com/openai/sign-in-with-chatgpt-devkit/issues/3#issuecomment-5936080960)):
Usage shows the localized `openai-token-sharing-unsupported` explanation for that
login, which neither restores quota access nor qualifies it for automatic selection.

Pay-as-you-go integrations (`zai`, `minimax`, OpenRouter, DeepInfra, Kilo,
ZenMux, DeepSeek, credit providers), the Console's Zen provider and readers that
need unrelated environment cookies/tokens (Cursor, Ollama, the Go web scrape)
are not registered.

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
  two eligible accounts. Environment, external and pay-as-you-go connections are
  never automatic fallback candidates. The route refuses writes for unregistered
  integrations or unsupported catalogs.
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
- Persist only the opt-in policy; redact failures and never expose tokens through
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
- In-flight OpenCode steps may retain a previously acquired account; seamless
  mid-generation failover needs a proven upstream contract, not a UI promise.
- Native activation has no compare-and-set contract: a TUI/other backend can
  still change selection after the last read. The local serialization fence does
  not claim distributed locking or atomic selection against external clients.
- Validation: server policy/ownership/admission regressions, real Chromium
  controls and `scripts/test-provider-account-selection-native.mjs` against an
  isolated CLI/database, with synthetic OAuth and injected quota responses.
  The native fixture covers concurrency, exhaustion, alias preservation and a
  fresh read of persisted YAML. Adapter, Go parser, reactive-mark and per-integration
  rotation regressions (`provider-accounts/*.test.ts`, `usage/opencode-go-quota.test.ts`)
  use fake daemons and stubbed fetch. No real credentials or remote generation.

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

## Preview variants

`tests/browser/fixtures/provider-accounts-preview.tsx` renders the real Settings
components with synthetic credentials/quotas: `/preview` (manual), `?auto`
(simulated rotation), `?single` (no option), `?light`; its toolbar's Simulate 100%
exhausts the current mock account. Production has no simulation action.

## Agent conventions

- Provider accounts use a native dropdown like Web search defaults, without an Accounts disclosure or selectable account rows. Provider headers keep the name and text Manage models button on one row; a faint separator distinguishes the account controls below. Account actions are always visible, not hover-revealed. The `provider-account` container stacks the label above the dropdown/actions at narrow card widths. Native account ordering supplies the current account; rename/remove drafts stay keyed by credential. Environment connections are read-only. The browser never reads credential secrets. Native labels win; only `default` may display a sanitized login email from the owned server adapter. Opt-in rotation is per integration (`providerAccounts.autoSelect.<integrationID>`) through the selection-adapter registry in `provider-accounts/adapters.ts`, for subscription accounts with quota windows only: Codex, OpenCode Go (Go key and Console sign-in, Go provider only), Claude Pro/Max (OpenCode Anthropic OAuth, never the Claude Code login), GitHub Copilot and key-based coding plans; pay-as-you-go keys/credits stay manual. It runs before prompt/command admission, reading each explicit credential's fresh quota (reusing Usage readers) without activating candidates or refreshing tokens, with local manual-change fences and no mutation/prompt replay; the only switch condition is a full current account. Native `provider.quota` failures add bounded in-memory per-connection marks (`quota-observer.ts`); reactive adapters (Go, Console, Claude) accept unknown-but-unmarked candidates, others need "available". Account styling lives in `styles/components/provider-accounts.css`, backend policy in `provider-accounts/`. Browser preview percentages remain simulated.
- Provider usage providers receive credentials explicitly: the route projects each integration's active native `credential.list` entry through `usage/native-credentials.ts` (never host auth.json; a missing endpoint is unavailability) and caches snapshots per provider credential identity. Codex keeps its selected-connection adapter. Claude quotas follow the session's login (`usage/claude-credential.ts`): `anthropic`/`claude` use only OpenCode's Anthropic OAuth, opencode-claude's `claude-code` only the Claude Code login the route resolves on the daemon host (session environment, WSL path translation, Claude Code's token/Keychain/file order) and injects as the `claude-code` entry, so it joins the cache identity; never cross-fall back between them. Never exchange refresh tokens or embed OAuth client secrets; Google stays unsupported for that reason. Model-scoped limits add `window:Model` rows beside the plan windows.
