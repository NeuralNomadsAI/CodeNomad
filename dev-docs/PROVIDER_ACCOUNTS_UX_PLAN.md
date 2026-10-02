# Provider accounts: direct selection and opt-in rotation

Design exploration for #793. The browser sandbox uses real Settings and account
components with synthetic credentials and quota data. Auto-selection is not
implemented in production, and preview percentages are not native measurements.

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

## Login-derived names: capability boundary

The pinned 2.0.21 `ConnectionCredentialInfo` exposes ID, label, method and optional
auth status; it does not expose a login. Native OAuth implementations may supply
an automatic label (`packages/core/src/integration.ts`), otherwise native
credential creation falls back to `default`. A login cannot be inferred from
a credential ID or an API key.

Prefer an upstream sanitized identity field. If CodeNomad adds its own server
identity adapter, limit it to supported OAuth providers and return only the
display identity, never credential values. Preserve explicit user names; no
credential export route or token parsing in the browser. Existing custom names
need a defined automatic-vs-explicit origin before any automatic renaming.

## Auto-select account: proposed backend behavior

- Opt-in per provider, service-wide, visible only with at least two saved
  accounts. An environment connection is not a selectable fallback account.
- At 100% of an applicable quota window, choose the next usable account of the
  same provider in stable order. Exclude exhausted, expired or needs-auth
  accounts; unknown/stale usage is not evidence of availability.
- If no account is demonstrably available, retain the current selection and
  report unavailability. Do not loop, create credentials, change models or
  silently fall back to another provider.
- Extend the existing server-side quota adapters to address an explicit
  credential, without temporarily activating each candidate to read its quota.
  Current `usage/native-codex.ts` reads only the selected OAuth account; it is not
  yet a multi-account quota catalog. Other providers need independent adapters.
- Persist only the opt-in policy and sanitized bounded snapshots. Keep native
  exports on the server stack, redact failures, and never expose tokens through
  the account catalog, browser, logs or persisted display cache.
- Apply decisions before the next eligible model request, independent of an
  open Settings window. Serialize decisions across workspaces, freshly verify
  connection/ownership/deletion fences and current credential before activation.
  A manual selection racing a quota read wins; stale responses cannot switch it.
- Do not automatically replay a failed prompt, custom command or tool operation.
  In-flight OpenCode steps may retain a previously acquired account; seamless
  mid-generation failover needs a proven upstream contract, not a UI promise.
- Validate opt-in persistence, quota resets, unknown usage, all-exhausted cases,
  manual-switch races and concurrent sessions using isolated native data before
  offering the production toggle. No blanket minimum-version increase based on
  this preview.

## Preview variants

`/preview` is manual; `/preview?auto` starts with simulated rotation enabled;
`/preview?single` omits the option. `?light` renders the light palette.
The separate preview toolbar's Simulate 100% button exhausts the current mock
account. Production controls do not contain a simulation action.
