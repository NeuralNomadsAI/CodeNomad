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
- The direct listener applies the shared host-only paths to every non-local
  request, including encoded route targets and SideCar WebSocket upgrades.
  Direct password login, its page and logout remain available to LAN clients.
  `GET /api/remote-control/status` is available to authenticated clients and
  returns `manageable: false` for non-local peers. SideCar registration APIs remain
  available to authenticated clients; content and WebSockets require loopback.
  Live preview capabilities retain their scoped admission. `/api/meta` reports
  `localRequest` using that same transport authority; the UI hides password changes,
  SideCar opening and remote-server management unless it is true.
- `gate.ts` runs before CORS, authentication and routing. It requires the exact
  tunnel `Host` and the public `Origin` on browser mutations, and strips forwarding
  headers. It accepts origin-form targets only (no absolute-form, leading `//`
  or fragment, which the router would reinterpret) and judges the path the
  router routes (`server/routed-path.ts`). It denies host-only paths: login and token
  bootstrap, Remote Control management, remote windows/proxy, SideCar content,
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
- Server-to-server `POST /api/remote-control/pair` accepts a valid one-use
  code with no Origin, Referer or browser fetch metadata. Browser pairing
  supplies the exact tunnel Origin. Other tunnel mutations require that Origin.
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

Experimental Settings → Servers uses the host client for `POST /api/remote-servers/:id/connect` and `forget`, with caller cancellation and stable typed errors. Pairing keeps verified TLS, clears its field before waiting and saves only the origin. Its private device identity persists beside the host configuration across launches. Same-origin/TLS renames keep that identity. Removal captures the profile policy, awaits Forget and then awaits profile persistence; a refused persistence leaves an actionable save error and the registered row. Mounting, adding and editing profiles are independent of backend attachment and project creation. View cancellation fences continuations while already dispatched durable mutations retain their result.

An optional saved `ssh.host` routes the profile through a backend-owned OpenSSH local forward to its remote-visible `baseUrl`. The destination is part of credential scope and profile generation. Relay proofs bind that declared origin, SSH host and TLS policy. Each new forward with an admitted identity gates all waiting operations on one shared, bounded metadata check through that exact forward, using the saved TLS policy and declared server hostname. A matching `serverId` preserves the proof; a changed, missing or unreadable identity revokes it, removes credentials and closes the forward before business dispatch. Host retargeting also revokes the generation. SSH uses strict known-host verification and batch key authentication; the remote CodeNomad instance is already running. `GET /api/remote-servers/ssh-hosts` shares the local relay guard and suggests concrete aliases from the backend account's `~/.ssh/config` and Includes. Stable failures are `ssh_unavailable`, `ssh_host_key` and `ssh_auth`. Tests in `codenomad-servers/ssh.test.ts` and `ssh-manager.test.ts` cover parsing, process readiness, authentication failure, credential scope, relay proof lifetime, concurrent renewal gates and shared tunnel ownership.

The local CodeNomad backend connects to saved CodeNomad profiles through `codenomad-servers/`. Its browse/connect/forget routes and `/api/backends/:profileId/*` require both `isLocalRequest()` and exact loopback local-origin provenance. Same-origin EventSource and media reads use a loopback self Referer with `Sec-Fetch-Site: same-origin` when the browser omits Origin. Foreign, null and absent provenance, LAN peers and Remote Control ingress sockets are refused before credential or network access. Server-advertised LAN/remote addresses also stay outside this loopback-origin authority. Remote pages and opaque preview/extension frames stay outside this authority. SideCars intentionally share the local UI's origin and full application privileges, including this relay and OpenCode command execution; they are trusted extensions.

The saved profile alone selects the destination and TLS verification policy. The explicit transport pins validated DNS answers to the connection, keeps the saved hostname for TLS verification and SNI, never follows redirects and never manufactures Origin or browser Fetch Metadata. Caller cookies, authorization and forwarding headers stay local; private session/device cookies stay in the backend's mode-0600 store beside its configuration. Response cookies and authentication headers remain private. Response documents receive sandbox CSP and `nosniff`; the relay publishes a small response-header allowlist. Log records retain fixed relay route names and completion metadata, excluding request payloads and target queries.

