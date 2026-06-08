---
id: DISCUSSION-001
title: CodeNomad Cloud Phase 2 planning
status: closed
agent: product_manager
session_id: ses_24f740006ffe4tIN5wpSo4H5QQ
appended_message_ids:
  - msg_db21867a0001K0zBBeA02YA7ps
  - msg_db21867a8001Xak6lGqQQfGXEu
  - msg_db21b0165001LXJPLOuMlzsLcc
  - msg_db21be453001Lg04YpyHFEMBq3
  - msg_db21be463001V87a73ghxF41My
  - msg_db21d73220011lrYY6jvP4253C
  - msg_db21db756001jqdUgJykZyHwXt
  - msg_db43c5edf001NWgaTjqRVhWvjV
  - msg_db43d17f4001nTl0YgRsM7I6HW
  - msg_db43d54d6001oWA13I7K1C4tk3
  - msg_db446b5ad0018gv9lr4BjmE8Rz
  - msg_db446b5c50012a6z0iaWTM7jwF
  - msg_db44757ea001Jp9RYNm1PMkGB9
  - msg_db64127e8001mS7kVRE4E2jQi3
  - msg_db641280c001peUPWAWC2kGLUq
  - msg_db642936e001JnGl5GqIoTlDa8
  - msg_db6429379001iKhyc522aqp1HO
  - msg_db6455a6e001eXfXugmoj8cy14
  - msg_db6455a81001KUSGiI8tKNuvUW
  - msg_db64636de001U1LzlCzHgaCrBR
  - msg_db64636ec001ktv62QzrbhrAMd
  - msg_db646ce130010iW9bqssu1d4ju
  - msg_db64bef9c001T3TSYczQMZJkh1
  - msg_db64e27ee001CdQr5OtDnP6YCH
  - msg_db65d8cf700139ogvo7eBgTzO8
---

# Discussion: CodeNomad Cloud Phase 2 planning

## Messages

**User**
Can you set it up for me and give me the url to test

**product_manager**
I’ll have QA set up a fresh local Phase 1 test run and hand back the exact local URL and any login details you need.

**product_manager**
Yes — it’s set up and running now.

## Open this URL
- `http://127.0.0.1:53984`

## Local login
- Username: `codenomad`
- Password: `TmpPass123!`

## Current state
QA confirmed this local run is:
- up
- cloud-connected
- using a fresh staging-backed enrollment
- ready for manual testing now

## Notes
- This is an active local run, so the URL only works while that process stays running.
- It’s HTTP-only for this manual test session.
- Temp enrolled state/artifacts live under:
  - `tmp/codenomad-cloud-e2e/manual-run/`

If you want, after you test it, I can help you:
1. clean up the temp environment, or
2. capture any bugs/findings into a follow-up task.

**User**
I want to be able to access it from dashboard

**product_manager**
Not with Phase 1 as currently built.

## What Phase 1 supports
Phase 1 gives you:

- server-side enrollment
- cloud connector reachability
- persisted reconnect
- local status visibility

It proves the machine can register/connect to cloud, but it does **not** yet implement the full **dashboard-driven access/open workflow**.

## Why
What’s missing is the next layer of product integration, such as:

- a dashboard action that opens or routes into the connected CodeNomad server
- a stable remote session/access handshake between dashboard and local CodeNomad
- the corresponding server/API flow in CodeNomad to accept that dashboard-driven access path
- possibly desktop/browser UX for joining from the cloud side

So right now, the dashboard can help produce the pairing/enrollment flow, but not serve as the full remote access entrypoint for using CodeNomad.

## What you can do today
Today you can:
- enroll/connect the local server to cloud
- verify it is connected
- use the local CodeNomad URL directly

But you **cannot yet** rely on:
- “see server in dashboard and click into it to use CodeNomad remotely”

## What this means
If your real goal is:

> “I want to open/use the connected CodeNomad instance from the dashboard”

then that should be the core goal of **Phase 2**.

## Recommended Phase 2 objective
I’d define it as:

**Dashboard-accessible remote CodeNomad session flow**

