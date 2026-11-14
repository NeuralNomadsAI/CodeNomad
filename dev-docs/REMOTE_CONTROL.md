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
