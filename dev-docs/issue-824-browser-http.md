# Issue #824 — bounded Chromium HTTP/1 admission qualification

## Result and scope

**No global freeze reproduced in these five isolated scenarios.** Chromium
Windows can progress in session B while session A's prompt/compact ownership
preflight is held. Closing a page or browser context retires the old HTTP/SSE
observers before the upstream handler is released. A new page connects and reads
B before that release; late completion does not forward the abandoned mutation.
No additional product correction follows from this result.

This is **Windows Chromium → Windows Fastify over private loopback HTTP/1.1**,
not Electron Linux → Windows LAN qualification, not a desktop process restart,
and not qualification of an OpenCode 2.0.19 runtime. No OpenCode daemon, database,
provider, shared profile, production backend or installed desktop is used.

Added paths only:

- `packages/ui/tests/browser/http-admission-responsiveness.test.ts`
- `packages/ui/tests/browser/fixtures/http-admission-responsiveness.tsx`
- this report

## What is real versus supplied

- Playwright 1.63.0 launches installed Chromium **153.0.8010.12** on Windows;
  Node **25.2.1** runs private ephemeral Fastify listeners.
- The browser addresses Fastify directly. Vite serves fixture modules on another
  origin; there is **no Vite/Node proxy** in the business-request/SSE path.
- CDP `Network.responseReceived` asserts `http/1.1` for the real SSE response,
  B response, CodeNomad metadata and control witness. Fastify also records request
  `httpVersion === "1.1"`. These are not intercepted Playwright responses.
- Production `registerEventRoutes`, `EventBus`, `ClientConnectionManager` and
  browser `serverEvents` provide one multiplexed EventSource subscription per
  page. Event payloads are fixture-controlled; there is no native event relay or
  native compaction event sequence in this experiment.
- Production `registerInstanceProxyRoutes`, request admission, runtime fetch and
  `WorktreeDeletionFence` implement admission/cancellation. The official
  `@opencode/client@2.0.21` Promise SDK runs in browser **and** backend. Real
  browser `createInstanceFetch` performs classification/background scheduling.
- A disposable upstream Fastify service supplies native-shaped HTTP responses,
  including the session `{ data }` wire envelope. Its A GET handler deliberately
  remains held even after its HTTP response socket closes. This is an induced
  preflight wait, **not** real native compaction or provider execution.
- A small ownership manager supplies only the `/fixture` identity and invokes a
  real SDK location read. No discovery, filesystem or actual worktree scan is
  performed. Shared production primitives are imported rather than copying the
  server disconnect fixture's complete fake SDK tree.
- Draft input/session switching are minimal Solid fixture controls. Their switch
  performs the real SDK B read. This measures browser event/input/network progress,
  not rendering of the full CodeNomad transcript, session store or composer.
- “Info” is the real CodeNomad `/api/meta` route, not native `server.info()`.
  `/api/info` is not exposed by the workspace proxy allowlist and was not added.

## Scenarios and causal assertions

Four cases cross prompt/compact with page/context close. Each starts exactly one
SSE plus one A mutation whose real backend SDK session read is held. Before release,
the browser edits a draft, switches/loads B, reads `/api/meta` and reads a control
witness. A stays pending throughout those successful operations.

A **separate fifth case** adds five distinct agent catalogue read intents through
the existing `createInstanceFetch` policy. Only **two** reach upstream and remain
held; three stay queued. Distinct agent URLs avoid Chromium's same-URL cache
coalescing. This is a scheduling stress witness, not a claim that normal UI issues
five such reads on any particular cadence. No six-held-foreground-request fanout
is used to manufacture an ordinary-workflow freeze.

Before releasing any held upstream handler, closing the page/context must produce:

- zero SSE registrations, old downstream mutation responses, backend SDK A
  observers, native A HTTP responses and (fifth case) catalogue HTTP responses;
- one observed A admission abort, restored request-abort listener count and no
  residual admission/forwarding close listener;
- a completed deletion-fence operation; A is held **before** fence admission,
  so this checks non-reservation, not cancellation of an already admitted write;
- successful new-page SSE/B/control reads with no old observer restarted.