HTTP, HTTPS and the private bridge share the backend's connection authority and private credential cache. Admission captures the profile id, exact origin, TLS policy and revocable generation before entering a queue; dispatch and publication recheck that owner. Retargeting or changing TLS invalidates pending and queued operations and the stored identity. Stored identities include their TLS policy; entries without that field bind to verified TLS. Forget through any listener closes all of that profile's streams and removes its identity for every listener. The backend owns shutdown; a standalone listener releases its shared lease without closing another listener's owner.

Multi-backend registry candidates opt into a destination-generation proof. Their fresh, bounded metadata read observes remote `serverId`, rechecks the captured authority and returns the locally generated `X-CodeNomad-Backend-Authority` header. The candidate admits that proof once after compatibility validation. Its HTTP requests carry the header; resource and EventSource URLs carry `__codenomad_authority`. Both carriers stay local and are stripped upstream. Invalid or revoked proofs fail before client/fetch/DNS, with no recapture. Bootstrap is restricted to GET metadata, GET auth status and POST login for pre-admission authentication. Ordinary opted-in operations with no proof fail before dispatch. Existing clients without this opt-in keep their request contract.

Removal/recreation, address/TLS changes, Forget, explicit authentication-principal replacement, observed remote identity change and last-owner shutdown revoke the proof. Rename and same-principal cookie renewal retain it. Cleanup retries, including cancel/release/close without an attachment signal, retain their original proof and can remain pending after revocation. A mutation already dispatched may finish remotely; revocation provides no rollback or replay. These fences complement the existing provenance, authentication, route and TLS admission.

Proof-bearing and bootstrap transfers select status observation per call. On a business 401, the captured client observes `/api/auth/status` with its live private cookies before deciding whether to revoke its authority. Authenticated status preserves the original 401 and its body, credentials, proof and streams. False status permits one private password restoration and a fresh status, except when pairing is required; device/session identities retain their authentication kind. The business request is sent once, including after successful restoration. A confirmed rejection revokes only the still-current captured client. Network, TLS, timeout and invalid status responses remain unavailable and preserve the saved identity.

Direct opted-in status reads join the same client/principal flight across caller signals. Its eight-second monotonic deadline is checked at dispatch, cookie effects and verdict publication, covering headers, body validation and cancellation, with at most two status GETs and one password login, including any preliminary or already-running login. Status JSON requires UTF-8, a matching schema and at most 4096 decoded bytes checked during streaming. Cancelling one follower releases only its wait; the last follower cancels its privately owned exchange, while a legacy-owned login retains its own cancellation. Completion releases the active observation by identity; later calls observe afresh, while already-admitted business calls retain their original deadline and quotas. Shared login IO and cookie effects belong to its live borrowing flights and any legacy owner, within the login's original ten-second limit. Legacy promotion carries the right to publish confirmed login rejection once; departed or expired borrowers lose their rights. Legacy calls keep their existing recovery contract on the same cached client.

`POST /api/remote-control/server-pair` is a dedicated ingress-only, cookie-free protocol with `X-CodeNomad-Server-Pairing: 1`, a strict JSON body and no Origin, Referer, authorization or browser metadata. It atomically consumes the ordinary five-minute pairing code and returns one revocable device credential to the local backend. Invalid attempts have a backend-wide failure bucket; a valid high-entropy code remains usable. Servers without this route yield a stable `pairing_unavailable` result. Password connections use the direct listener's existing login policy and private session cookies.

An authenticated device request carrying `X-CodeNomad-Server-Request: 1` can mutate through the ingress or direct listener while carrying no browser context: Origin, Referer, Fetch Metadata, client hints and preflight headers, including empty ones, exclude this admission. Browser requests continue to require the public Origin. Device scope applies on both listeners, with host-only paths and nested backend relays denied. Invalid explicit device credentials never fall back to password sessions or skipped authentication. Revocation, eviction, Stop, shutdown and tunnel failure destroy admitted device sockets on both listeners. Profile removal or retargeting similarly aborts local uploads/SSE and deletes its private identity; pending connection results check their captured owner before saving.

