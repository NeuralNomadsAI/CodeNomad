# Remote Control

Remote Control reaches CodeNomad from another device without an inbound port.
Keep it independent of direct `--host` access; never fall back between them.

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
- The relay observes hostnames, connection timing and sizes; TLS keeps traffic encrypted.
  Impersonating the host requires a misissued certificate for the
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

## Administrator policy

`server/network-policy.ts` reads two variables from the environment the backend
inherits, so machine-wide values reach every desktop launch and the UI cannot
override them. An unknown value refuses startup.

- `CODENOMAD_REMOTE_CONTROL=disabled`: the manager opens no tunnel, skips the
  launch resume (keeping the registry's choice), refuses Start and pairing links
  (`403`, `code: "remote_control_disabled"`) and authorizes no device. Its status
  carries `disabledByAdministrator`; Settings shows that state, hides Start,
  pairing and previews, and keeps paired devices listed for revocation.
- `CODENOMAD_LOCKED_HOST=<address>`: the listening address, validated like
  `--host`, wins over `--host`, `CLI_HOST` and the desktop listening switch (the
  hosts still pass their own `--host`). `ServerMeta.listeningLocked` disables the
  switch in Remote Access settings. An intranet address keeps direct access for
  colleagues; `127.0.0.1` keeps it on this machine.

## Admission

`server/src/remote-control/`:

- `ingress.ts` marks every accepted socket as remote before any request is
  parsed and routes requests into the same Fastify application, with the
   local listener's timeouts (no request timeout, 72 s keep-alive). Its two
   WebSocket surfaces are live web preview capabilities and voice. The manager
   routes each to its dedicated handler; other upgrades get 404.
- `request-origin.ts` is the only authority for local privileges:
  `isLocalRequest()` requires a loopback peer **and** a non-ingress socket.
- The direct listener applies the shared host-only paths to every non-local
  request, including encoded route targets and SideCar WebSocket upgrades.
  Direct password login, its page and logout remain available to LAN clients.
  `GET /api/remote-control/status` is available to authenticated clients and
  returns `manageable: false` for non-local peers. SideCar registration APIs remain
  available to authenticated clients; content and WebSockets require loopback,
  except under the host's SideCar opt-in below.
  Live preview capabilities retain their scoped admission. `/api/meta` reports
   `localRequest` using that same transport authority; the UI restricts password changes
   to that authority. `/api/meta` also reports
  `sidecarsAllowed` (local, or admitted by the opt-in); the UI shows SideCar opening
  and the picker only when it or `localRequest` is true.
- SideCar opt-in over direct HTTPS: the host setting `server.sidecarsOverDirectHttps`
  (`config.yaml`, off unless `true`; **Settings → SideCars → Open SideCars over HTTPS**,
  shown to local clients only) lifts the host-only gate for `/sidecars/` content and
  SideCar WebSocket upgrades, and nothing else, for a direct-listener request from a
  verified direct HTTPS origin (`server/sidecar-direct-https.ts`). The origin rule is
  `remote-control/direct-https.ts`: the `https:` advertised local/remote URLs, reachable
  addresses and `CODENOMAD_ALLOWED_ORIGINS` entries, never loopback or unspecified
  hosts; mutations need their own `Origin`; GET/HEAD/OPTIONS use `Origin`, else the
  `Referer` origin, else `https://` plus `Host`; ingress sockets never qualify. Plain-HTTP
  LAN, loopback-alias and foreign or opaque origins stay refused. Authentication, the
  direct source policy, SideCar cookie stripping and WebSocket Origin/Referer checks
  still apply. Admission reads the setting from `config.yaml` as it is now
  (`SettingsService.serverFlag`, `settings/server-flag-reader.ts`: re-parsed when its stat
  signature changes; missing, unreadable or invalid reads as off), never the display cache,
  so a host edit applies to the next request. The config routes refuse a change to this key
  from non-local requests with 403 (`settings/host-only-settings.ts`), including deleting
  the server owner, judged against the authoritative document each write starts from.
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
  its preview entry. Static UI bundle files stay public, as on local listeners,
  because browsers fetch the PWA manifest without cookies. Packaged and
  downloadable bundles include smaller `.br` and `.gz` variants beside
  originals of at least 1 KiB. Downloadable bundles keep HTML at its
  original paths for compatible servers. Custom bundles can supply static
  variants. The server negotiates on the original URL with `Accept-Encoding`
  and preserves its media type; equal weights prefer Brotli to gzip.
  HTML entry points and their compressed variants require a paired device.
  Refusals close the connection,
  because an unread body would otherwise break the client's next keep-alive
  request.
- Server-to-server `POST /api/remote-control/pair` accepts a valid one-use
  code with no Origin, Referer or browser fetch metadata. Browser pairing
  supplies the exact tunnel Origin. Other tunnel mutations require that Origin.
- `GET` and `HEAD` navigations to `/remote-pair` and `/` accept external links
  on the tunnel and verified direct HTTPS hosts. Direct entry reads without an
  explicit `Origin` use the target host; API admission retains its source checks.
- A remote `/api/auth/status` without a valid device reports
  `pairingRequired`. The recovery dialog then explains how to pair again
  instead of offering password login, keeping the page and its drafts.
  Pairing from another tab restores it on the next check.
- `devices.ts` issues one five-minute, single-use pairing code at a time, bound
  to one channel: the tunnel, or one verified direct HTTPS origin. A code
  redeems only on its channel, and the device it creates authenticates only
  there. Stop and tunnel failure cancel only a tunnel code. The link carries
  it in the fragment, never in the query or a log. It stores SHA-256 hashes of
  device credentials and expires devices after 30 days without use.
  `__Host-codenomad_device` is `Secure; HttpOnly; SameSite=Lax`. Revocation,
  and replacement of the least recently seen device at the 32-device limit,
  also destroy that device's open connections. The registry file is written
  only once Remote Control is used.
- Remote devices authenticate even with `--dangerously-skip-auth`, and the
  local session cookie is never accepted on the ingress.
- With `multiBackend` enabled, paste a pairing link into the server address field
  in Browse or Settings → Servers. The host relay pairs as a device, keeps TLS
  verification on and retains the device credential in its private store. The
  profile saves the origin; the one-use code is cleared before network dispatch.
- With `multiBackend` off, paste the link into the separate-window server dialog
  (`lib/remote-pairing-link.ts`). It saves the origin and opens the link once in
  the remote window. TLS verification stays on; a Tauri TLS-proxy window uses an
  incognito store. Re-pairing against the same origin reuses that window's
  device-cookie storage. See `tests/browser/remote-server-pairing.test.ts`.
- `--connect-server` opens a saved server or URL at launch through the separate
  desktop-window flow regardless of `multiBackend` ([architecture.md](architecture.md#native-profiles-windows-and-client-state)).
  It refuses URLs with user info or a fragment, so a pairing code or password
  never travels on a command line; use the pairing field instead.

## Saved-profile relay

### Remote UI operation lifetime

Every admitted operation uses one request principal captured by the common `onRequest` hook before body parsing. Its signal follows queued work and IO; dispatch and publication check that same signal. Revocation closes the client response and upstream work. A completed explicit profile mutation retains its durable result.
An originless native caller keeps local UI authority on a loopback target Host. A declared public HTTP Host through a loopback proxy keeps its remote class, including when Origin/Referer are absent; secret entry then remains refused.

| Surface | Capture and revocation | Shared work | Publication and logs |
|---|---|---|---|
| `/api/backends/*`, bootstrap and ordinary reads/mutations | Common pre-body capture; signal through HTTP, queued authentication and raw uploads | Borrower-aware authentication observation, including calls without a proof | Check before dispatch and publication; proof carriers stripped upstream |
| Backend SSE / streaming uploads | Same capture; invalidation aborts upstream and client streams | Each request owns its IO; shared authentication keeps independent borrowers | Stream signal remains live through the body |
| Backend WebSocket upgrades | Closed with 404 before upstream IO | None | No relay authority or content publication |
| `/api/remote-servers/:id/browse` | Common capture; signal enters the per-profile queue and each status/filesystem/state read | Borrower-aware observation; one cancellation releases only its own share | Check at queue entry, between IO and before returning the listing |
| `/api/remote-servers/:id/connect`, including password/pairing | Common capture; queue and private connection/pairing client inherit its signal | Each connect owns its private candidate; destination-generation checks fence credential persistence | Check before dispatch and credential/result publication |
| SSH forward readiness and renewal identity check | Each principal owns its interruptible wait; profile generation and forward identity fence readiness | The backend owns one bounded forward/identity check per profile generation, across principals | Cancelled waiters cannot resume business dispatch; retargeting, Forget and final-owner shutdown close shared infrastructure |
| Probe, SSH-host/profile inventory, Forget and profile-state mutations | Common capture; probe IO inherits the signal; synchronous administration checks before mutation | None; explicit administration retains its profile-wide effects | Common pre-publication check |
| Host `/api/memory` and `/api/memory/settings` | Common pre-body channel guard and principal capture; signal follows project identity, repository-lock waits, reads and locked decisions | The repository lock serializes transactions; each waiter retains its own signal | Recheck after awaits and immediately before the journal temporary file's atomic rename; published journals complete durably; acknowledgement uses the original principal |
| Relayed memory and Tidy up preflight | Same relay capture, current destination proof and request signal | Existing backend client and borrower-aware authentication | Memory replies retain the relay header filter and publication fence; Tidy up retains its selected backend/project context |
| Browser-device `POST /api/auth/logout` | Paired browser principal and channel mutation-Origin checks; explicit server-device protocol keeps its closed catalog | Ends the current browser login | Clears the Secure device cookie before returning |
| Request logging, including rejected/malformed targets | Independent of admission | None | Static route template, method, status and duration only; raw paths, params, queries and bodies stay private |

Registered wildcard families retain their static template, including `/api/backends/:id/*`. Only global `*` / `/*` fallbacks use `<catchall>`; unmatched routes use `<unmatched>`.

Settings → Servers uses the host client for `POST /api/remote-servers/:id/connect` and `forget`, with caller cancellation and stable typed errors. Pairing keeps verified TLS, clears its field before waiting and saves only the origin. Its private device identity persists beside the host configuration across launches. Same-origin/TLS renames keep that identity. Address changes and removal check known tabs and use a known tab or recent project in the confirmation. Removal captures the profile policy, awaits Forget and then awaits profile persistence; a refused persistence leaves an actionable save error and the registered row. Mounting, adding and editing profiles are independent of backend attachment and project creation. View cancellation fences continuations while already dispatched durable mutations retain their result.

An optional saved `ssh.host` routes the profile through a backend-owned OpenSSH local forward to its remote-visible `baseUrl`. The destination is part of credential scope and profile generation. Relay proofs bind that declared origin, SSH host and TLS policy. Each new forward with an admitted identity gates all waiting operations on one shared, bounded metadata check through that exact forward, using the saved TLS policy and declared server hostname. A matching `serverId` preserves the proof; a changed, missing or unreadable identity revokes it, removes credentials and closes the forward before business dispatch. Host retargeting also revokes the generation. SSH uses strict known-host verification and batch key authentication; the remote CodeNomad instance is already running. `GET /api/remote-servers/ssh-hosts` shares the authenticated UI relay guard and suggests concrete aliases from the backend account's `~/.ssh/config` and Includes. Stable failures are `ssh_unavailable`, `ssh_host_key` and `ssh_auth`. Tests in `codenomad-servers/ssh.test.ts` and `ssh-manager.test.ts` cover parsing, process readiness, authentication failure, credential scope, relay proof lifetime, concurrent renewal gates and shared tunnel ownership.

The host connects to saved CodeNomad profiles through `codenomad-servers/`. Local relay callers retain exact loopback Origin provenance, or a loopback self Referer with `Sec-Fetch-Site: same-origin` for GET/HEAD. With the authoritative `config.ui.settings.multiBackend` setting enabled (the default), `createBackendUiAccess()` also admits authenticated UI clients for the reviewed `isBackendUiRoute()` method/path catalog: saved-profile browse/connect/forget, probe, SSH-host suggestions and backend business relays. All host profiles share this authority. SideCars share the local UI's application privileges and remain trusted extensions.

| UI channel | Saved-server admission |
|---|---|
| Remote Control | Paired device on the physical ingress, exact tunnel Host, exact public Origin for mutations; supplied read Origin/Referer must also match. |
| Direct HTTPS | Authenticated session or origin-bound device and `verifiedDirectHttpsOrigin()`, retaining the direct listener's source/CORS policy. |
| Direct LAN HTTP | Authenticated session and an explicitly admitted non-loopback HTTP Origin; sensitive reads may instead supply its Referer. |
| Installed PWA | Its current URL's channel rules. |

`/api/meta` announces `serversUsable`, `serversManageable` and `secretEntryAllowed`. The UI uses these host capabilities alongside the strict feature flag. Password or pairing-link submission to connect and relay login is backend-refused with `403` / `secret_entry_forbidden` on LAN HTTP; Remote Control, verified HTTPS and local loopback permit it. Foreign, opaque, undeclared or absent LAN provenance is refused before destination access. Forwarding headers confer no authority. Explicit server-device traffic retains its closed protocol catalog; it never receives these browser exceptions. Remote-side administration, nested relays and remote-preview capability management keep their existing route boundaries. Administrator-disabled Remote Control supplies no ingress principal; the listening lock governs which direct peers can connect.

Shared state writes that replace `ui.remoteServers`, delete that key or replace/delete its owner apply the same admission before persistence. Local preference writes retain their direct source policy. Non-loopback HTTP/HTTPS provenance through a loopback proxy retains its remote UI class and the strict feature flag. Probe URLs reject userinfo and pairing fragments before IO; malformed URL diagnostics omit the submitted value.

The saved profile alone selects the destination and TLS verification policy. The explicit transport pins validated DNS answers to the connection, keeps the saved hostname for TLS verification and SNI, and never follows redirects. Password login and password-backed writes send the exact saved destination as `Origin` for its direct-listener CSRF check. Reads, server pairing and device traffic stay originless. Caller Origin, cookies, authorization and forwarding headers stay local; private session/device cookies stay in the backend's mode-0600 store beside its configuration. Response cookies and authentication headers remain private. Response documents receive sandbox CSP and `nosniff`; the relay publishes a small response-header allowlist. Log records retain fixed relay route names and completion metadata, excluding request payloads and target queries.

`relay-principal.ts` captures each remote UI relay's authenticated principal before body parsing. Its signal spans queued work, upstream dispatch and response publication. Session logout, idle/absolute expiry and successful password replacement synchronously invalidate the captured session through `SessionManager.onInvalidated()`; watched sessions retain their ordinary activity deadlines. Device revocation and tunnel Stop close their tracked sockets; a 250 ms read-only device validity check also covers idle expiry and origin removal. Invalidation aborts the upstream and client response, while other principals retain their transfers and the host's saved connection. Local-loopback UI relays retain their local authority.

Principal-bound relays use the shared client's borrower-aware status observation even for calls without a relay proof. Each authenticated waiter owns its cancellation; a departing waiter releases only its share of a pending private login. Local legacy callers retain their recovery contract.
Browse without a saved credential turns a confirmed unauthenticated destination status into `409 needs_credentials` before any folder request, so the caller can sign in inline.

HTTP, HTTPS and the private bridge share the backend's connection authority and private credential cache. Admission captures the profile id, exact origin, TLS policy and revocable generation before entering a queue; dispatch and publication recheck that owner. Retargeting or changing TLS invalidates pending and queued operations and the stored identity. Stored identities include their TLS policy; entries without that field bind to verified TLS. Forget through any listener closes all of that profile's streams and removes its identity for every listener. The backend owns shutdown; a standalone listener releases its shared lease without closing another listener's owner.

Multi-backend registry candidates opt into a destination-generation proof. Their fresh, bounded metadata read observes remote `serverId`, rechecks the captured authority and returns the locally generated `X-CodeNomad-Backend-Authority` header. The candidate admits that proof once after compatibility validation. Its HTTP requests carry the header; resource and EventSource URLs carry `__codenomad_authority`. Both carriers stay local and are stripped upstream. Invalid or revoked proofs fail before client/fetch/DNS, with no recapture. Bootstrap is restricted to GET metadata, GET auth status and POST login for pre-admission authentication. Ordinary opted-in operations with no proof fail before dispatch. Existing clients without this opt-in keep their request contract.

Removal/recreation, address/TLS changes, Forget, explicit authentication-principal replacement, observed remote identity change and last-owner shutdown revoke the proof. Rename and same-principal cookie renewal retain it. Cleanup retries, including cancel/release/close without an attachment signal, retain their original proof and can remain pending after revocation. A mutation already dispatched may finish remotely; revocation provides no rollback or replay. These fences complement the existing provenance, authentication, route and TLS admission.

Proof-bearing and bootstrap transfers select status observation per call. On a business 401, the captured client observes `/api/auth/status` with its live private cookies before deciding whether to revoke its authority. Authenticated status preserves the original 401 and its body, credentials, proof and streams. False status permits one private password restoration and a fresh status, except when pairing is required; device/session identities retain their authentication kind. The business request is sent once, including after successful restoration. A confirmed rejection revokes only the still-current captured client. Network, TLS, timeout and invalid status responses remain unavailable and preserve the saved identity.

Direct opted-in status reads join the same client/principal flight across caller signals. Its eight-second monotonic deadline is checked at dispatch, cookie effects and verdict publication, covering headers, body validation and cancellation, with at most two status GETs and one password login, including any preliminary or already-running login. Status JSON requires UTF-8, a matching schema and at most 4096 decoded bytes checked during streaming. Cancelling one follower releases only its wait; the last follower cancels its privately owned exchange, while a legacy-owned login retains its own cancellation. Completion releases the active observation by identity; later calls observe afresh, while already-admitted business calls retain their original deadline and quotas. Shared login IO and cookie effects belong to its live borrowing flights and any legacy owner, within the login's original ten-second limit. Legacy promotion carries the right to publish confirmed login rejection once; departed or expired borrowers lose their rights. Legacy calls keep their existing recovery contract on the same cached client.

`POST /api/remote-control/server-pair` is a dedicated cookie-free protocol on the ingress or a verified direct HTTPS target with `X-CodeNomad-Server-Pairing: 1`, a strict JSON body and no Origin, Referer, authorization or browser metadata. It atomically consumes the five-minute pairing code for the targeted channel and returns one revocable device credential to the local backend. Invalid attempts have a backend-wide failure bucket; a valid high-entropy code remains usable. Servers without this route yield a stable `pairing_unavailable` result. Password connections use the direct listener's existing login policy and private session cookies.

An authenticated device request carrying `X-CodeNomad-Server-Request: 1` can mutate through the ingress or direct listener while carrying no browser context: Origin, Referer, Fetch Metadata, client hints and preflight headers, including empty ones, exclude this admission. Browser requests continue to require the public Origin. Device scope applies on both listeners, with host-only paths and nested backend relays denied. Invalid explicit device credentials never fall back to password sessions or skipped authentication. Revocation, eviction and shutdown close admitted device sockets on both listeners. Stop and tunnel failure close only ingress sockets. Profile removal or retargeting similarly aborts local uploads/SSE and deletes its private identity; pending connection results check their captured owner before saving.

`gate.ts` maintains the closed `SERVER_DEVICE_ROUTES` catalog of method/path pairs for the relay's existing backend API contracts. Additions require review of the caller and remote route together; unknown paths and unlisted methods return 404. Direct requests using the explicit device protocol stay within this catalog even when they carry browser headers, and never reach browser pairing. Server pairing checks the physical ingress or the exact verified direct HTTPS Host before handling the exchange. Browser pairing (`/remote-pair`, `/api/remote-control/pair`) requires ingress membership or a [verified direct HTTPS origin](#direct-https-devices).

| Reviewed device-route family | Admission surface |
|---|---|
| Identity and connection | GET auth status, metadata, events and read-only Remote Control status; POST connection pong. |
| Backend data and preferences | Explicit filesystem, config-file, storage owner/instance, usage, runtime, speech, SideCar/previews and panel-extension method/path pairs in `SERVER_DEVICE_ROUTES`; existing host-only exclusions still apply. |
| Project operations | Workspace inventory/lifecycle, repository-source discovery, directory-owned background Shell inventory (GET), worktrees, files/Git, plugin/integration settings, accounts/usage, session media/history/pruning preview and mutation, pending requests, Missions and conversation permission-mode reads/writes. |
| Agent memory | UI clients use exact POST `/api/memory` and GET/PUT `/api/memory/settings`; remote browser admission requires the strict host flag and channel provenance. Relayed memory requires its current proof. The explicit server-device catalog retains its authenticated direct transport and ingress boundary. Project-directory ownership and strict schemas apply at the destination. |
| Native workspace API | `/workspaces/:id/instance/api/…` under the existing `isAllowedInstanceApiRoute()` allowlist and workspace/location ownership checks in `http-server.ts`. |

Read the creation receipt on its original backend and project Location. See [Missions](MISSIONS.md#backend-routing) for request ownership and reconciliation.

Browser traffic on the ingress retains its existing public-Origin and device admission. Browser-pairing authority comes from physical ingress membership or a verified direct HTTPS origin.

### Host and device-local boundaries

Authenticated browser admission retains these method/path boundaries:

| Surface | Authority |
|---|---|
| `/login`, `/auth/token`; POST `/api/auth/{login,token,logout,password}` | Local bootstrap/password administration; direct password clients retain login/logout |
| POST `/api/remote-control/{start,pairings}`; DELETE `/api/remote-control`; GET `/api/remote-control/devices`; DELETE `/api/remote-control/devices/:id`; PUT `/api/remote-control/previews` | Host administration under the Remote Control/listening policy |
| Config document/owner patches changing `server.sidecarsOverDirectHttps` | Host-owned setting; authoritative before/after comparison |
| GET `/api/opencode/logs`, including backend relays | Host-only global diagnostics: the absolute path and raw global log may contain credentials and data from other projects |
| `/sidecars/:id` and descendants, HTTP/WS | Device-local content, with the explicit host-controlled direct HTTPS opt-in |
| `/api/backends/:id/preview-capabilities` and `/:capability`; preview HTTP/WS content | Scoped preview authority; live ingress content additionally follows the Web previews switch. Under `multiBackend`, remote clients may POST the collection and DELETE their own capability through the authenticated UI guard; collection DELETE stays local |
| Remote-client `/previews/<capability>/…` HTTP/WS content | Cookie-free; bound to the issuing principal's liveness, channel and exact Host; paired devices also follow the Web previews switch |
| POST `/api/opencode-plugin/automation` | Private loopback native bridge and token |
| POST `/api/remote-proxy/sessions`; DELETE `/api/remote-proxy/sessions/:id` | Local native window transport |
| Nested relays and destination host administration | Closed relay boundary |

## Direct HTTPS devices

Where the tunnel is blocked but a direct HTTPS deployment exists (a TLS-terminating reverse proxy with a real certificate, or the backend's own HTTPS listener), browsers and saved servers pair and authenticate as devices on that origin. Plain-HTTP and loopback pages stay password-only.

- **Verified direct HTTPS origins** (`remote-control/direct-https.ts` `verifiedHttpsOrigins()`) are the `https:` origins the direct listener already trusts for mutations: the advertised `localUrl`, `remoteUrl` and reachable addresses, plus `CODENOMAD_ALLOWED_ORIGINS`. Loopback (`localhost`, `*.localhost`, `127/8`, `[::1]`, mapped IPv4 loopback) and unspecified hosts never qualify, nor do the UI development origin and same-origin loopback aliases. Removing an origin from the configuration ends its devices' authority at the next request.
- `verifiedDirectHttpsOrigin()` checks browser provenance. It never accepts an ingress socket. Unsafe methods need their own `Origin`; safe methods use `Origin`, else the `Referer` origin, else the targeted `Host` as `https`, because same-origin navigations and fetches send neither header. Opaque (`null`), empty, `http:` and unlisted values give null. The listener's transport is deliberately ignored: behind a TLS-terminating proxy the request reaches a plain-HTTP socket, so the configured public origin, which the proxy forwards in `Host`/`Origin`, is the evidence. Browsers send the `Secure`, host-only `__Host-` cookie only over TLS to the host that received it, and pairing sets it only in response to a verified origin. The proxy must forward the public `Host` and `Origin` and reach the backend over loopback or a protected hop.
- `gate.ts` `gateDirectHttpsDevice()` judges a direct request carrying the device cookie only on a verified origin; elsewhere the cookie is ignored and password rules apply unchanged. Pairing paths and `/previews/<token>/…` capability paths pass through untouched. A valid device of that origin (`registry.authenticate(token, origin)`) is attached with `attachRemoteDevice()`, so `isRemoteRequest()`, `isLocalRequest()` and the auth manager treat it like an ingress device: no loopback privileges, even through a proxy on loopback; host-only paths return 404 except for the reviewed authenticated UI catalog under `multiBackend`; forwarding headers are stripped. `isDirectHttpsDeviceRequest()` marks it separately; the direct origin policy uses it to keep the direct listener's CORS origins instead of the tunnel origin. An invalid, revoked, expired or other-channel credential marks the request refused (`isRefusedDeviceRequest()`): the auth manager returns no session, so it never falls back to a password session or skipped authentication; `/api/auth/status` reports `pairingRequired`, the static bundle stays public, HTML navigations redirect to `/remote-pair` and everything else gets 401.
- The host creates a link with `POST /api/remote-control/pairings` and body `{ "origin": "https://…" }` (host-only; 409 for an unverified origin). `GET /api/remote-control/status` lists `directOrigins` for local requests only, and Remote Access settings offer **Direct HTTPS pairing** in the Remote Control card, with a native select when several origins exist; the tunnel need not run. The direct exchange requires its own verified `Origin`, redeems only that origin's code, counts failures in the backend-wide bucket shared with server pairing (a valid code is checked first) and sets the same `__Host-codenomad_device` cookie. The direct listener's host-only hook admits `/api/remote-control/pair` only on a verified origin. The pairing page refuses to post a code from a non-`https:` page.
- Direct devices are independent of the tunnel: Stop, tunnel failure and resume neither cancel their codes nor close their sockets (`directDeviceSockets` in `manager.ts`). Revocation, eviction at the device limit and shutdown destroy them. `isDeviceAuthorized()` accepts a direct device while its origin remains verified, so Missions human-answer and recurrence proofs keep working. The inventory exposes `origin` for direct devices; Settings labels each device with its HTTPS origin or Remote Control.
- `verifiedDirectHttpsOrigin()` and the explicit server-device protocol stay separate: `X-CodeNomad-Server-Request: 1` uses the same closed catalog on either channel. Direct server requests carry no browser context and match the credential to the verified HTTPS Host.

### Isolated remote preview capabilities

The [Browser Automation contract](BROWSER_AUTOMATION.md#remote-preview-content-transport) defines capability APIs and lifetime.
Local management requires the host's local-origin guard and current relay proof;
ingress content follows Remote Control's **Web previews** switch. Remote clients
receive host path capabilities instead, bound to their principal, channel and
Host ([Remote-client path capabilities](BROWSER_AUTOMATION.md#remote-client-path-capabilities)).
The manager's `hasPreview` admits them beside local previews.
HTTP/WS transports pin the saved destination, verify its TLS hostname and borrow
the identity-gated SSH forward. Private connection credentials serve only preview
creation/deletion; content uses the cookie-free remote capability protocol.

Preview and SideCar proxies apply a per-listener target boundary before HTTP,
asset-fallback and WebSocket dispatch. Control APIs on this backend's own origins
and loopback aliases, and every preview capability origin, return 404 before IO.
Ordinary application targets retain their proxy behavior. Direct HTTPS SideCar
opt-in admits only SideCar content, including an authenticated direct browser
device. Backend relays, memory and remote-client preview management follow the
authenticated UI matrix; preview content retains its capability lifetime rules.

The administrator's listening lock governs the ordinary application listener.
Relay APIs share that listener and apply the authenticated UI admission matrix.
Outbound profile transports, SSH forwards and the isolated preview listener keep
their private lifetimes and bindings; a local relay operation leaves the Remote
Control administrator policy unchanged.

## Direct listener origins and password sessions

The password session cookie persists for seven days across browser restarts.
The backend enforces idle and absolute deadlines and revokes the session on sign-out.

The direct listener grants credentialed CORS to its advertised local and remote
origins, reachable interface addresses and explicit `CODENOMAD_ALLOWED_ORIGINS`.
This environment variable is a comma-separated list of exact HTTP(S) origins,
for example `https://code.example.test,https://ui.example.test:8443`. Paths,
credentials, opaque origins and wildcards fail startup. Configure DNS aliases,
reverse-proxy public origins and separately hosted UIs here, then restart.
For a separately hosted UI, deploy it and reload open tabs and windows before updating the backend.
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

Outbound HTTP proxies and preview/SideCar WebSockets resolve their destination
once and connect only to those pinned answers while retaining the target's HTTP Host
and TLS identity. `server/proxy-destination.ts` refuses any destination address/port
covered by a live backend listener, including sibling HTTP/HTTPS listeners,
remote proxy session HTTPS listeners and the Remote Control ingress. Unspecified
destinations (`0.0.0.0`, `::` and mapped forms) match every local listener on
that port. Wildcard binds cover loopback and the host's current interface
addresses. Other loopback ports and LAN applications remain eligible.

Direct state-changing requests check Origin first, then the origin of Referer
when Origin is absent. Non-local mutations require an allowed source; native
loopback calls may omit both. Read-only methods are GET, HEAD and OPTIONS.
Authentication and the host-only gate also apply with explicitly allowed origins;
`--dangerously-skip-auth` retains the origin and host-only gates.

SideCar WebSocket upgrades apply this same Origin/Referer policy before opening
an upstream connection, alongside their loopback transport (or the host's direct
HTTPS opt-in) and session checks.
Native loopback upgrades may omit both source headers. Preview WebSockets use
their scoped capability admission.

Password sessions expire after 24 hours without an authenticated request and
after seven days from creation. `CODENOMAD_SESSION_IDLE_SECONDS` and
`CODENOMAD_SESSION_ABSOLUTE_SECONDS` configure positive integer lifetimes in
seconds at startup. Logout revokes its current token; a successful persistent
password change revokes every session for that user, including the caller.
A failed password change preserves the existing sessions. Remote Control device
credentials follow their separate registry lifetime and revocation rules.

- Desktop remote windows delegate [device-engine dictation](DESKTOP_SPEECH.md#remote-server-windows)
   to the client without sending capture audio through the tunnel. Paired
   browsers can use the configured API path.

### Live voice upgrades

- `/api/speech/conversation/live?engine=…` accepts only the canonical URL
  for Gemini Live or OpenAI Realtime. It requires an exact secure-context
  `Origin` (HTTPS or loopback HTTP). The direct listener uses its normal
  origin policy and password session; when direct authentication is explicitly
  disabled, voice is limited to loopback peers and loopback origins. Opaque
  documents and preview capability hosts cannot upgrade. Logout, password
  changes, session expiry and listener shutdown terminate those connections.
- Remote Control checks the exact tunnel `Host` and HTTPS `Origin`, plus its
  paired-device cookie on every voice upgrade. It binds the socket to the
  device, independently of the local authentication setting. The gateway's
  single-conversation slot is keyed by paired device at this ingress and by
  username on the direct listener. Device revocation or tunnel shutdown ends
  voice; the preview switch affects previews alone. A failed revocation write
  denies the device in memory and keeps its row marked as pending so the host
  can retry Revoke. Any successful registry write also commits the removal.
- The Tauri TLS-exception proxy accepts this one upgrade from its exact window
  origin and checks a per-window HttpOnly credential from bootstrap. The proxy
  connects only to that window's configured HTTPS target via the pinned DNS
  destination guard, sending the target's origin and its rewritten login cookies.
  It relays bounded WebSocket messages without forwarding handshake headers or
  provider credentials. The target performs voice admission as usual. Disposing
  the window proxy ends both streams.

## Validation

- `remote-control/password-relay.test.ts` exercises HTTPS browser admission, private sign-in, folder browsing and project creation/reload against a password-protected destination on a non-loopback interface.
- `remote-control/logs-host-only.test.ts` uses the production global-log reader
  with synthetic credentials and private paths. Remote browser/device channels
  and relays refuse before host binary discovery or upstream IO; native loopback
  retains the host diagnostic view.
- `remote-control/memory-remote.test.ts` covers the exact host/relay memory catalog,
  channel provenance, strict feature flag, schemas, project ownership, proofs and
  principal revocation before body parsing, during lock waits and before publication.
  `memory-project-remotes.test.ts` exercises real Git-backed A/B project stores
  with colliding raw IDs over ingress, a TLS reverse proxy and non-loopback LAN,
  including destination-owned Tidy up eligibility and strict mutation revisions.
- `remote-control/security-sentinels.test.ts` scans admitted Remote Control, TLS reverse-proxy and non-loopback LAN flows over direct and injected SSH TCP-forward transports. Controlled A/B destinations exercise stored password/device identities, private SSH/TLS material, pairing tokens and relay proofs. Captured response bodies/headers, redirect failures, rejected raw targets, exposed URL carriers, persisted state and trace-level application logs are checked together. Relay proofs retain their authorized bootstrap-header/resource-query contract; every other response, state/log field and upstream request keeps them private. Rejected targets retain the fixed namespace log treatment even when path admission refuses their syntax.
- Remote preview coverage: [Browser Automation](BROWSER_AUTOMATION.md#focused-validation).
- `codenomad-servers/relay-principal.test.ts` drives real HTTP streams through logout, idle/absolute session expiry, persistent password replacement, device revocation/expiry and tunnel Stop, checking bounded upstream/client closure and isolation of other principals and local-loopback authority.

- `codenomad-servers/ssh-manager.test.ts` exercises private authentication restoration through the owned SSH dial, single business dispatch and stale-proof refusal before IO after SSH retargeting. Concurrent mutations, direct status reads and post-401 observations share the renewal identity gate; a changed, missing or refused identity prevents status dispatch through the replacement forward.

- `codenomad-servers/review-regressions.test.ts` covers queued credentials across address/TLS changes, persisted TLS binding, cross-listener Forget, and shared-owner shutdown. `remote-control/device-relay-admission.test.ts` exercises the closed route/method catalog and preserves browser pairing on the ingress.

- `remote-surface.test.ts` drives the real `createHttpServer` through the
  ingress. It covers unpaired access, pairing, `Origin`/`Host` checks,
  host-only paths including encoded ones, loopback privileges, spoofed headers,
  upgrades, web previews and their switch, revocation of a live stream, skipped
  local auth and tunnel failure.
- `remote-control/direct-https.test.ts` covers verified-origin pairing from
  loopback/LAN, channel and device scope, no credential fallback, failure limits,
  origin revocation, and socket lifetimes across Stop, revocation and eviction.
- `speech/live-voice-gateway.test.ts` uses both simulated providers over the
  direct listener, the Remote Control ingress and a TLS-exception window proxy.
- `server/preview-proxy-boundary.test.ts` uses simulated DNS and local listeners
  to check refusal before upstream contact, password-enabled and skipped-auth
  previews, capability hosts, Referer fallback, SideCar HTTP and both WebSocket
  proxies, unspecified destinations, bound-interface matching and a pinned
  ordinary dev-server connection. `server/__tests__/remote-proxy.test.ts`
  checks registration of the remote proxy session's HTTPS listener.
- Isolated preview listeners and SSH reservation/forward addresses register with
  `guardProxyListener`. Forward protection lasts until observed child exit;
  proof-owned capability WebSockets keep their captured pinned dial and TLS policy.
- `direct-listener.test.ts` exercises the real application with LAN and loopback
  peers, credentialed CORS, Origin/Referer checks and host-only routes.
  `server/__tests__/sidecar-proxy.test.ts` covers SideCar upgrade source checks,
  refusal before upstream contact, authenticated and skipped-auth exchanges,
  native origin-less calls and logout revocation, and the direct HTTPS opt-in for
  content and upgrades. `remote-control/direct-https.test.ts` covers the verified
  origin rule, the opt-in's `/api/meta` matrix, the other host-only paths and the
  ingress; `routes/settings.test.ts` covers the host-only setting guard and config writes
  that start from the file on disk. The SideCar and settings tests use the real settings
  service and edit `config.yaml` as the host would, including revocation after the display
  cache loaded the opt-in.
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

- Remote Access settings put Remote Control first. Direct/LAN access (listening mode, server password, reachable addresses) sits in one collapsed disclosure that opens by itself while the server listens beyond localhost. Its texts refer to password-based direct connections only, because Remote Control pairs devices and needs neither a password nor an open port. Device pairing on direct HTTPS origins lives in the Remote Control card with the pairing link and device inventory. It uses the shared `.settings-disclosure` (`styles/components/settings-disclosure.css`).
- The tunnel runtime (`build:remote-tunnel`) keeps its own backend-side Effect runtime, separate from OpenCode's native plugin graph. Ingress sockets are remote by membership: grant local privileges only through `isLocalRequest()`/`isLoopbackRequest()`, never peer addresses or headers. The resume lease lives in `owner-lease.ts`; never auto-start an installation that was not started. Run the Validation tests above when changing the transport.