Upstream handler closures deliberately remain alive until the test gate is opened
(one handler, or three with catalogues). They are counted separately from HTTP
observers: their intentional retention must not be mistaken for an orphaned HTTP
watcher. After release the test waits for those continuations to finish and checks
zero A forwards, environment writes and connection invalidations, with no new
catalogue dispatch from the destroyed page.

## Executed validation

Existing dependencies/browser reused without installation. From the mission root:

```powershell
node --unhandled-rejections=strict --import tsx --test packages/ui/tests/browser/http-admission-responsiveness.test.ts
node --unhandled-rejections=strict --import tsx --test packages/ui/tests/browser/http-admission-responsiveness.test.ts packages/ui/tests/browser/event-subscriber-isolation.test.ts
node --unhandled-rejections=strict --import tsx --test packages/server/src/server/__tests__/instance-proxy-disconnect-diagnostic.test.ts packages/server/src/server/request-admission.test.ts
npm run typecheck --workspace @codenomad/ui
```

Standalone: **5/5 pass**, zero skips, natural exit ~4.0 s. After adding explicit
held-handler continuation accounting, combined gate: **10/10 pass**, zero skips,
natural exit ~5.1 s (five new cases plus five existing subscriber-isolation cases).
UI source typecheck passes; that tsconfig excludes browser tests/fixtures, which
are instead executed via tsx/Vite/Chromium. Neither a full browser-suite gate nor
full desktop/native-runtime validation is claimed.
The existing server disconnect/admission cases also pass **15/15**, zero skips,
natural exit ~0.8 s, without editing their fixture or product sources. Scoped
no-index whitespace checks on the three new files emitted only Git's LF/CRLF
warnings, no whitespace diagnostics (no-index diff status 1 for new contents).

Descriptive measurements from the combined run (not CPU latency requirements):

| Scenario | Input/B/meta/control progress while held | Close cleanup | Backend peak TCP sockets |
| --- | ---: | ---: | ---: |
| prompt, page close | 92 ms | 13 ms | 3 |
| compact, page close | 79 ms | 16 ms | 3 |
| prompt, context close | 68 ms | 5 ms | 3 |
| compact, context close | 74 ms | 5 ms | 3 |
| compact + background budget, context close | 72 ms | 7 ms | 5 |

Socket counts include idle/preconnect connections and are **not** asserted as busy
connection counts. Page close left one idle pooled TCP socket but no pending HTTP
observer; context close left zero in this run. New pages had one SSE and two TCP
sockets. Assertions are causal (B succeeds before gate release, cleanup occurs
before release); 10/30/60-second harness bounds detect deadlock only, not latency
regression thresholds.

## Remaining Linux → Windows qualification

The smallest useful next experiment needs an approved isolated Windows backend
and native storage/provider, plus the actual Linux Electron build. Bind that private
backend on a test interface restricted to the Linux host; never expose or use the
shared daemon. Record backend/UI/native/Electron/Chromium versions, exact scheme,
proxy/VPN configuration and whether authentication uses the remote-window path.

Concrete read-only external control from Linux, using the approved private URL:

```sh
curl --http1.1 --max-time 10 -sS -D private-meta.headers \
  -o private-meta.json "$WINDOWS_PRIVATE_URL/api/meta"
```

Provide the isolated backend's normal authentication if required, without saving
credentials in the report. This curl process does not consume the renderer's
connection pool; compare its progress with renderer Network timings, not as proof
that the renderer is healthy. In Electron collect the owned window's existing
automation/CDP Network events (no fixed debugging port), protocol, connection IDs,
request initiator, queue/stall/connect/TTFB timings and one SSE subscription count.
Start with one real A compaction and B switch/draft/meta reads; count background
reads separately. Compare close/reopen page, close/reopen remote window and full
isolated Electron restart **without restarting Windows backend/native runtime**.
Capture admission abort, pending SDK reads, relay backlog, upstream execution and
backend event-loop progress before/after each boundary. Do not replay a timed-out
mutation. A genuine native 2.0.19 run must identify its binary/storage/provider;
the pinned 2.0.21 SDK is not evidence about that runtime.

The current harness is intentionally loopback-only and self-terminating; changing
`CODENOMAD_BROWSER_PATH` selects a local browser, not a remote backend. A persistent
LAN-controllable version requires a separately authorized fixture/launch change.
