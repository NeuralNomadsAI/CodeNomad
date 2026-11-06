# Remote Control

Remote Control reaches CodeNomad from another device without an inbound port.
It is separate from direct `--host` access; neither falls back to the other.

```text
browser ─TLS─▶ OpenTunnel relay (forwards ciphertext) ─▶ OpenTunnel SDK in the backend (TLS ends here)
        ─TCP─▶ remote-only loopback ingress ─▶ remote gate ─▶ the normal CodeNomad application
```

## Transport

- `packages/remote-tunnel` wraps `@opentunnel/client` behind CodeNomad-owned
  types. The server build bundles it with its resolved Effect copy into
  `dist/remote-control/tunnel-runtime.js`; never give the published server a
  runtime dependency on the private workspace package.
- CodeNomad claims one random route (`codenomad-<hex>`, persisted) on the
  device's shared `default` identity. OpenCode's `opencode pair --remote` and
  the OpenTunnel CLI use the same identity with their own routes. Stopping
  closes CodeNomad's bridge only and never calls `tunnel.remove()`.
- The relay can observe hostnames, connection timing and sizes. It cannot read
  traffic. Impersonating the host requires a misissued certificate for the
  tunnel hostname, which would appear in Certificate Transparency logs.
  `opentunnel.xyz` is on the Public Suffix List, so other users' tunnels are
  cross-site; OpenCode's route on the same device is same-site, so mutations
  check `Origin` rather than rely on `SameSite`.
- First use provisions the identity and its certificate (about 30 seconds);
  the start request waits up to five minutes.
- Start records the choice in the registry file and only Stop clears it. A
  launch after Start reconnects in the background (`manager.resume()`) and
  issues no pairing code; shutdown, a fatal tunnel stop and a failed resume keep
  the choice, so the next launch retries. Only one backend per config
  directory resumes (`remote-control.owner`, live-PID lease replaced after a
  crash): OpenTunnel gives a route to one bridge and a contender retries until
  it takes over, so a second backend would otherwise silently serve the paired
  devices. An explicit Start always proceeds. Settings polls the status only while
  the tunnel is (re)connecting, keeps paired devices listed while it is off and
  offers Stop after a failed resume.
- Keep OpenTunnel's per-route PROXY protocol off: the ingress expects plain
  HTTP.

## Admission

`server/src/remote-control/`:

- `ingress.ts` marks every accepted socket as remote before any request is
  parsed and routes requests into the same Fastify application, with the
  local listener's timeouts (no request timeout, 72 s keep-alive). Its only
  WebSocket endpoints are web previews: `gate.ts` `admitRemoteUpgrade()` parses
  the target as the preview proxy does, then the manager hands the socket to the
  application's path-preview upgrade handler, never to the shared upgrade event.
  Every other upgrade gets 404.
- `request-origin.ts` is the only authority for local privileges:
  `isLocalRequest()` requires a loopback peer **and** a non-ingress socket.
- `gate.ts` runs before CORS, authentication and routing. It requires the exact
   tunnel `Host` and the public `Origin` on browser mutations, and strips forwarding
  headers. It accepts origin-form targets only (no absolute-form, leading `//`
  or fragment, which the router would reinterpret) and judges the path the
  router routes (`server/routed-path.ts`). It denies host-only paths: login and token
  bootstrap, Remote Control management, remote windows/proxy, SideCars,
  previews and the automation bridge. A live `/previews/<token>/…` capability
  is admitted without a device cookie or public `Origin` (its sandboxed document
  sends neither) while the host's **Web previews** switch is on, the default:
  `devices.ts` stores only the opt-out, `PUT /api/remote-control/previews` is
  host-only, and turning it off also closes live preview WebSockets. Remote
  `/api/meta` reports `previewsUnavailable` while it is off, so the UI hides
  its preview entry. Static UI bundle files stay public, as
  on local listeners, because browsers fetch the PWA manifest without cookies.
  Every other path requires a paired device. Refusals close the connection,
  because an unread body would otherwise break the client's next keep-alive
  request.
- A remote `/api/auth/status` without a valid device reports
  `pairingRequired`. The recovery dialog then explains how to pair again
  instead of offering password login, keeping the page and its drafts.
  Pairing from another tab restores it on the next check.
- `devices.ts` issues one 192-bit, five-minute, single-use pairing code shared by
   browser and server pairing. Consuming it through either route exhausts it for both. The link carries
  it in the fragment, never in the query or a log. It stores SHA-256 hashes of
  device credentials and expires devices after 30 days without use.
  `__Host-codenomad_device` is `Secure; HttpOnly; SameSite=Lax`. Revocation,
  and replacement of the least recently seen device at the 32-device limit,
  also destroy that device's open connections. The registry file is written
  only once Remote Control is used.
- Remote devices authenticate even with `--dangerously-skip-auth`, and the
  local session cookie is never accepted on the ingress.
