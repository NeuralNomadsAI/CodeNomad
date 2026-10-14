# Fresh profile environment reads at admission

`SettingsService.readEnvironmentForAdmission(signal)` reads only the profile's
resolved `ConfigLocation.configYamlPath`. `WorkspaceManager.getSessionEnvironment`
uses this read before calling the existing execution-host snapshot builder.
Ordinary settings reads, UI caches, settings persistence and daemon startup
environment behavior are unchanged.

Each admission opens and reads the canonical file anew. There is no fallback to
cached settings, `state.yaml`, legacy JSON, backups, another profile or browser
storage. An absent canonical file has the normal empty-profile override default;
removing an override (or the file) rebuilds from the authority process environment,
not the previous native session snapshot. A missing server/environment owner in
a valid object document also means no overrides. Profile/host ownership remains
the caller's responsibility.

Reads are limited to 1 MiB, including growth after stat, and a 2-second I/O admission
deadline. Nonregular files, unreadable files, malformed UTF-8/YAML, duplicate keys,
parser warnings, excessive alias expansion, invalid document/owner/environment
shapes and invalid environment entries reject with
`PROFILE_ENVIRONMENT_UNAVAILABLE`. Empty/null documents are not valid object
documents. Legacy `preferences` layout must go through the existing startup
migration; the admission reader never migrates or writes it. Cancellation rejects
without carrying the caller's abort reason. A late I/O completion closes its
descriptor but cannot admit a native send. Parsing is synchronous and bounded by
the file/alias quotas; the deadline is not preemption of synchronous parser work.

The reader never logs and replaces underlying parser/I/O errors with a fixed
message, without paths, values or error causes. Failed reads return no snapshot,
so callers cannot apply `session.environment` or send prompt/synthetic input.
Native authority, connection and ownership fences still apply around the awaits.

The existing `session-environment.ts` constructs the **full** snapshot: host
`process.env` plus overrides (case-insensitive keys on Windows), or the selected
WSL distro's bounded `env -0` result plus overrides. Internal authentication and
native storage variables remain excluded. Restarting the authority can change its
base process environment; this does not claim a live global OS environment read.

Validation (isolated temporary files; no daemon/application/user-config mutations):

```text
node --import tsx --test packages/server/src/settings/admission-environment.test.ts packages/server/src/settings/service.test.ts packages/server/src/workspaces/session-environment.test.ts
npm run typecheck --workspace @neuralnomads/codenomad
```