`gate.ts` maintains the closed `SERVER_DEVICE_ROUTES` catalog of method/path pairs for the relay's existing backend API contracts. Additions require review of the caller and remote route together; unknown paths and unlisted methods return 404. Direct requests using the explicit device protocol stay within this catalog even when they carry browser headers. Browser pairing (`/remote-pair`, `/api/remote-control/pair`) and server pairing judge the physical ingress socket before device attachment; their route handlers also require ingress membership.

| Reviewed device-route family | Admission surface |
|---|---|
| Identity and connection | GET auth status, metadata, events and read-only Remote Control status; POST connection pong. |
| Backend data and preferences | Explicit filesystem, config-file, storage owner/instance, usage, runtime, speech, SideCar/previews and panel-extension method/path pairs in `SERVER_DEVICE_ROUTES`; existing host-only exclusions still apply. |
| Project operations | Workspace inventory/lifecycle, directory-owned background Shell inventory (GET), worktrees, files/Git, plugin/integration settings, accounts/usage, session media/history/pruning, pending requests, Missions and Yolo method/path pairs. |
| Native workspace API | `/workspaces/:id/instance/api/…` under the existing `isAllowedInstanceApiRoute()` allowlist and workspace/location ownership checks in `http-server.ts`. |

Browser traffic on the ingress retains its existing public-Origin and device admission. Browser-pairing authority comes from physical ingress membership.

### Isolated remote preview capabilities