Likely scope:
- expose connected server identity/status in a cloud-visible way
- add a dashboard-to-CodeNomad session/open flow
- add the required server endpoints/handshake
- optionally add desktop/browser routing UX

## Short answer
- **Phase 1:** cloud-connected, locally testable
- **Not yet:** dashboard-accessible usage flow

If you want, I can turn that into a concrete **Phase 2 proposal specifically for dashboard access**.

**User**
Lets go to phase 2

**product_manager**
I’m going to frame Phase 2 around the dashboard-accessible use case and get your decisions on the boundaries before I draft the spec.

**product_manager**
Great — that gives us a clear Phase 2 direction.

## Locked Phase 2 direction

### Primary goal
- **Dashboard opens server**

### Primary surface
- **Web dashboard first**

### Remote usage depth
- **Launch/access only**
- not a full remote session UX redesign

### Explicitly out of scope
- multi-profile cloud
- non-web desktop polish
- advanced recovery logic
- broader remote-connect redesign

## My recommended Phase 2 definition

**Phase 2 = dashboard-driven access to a connected CodeNomad server**

In practical terms, that means:

1. the connected CodeNomad server becomes visible/actionable from the dashboard
2. the dashboard can initiate an access/open flow for that server
3. CodeNomad accepts that cloud-driven open/access handshake
4. the user can reach the connected instance from the dashboard
5. we do not yet broaden into a full remote workflow redesign

## What I think Phase 2 should include

### In scope
- dashboard-visible connected server identity/status
- a dashboard “open/connect/access” action
- the minimal cloud-to-CodeNomad handshake needed to launch access
- server/API support for that launch/access flow
- enough browser/web UX to enter the connected instance successfully
- verification of the end-to-end dashboard → connected server path

### Out of scope
- multi-account/profile handling
- deep desktop-specific UX work
- major reconnect/recovery expansion
- broader remote architecture rewrite
- richer collaborative/admin workflows

## Suggested slices
I’d likely split Phase 2 into:

1. **Spec / contract**
   - define dashboard-to-server access flow
   - define identity/session/open semantics

2. **Server implementation**
   - minimal access/open endpoints + handshake
   - validation/auth boundaries

3. **Dashboard/web flow**
   - connected server visibility
   - open/access action

4. **QA / E2E**
   - dashboard → open connected server end to end

## Next step
I should now turn this into a **Phase 2 spec draft** before any implementation work.

That draft should define:
- exact user flow
- server identity assumptions
- what “open” means technically
- minimum endpoints/contracts
- acceptance criteria
- out-of-scope boundaries

If you want, I’ll do that next.

**User**
Go for it

**User**
Go for it

**User**
conitnue

**product_manager**
I’ve got the technical side. I’m going to get the missing BA product framing now, then I’ll synthesize the Phase 2 proposal for you.

**product_manager**
Here’s the **Phase 2 spec draft** I’d propose for approval.

## Phase 2: Dashboard access to a connected CodeNomad server

### Goal
Let a user **see a connected CodeNomad server in the web dashboard and open it from the dashboard into the existing web CodeNomad experience**.

This builds directly on Phase 1, which already proved:
- server enrollment
- cloud connectivity
- persisted reconnect
- status visibility

Phase 2 turns that into a real user-facing access flow.

---

## User outcome
A user can:

1. sign into the web dashboard
2. see that a CodeNomad server is connected and available
3. click an **Open** / **Access** action
4. land in the existing CodeNomad web experience for that connected server

If the server is unavailable, the dashboard shows that clearly and does **not** attempt advanced recovery.

---

## Bounded Phase 2 user flow

1. A CodeNomad server has already been connected through the existing Phase 1 cloud flow.
2. The user signs into the web dashboard.
3. The dashboard shows connected server entries with enough identity/status to distinguish which server is available.
4. The user selects a connected server and clicks **Open**.
5. The dashboard initiates a minimal launch/access flow for that server.
6. CodeNomad redeems/validates that launch access and creates its normal authenticated web session.
7. The user is redirected into the existing web UI.

---

## Technical contract, at a high level

