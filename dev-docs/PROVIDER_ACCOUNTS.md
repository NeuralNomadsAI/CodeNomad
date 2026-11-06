# Provider accounts: direct selection and opt-in rotation

## Visible accounts

Choosing a dropdown option activates that account service-wide; the account label
is softer than the provider name. Add reuses the native Connect flow with the
provider preselected; never build a second connection mechanism. Refreshes never
overwrite explicit aliases; rename drafts survive refreshes, account switches and
failed writes.

## Login-derived names

Native `ConnectionCredentialInfo` lists only ID, label and method, so only the
native fallback label `default` is enriched: Codex OAuth through the server-only
`usage/codex-credential.ts` (native credential exports, same selected-token
identity rules as the quota adapter), OpenCode Console and Anthropic OAuth from a
sanitized native metadata email. The owned account settings route returns only
the bounded display email, never tokens, account IDs, claims or credential
values; claims are display hints, never authorization. Never rename a credential
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
| `anthropic` (Claude Pro/Max) | OpenCode Anthropic OAuth only, never Claude Code's `claude-code` login, even as fallback | Usage tab Claude reader | accepted unless marked |
| `github-copilot` | OAuth; automatic selection: github.com only | Usage tab Copilot reader (premium requests and consumed credits; validated Enterprise destinations for display) | rejected |
| `zai-coding-plan`, `zhipuai-coding-plan` | plan key | Usage tab credit/token-limit reader (MCP tool allowance ignored) | rejected |
| `kimi-for-coding`, `kimi`, `kimi-code-plan-cn`, `kimi-code-plan-global` | plan key | Usage tab Kimi reader, including calendar-month caps | rejected |
| `minimax-coding-plan`, `minimax-cn-coding-plan` | plan key | Usage tab MiniMax reader | rejected |

