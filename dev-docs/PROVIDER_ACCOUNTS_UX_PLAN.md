# Provider accounts: direct selection and opt-in rotation

Implemented UX and bounded backend behavior for #793. The browser sandbox uses
real Settings and account components with synthetic credentials and quota data;
preview percentages are not native measurements. Production auto-selection is
opt-in and supports native OpenAI ChatGPT OAuth (Codex) only.

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

Other providers and API keys retain their native labels. An upstream sanitized
identity field is preferable for extending provider coverage. Display metadata
is fetched only while Settings is mounted; it is not persisted as a catalog.

## Auto-select account: implemented backend behavior

- Opt-in for the OpenAI integration, persisted under CodeNomad's
  `providerAccounts.autoSelect.openai` config owner. The control is visible only
  with two supported, unexpired OAuth accounts and native credential export
  support (2.0.20+); this feature does not raise the global technical minimum.
  Selection is native and service-wide, not session-specific. Environment and
  API-key connections are never automatic fallback candidates.
- At 100% of an applicable quota window, choose the next usable account of the
  same provider in stable order. Exclude exhausted, expired or needs-auth
  accounts; unknown/stale usage is not evidence of availability.
- If no account is demonstrably available, retain the current selection and
  let the ordinary native send report its result. Do not loop, create credentials, change models or
  silently fall back to another provider.
- Reuse `usage/native-codex.ts`'s bounded quota transport with each explicit
  credential, without temporarily activating candidates. At most 20 candidates
  are considered within a 15-second preflight. Unknown, missing, past-reset or
  failed quota responses cannot authorize a fallback. No quota display cache is
  used for an activation decision. Other providers need independent adapters.
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
  fresh read of persisted YAML. No real credentials or remote generation.

## Preview variants

`/preview` is manual; `/preview?auto` starts with simulated rotation enabled;
`/preview?single` omits the option. `?light` renders the light palette.
The separate preview toolbar's Simulate 100% button exhausts the current mock
account. Production controls do not contain a simulation action.
