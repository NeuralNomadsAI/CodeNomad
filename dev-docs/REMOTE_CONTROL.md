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
- `devices.ts` issues one five-minute, single-use pairing code. The link carries
  it in the fragment, never in the query or a log. It stores SHA-256 hashes of
  device credentials and expires devices after 30 days without use.
  `__Host-codenomad_device` is `Secure; HttpOnly; SameSite=Lax`. Revocation,
  and replacement of the least recently seen device at the 32-device limit,
  also destroy that device's open connections. The registry file is written
  only once Remote Control is used.
- Remote devices authenticate even with `--dangerously-skip-auth`, and the
  local session cookie is never accepted on the ingress.
- A desktop CodeNomad pairs as a device: pasting a pairing link into Add server
  saves only the tunnel origin and opens the remote window once on the link
  (`lib/remote-pairing-link.ts`). The profile keeps TLS verification on, since
  a Tauri TLS-proxy window uses an incognito store without the device cookie.
  The code is never stored with the server;
  re-pairing a saved server reuses its window storage, which keeps the device
  cookie across launches. Covered by `tests/browser/remote-server-pairing.test.ts`.
- `--connect-server` opens a saved server or URL at launch through that same
  connect flow ([architecture.md](architecture.md#native-profiles-windows-and-client-state)).
  It refuses URLs with user info or a fragment, so a pairing code or password
  never travels on a command line; pair from Add server instead.

## Saved-profile relay

An optional saved `ssh.host` routes the profile through a backend-owned OpenSSH local forward to its remote-visible `baseUrl`. The destination is part of credential scope and profile generation. SSH uses strict known-host verification and batch key authentication; the remote CodeNomad instance is already running. `GET /api/remote-servers/ssh-hosts` shares the local relay guard and suggests concrete aliases from the backend account's `~/.ssh/config` and Includes. Stable failures are `ssh_unavailable`, `ssh_host_key` and `ssh_auth`. Tests in `codenomad-servers/ssh.test.ts` and `ssh-manager.test.ts` cover parsing, process readiness, authentication failure, credential scope and shared tunnel ownership.

The local CodeNomad backend connects to saved CodeNomad profiles through `codenomad-servers/`. Its browse/connect/forget routes and `/api/backends/:profileId/*` require both `isLocalRequest()` and exact loopback local-origin provenance. Same-origin EventSource and media reads use a loopback self Referer with `Sec-Fetch-Site: same-origin` when the browser omits Origin. Foreign, null and absent provenance, LAN peers and Remote Control ingress sockets are refused before credential or network access. Server-advertised LAN/remote addresses also stay outside this loopback-origin authority. Remote pages and opaque preview/extension frames stay outside this authority. SideCars intentionally share the local UI's origin and full application privileges, including this relay and OpenCode command execution; they are trusted extensions.

The saved profile alone selects the destination and TLS verification policy. The explicit transport pins validated DNS answers to the connection, keeps the saved hostname for TLS verification and SNI, never follows redirects and never manufactures Origin or browser Fetch Metadata. Caller cookies, authorization and forwarding headers stay local; private session/device cookies stay in the backend's mode-0600 store beside its configuration. Response cookies and authentication headers remain private. Response documents receive sandbox CSP and `nosniff`; the relay publishes a small response-header allowlist. Log records retain fixed relay route names and completion metadata, excluding request payloads and target queries.

HTTP, HTTPS and the private bridge share the backend's connection authority and private credential cache. Admission captures the profile id, exact origin, TLS policy and revocable generation before entering a queue; dispatch and publication recheck that owner. Retargeting or changing TLS invalidates pending and queued operations and the stored identity. Stored identities include their TLS policy; entries without that field bind to verified TLS. Forget through any listener closes all of that profile's streams and removes its identity for every listener. The backend owns shutdown; a standalone listener releases its shared lease without closing another listener's owner.

`POST /api/remote-control/server-pair` is a dedicated ingress-only, cookie-free protocol with `X-CodeNomad-Server-Pairing: 1`, a strict JSON body and no Origin, Referer, authorization or browser metadata. It atomically consumes the ordinary five-minute pairing code and returns one revocable device credential to the local backend. Invalid attempts have a backend-wide failure bucket; a valid high-entropy code remains usable. Servers without this route yield a stable `pairing_unavailable` result. Password connections use the direct listener's existing login policy and private session cookies.

An authenticated device request carrying `X-CodeNomad-Server-Request: 1` can mutate through the ingress or direct listener while carrying no browser context: Origin, Referer, Fetch Metadata, client hints and preflight headers, including empty ones, exclude this admission. Browser requests continue to require the public Origin. Device scope applies on both listeners, with host-only paths and nested backend relays denied. Invalid explicit device credentials never fall back to password sessions or skipped authentication. Revocation, eviction, Stop, shutdown and tunnel failure destroy admitted device sockets on both listeners. Profile removal or retargeting similarly aborts local uploads/SSE and deletes its private identity; pending connection results check their captured owner before saving.

`gate.ts` maintains the closed `SERVER_DEVICE_ROUTES` catalog of method/path pairs for the relay's existing backend API contracts. Additions require review of the caller and remote route together; unknown paths and unlisted methods return 404. Direct requests using the explicit device protocol stay within this catalog even when they carry browser headers. Browser pairing (`/remote-pair`, `/api/remote-control/pair`) and server pairing judge the physical ingress socket before device attachment; their route handlers also require ingress membership.

| Reviewed device-route family | Admission surface |
|---|---|
| Identity and connection | GET auth status, metadata, events and read-only Remote Control status; POST connection pong. |
| Backend data and preferences | Explicit filesystem, config-file, storage owner/instance, usage, runtime, speech, SideCar/previews and panel-extension method/path pairs in `SERVER_DEVICE_ROUTES`; existing host-only exclusions still apply. |
| Project operations | Workspace inventory/lifecycle, worktrees, files/Git, plugin/integration settings, accounts/usage, session media/history/pruning, pending requests, Missions and Yolo method/path pairs. |
| Native workspace API | `/workspaces/:id/instance/api/…` under the existing `isAllowedInstanceApiRoute()` allowlist and workspace/location ownership checks in `http-server.ts`. |

Browser traffic on the ingress retains its existing public-Origin and device admission. Browser-pairing authority comes from physical ingress membership.

## Validation

- `codenomad-servers/review-regressions.test.ts` covers queued credentials across address/TLS changes, persisted TLS binding, cross-listener Forget, shared-owner shutdown and direct browser-pairing refusal. `remote-control/device-relay-r1.test.ts` exercises the closed route/method catalog and preserves browser pairing on the ingress.

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