OpenAI's `chatgpt-token-sharing` grant cannot read Codex usage ([confirmed by
OpenAI](https://github.com/openai/sign-in-with-chatgpt-devkit/issues/3#issuecomment-5936080960)):
Usage shows the localized `openai-token-sharing-unsupported` explanation and a
translated **View ChatGPT usage** link to `https://chatgpt.com/settings/usage`
for that login, as [OpenAI recommends](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions#tracking-usage).
The reader returns the `chatgpt-usage` action; the UI owns the fixed destination.
Its quota stays unknown, so automatic selection rejects it.

Pay-as-you-go integrations (`zai`, `minimax`, OpenRouter, DeepInfra, Kilo,
ZenMux, DeepSeek, credit providers), the Console's Zen provider and readers that
need unrelated environment cookies/tokens (Cursor, Ollama, the Go web scrape)
stay manual, outside the registry.

GitHub Copilot display reads project only `metadata.enterpriseUrl` from the native
[Copilot credential](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/plugin/provider/github-copilot.ts),
which stores the entered HTTPS root URL as a hostname. Both hostname and HTTPS
root forms are accepted after raw validation; `parseQuotaBaseURL` checks qualified
DNS syntax and rejects credentials, explicit ports (including 443), non-root paths,
queries, fragments, backslashes, controls, IP/numeric address forms and localhost.
Invalid metadata publishes `invalid-base-url` without a request or public-host
fallback. The endpoint is exactly `https://api.<host>/copilot_internal/user`, matching
[GitHub's Enterprise API host](https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/about-github-enterprise-cloud-with-data-residency#api-access);
absent metadata uses `https://api.github.com/copilot_internal/user`. The bounded
transport rejects redirects. Host validation covers syntax; DNS resolution follows
the backend resolver, including private results. Endpoint availability on arbitrary
self-hosted servers depends on their API support. Enterprise credentials stay
unread by automatic selection.

The [VS Code quota contract](https://github.com/microsoft/vscode/blob/main/src/vs/base/common/defaultAccount.ts)
and [usage calculation](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/chat/common/chatEntitlementService.ts)
supply `quota_snapshots.{chat,completions,premium_interactions}`. Capped usage is
`entitlement - quota_remaining`, falling back to `entitlement * (100 - percent_remaining) / 100`;
the bar follows `100 - percent_remaining`, or the count ratio if that percentage
is absent. Zero entitlements omit the row. Unlimited snapshots expose only
`credits_used` when available and `has_quota` permits, otherwise the localized
Unlimited state. `ProviderUsageWindow.consumption` carries numbers/state; the UI
formats fractional counts with `Intl.NumberFormat` and translates the used/limit,
credits-used and unlimited labels. Premium requests keep their category label;
only the `credits_used` value is labelled as credits. `quota_reset_at` is Unix
seconds and takes precedence over `quota_reset_date_utc`, `quota_reset_date`, then
`limited_user_reset_date`. `copilotPlan` maps verified `copilot_plan` and
`access_type_sku` values to Free, Pro, Pro+, Business, Enterprise, Student or Max
in the footer; unknown/missing plans omit the suffix. These fields belong to the
client-consumed internal endpoint contract.

Usage-backed adapters reuse the Usage tab readers with a one-entry projection
(`usage/native-credentials.ts` `projectCredential`) and a small selection view
that keeps plan windows, including Kimi's calendar-month caps with unknown duration.
Readers use a 15-second display transport; Kimi, Copilot, z.ai/Zhipu, Codex and Go use
the bounded credential-free transport in `usage/bounded-fetch.ts` (64 KiB,
redirects rejected, abortable). Readers keep the upstream HTTP status, and any
definite client error (4xx except 408/429, e.g. a Zen key answering 402 or a
missing endpoint) rejects a candidate, including for reactive adapters, so an
unrelated account (or Zen billing account) is never activated. Only reads not
performed, transport failures, timeouts, rate limits and 5xx stay unknown.
Inactive Anthropic/Console OAuth tokens near or past expiry, enterprise Copilot
tokens and self-hosted Console credentials (OAuth tokens and service-account
keys alike) stay unread (unknown); never refresh them or send them to the public
endpoint. The Usage tab sends native Go credentials only for the `opencode-go`
provider (ID or canonical); pay-as-you-go Zen sessions use the env-cookie reader.

The Go usage endpoint (`GET https://opencode.ai/zen/go/v1/usage`) is
unversioned and only partly verified: the parser accepts the current
`usage.{rolling,weekly,monthly}` and older `*Usage` shapes, and treats anything
else as unknown. Console OAuth usage with `x-org-id` is unverified upstream.

MiniMax's international and China readers try Token Plan, then Coding Plan when
needed. A final successful response (`base_resp.status_code === 0`) with absent
or empty `model_remains` publishes `minimax-limits-not-shared`; Usage shows its
localized status card with unknown quota. This is a narrow interpretation of a
successful empty quota response: the [M Plan FAQ](https://platform.minimax.io/docs/m-plan/faq.md)
and [official CLI](https://github.com/MiniMax-AI/cli/blob/main/src/commands/quota/show.ts)
establish the endpoint and response fields; a dedicated unshared-limits signal
remains unverified. [API errors](https://platform.minimax.io/docs/api-reference/errorcode.md),
HTTP/transport failures and malformed payloads keep their existing failure path.

OpenRouter display reads use the effective native provider `baseURL` (path prefix
preserved, trailing slashes normalized), defaulting to `https://openrouter.ai/api/v1`
only when absent. `parseQuotaBaseURL` admits public HTTPS hostnames without userinfo,
explicit port, query, fragment, IP literals or localhost; invalid destinations publish
`invalid-base-url` before any request. Unreadable/unresolved native settings leave
usage unavailable. The bounded transport rejects redirects; an incompatible gateway
stays unavailable at its configured destination. [GET /key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key)
provides the key's own USD `limit` and `limit_remaining`: `key_limit` (**Key Limit**)
computes consumption as `limit - limit_remaining`, independently of lifetime `usage`.
A null limit omits that row; zero is an exhausted limit. `limit_reset` supplies an
interval name rather than an instant, so the reader leaves `resetAt` unknown.
[GET /credits](https://openrouter.ai/docs/api/api-reference/credits/get-credits)
requires a management key and adds a separate credits row only on a usable success;
its failure preserves the key-limit row. `ProviderUsageWindow.balanceUSD` carries
numeric remaining/total amounts, formatted with the UI locale's `Intl.NumberFormat`.

The z.ai and Zhipu readers use the native effective `apiKey` first, then the
explicitly supplied stored credential when that setting is absent or unresolved.
Provider configuration owns the model-call key; native `provider.get` performs
`{env:…}` and `{file:…}` substitution in the daemon's scope (relative files are
relative to the configuration directory, `~` uses the daemon's home). Empty or
unresolved settings without a stored credential produce the unconfigured state
before any request. Selection adapters keep their explicit candidate key.
Both readers use bounded, redirect-free GETs with Bearer authentication at
`https://api.z.ai/api/monitor/usage/quota/limit` and
`https://open.bigmodel.cn/api/monitor/usage/quota/limit`, respectively.
An HTTP 200 envelope with `success: false` or a non-200 business `code` publishes
`provider-error`, with only a one-to-eight-digit code; the UI uses its translated
generic error. Empty/unusable quota payloads publish that reason without a code.
Never expose upstream `msg` or activate gift resets. HTTP failures retain their
status for account selection. `CREDIT_LIMIT` uses `percentage`, or consumption
from `currentValue` / `usage` (falling back to `remaining`); credits are plan units.
`unit: 3, number: 5` supplies five hours and `unit: 6, number: 1` supplies a week;
`nextResetTime` supplies the reset in milliseconds. `TOKENS_LIMIT` and the separate
`TIME_LIMIT` MCP-tools row remain supported. The [plan guide](https://docs.z.ai/devpack/overview.md)
and [usage revision](https://docs.z.ai/devpack/notice/usage-revision.md) document
credit-based and legacy windows; the public quota endpoints return the business
error envelope even without authentication.

Kimi's [models.dev entries](https://models.dev/api.json) identify `kimi-code-plan-cn`
at `https://api.kimi.com/coding/v1` and `kimi-code-plan-global` at
`https://api.kimi.ai/coding/v1`; `kimi-for-coding` and `kimi` use the China host.
The reader sends Bearer-authenticated GET `/usages` through the bounded transport.
It tries the active projected credentials only, session integration first, with
duplicate keys removed and one 12-second deadline combined with the caller's signal.
Selection adapters supply only their explicit candidate. The session integration
from native provider settings participates in display-cache identity.
The official [managed usage parser](https://github.com/MoonshotAI/kimi-code/blob/main/packages/oauth/src/managed-usage.ts)
and [tests](https://github.com/MoonshotAI/kimi-code/blob/main/packages/oauth/test/managed-usage.test.ts)
define `usages.{limit_5h,limit_7d,limit_month_total,limit_month_code}` with numeric or
numeric-string `used_ratio` and ISO `reset_time`. Ratios within `[0,1]` become
consumed percentages; invalid entries are omitted. Five hours and seven days use
18,000 and 604,800 seconds. Independent `monthly` and `monthly-code` caps retain
unknown durations and the provider's reset date, with common percentage rendering
and localized Monthly / Monthly coding labels. `quotaState` includes those calendar
caps, so monthly exhaustion prevents availability even beside usable shorter windows.
The [membership guide](https://www.kimi.com/code/docs/en/kimi-code/membership.html)
confirms the shared monthly total and optional weekly quota. Historical `usage` and
`limits[]` payloads remain supported; ratio entries take precedence on matching windows.

Cursor display keeps the environment token (`CURSOR_ACCESS_TOKEN`, then `CURSOR_TOKEN`)
and the existing personal-plan `GetCurrentPeriodUsage` / `GetPlanInfo` readings.
Without a usable personal meter, it reads the private dashboard profile at
`GET https://api2.cursor.sh/auth/full_stripe_profile`: `membershipType: enterprise`,
`isTeamMember: true` or a positive `teamId` identifies the team path. That path
requires a positive integer team ID, reads `GET /auth/usage` and POSTs
`aiserver.v1.DashboardService/GetHardLimit` with `{teamId}`, Bearer authentication,
JSON and `Connect-Protocol-Version: 1`. These private endpoints are best-effort.
The official [Admin API](https://cursor.com/docs/account/teams/admin-api) uses its
own Basic-auth administrative key.

The [observed usage shape](https://github.com/can1357/oh-my-pi/issues/6381)
corroborates the legacy `gpt-4` bucket's `numRequests` and nullable `maxRequestUsage`.
Only that identified bucket is displayed, under `requests:gpt-4`; an absent cap
keeps a used-only `consumption` count with unknown percentage. `startOfMonth`
leaves the reset unknown. Unknown buckets are omitted. `hardLimitPerUser` and
`hardLimit` are USD caps in separate `per_user_limit` / `team_limit` rows with
numeric `limitUSD`, formatted by the UI's `Intl.NumberFormat`; spend and cap
percentages remain unknown. Absent, negative or malformed limits are omitted.
All calls share one 15-second budget combined with the caller's cancellation,
using the bounded redirect-free JSON transport for GET and POST. Verified partial
readings remain visible; a response without any readable meter returns
`cursor-usage-unavailable`. Missing teams, HTTP 403 and expired tokens/HTTP 401
use distinct translated reasons; HTTP 401 revokes partial readings. Cursor stays
manual, outside the account-selection registry.

## Auto-select account

- Opt-in per integration, persisted under CodeNomad's
  `providerAccounts.autoSelect.<integrationID>` config owner. Settings asks the
  server for every integration with saved credentials; the control is visible only when the server reports
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
- If no account is acceptable, retain the current selection and let the ordinary
  native send report its result. Never loop, create credentials, change models or
  silently fall back to another provider.
- At most 20 candidates are considered within a 15-second preflight, without
  temporarily activating candidates. Never use the quota display cache for an
  activation decision. For Codex, selection rejects every malformed declared
  window, missing/past resets, duplicate durations, out-of-range percentages and
  contradictory availability flags before any normalization can omit or clamp
  them.
- Persist only the opt-in policy; redact failures and never expose tokens through
  the account catalog, browser, logs or persisted display cache.
- Apply decisions before the next prompt/custom-command admission,
  independent of an open Settings window. Never replay or intercept Shell, `/btw`,
  tools, autonomous native steps or already queued requests. Serialize decisions across this backend's workspaces, freshly verify
  connection/ownership/deletion fences and current credential before activation.
  A local manual mutation or policy change racing a quota read wins, including
  away-and-back selection; stale responses cannot switch it. Native selection,
  credential fingerprints, session model/location and ownership are reread before
  activation. An ambiguous activation failure blocks that send with a redacted
  error, without retrying another candidate or the prompt.
- In-flight OpenCode steps may retain a previously acquired account; never promise
  mid-generation failover without a proven upstream contract.
- Native activation lacks compare-and-set, so a TUI or another backend can change
  the selection after the last read; the serialization fence covers only this
  backend's decisions.
- Validation: server policy/ownership/admission regressions, real Chromium
  controls and `scripts/test-provider-account-selection-native.mjs` against an
  isolated CLI/database, with synthetic OAuth and injected quota responses.
  The native fixture covers concurrency, exhaustion, alias preservation and a
  fresh read of persisted YAML. Adapter, Go parser, reactive-mark and per-integration
  rotation regressions (`provider-accounts/*.test.ts`, `usage/opencode-go-quota.test.ts`)
  use fake daemons and stubbed fetch; never use real credentials or remote generation.

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
exhausts the current mock account. Never add a simulation action to production.

## Agent conventions

- Display readers accept an optional `ProviderReadContext` (`usage/types.ts`): the route's 15-second cancellation signal and the effective `baseURL`/`apiKey` from native `provider.get({ providerID, location })`, after session/Location authorization and with connection/publication fences. `usage/native-settings.ts` admits only the requested provider and Location, keeps these two settings on the server, trims nonempty strings, omits empty values and unresolved `{env:…}`/`{file:…}` strings, and reports `settingsStatus` as `available`, `unresolved` or `unavailable`. A reader with no usable configured key keeps its explicitly supplied stored credential. Never resolve config files or variables in the backend's environment/HOME. Native substitution follows the daemon's configuration scope ([OpenCode config variables](https://opencode.ai/v2/docs/config#variables)); `scripts/test-usage-settings-native.mjs` qualifies relative-file, environment and absent-value behavior with synthetic settings in an isolated runtime. Selection adapters keep their explicit-credential calls and HTTP-status semantics.
- Usage display cache identities digest the reader's credential aliases, settings status and consumed `baseURL`/`apiKey` with SHA-256; signals stay outside the identity. Aborted reads cannot populate a snapshot. Credential-bearing readers can use `usage/bounded-fetch.ts` for a 15-second, 64 KiB JSON read with cancellation, rejected redirects and HTTP-status-only failures. `parseQuotaBaseURL` validates configured HTTPS destinations before any request: qualified DNS names, optional path prefix, no credentials, explicit ports (including 443), query, fragment, IP literals/numeric address forms or localhost. Host-only consumers additionally reject paths. Never send credentials when destination validation fails.
- Public usage failures use `ProviderUsageUnavailableReason` (`api-types.ts`), shared by `ProviderResult`: an enumerated `unavailableReason`, an optional numeric `providerErrorCode` of one to eight digits for `provider-error`, and an optional enumerated `unavailableAction` associated with its known reason. `usage/service.ts` allowlists these fields and clears failure windows. Never serialize `ProviderResult.error`, native errors, upstream bodies, arbitrary messages, URLs or secrets. The UI maps reasons to translated text and actions to fixed destinations (`chatgpt-usage` for `openai-token-sharing-unsupported`); readers opt into the action explicitly. Failure cards use `role="status"`, without quota bars or retained values; their real external anchors have explicit underlined labels, keyboard focus, `noopener noreferrer` and `openExternalUrl`. Add every new public reason/action to the service allowlist, UI mapping, all ten locales and regression tests together.
- Provider accounts use a native dropdown like Web search defaults; never add an Accounts disclosure or selectable account rows. Provider headers keep the name and text Manage models button on one row; a faint separator distinguishes the account controls below. Account actions are always visible. The `provider-account` container stacks the label above the dropdown/actions at narrow card widths. Native account ordering supplies the current account; rename/remove drafts stay keyed by credential. Environment connections are read-only. The browser never reads credential secrets. Native labels win; only `default` may display a sanitized login email from the owned server adapter. Opt-in rotation is per integration (`providerAccounts.autoSelect.<integrationID>`) through the selection-adapter registry in `provider-accounts/adapters.ts`, for subscription accounts with quota windows only: Codex, OpenCode Go (Go key and Console sign-in, Go provider only), Claude Pro/Max (OpenCode Anthropic OAuth, never the Claude Code login), GitHub Copilot and key-based coding plans; pay-as-you-go keys/credits stay manual. It runs before prompt/command admission, reading each explicit credential's fresh quota (reusing Usage readers) without activating candidates or refreshing tokens, with local manual-change fences and no mutation/prompt replay; the only switch condition is a full current account. Native `provider.quota` failures add bounded in-memory per-connection marks (`quota-observer.ts`); reactive adapters (Go, Console, Claude) accept unknown-but-unmarked candidates, others need "available". Account styling lives in `styles/components/provider-accounts.css`, backend policy in `provider-accounts/`. Browser preview percentages are simulated.
- Provider usage providers receive credentials explicitly: the route projects each integration's active native `credential.list` entry through `usage/native-credentials.ts` (never host auth.json; a missing endpoint is unavailability) and caches snapshots per provider credential identity. Codex uses its selected-connection adapter. Claude quotas follow the session's login (`usage/claude-credential.ts`): `anthropic`/`claude` use only OpenCode's Anthropic OAuth; the providers that run Claude Code inside the daemon, opencode-claude's `claude-code` and OpenCode's Claude Agent `claude-agent` (native method `claude-login`, external), resolve to one `claude-code` reader (shared snapshot and rate-limit backoff) and use only the Claude Code login the route resolves on the daemon host (session environment, WSL path translation, Claude Code's token/Keychain/file order) and injects as the `claude-code` entry, so it joins the cache identity; never cross-fall back between them. Never exchange refresh tokens or embed OAuth client secrets; Google stays unsupported for that reason. Model-scoped limits add `window:Model` rows beside the plan windows.
- OpenCode Zen free models (`opencode` provider, `big-pickle` or a `-free` model ID) use the local display estimate in `usage/opencode-free-estimate.ts`: native `session.stats` since 00:00 UTC (`tools: "none"`), summing every identified free model's steps against an assumed 200 requests per day. The next UTC midnight is the estimated reset. The `estimated` response flag enables a localized caveat and reset label; steps approximate requests, other clients' traffic is unseen, and actual IP-based limits vary. This credential-free path keeps the existing session ownership and connection publication fences. Never present the estimate as an upstream reading or feed it to account selection.