### Recommended boundary
- **Cloud/dashboard owns:**
  - discovery of connected servers
  - authorization to launch/access a specific server
  - issuance of a **short-lived launch/access artifact**

- **CodeNomad owns:**
  - redeeming/validating that launch artifact
  - creating the normal authenticated session cookie
  - serving the existing web app

### Recommended handshake
1. Phase 1 connector keeps the server registered and connected.
2. Dashboard lists connected servers from cloud.
3. User clicks **Open** for a chosen `serverId`.
4. Dashboard/cloud obtains a short-lived per-launch artifact.
5. Browser is sent to a CodeNomad bootstrap/open endpoint carrying that artifact.
6. CodeNomad redeems it with cloud.
7. CodeNomad creates the normal web session.
8. CodeNomad redirects into the existing web UI.

---

## Minimum dashboard-visible server model
The dashboard should show only the minimum user-safe metadata needed to choose and open a server:

- stable `serverId`
- human-readable server label
- connection state
- `lastConnectedAt`
- basic version/support compatibility metadata if needed

The dashboard should **not** expose:
- private connector credentials
- raw loopback URLs
- local filesystem paths
- internal CodeNomad auth cookies/tokens

---

## In scope
- dashboard visibility of connected CodeNomad servers
- dashboard **Open/Access** action
- minimal launch/access handshake
- CodeNomad bootstrap endpoint for cloud-driven open flow
- use of the existing web CodeNomad experience after access is granted
- end-to-end verification of dashboard → open connected server

---

## Explicitly out of scope
- multi-profile or multi-cloud management
- non-web desktop polish
- advanced recovery/retry/offline orchestration
- broader remote session redesign
- broader replacement of current remote-connect workflows
- fleet/admin management expansion
- deep workspace/session management from dashboard

---

## Acceptance criteria

- **AC-1:** A connected CodeNomad server is visible in the web dashboard with enough identity/status for a user to distinguish and select it.
- **AC-2:** The dashboard provides an **Open/Access** action for a connected server.
- **AC-3:** Invoking **Open/Access** initiates a bounded launch flow that reaches CodeNomad without exposing connector secrets to the user/browser.
- **AC-4:** CodeNomad validates the launch request, creates its normal authenticated web session, and redirects the user into the existing web UI.
- **AC-5:** If the server is not available/openable, the dashboard presents a clear unavailable state without advanced recovery behavior.
- **AC-6:** Phase 2 ships without multi-profile cloud support, non-web desktop polish, advanced recovery logic, or broader remote-workflow redesign.

---

## Why this is the right Phase 2
This gives us the missing product step:

- Phase 1 proved the machine can connect
- Phase 2 proves the user can **actually access it from the dashboard**

It stays focused and avoids turning Phase 2 into a full remote-platform rewrite.

## Recommendation
I recommend we lock this as the Phase 2 direction.

If you approve it, I’ll convert this into a formal SCR and implementation-planning task set.

**User**
Approved, what you need from me to be autonomous?

**product_manager**
To go autonomous on Phase 2, I need a few concrete things from you:

## Required

1. **Repo scope confirmation**
   - Is all Phase 2 work in this repo?
   - Or does dashboard/cloud code live in another repo too?

2. **Permission to modify dashboard/cloud side**
   - Since Phase 2 is **web dashboard first**, I need confirmation I can change:
     - dashboard code
     - cloud/backend launch-flow code
     - CodeNomad server code
   - If any of that is in another repo, I need the path/repo.

3. **Commit authority confirmation**
   - You already had me commit earlier, but for Phase 2 I want explicit confirmation:
   - should I autonomously create commits as the work progresses / at closure?

## Very helpful

4. **Cloud/dashboard environment access**
   - whichever environment is used to test the dashboard-open flow
   - staging is probably enough, but I need the right target environment for:
     - dashboard
     - launch/access artifact issuance
     - connected-server discovery

5. **Any cloud-side repo/package references**
   - especially the code that owns:
     - connected server listing
     - launch/access artifact issuance
     - dashboard Open action

