# Desktop versions, update feeds and data profiles

Three independent notions:

| Notion | What it is | Who chooses it | What it affects |
|---|---|---|---|
| Installed version | The build you run, e.g. `0.20.1` or `0.20.1-dev-20261008-…` | The installer | Nothing else. It never selects data. |
| Update feed | Which releases are offered: `stable` or `preview` | The user, in Settings → Info → Updates (`server.updateFeed`) | Update offers only. Until chosen, `-dev-*` builds default to preview, others to stable. |
| Data profile | Which desktop state is used: windows, tabs, drafts, WebView/Chromium storage, singleton and CodeNomad backend | The user, in Settings → General → Restore previous state (**Data profile**); developers with `CODENOMAD_PROFILE` | Desktop data only. |

OpenCode sessions and messages live in the shared OpenCode daemon and are the same in every profile. Server configuration (`CLI_CONFIG`, default `~/.config/codenomad/config.yaml`) is also independent of the profile; a non-default config file gets its own scope.

## Selecting a profile

Precedence, evaluated by both Electron (`electron/main/data-profile.ts`) and Tauri (`src-tauri/src/data_profile.rs`) before any profile path, singleton or WebView storage is fixed:

1. `CODENOMAD_PROFILE=<name>` — explicit profile.
2. `CODENOMAD_UPDATE_CHANNEL=<value>` — deprecated alias, only when `CODENOMAD_PROFILE` is unset or blank.
3. Unpackaged (npm/dev) runs — the `dev` profile.
4. Packaged builds — the remembered choice (made in the profile manager or by the automatic choice), otherwise the automatic choice below, otherwise the default profile.

Updating CodeNomad or changing the update feed never changes the profile.

### `CODENOMAD_PROFILE` grammar

After trimming ASCII whitespace and lowercasing ASCII letters: 1–64 characters from `a-z`, `0-9`, `.`, `_`, `-`, starting with a letter or digit. Non-ASCII and other characters are rejected. `default` and `stable` both mean the default profile. An invalid value shows an error and quits; it never opens another profile. Both hosts run the shared vectors in `packages/electron-app/electron/main/data-profile-vectors.json`.

### Storage

