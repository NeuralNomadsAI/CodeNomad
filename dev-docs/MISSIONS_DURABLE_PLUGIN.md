# Private durable Missions product-adapter fixture

## Outcome: eleven private native gates passed; production unqualified

This is **not desktop enablement or managed-host qualification**. The isolated
OpenCode **2.0.21** run passed all eleven bounded product-adapter fixture gates.
`completed` is true, `blockers` is empty, and `qualified` deliberately stays false.

Final evidence:

- `C:/Users/Admin/AppData/Local/Temp/opencode/missions-durable-TKZjHq/result.json`
- `C:/Users/Admin/AppData/Local/Temp/opencode/missions-durable-TKZjHq/native.log`
- Source SHA-256 values before/after match; assigned CLI reports `2.0.21`.
- Separate private sentinel PID/session remained unchanged after primary
  backend/child cleanup. No shared/user daemon was contacted.

Independent coordinator rerun also passed all eleven gates:
`C:/Users/Admin/AppData/Local/Temp/opencode/missions-durable-WLcrf7/result.json`.
Its source-hash set additionally includes `authority-synchronous.ts` and
`authority-admission.ts`. The same `qualified:false` and private-injection limits
apply; repetition does not qualify host provisioning or desktop lifetime.

Native plugin storage is plugin-scoped. Its namespace UUID identifies the
**storage incarnation**, not a project partition. A preliminary fixture assertion
incorrectly expected distinct UUIDs per project; source inspection corrected it.
The actual authority document key is
`codenomad-missions/authority-v1/project/{projectToken}`, derived from native
project ID and canonical identity. The final fixture writes a real first-project
grant, proves it is absent from the other project's state/journal, refuses the
original project's signed intent at the second location, and rechecks the first
grant unchanged. UUID equality is not reported as a product defect. No storage
wrapper, alternate authority engine or product patch was introduced.

## Run

```powershell
node --check scripts/test-missions-durable-native.mjs
node --check scripts/missions-durable-native/plugin.mjs
node --check scripts/missions-durable-native/broker.mjs
node --check scripts/missions-durable-native/schema.mjs
node scripts/test-missions-durable-native.mjs "C:/Users/Admin/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe"
```

Only that assigned absolute CLI is accepted. The final native command exited
**0**; any failed assertion or bounded native failure exits **1** and records its
stage in the artifact. Passing this fixture is not production qualification.

Each run keeps its exact artifacts in a new
`C:/Users/Admin/AppData/Local/Temp/opencode/missions-durable-*` directory:
`result.json`, `native.log`, private generated entry/bundle, isolated database,
Git projects, profile settings and protected fixture grant file. The generated
entry/bundle contains a private bridge token; do not publish it or the entire
temporary directory. The signing private key stays in runner memory only.

## What is real, and what is deliberately injected

- The bundle imports the **actual** `setupDurableMissionsPlugin`, which uses
  genuine `setupMissionsPlugin`, `MissionControl`, journal, authority protocol,
  store, RPC definition and reservation/completion code. Source SHA-256 values
  are recorded, not a copied prototype implementation.
- Actual native `storage.get/set/scan`, `rpc.register`, tool transforms,
  model-context hooks, provider HTTP hooks and unload are exercised. Diagnostics
  record the installed context methods. The measured plugin context has no
  `environment`/`inbox` methods; those calls correctly use the authenticated
  backend's native **client**, which declares both.
- The Ed25519 public key, generation, profile/host/key IDs and physical Git
  identities are pinned in the trusted generated entry. No trust comes from
  `ctx.options`, RPC input, configuration booleans or caller-provided keys.
  Real native UUID challenge, nonce, project/canonical binding and product
  signing bytes authenticate each signed typed intent.
- **Managed incarnation/qualified signer assertions are private injections**.
  This construction is not proof of protected installation, human approval,
  old-writer exclusion, downgrade resistance or actual host provisioning.
