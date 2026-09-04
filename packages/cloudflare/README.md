# CodeNomad Cloudflare Worker

This package serves the published web UI and the shared Remote Control relay.

## Remote Control topology

- The CodeNomad host opens one authenticated outbound WebSocket.
- A random 128-bit host ID selects one `RemoteControlHost` Durable Object.
- Remote browsers use a one-time pairing link and a host-scoped device cookie.
- The pairing fragment pins the host's persistent P-256 public key without
  disclosing the one-time token to the relay in an HTTP request URL.
- The Worker authenticates and routes devices, but forwards application traffic
  only as opaque encrypted tunnel frames.
- The local connector strips remote headers and injects its private CodeNomad
  session only after decrypting a request on the host.
- OpenCode remains behind the loopback-only CodeNomad server.

The browser uses an ephemeral P-256 key and the host contributes a fresh
challenge to every tunnel. HKDF-SHA-256 derives separate client-to-host and
host-to-client AES-256-GCM keys. Authenticated counters reject tampering,
reordering, same-tunnel replay, and replay into a later tunnel. The private host
key and plaintext never enter Worker storage or messages. The relay can still
observe routing metadata, frame sizes, and timing, and it serves the published
browser bundle. E2EE protects against an honest-but-curious relay, storage
disclosure, and captured tunnel traffic. It cannot protect a session from an
actively malicious Worker operator that replaces the browser JavaScript before
it runs; release review and Cloudflare account security remain part of the
trust boundary.

Both host and browser WebSockets use the Durable Objects WebSocket Hibernation
API. Socket attachments contain the minimum routing metadata needed after an
object is evicted. The host heartbeat is handled with a WebSocket auto response,
so it does not wake an idle object. Hashed UI assets are public and immutable;
only HTML navigation, bootstrap discovery, pairing, management, and tunnel
operations consult the host object.

## Resource limits

Each host object limits browser tunnels, paired devices, unredeemed pairing
links, pairing bodies, and opaque frame sizes. The local connector separately
limits concurrent HTTP requests, local WebSockets, decrypted request bodies,
handshake frames, and pre-open socket queues. HTTP streams have an idle timeout
and abandoned requests are cancelled at the host. Expired pairing and device
records are removed by a Durable Object alarm.

These limits contain abuse and memory use, but they are not a substitute for
Cloudflare account-level usage alerts and limits.

## Validation

```sh
npm install
npm run typecheck
npm test
npm run test:e2e
npx wrangler deploy --dry-run
```

The end-to-end test starts a local Wrangler relay plus a loopback host and
verifies one-time pairing, encrypted multiplexed HTTP streaming, header
isolation, connector recovery, pairing and client limits, WebSocket forwarding,
and live revocation. Use `npm run dev` for manual testing with a local CodeNomad
server. The protocol package is built automatically before either flow.

## Deployment

`wrangler.toml` requires:

- the `REMOTE_HOSTS` Durable Object binding;
- an assets directory built into `dist`;
- the `ui.codenomad.neuralnomads.ai` and
  `remote.codenomad.neuralnomads.ai` custom domains;
- a wildcard route for `*.remote.codenomad.neuralnomads.ai`.

Deploy only from the Cloudflare account that owns the `neuralnomads.ai` zone.
Do not put host or device credentials in URLs, logs, or Worker variables.