The default profile with the default config uses the unscoped locations (`~/.codenomad/client-state/v2`, Electron's `userData`, Tauri's stable identifier and WebView directory). Every other profile/config pair uses `<scope> = <key>-sha256(key + "\0" + configIdentity)[0..16]`, i.e. `%APPDATA%/CodeNomad/scopes/<scope>` (Electron `userData` and both hosts' client state) and `…-v2/scopes/<scope>` (Tauri WebView), plus a scoped Tauri identifier. The default profile's key is `stable`, so existing folders such as `dev-<hash>` and `dev-v2-<hash>` are reached with `CODENOMAD_PROFILE=dev` / `dev-v2`.

On Windows, Tauri runs each profile under its identifier as AppUserModelID, and its system notifications carry that ID. Windows shows a desktop app's notifications only under an ID it knows, and the installer's Start menu shortcut carries the stable one, so every launch registers the running ID under `HKCU\Software\Classes\AppUserModelId\<identifier>` (`DisplayName` CodeNomad, `IconUri` the bundled web app icon `resources\server\public\pwa-192x192.png`; `windows_notification_identity.rs`). Electron always uses the stable ID.

The alias uses each host's own normalization (Electron lowercases Unicode and turns each run of other characters into `-`; Tauri lowercases ASCII and collapses separators); keep both exactly, since changing either moves alias scopes. `CODENOMAD_UPDATE_CHANNEL=default` selects the `default-<hash>` scope, whereas `CODENOMAD_PROFILE=default` is the default profile.

Non-ASCII config paths on Windows: each host folds the config identity's case differently (Electron uses Unicode lowercase, Tauri ASCII lowercase), so for a path such as `C:\Users\Émile\…` the two hosts compute different scope hashes. Keep this divergence: changing either fold would move scoped folders. The choices file uses one shared fold (see below).

Every backend launch (the default profile included, as key `stable`) receives the resolved scope that the backend uses as its Mission profile scope: `CODENOMAD_UPDATE_CHANNEL=<profile key>`, `CODENOMAD_PROFILE_CONFIG_IDENTITY=<config identity>` and the selected `CLI_CONFIG`. Tauri applies these only to the backend `Command`, never through a process-wide `set_var`. They are backend-only: the backend strips them and `CODENOMAD_PROFILE` from the environment of the shared OpenCode daemon it starts (`workspaces/host-opencode-service.ts`), so agent shells never pin a desktop launched from them to this profile.

## Automatic choice

On a packaged launch without `CODENOMAD_PROFILE`/alias and without a usable remembered choice, the host decides alone, without asking:

1. Looks, read-only and size-bounded, at the default profile and the `dev` and `dev-v2` scopes for the same config identity, using the regular client-state parsers. A store counts only when a restore-enabled window has a workspace tab (more than the session partition, or a `workspace`-kind tab in a legacy monolithic snapshot; sidecar-only tabs never count). Legacy default files count only while the current shared file is missing.
2. None → default profile. One → that profile. Several → the most recently used one (newest client-state write; ties go to the default profile, then `dev`, then `dev-v2`).
3. Remembers the result in `%APPDATA%/CodeNomad/profile-selection/choices.json` (macOS `~/Library/Application Support/CodeNomad`, Linux `$XDG_CONFIG_HOME/CodeNomad`), outside every profile: `{ "version": 1, "choices": { "<sha256(choice identity)>": "<profile name>" } }`. Names only, never paths; atomic write; at most 64 KiB/256 entries. A corrupt file or entry reruns detection; a remembered named profile whose `scopes/<scope>` folder definitely no longer exists under the userData base for this config (both hosts create it when they open a scoped profile) is ignored, so detection reruns and replaces it rather than silently opening an empty profile, even in a full file. This check follows a symlink/junction, because the hosts open a relocated profile through it (deletion never follows links). Only a definite absence of a plain entry (not found, or not a directory) counts as missing and is replaced. When `scopes/<scope>` is itself a link whose target is missing or not a folder (for example a disconnected removable or network drive), the profile is only unavailable: detection decides that launch, which is unremembered, and the choice is kept, so the profile is used again once its target returns. An unreadable entry, or any other error, keeps the choice and uses it. Both hosts run the same `rememberedProfileStates` vectors; the automatic choice never overwrites another valid choice (only the profile manager does); a newer-version file is left untouched (detection runs each launch). On Windows the choice identity is the config identity folded with Unicode lowercase on both hosts (idempotent over either host's identity), so Electron and Tauri share a choice even for non-ASCII paths; no folder depends on this key. Other platforms keep case-sensitive identities.

Remembering is best effort. If the selection folder, the lock or `choices.json` cannot be written (antivirus EPERM/EBUSY, full disk, read-only `%APPDATA%`), the launch still starts with the detected profile and the automatic choice simply runs again next time.

The automatic choice never moves, copies, merges, renames or deletes anything. Other profiles stay on disk until the user deletes them (see below).

Writes to `choices.json` take `profile-selection/choices.lock` (exclusive create, taken over once it is 15 s old). A first attempt only moves a stale lock aside, so the launch and the profile manager try twice. A launch that finds the lock held, or cannot use it, opens the detected profile without remembering it; concurrent first launches detect the same result. Known, accepted race: taking over a stale lock moves it aside and restores it if it turns out to be fresh; if a third launcher creates a new lock in between, the restore fails and two writers may hold the lock at once, and the automatic choice still never overwrites a valid entry.

Both hosts decide before any window, singleton or WebView/Chromium storage exists. Electron launches also remove leftover `%TEMP%/codenomad-profile-selection-*` folders not touched for 10 minutes, without following links, and drop `CODENOMAD_PROFILE_SELECTION_ANSWER` and `CODENOMAD_PROFILE_SELECTION_CLEANUP`, which an older build's relaunch can still carry, from their environment before anything reads it, so neither the backend nor its terminals inherit them.

## Profile manager

A profile is only saved desktop state. Settings → General's startup card (**Restore previous state**) ends with one folded line, "Data profile: <name>", naming the open profile ("Default" for the default profile). It appears in main windows and in the desktop Preferences window, and is hidden in a plain browser and in remote windows (`components/settings/data-profiles-settings.tsx`). Unfolded, it lists the open profile first, then the others by last use, each with its size, creation date and last use:

- `createdAt` is the birth time of the profile's main folder (a named scope's `scopes/<scope>`, the default profile's `~/.codenomad/client-state/v2`, an unused lock folder itself), read without following links; it is omitted when the filesystem reports no birth time. Node reports the change time when Linux gives no birth time, so Electron also treats a Linux birth time equal to the change time as unknown.
- `lastUsedAt` is the newest modification time of the client-state files the automatic choice reads, counted even when they hold nothing restorable and read without following links; "never used" when none exists.

A radio chooses the profile the next launch opens: any profile of this configuration, the open one included (which cancels a pending choice). Profiles of another configuration and unused lock folders are listed but cannot be chosen. **New profile** takes a name, checks the `CODENOMAD_PROFILE` grammar in the renderer and again on the host, and chooses it. While the next launch's profile differs from the open one, **Restart in <name>** restarts the application the way developer mode does (Electron `lifecycle.requestRelaunch()`, Tauri `shutdown::request_restart`); the relaunch resolves its profile normally, so it opens the remembered choice. When `CODENOMAD_PROFILE`, its alias or an unpackaged run decides every launch (`pinned`), the radios and **New profile** are disabled with a note; deletion still works. "Clear saved state" only affects the current window.

**Choosing the next launch's profile.** The host validates the name (`default` and `stable` mean the default profile, stored as `default`), takes the selection lock and overwrites this configuration's entry in `choices.json` with the automatic choice's atomic write, limits and version handling; a corrupt file is replaced by one holding only this entry. A crashed launch's stale lock is only moved aside by a first attempt, so the host tries twice. Inside the lock, a named profile whose `scopes/<scope>` folder is missing gets it (a plain create; any existing entry, link or not, is left as is), so the launch's remembered-profile check keeps the choice; a failed write removes the folder again while it is still empty. Outcomes: `updated`, `invalid`, `busy` (a launch holds the lock) and `failed` (newer-version or full file, write error). The listing's `nextLaunch` reads the remembered entry back without checking that its folder still exists, so a choice the launch would ignore can be shown.

### Deleting a profile

Every other profile has a delete button, disabled while the profile is in use or its state unknown; the confirmation names the profile and its size.

**Which profiles.** Every data profile on this machine except the open one: each `scopes/<key>-<hash>` folder under Electron's userData base or the Tauri WebView root (any config identity, including legacy-alias keys; profiles of another config are labelled "other configuration"), the default profile when the open one is scoped (named, or the default profile of a non-default config), and Tauri lock folders `ai.neuralnomads.codenomad.client.scope.s<hash>` whose hash matches no scope folder (shown as unused lock folders). The listing is computed when the card mounts or on explicit refresh, never polled, read-only, reading at most 10 000 names and keeping at most 512 profiles per root, with a size walk of at most 20 000 entries and depth 32 per profile (the size is then shown as "at least X").

**What is deleted.**

| Profile | Removed | Never touched |
|---|---|---|
| Named scope | `<appData>/CodeNomad/scopes/<scope>` (Electron data and both hosts' client state), `<localData>/ai.neuralnomads.codenomad.client-v2/scopes/<scope>` (WebView), `<dataDir>/ai.neuralnomads.codenomad.client.scope.s<hash>` (Tauri locks) | other scopes, `scopes/` itself, `profile-selection/` |
| Default | Electron `developer-mode-browser-v2/` and legacy `client-state.json` in `<appData>/CodeNomad`; `~/.codenomad/client-state/v2/client-state.json` and `v2/partitions/`; legacy `~/.codenomad/client-state/client-state.json`; WebView `developer-mode/`, `local/`, `remote/`, `browser/` in `client-v2`; legacy Tauri `client-state.json` | `scopes/`, `profile-selection/`, the election folders, lock/marker files; any other entry is kept and reported as not recognized |
| Unused lock folder | the folder | — |

The default profile's folders are parents of other roots, so they are never removed recursively: only the children above, which the host code creates, are deleted. Every target must be a plain direct child of a link-free root with the planned name; symlinks and junctions are neither listed nor followed. Links nested inside a removed folder are unlinked without traversal (Node's `fs.rm` and Rust's `remove_dir_all` both treat junctions and symlinks as links; regression tests cover a nested junction/symlink on both hosts).

**macOS WebKit storage is kept.** On macOS, Tauri windows of every scoped profile use the same WebKit data-store identifier (`profile_identifier("local")`) inside the app's single WebKit container, and the default profile uses WebKit's default store. No profile owns that store, so it is never deleted: removing it would also clear other profiles, including the open one. Electron keeps its web storage inside the profile folder, which is deleted. The listing reports `sharedWebKitStorage` on macOS and the confirmation says that Tauri's WebKit web storage, sign-ins and cache are shared and not deleted.

**In use.** A profile can be open in either host, so both hosts check the same evidence: Electron running markers and primary/registration locks; Chromium's process singleton, which Electron's `requestSingleInstanceLock()` takes while userData is still the profile folder itself (Chromium storage moves to `developer-mode-browser-v2` only afterwards), so it is read directly in `scopes/<scope>/` or, for the default profile, in `<appData>/CodeNomad`: Windows `lockfile` (delete-on-close, so present only while held) and POSIX `SingletonLock`, a symlink to `<hostname>-<pid>` (a lock of this host with a live PID is in use, with a dead PID is stale, another host's or an unparsable one is unknown; `SingletonSocket`/`SingletonCookie` carry no ownership); the cross-host client-state election (owner and participants); Tauri running markers and WebView2 `EBWebView/lockfile`. A live PID counts as in use even if it was reused; an unreadable marker or lock means "state unknown". In-use and unknown profiles are listed but skipped. The host rechecks immediately before removing each folder and stops at the first sign of activity; locked files make removal fail rather than succeed partially in silence. The result lists, per profile, deleted / in use / unknown / no longer found / incomplete with the exact paths that remain, and the list refreshes.

**Remembered choices.** After deleting a named profile of the open configuration, that configuration's entry in `profile-selection/choices.json` is removed if it names the profile (its choice key is known). Other configurations' keys cannot be mapped back to a scope, so their entries naming it are removed only when no folder of that profile remains for any configuration (a scope entry that is a symlink or junction, present or dangling, counts as remaining here, because a configuration may open its profile through it; links are still never listed or deleted); a remaining stale entry is still caught at launch, which ignores remembered profiles whose folder is gone. The update takes the selection lock; if a launch currently holds it, or the file is corrupt or newer, nothing is rewritten. Choices naming `default` are never removed.

**Contract.** Four host operations, granted to local windows and Preferences only: list (the open profile as `current`, the others, `nextLaunch`, `pinned`, `sharedWebKitStorage`), delete, choose the next launch's profile and restart (Electron IPC `data-profiles:listOthers` / `deleteOthers` / `setNextLaunch` / `relaunch`, Tauri commands `data_profiles_list_others` / `data_profiles_delete_others` / `data_profiles_set_next_launch` / `data_profiles_relaunch`). The renderer sends only IDs from a listing (`default`, `scope:<scope>`, `orphan:<hash>`) or a profile name; the host re-enumerates, re-validates and rechecks activity before deleting and never accepts paths. Operations are serialized per host process. Implementation: Electron `data-profile-cleanup.ts` and `data-profile-cleanup-ipc.ts`, Tauri `data_profile_cleanup.rs`, UI `components/settings/data-profiles-settings.tsx` over `lib/native/data-profiles.ts`.

Known limits: the Tauri singleton itself is not file-based; a Tauri instance is detected through the running marker it creates while starting, and its WebView2 locks. A profile opened between the last check and a removal is caught only by the operating system's file locks.

## Validation

- Electron: `data-profile.test.ts`, `profile-transition.test.ts` (including unwritable choices/lock and the leftover-folder sweep), `startup.test.ts`, `data-profile-cleanup.test.ts`, `data-profile-cleanup-ipc.test.ts`, `preload/index.test.ts`.
- Tauri: `data_profile`, `profile_transition`, `client_state::restorable`, `identity`, `data_profile_cleanup` tests.
- UI: `tests/browser/data-profiles.test.ts` (the profile manager in Preferences and inline, pinned launches, plain browser).

**Restart in <name>** needs a manual check on each host. Profile deletion is tested against temporary roots, with Chromium singleton files simulated at the location derived from main.ts ordering; a running second host needs a manual check.