6. **Acceptance of bounded scope**
   - just to restate the locked boundary:
     - dashboard-visible connected server
     - dashboard Open/Access flow
     - minimal bootstrap handshake
     - existing web UI destination
     - no broader remote redesign

## Potential blocker I want to call out now
Phase 2 is no longer purely local-server work.

So if the dashboard/cloud control-plane code is not fully present and editable from this repo, I cannot truly execute autonomously until I have:
- access to the relevant repo(s), or
- a clear handoff boundary saying “implement only the CodeNomad side here”

## Smallest answer you can give me
If you want the shortest unblock, reply with:

1. **All code is in this repo** / **dashboard code is in repo X**
2. **Yes, you may modify all required repos**
3. **Yes, you may commit autonomously**
4. **Use staging for validation**

If you send that, I can start the formal Phase 2 execution setup.

**User**
Dashboard already supports displaying the http web based services when client lib is integrated.

Give me the questinos you need me to ask CodeNomad Cloud implementers

**product_manager**
Ask them these, from the **CodeNomad-side integration contract** perspective.

## Core questions

### 1. Open-flow entry contract
- When a connected HTTP web service is shown in the dashboard, what exact data does the dashboard need from the client-lib registration in order to render an **Open** action?
- Is the dashboard already expecting a standard service descriptor for “web app” targets, and if so what is that schema?

### 2. Launch target model
- For a connected CodeNomad server, should the dashboard open:
  - a direct URL provided by the client/lib registration,
  - a cloud-issued short-lived launch URL,
  - or a cloud-issued launch artifact that CodeNomad redeems server-side/browser-side?
- Which of those is the intended model for secure web-app launch?

### 3. Existing support for HTTP web services
- Since dashboard already supports displaying HTTP web-based services, what is the canonical integration path we should follow for CodeNomad?
- Is CodeNomad just another registered HTTP service type, or does it need a distinct service/category/capability flag?

### 4. Required service metadata
- What exact fields should CodeNomad publish so the dashboard can list and open it correctly?
- Please specify required vs optional fields for things like:
  - service id
  - label/name
  - URL
  - icon/type
  - health/connected state
  - last seen / last connected
  - version / compatibility
  - access mode / auth hints

### 5. Auth expectation for dashboard-opened web apps
- When the dashboard opens a registered HTTP service, what auth model is expected?
- Should the target already be directly browser-accessible and self-authing?
- Or is there an expected cloud-mediated access bootstrap step?

### 6. Browser reachability assumption
- Does the dashboard-open flow assume the user’s browser can directly reach the registered service URL?
- Or is the cloud platform expected to proxy/tunnel/relay browser traffic to the service?
- If direct reachability is assumed, what kind of URL should CodeNomad publish?

### 7. Secure launch recommendation
- For a locally connected CodeNomad instance, what is the recommended secure launch pattern?
- Specifically, should we:
  - register a stable dashboard-openable URL,
  - issue short-lived launch URLs,
  - or register a bootstrap endpoint that exchanges a launch artifact before creating a session?

### 8. Session bootstrap semantics
- If a launch artifact or launch URL is involved, what are the expected semantics?
- Please clarify:
  - TTL
  - one-time-use vs reusable
  - audience binding
  - whether it is browser-consumable or server-redeemed
  - failure modes on expiry/invalidity

### 9. Visibility vs launch separation
- Can dashboard listing of a connected service be supported independently from launch/open?
- If yes, what is the minimum metadata for listing only, and what additional metadata/capability is needed to enable **Open**?

### 10. Service state model
- What service states should CodeNomad map to for dashboard presentation?
- For example:
  - connected
  - ready
  - unavailable
  - degraded
  - disconnected
- Which state enables **Open**?

### 11. Capability advertisement
- Is there a formal capability model the client lib expects us to advertise for dashboard-openable web services?
- If yes, what capability/capabilities should CodeNomad declare?

### 12. CodeNomad-specific recommendation
- Given that CodeNomad already has its own authenticated web UI, what integration pattern do you recommend:
  - expose the existing web UI directly as the registered service,
  - expose a dedicated launch/bootstrap endpoint,
  - or use a cloud-mediated open token flow first?

