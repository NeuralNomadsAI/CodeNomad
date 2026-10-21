# Remote Control

Remote Control reaches CodeNomad from another device without an inbound port.
It is separate from direct `--host` access; neither falls back to the other.

```text
browser ─TLS─▶ OpenTunnel relay (forwards ciphertext) ─▶ OpenTunnel SDK in the backend (TLS ends here)
        ─TCP─▶ remote-only loopback ingress ─▶ remote gate ─▶ the normal CodeNomad application
```

## Transport

- `packages/remote-tunnel` wraps `@opentunnel/client` behind CodeNomad-owned
  types. The server build bundles it into `dist/remote-control/tunnel-runtime.js`
  with the Effect copy it resolves (the SDK peers `effect ^4.0.0`; since
  OpenCode 2.0.27 the workspace shares one stable 4.0.x). It was introduced
  while `@opencode/client` pinned `4.0.0-rc.112`, where a strict npm install of
  both side by side failed with `ERESOLVE`; the published server still keeps no runtime
  dependency on the private workspace package.
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
  devices. An explicit Start is not blocked. Settings polls the status only while
  the tunnel is (re)connecting, keeps paired devices listed while it is off and
  offers Stop after a failed resume.

## Admission

`server/src/remote-control/`:

- `ingress.ts` marks every accepted socket as remote before any request is
  parsed and routes requests into the same Fastify application, with the
  local listener's timeouts (no request timeout, 72 s keep-alive). Upgrades are
  refused: the remote surface exposes no WebSocket endpoint.
- `request-origin.ts` is the only authority for local privileges:
  `isLocalRequest()` requires a loopback peer **and** a non-ingress socket.
- `gate.ts` runs before CORS, authentication and routing. It requires the exact
  tunnel `Host` and the public `Origin` on mutations, and strips forwarding
  headers. It accepts origin-form targets only (no absolute-form, leading `//`
  or fragment, which the router would reinterpret) and judges the path the
  router routes: percent-decoded and cut at `;`. It denies host-only paths: login and token
  bootstrap, Remote Control management, remote windows/proxy, SideCars,
  previews and the automation bridge. Static UI bundle files stay public, as
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

## Validation

- `remote-surface.test.ts` drives the real `createHttpServer` through the
  ingress. It covers unpaired access, pairing, `Origin`/`Host` checks,
  host-only paths including encoded ones, loopback privileges, spoofed headers,
  upgrades, revocation of a live stream, skipped local auth and tunnel failure.
- `manager.test.ts` covers resuming after a restart, Stop, never-started
  installations, failed resumes and backends sharing a configuration;
  `owner-lease.test.ts` the lease; `tests/browser/remote-control-settings.test.ts`
  the settings panel after a failed, skipped or slow resume and across a reconnect.
- `scripts/remote-control-live.test.ts` (opt-in,
  `CODENOMAD_REMOTE_CONTROL_LIVE=1`) repeats the flow through the hosted
  relay, using a throwaway profile and data directory, and deletes that tunnel
  afterwards. It creates a public, certificate-logged hostname.
- The packaged smoke test imports the bundled runtime with the packaged Node.

Measured on 2026-10-09 with the hosted relay: HTTPS with a publicly trusted
certificate, an 8 MiB upload, SSE with cancellation reaching the target, and
WebSocket text and binary all worked. A reader stalled on a 64 MiB download did
not delay other requests on the same bridge. On Node 24/25, undici's
`WebSocket.bufferedAmount` grows to 31.8 MiB against a paused peer, so the
SDK's 1 MiB/256 KiB watermarks apply. The `bufferedAmount = 0` defect reported
upstream affects Bun only.

## Upstream

- [anomalyco/opentunnel#34](https://github.com/anomalyco/opentunnel/pull/34):
  both clients enforce the `max_conns` they advertise.
- [anomalyco/opentunnel#45](https://github.com/anomalyco/opentunnel/issues/45)
  (0.5.1): API calls retry transient failures (5xx, Cloudflare 52x) with capped
  backoff, errors name the HTTP status, and `connect` keeps an unexpired saved
  certificate when the check still fails. CodeNomad does not enable the 0.5.0
  per-route PROXY protocol: the ingress expects plain HTTP.
- Open topics: atomic identity writes with a provisioning lock, an in-process
  connection target (no loopback hop, preserved peer address) and
  per-connection flow control. The repository now accepts issues only.

## Agent conventions

These rules moved here from `AGENTS.md`, which indexes this document; they bind every change in this area.

- Remote Access settings put Remote Control first. Direct/LAN access (listening mode, server password, reachable addresses) sits in one collapsed disclosure that opens by itself while the server listens beyond localhost. Its texts refer to direct connections only, because Remote Control pairs devices and needs neither a password nor an open port. It uses the shared `.settings-disclosure` (`styles/components/settings-disclosure.css`).
- Remote Control uses the OpenTunnel SDK through `packages/remote-tunnel`, bundled into the server build (`build:remote-tunnel`) with its own backend-side Effect runtime, separate from OpenCode's native plugin graph. Claim only CodeNomad's own route on the device's shared identity and never delete that identity. Ingress sockets are remote by membership: grant local privileges only through `isLocalRequest()`/`isLoopbackRequest()`, never peer addresses or headers. Pairing, devices and admission live in `server/src/remote-control/`. Start is remembered until an explicit Stop and resumes at launch without a pairing code, in one backend per config directory (`owner-lease.ts`); never auto-start an installation that was not started. Run `remote-surface.test.ts` and `manager.test.ts`, plus the opt-in hosted-relay `scripts/remote-control-live.test.ts` when changing the transport. See `dev-docs/REMOTE_CONTROL.md`.