- The private host grant registry originates from runner-verified immutable
  signed bodies. Broker checks compare full host/native grant mirrors and the
  original intent digest/binding/**signed epoch**, including denial before Stop.
  No epoch is silently substituted from the latest mirror.
- The authenticated loopback bridge calls real `WorkspaceManager` and
  `admitMissionInput`/lifecycle routes with real ownership and deletion fences.
  It serializes sends, re-reads profile environment on admission and checks the
  original protected grant again after native preparation. A token-authenticated
  checkpoint RPC calls the adapter's own **read-only** final callback immediately
  before native effects; it never invokes a mutation under the project lock.
- Direct private `session.prompt` calls in the runner are explicit human test
  stimuli to request a provider-selected native mission tool. They are not
  adapter transport fallbacks. Tools execute with genuine native session actors,
  not an RPC tool-driver or fabricated invocation context.
- No `DesktopPluginLifecycle`, presence, automation attachment, dispatch loop,
  service discovery, installation, shared-daemon stop/restart or deployment.
  Native browser definitions may exist in the registry; permission rules deny
  them and no browser/desktop attachment is installed.

## Bounded assertions (not production qualification)

The final artifact records eleven gates, including two distinct-project identity
and storage-isolation gates. The scenarios are:

- Actual native product setup, UUID/storage/RPC/tools, no presence.
- Distinct Git projects, real authority grant/journal isolation and refusal of the
  first project's original signed intent at the second native location.
- Signed deterministic **prepared** create, adoption and exact epoch; unsigned
   create/update/delete/lifecycle/recover and forged profile refused; real inspect.
- Play through real lifecycle/bridge; provider consumes the start input; native
   shell observes freshly applied full environment without bridge/DB/auth secrets.
- Existing-root delegation, native actor report and saved outbox `admitted` ACK;
   separate provider request proves coordinator consumption. Duplicate report
   does not wake it again.
- Bridge unavailable: inspect/context and newly reported native evidence remain
   available/pending, with no coordinator wake or direct-send fallback. The fixture
   physically closes its owned bridge listener; native daemon/plugin/provider stay
   live. Explicit restoration rebinds the same trusted loopback endpoint.
- Explicit restoration, Pause then Play, and same saved-report retry admit its
   stable notification input; no assignment replay. **Play is invalid when already
   running. Play alone does not drain the outbox in this adapter.**
- Real directory deletion fence blocks a dispatch; only explicit identical retry
   admits one assignment after the fence clears.
- Signed update/coordinator recovery/Pause; changing protected epoch **after
   environment preparation** vetoes native send. Receipt stays honestly pending,
   sends disabled; exact signed retry does not rerun the effect.
- Signed terminal Stop supersedes that pending Play; real native location reload
   fences a previously captured native inspector closure. Damaged authority is
   not repaired; inspect and a **new late actor report** still persist without
   waking the coordinator. Agent/model/location selections remain unchanged.

`recover/report` means asking an actor for a **missing task report**, not retrying
notification of an already saved report. The fixture does not misuse it as an
outbox driver. Native `location.reload` is explicit, private to this child, and
used only for bounded unload/damage tests—not an automatic recovery mechanism.

All of these assertions ran against native 2.0.21. Transport traces distinguish
native effect attempts, returned native ACKs, journal notification admission and
actual provider consumption. `qualified` remains `false` even when every fixture
assertion passes: production host qualification is a separate gate.

## Open gates

- Cross-project grants/journal were checked, but concurrency/ownership storage
  qualification across aliases, checkouts and independent writers remains open.
- Protected human signer provisioning/rotation/generation and managed writer
  incarnation, old-writer exclusion, downgrade and crash/restart qualification.
- Production authenticated bridge, physical root/family identity and protected
  host grant transactions across competing processes (fixture claims alone are
  not approval).
- New managed specialist creation and managed session cleanup remain unsupported
  by the delivered adapter. This fixture does not fake either capability.
- Background host lifetime, automatic notifications, dispatch/control recovery,
  packaged Electron/Tauri, WSL, macOS/Linux, production detach/reconnect and
  permissions/Forms/Shell recovery coverage are not qualified here.
- Desktop rollout and public/private packaging decisions remain disabled and
  outside this fixture. No product source, dependencies, installs or runtime
  configuration are changed by the repository patch.