## Important implementation-boundary questions

### 13. What should live in client-lib registration vs CodeNomad server
- Which parts of the dashboard-open flow should be handled purely by the cloud client library integration?
- Which parts must be implemented by the CodeNomad server itself?

### 14. What should *not* be custom
- Which pieces of this flow are already standardized by CodeNomad Cloud and should not be re-invented by CodeNomad?
- We want to avoid building a custom launch flow if the platform already defines one.

### 15. Backward-compatible minimum slice
- What is the smallest supported integration slice that would let the dashboard display and open CodeNomad as a connected HTTP service without requiring broader platform changes?

## Validation / testing questions

### 16. Staging E2E expectations
- For a correctly integrated HTTP web service in staging, what should we expect to observe in the dashboard?
- What exact success criteria should we use for:
  - visible in dashboard
  - open action enabled
  - successful browser launch

### 17. Test fixture recommendation
- Do you have a known-good example of another service using the same dashboard-openable HTTP service integration pattern that we should mirror?

### 18. Compatibility with current tarballs
- Do the current local SDK/client-lib tarballs already include everything needed for:
  - service registration/listing
  - dashboard open behavior
  - any launch capability metadata
- Or are there newer artifacts/changes we need first?

---

## Short version to send them

If you want a tighter message, send this:

> We’re planning Phase 2 for CodeNomad: the dashboard should display a connected CodeNomad instance and let the user open it as a web-based service.
>
> Since the dashboard already supports displaying HTTP web services when the client lib is integrated, we need the exact integration contract:
>
> 1. What service descriptor/schema should CodeNomad publish for a dashboard-openable HTTP web app?
> 2. What exact metadata/capabilities are required for the dashboard to enable the Open action?
> 3. Does Open use a direct registered URL, a short-lived launch URL, or a launch artifact/bootstrap flow?
> 4. What auth/reachability model is expected for opened services?
> 5. What should be handled by the client-lib/platform vs by the CodeNomad server?
> 6. What is the smallest supported integration slice to make CodeNomad visible and openable from the dashboard?
> 7. Do current SDK tarballs already support this, or do we need newer artifacts?
>
> If possible, please point us to a known-good example service using this exact HTTP web-service dashboard-open pattern.

If you want, after they answer, paste it here and I’ll translate it into a concrete Phase 2 implementation plan.

**User**
Answer below