- Browser pairing consumes the link in the intended browser/profile through
   `/api/remote-control/pair`. Its exact public `Origin` checks remain mandatory.
   Direct listeners refuse both pairing routes. Pasting a pairing link into the
   desktop server-add field saves the tunnel-origin profile and asks the local
   backend to redeem the code through the server protocol below. Embedded views
   retain their own remote-window authentication, independently of backend Browse
   pairing ([PROJECTS.md](PROJECTS.md#agent-conventions)). Never persist a pairing
   code or retain it for native opening.
- `--connect-server` opens a saved server or URL at launch through that same
  connect flow ([architecture.md](architecture.md#native-profiles-windows-and-client-state)).
  It refuses URLs with user info or a fragment, so a pairing code or password
   never travels on a command line; use the server-add field or the intended browser for pairing links.

## Backend-to-backend pairing

`POST /api/remote-control/server-pair` is a dedicated HTTPS tunnel-ingress
protocol. `server-pairing.ts` guards its exact routed path before CORS, authentication
and routing; the remote gate exempts only that path from browser mutation `Origin`
requirements. The direct listener returns 404. Never forge an `Origin` to pair.

- Require `X-CodeNomad-Server-Pairing: 1`, exact `Content-Type: application/json`,
  and a body of at most 4096 bytes: `{code, hostName}`, with a 32-character base64url
  code and a hostname of at most 255 characters.
- Refuse every non-POST and any presence of `Origin` (including `null`), `Cookie`,
  `Cookie2`, `Authorization`, `Proxy-Authorization`, `Referer`, `sec-fetch-*` or
  `access-control-request-*` headers before CORS. Responses carry `Cache-Control:
  no-store`, omit CORS and `Set-Cookie`, and return `{device, credential}` only to
  the calling backend on success. Code possession is the authorization; excluding
  ambient authentication and browser/preflight metadata confines this exchange
  to the explicit protocol while browser pairing keeps its own admission checks.
- Valid codes are checked and atomically consumed through the manager exchange
  before the global failure bucket: successful pairings always proceed, even
  after an anonymous failure flood, and never count toward the quota. The bucket
  allows ten failure responses per minute per remote backend, then returns 429
  with `Retry-After`. Replayed codes remain invalid and receive 401 or 429 according
  to the failure budget. The cryptographically random 192-bit code expires after
  300 seconds; even at one million guesses per second, the chance of guessing it
  is below 4.8 × 10^-50. Code entropy supplies the guessing resistance; the quota
  throttles failure responses while keeping valid links redeemable. Browser
  pairing has no failure quota and keeps its exact public `Origin` checks.
- The device uses the shared registry's 30-day idle expiry, revocation and
  least-recently-seen eviction. Its display name is `CodeNomad · <backend hostname>`:
  a self-reported label, with identity assurance supplied by code possession and
  the TLS endpoint rather than hostname attestation.

The local backend validates an HTTPS pairing link against the exact saved origin
before DNS resolution. A fresh, cookie-free, bounded exchange strips Undici Fetch
metadata, follows the saved TLS policy and endpoint-identity checks, and refuses
redirects and foreign origins. It verifies `/api/auth/status` reports device
authentication before persisting the device cookie in private
`remote-server-credentials.json` (mode `0600`). Protect the configuration directory
and its platform permissions as credential storage. The local UI receives only
success; secrets stay out of UI state and logs, and the add field is scrubbed after
the attempt. Never retain codes for retries.

The credential survives local launches. Forgetting the saved server deletes it;
revocation clears the rejected credential and returns Browse to its inline
password form. To repair tunnel browsing, use Back to Browse and paste a fresh
pairing link into the add field. Native embedded views pair separately.

Compatibility is capability-based: an endpoint returning 403 (including an older
browser-Origin rejection), 404 or 405 maps to `pairing_unavailable` and offers
inline password recovery. Password login on tunnel ingress remains host-only:
update the remote server for backend pairing, or save its direct-listener URL for
password access. Invalid, expired or replayed codes map to `pairing_expired`
(`pairingExpired` in UI translations); 429 maps to `pairing_rate_limited`
(`pairingRateLimited`). Obtain a fresh link for expired codes and wait before
retrying a rate-limited attempt.

## Validation

- `remote-surface.test.ts` drives the real `createHttpServer` through the
  ingress. It covers unpaired access, pairing, `Origin`/`Host` checks,
  host-only paths including encoded ones, loopback privileges, spoofed headers,
  upgrades, web previews and their switch, revocation of a live stream, skipped
  local auth and tunnel failure.
- `manager.test.ts` covers resuming after a restart, Stop, never-started
  installations, failed resumes and backends sharing a configuration;
  `owner-lease.test.ts` the lease; `tests/browser/remote-control-settings.test.ts`
  the settings panel after a failed, skipped or slow resume and across a reconnect.
- `scripts/remote-control-live.test.ts` (opt-in,
  `CODENOMAD_REMOTE_CONTROL_LIVE=1`) repeats the flow through the hosted
  relay, using a throwaway profile and data directory, and deletes that tunnel
  afterwards. It creates a public, certificate-logged hostname.
- The packaged smoke test imports the bundled runtime with the packaged Node.

## Agent conventions

- Remote Access settings put Remote Control first. Direct/LAN access (listening mode, server password, reachable addresses) sits in one collapsed disclosure that opens by itself while the server listens beyond localhost. Its texts refer to direct connections only, because Remote Control pairs devices and needs neither a password nor an open port. It uses the shared `.settings-disclosure` (`styles/components/settings-disclosure.css`).
- The tunnel runtime (`build:remote-tunnel`) keeps its own backend-side Effect runtime, separate from OpenCode's native plugin graph. Ingress sockets are remote by membership: grant local privileges only through `isLocalRequest()`/`isLoopbackRequest()`, never peer addresses or headers. The resume lease lives in `owner-lease.ts`; never auto-start an installation that was not started. Run the Validation tests above when changing the transport.