Remote preview creation and revocation use the host's
`/api/backends/:id/preview-capabilities` routes with the same local-origin guard
and a required current relay-authority header. A separate content-only loopback
listener maps a random local capability to one backend generation and remote
preview. Its HTTP and WebSocket transports pin the saved destination, preserve
TLS hostname verification and borrow the identity-gated SSH forward when present.
The backend's private connection identity is used only for preview creation and
deletion. Content uses the remote preview's existing cookie-free capability
protocol; Remote Control's preview switch continues to govern ingress content.
Ingress clients remain subject to the host-only gate for capability management.
Each content document retains its exclusive origin inside the sandbox. Origin
carriers and WebSocket handshakes require that exact origin; CORS reflects only
the owning origin. Same-origin resource policy protects no-CORS sub-resources,
and frame-ancestor policy restricts embedding to that content origin and its
issuing local UI.
See [Browser Automation](BROWSER_AUTOMATION.md#remote-preview-content-transport)
for the API and revocation lifetime.

Remote project previews retain their issuing client for dismissal, tab cleanup
and attachment revocation. Renderer `pagehide` sends keepalive capability deletion
under that same proof. Displayed addresses and persisted history use application
URLs; loading capabilities remain inside the embedded preview.

The isolated listener refuses service-worker script fetches before dispatch and
keeps scope-widening response headers private. Expired content-origin network
responses request storage cleanup independently of the host UI's storage.

## Direct listener origins and password sessions

The direct listener grants credentialed CORS to its advertised local and remote
origins, reachable interface addresses and explicit `CODENOMAD_ALLOWED_ORIGINS`.
This environment variable is a comma-separated list of exact HTTP(S) origins,
for example `https://code.example.test,https://ui.example.test:8443`. Paths,
credentials, opaque origins and wildcards fail startup. Configure DNS aliases,
reverse-proxy public origins and separately hosted UIs here, then restart.
Forwarding headers grant neither origins nor local privileges; a proxy connected
over loopback has the privileges of its loopback transport and needs an enforcing
trusted perimeter. The configured UI development origin is admitted for local
requests. A same-origin local request (Origin equal to the targeted Host) also
reaches the listening socket under the loopback names its bind address covers,
with the socket's protocol and port: `localhost` for `127.0.0.1` and `::1`, plus
`127.0.0.1` for `0.0.0.0`, plus `[::1]` for `::`. An alias page targeting another
authority stays cross-origin, since the name can resolve to a sibling listener.
Configured and development origins stay exact; their ports open no loopback
alias. CORS for opaque preview documents is scoped to live preview capabilities.
Preview capability admission requires the matched route's `previewCapability`
configuration; a capability Host on an ordinary application route retains that
route's authentication, origin and host-only checks.

Direct state-changing requests check Origin first, then the origin of Referer
when Origin is absent. Non-local mutations require an allowed source; native
loopback calls may omit both. Read-only methods are GET, HEAD and OPTIONS.
Authentication and the host-only gate also apply with explicitly allowed origins;
`--dangerously-skip-auth` retains the origin and host-only gates.

SideCar WebSocket upgrades apply this same Origin/Referer policy before opening
an upstream connection, alongside their loopback transport and session checks.
Native loopback upgrades may omit both source headers. Preview WebSockets use
their scoped capability admission.

Password sessions expire after 24 hours without an authenticated request and
after seven days from creation. `CODENOMAD_SESSION_IDLE_SECONDS` and
`CODENOMAD_SESSION_ABSOLUTE_SECONDS` configure positive integer lifetimes in
seconds at startup. Logout revokes its current token; a successful persistent
password change revokes every session for that user, including the caller.
A failed password change preserves the existing sessions. Remote Control device
credentials follow their separate registry lifetime and revocation rules.

## Validation

- `codenomad-servers/ssh-manager.test.ts` exercises private authentication restoration through the owned SSH dial, single business dispatch and stale-proof refusal before IO after SSH retargeting. Concurrent mutations, direct status reads and post-401 observations share the renewal identity gate; a changed, missing or refused identity prevents status dispatch through the replacement forward.

- `codenomad-servers/review-regressions.test.ts` covers queued credentials across address/TLS changes, persisted TLS binding, cross-listener Forget, shared-owner shutdown and direct browser-pairing refusal. `remote-control/device-relay-r1.test.ts` exercises the closed route/method catalog and preserves browser pairing on the ingress.

- `remote-surface.test.ts` drives the real `createHttpServer` through the
  ingress. It covers unpaired access, pairing, `Origin`/`Host` checks,
  host-only paths including encoded ones, loopback privileges, spoofed headers,
  upgrades, web previews and their switch, revocation of a live stream, skipped
  local auth and tunnel failure.
- `direct-listener.test.ts` exercises the real application with LAN and loopback
  peers, credentialed CORS, Origin/Referer checks and host-only routes.
  `server/__tests__/sidecar-proxy.test.ts` covers SideCar upgrade source checks,
  refusal before upstream contact, authenticated and skipped-auth exchanges,
  native origin-less calls and logout revocation.
  `session-manager.test.ts` covers idle/absolute deadlines, configuration and
  revocation; `auth-responsiveness.test.ts` covers logout and password replacement
  through real auth routes alongside concurrent credential checks.
- `manager.test.ts` covers resuming after a restart, Stop, never-started
  installations, failed resumes and backends sharing a configuration;
  `owner-lease.test.ts` the lease; `tests/browser/remote-control-settings.test.ts`
  the settings panel after a failed, skipped or slow resume and across a reconnect.
- `scripts/remote-control-live.test.ts` (opt-in,
  `CODENOMAD_REMOTE_CONTROL_LIVE=1`) repeats the flow through the hosted
  relay, using a throwaway profile and data directory, and deletes that tunnel
  afterwards. It creates a public, certificate-logged hostname.
- The packaged smoke test imports the packaged server with each host's server
  runtime: Tauri's bundled Node, or the Electron executable with
  `ELECTRON_RUN_AS_NODE=1` and `ELECTRON_NO_ASAR=1`.

## Agent conventions

- Remote Access settings put Remote Control first. Direct/LAN access (listening mode, server password, reachable addresses) sits in one collapsed disclosure that opens by itself while the server listens beyond localhost. Its texts refer to direct connections only, because Remote Control pairs devices and needs neither a password nor an open port. It uses the shared `.settings-disclosure` (`styles/components/settings-disclosure.css`).
- The tunnel runtime (`build:remote-tunnel`) keeps its own backend-side Effect runtime, separate from OpenCode's native plugin graph. Ingress sockets are remote by membership: grant local privileges only through `isLocalRequest()`/`isLoopbackRequest()`, never peer addresses or headers. The resume lease lives in `owner-lease.ts`; never auto-start an installation that was not started. Run the Validation tests above when changing the transport.