```
Yes — based on the current repo truth, I can answer these from the **current dashboard App View / openable-service contract**.

## Short answer
For the current bounded dashboard “Open server” flow:

- CodeNomad should expose **one primary HTTP service**
- the server must be **online**
- `remoteAccessEnabled` must be **true**
- `primaryService` must be present
- the dashboard “Open” flow is **not** a direct service URL
- it is an **owner-authenticated, session-scoped launch/bootstrap flow**
- current SDK tarballs appear **sufficient for the bounded HTTP App View path**
- the best known-good example is:
  - `scripts/dev/task064-appview-sample.mjs`

---

# Exact answers

## 1. What service descriptor/schema should CodeNomad publish for a dashboard-openable HTTP web app?

There are two relevant layers:

### A. Service registration shape
From `docs/architecture/INTERFACES.md`, the service definition is effectively:

```ts
type ServiceDefinitionV1 = {
  v: 1;
  name: string;      // serviceName
  agentId: string;
  mode: "http" | "tcp";
  target:
    | { type: "loopback"; port: number }
    | { type: "lan"; host: string; port: number }
    | { type: "handler"; handlerId: string };
  policy: {
    allow: {
      methods?: string[];
      pathPrefixes?: string[];
      headers?: string[];
    };
    deny?: {
      pathPrefixes?: string[];
      headers?: string[];
    };
  };
};
```

For a **dashboard-openable HTTP app**, the important part is:
- `mode: "http"`
- one valid HTTP-capable target
- a permissive enough policy for the app paths you want to render

### B. What the dashboard actually consumes
The dashboard server detail shape currently expects:

```ts
primaryService: {
  serviceId: string;
  serviceName: string;
  supportedProtocols: string[];
} | null
```

So from the dashboard perspective, the openable service is the server’s **primary service**.

### Practical recommendation
For current CodeNomad integration, publish a single primary service that behaves like:

- `serviceName: "CodeNomadService"`  
  or another stable service name if intentionally changed
- supported HTTP semantics
- target = loopback / LAN / handler
- allowlisted policy for the app routes

---

## 2. What exact metadata/capabilities are required for the dashboard to enable the Open action?

This is the clearest part of the current implementation.

In `apps/dashboard/src/app/dashboard/servers/[serverId]/page.tsx`, the **Open server** button is disabled unless:

- `server.capabilities?.remoteAccessEnabled` is truthy
- the server is **online**
- `server.primaryService` exists

So the current required conditions are:

### Required for Open button enablement
1. server is online
2. `capabilities.remoteAccessEnabled === true`
3. `primaryService != null`

### Important note
The current button logic does **not** appear to gate on `supportedProtocols` explicitly in the UI enablement check.

However, for a **real HTTP web app**, you should still expose `supportedProtocols` including at least:
- `"http"`

And likely, if your app needs them:
- `"https"`
- `"sse"`

The bounded App View production target explicitly supports:
- same-service document rendering/navigation
- same-service assets
- cookies/forms/redirects
- light same-origin JS
- SSE

WebSockets are still a bounded/non-guaranteed area in product scope.

---

## 3. Does Open use a direct registered URL, a short-lived launch URL, or a launch artifact/bootstrap flow?

It is best described as a **session-scoped bootstrap flow**, not a direct registered URL.

### What the UI does
The dashboard button opens:

```ts
/app-view/<serverId>/<serviceName>
```

not a service-owned public URL.

### What the platform model does
The dashboard then creates a **remote session** for the resolved primary service.

From the dashboard spec:
- session creation returns:
  - `sessionId`
  - `remoteSessionToken`
  - `expiresAt`
  - `iceServers`

So the real answer is:

> Open uses a dashboard-owned, owner-authenticated, short-lived session bootstrap flow built on remote-session creation, not a direct persistent service URL and not a consumer-visible launch artifact.

There is also a connect URL flow in the system, but the bounded dashboard App View path is specifically the in-dashboard session bootstrap.

---

## 4. What auth/reachability model is expected for opened services?

### Current approved model
- **owner-authenticated**
- **dashboard-scoped**
- **session-scoped**
- **primary-service only**
- **not a public share link**

From the dashboard spec:
- connect URLs are owner-authenticated cloud entry points
- App View is dashboard-scoped and owner-authenticated
- this is not arbitrary-host browsing
- this is not multi-service browsing

### Practical meaning
The platform handles:
- authenticated session creation
- short-lived session token issuance
- ICE / runtime bootstrap
- tunnel/session establishment

The CodeNomad service itself just needs to be reachable behind the registered primary service target.

---

## 5. What should be handled by the client-lib/platform vs by the CodeNomad server?

## Client-lib / platform should handle
- enrollment / presence / server registration
- remote access capability advertisement
- primary service registration
- remote session creation/bootstrap
- session token / ICE runtime handling
- tunnel transport
- dashboard App View session lifecycle

## CodeNomad server should handle
- exposing the actual HTTP application
- choosing the primary target:
  - loopback
  - LAN
  - handler
- providing correct app behavior over HTTP:
  - documents
  - assets
  - forms
  - redirects
  - cookies
  - SSE if needed
- defining the service policy/allowlist appropriately

### Best framing
The platform gets the user to the service securely.  
The CodeNomad server is responsible for the app experience behind that service.

---

## 6. What is the smallest supported integration slice to make CodeNomad visible and openable from the dashboard?

This is the most useful implementation answer.

## Smallest supported slice
1. enroll a server successfully
2. keep it online
3. advertise:
   - `remoteAccessEnabled: true`
4. register exactly one **primary HTTP service**
5. make that service reachable through one target:
   - simplest path is probably:
     - `primaryTarget: { type: "loopback", port: <your-port> }`
6. expose app behavior that fits the bounded App View classes

### Minimal required dashboard-visible state
- server appears in the server list
- `primaryService` is present
- server is online
- remote access capability is on

### Recommended minimal protocols
At minimum:
- `"http"`

If you want the known-good bounded behavior set:
- `"http"`
- `"https"`
- `"sse"`

The known-good sample also includes `"ws"`, but broader WebSocket compatibility is still not the safest thing to promise as the minimum dashboard-open contract.

---

## 7. Do current SDK tarballs already support this, or do we need newer artifacts?

Based on current repo truth: **current SDK tarballs should already support the bounded HTTP dashboard-open/App View path**.

Why:
- TASK-066 marked the SDK integration-ready
- TASK-065 validated bounded App View on staging
- the stable local SDK packaging flow is now in place
- the sample app view integration uses the current `serverConnector` flow

### Caveat
That answer is for the **bounded current App View contract**, not for any broader browser platform ambition.

So:
- **for the current bounded HTTP web-service dashboard-open pattern:** yes, current tarballs appear sufficient
- **for broader scope:** no promise should be inferred

---

## 8. Known-good example service using this exact pattern?

Yes — the strongest known-good reference is:

```text
scripts/dev/task064-appview-sample.mjs
```

Why this is the best example:
- it uses the current `serverConnector` SDK
- it creates a real enrolled server
- it creates an embedded connector
- it publishes a primary loopback HTTP app
- it advertises remote access
- it was used as the staging validation target for the bounded App View MVP / productionized flow

### What it registers
It uses:
- `createServerEnrollment(...)`
- `redeemServerEnrollment(...)`
- `createEmbeddedServerConnector(...)`
- `primaryTarget: { type: "loopback", port: samplePort }`
- `primaryService.supportedProtocols: ["http", "https", "sse", "ws"]`
- `capabilities.remoteAccessEnabled: true`

That is the best “do this shape” example currently in the repo.

---

# Recommended integration contract to give consumers

If you want a clean consumer-facing summary, I’d phrase it like this:

> To make CodeNomad openable from the dashboard in the current bounded App View model, the server should register one primary HTTP service via the client library, keep the server online, and advertise `remoteAccessEnabled: true`. The dashboard enables Open when the server is online, remote access is enabled, and `primaryService` is present. Open is not a direct app URL; it uses an owner-authenticated, short-lived remote-session bootstrap flow inside the dashboard. The current known-good reference implementation is `scripts/dev/task064-appview-sample.mjs`.

---

# Crisp answers by question

1. **Service descriptor/schema?**  
   A primary `mode: "http"` service with target + policy; dashboard consumes `primaryService { serviceId, serviceName, supportedProtocols }`.

2. **Required metadata/capabilities?**  
   Online server, `remoteAccessEnabled: true`, and non-null `primaryService`.

3. **How does Open work?**  
   Session-scoped dashboard bootstrap flow, not a direct persistent registered URL.

4. **Auth/reachability model?**  
   Owner-authenticated, dashboard-scoped, session-scoped, primary-service only.

5. **Platform vs server responsibilities?**  
   Platform handles session/tunnel/bootstrap; CodeNomad server handles the actual HTTP app and service target/policy.

6. **Smallest supported slice?**  
   One online server + one primary HTTP service + remote access enabled + loopback target is enough.

7. **Current SDK tarballs sufficient?**  
   Yes, for the current bounded HTTP App View/dashboard-open pattern.

8. **Known-good example?**  
   `scripts/dev/task064-appview-sample.mjs`

If you want, I can now rewrite this into a **ready-to-send response to client-lib consumers** in a shorter product/engineering tone.
```

**product_manager**
Yes — this is enough to move Phase 2 from “concept” to a **concrete implementation plan**.

## What this answer changes
It narrows Phase 2 nicely:

We **do not** need to invent a new launch/bootstrap model.

Instead, Phase 2 should use the **existing bounded App View contract**:

- one online connected server
- `capabilities.remoteAccessEnabled: true`
- one `primaryService`
- primary HTTP service registered through the client lib
- dashboard **Open** uses the existing **owner-authenticated, session-scoped App View flow**
- current SDK tarballs appear sufficient
- best reference is:
  - `scripts/dev/task064-appview-sample.mjs`

That’s a much better Phase 2 than the earlier more speculative “short-lived artifact redemption” model.

## Revised Phase 2 definition
**Phase 2 = make CodeNomad appear as an openable primary HTTP service in the dashboard App View flow.**

### In scope
- keep CodeNomad server online/present
- advertise `remoteAccessEnabled: true`
- register one primary HTTP service for the CodeNomad web UI
- ensure the service target/policy supports the bounded App View contract
- validate dashboard **Open** against the registered CodeNomad primary service
- verify end-to-end dashboard → App View → CodeNomad web UI

### Out of scope
- custom launch artifact design
- broader remote redesign
- multi-profile cloud
- non-web desktop polish
- advanced recovery logic

## Biggest practical implication
The main work is now likely on the **CodeNomad registration shape** and possibly **HTTP app compatibility/policy**, not on inventing a brand-new dashboard handshake.

## What I’d do next
I’d convert this into a formal Phase 2 execution setup centered on:

1. **Spec update / SCR**
   - revise the Phase 2 contract around existing App View

2. **Implementation work**
   - register CodeNomad as the primary HTTP service
   - ensure capability + metadata are correct
   - make sure the existing web UI works under the bounded App View transport expectations

3. **E2E**
   - dashboard shows CodeNomad server
   - Open button enabled
   - App View launches CodeNomad successfully

## One thing I still want to confirm with you
Given this new answer, do you want Phase 2 to target:

1. **Just CodeNomad-side changes in this repo**  
   assuming dashboard already knows how to render/open the service once registration is correct

or

2. **CodeNomad-side plus any needed dashboard/cloud repo changes**  
   if we discover the dashboard still needs small adjustments for labeling/display polish

My recommendation: **option 1 first**.  
If the existing App View contract is truly enough, that keeps Phase 2 tight.

If you confirm that, I’ll move into formal Phase 2 spec/SCR setup and implementation planning autonomously.

**User**
option 1 only

**product_manager**
Perfect — that keeps Phase 2 nicely bounded.

## Locked execution boundary
**Phase 2 will be CodeNomad-side only in this repo.**

So I will assume:

- dashboard/cloud App View contract already exists
- current SDK tarballs are sufficient for the bounded App View path
- our job is to make CodeNomad register and behave as a valid **primary HTTP service**
- no dashboard/cloud repo work is included in this phase

## What I’ll target
Phase 2 implementation will focus on:

1. **Primary service registration**
   - CodeNomad advertises one primary HTTP service

2. **Capability advertisement**
   - `remoteAccessEnabled: true`

3. **Target selection**
   - likely loopback target to the existing local server listener

4. **Service metadata**
   - correct `primaryService` shape and supported protocols for bounded App View

5. **HTTP compatibility**
   - ensure the existing web UI works under the bounded App View expectations
   - documents, assets, cookies, redirects, forms, SSE as needed

6. **E2E verification**
   - server visible in dashboard
   - Open button enabled
   - dashboard App View launches CodeNomad successfully

## What I’m explicitly not doing
- no dashboard repo changes
- no new custom launch artifact protocol
- no broader remote workflow redesign
- no desktop polish
- no multi-profile cloud work

## Next step
I’ll move into:
- formal Phase 2 SCR/task setup
- implementation planning
- autonomous execution in this repo only

If you want, I can start that now.

**User**
Go for it

**product_manager**
Pre-sync surfaced two real gaps, so I’m getting a technical addendum locked before developer handoff instead of making the developer guess.

**product_manager**
I’ve locked the missing technical constraints. I’m handing Phase 2 to the developer now with the App View contract bounded to repo-only changes.

**product_manager**
QA found a real live blocker: the dashboard Open path is returning a 410 removal page in staging, so I’m getting a technical review before deciding whether this stays blocked or can be worked around within repo-only scope.
