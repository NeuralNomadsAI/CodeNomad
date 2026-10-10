# Desktop versions, update feeds and data profiles

Three notions used to be one value (the "channel"). They are now independent.

| Notion | What it is | Who chooses it | What it affects |
|---|---|---|---|
| Installed version | The build you run, e.g. `0.20.1` or `0.20.1-dev-20261008-…` | The installer | Nothing else. It never selects data. |
| Update feed | Which releases are offered: `stable` or `preview` | The user, in Settings → Info → Updates (`server.updateFeed`) | Update offers only. Until chosen, `-dev-*` builds default to preview, others to stable. |
| Data profile | Which desktop state is used: windows, tabs, drafts, WebView/Chromium storage, singleton and CodeNomad backend | Developers, explicitly, with `CODENOMAD_PROFILE` | Desktop data only. |

On the preview feed, offers follow publication order (preview builds carry the previous release number, so SemVer would rank them below their base release). When the installed release is older than the first page of fetched releases, the server looks it up by tag before falling back to version order, and Settings → Info never substitutes a SemVer-ranked stable release on that feed.

OpenCode sessions and messages live in the shared OpenCode daemon and are the same in every profile. Server configuration (`CLI_CONFIG`, default `~/.config/codenomad/config.yaml`) is also independent of the profile; a non-default config file still gets its own scope, as before.

## Selecting a profile

Precedence, evaluated by both Electron (`electron/main/data-profile.ts`) and Tauri (`src-tauri/src/data_profile.rs`) before any profile path, singleton or WebView storage is fixed:

1. `CODENOMAD_PROFILE=<name>` — explicit profile.
2. `CODENOMAD_UPDATE_CHANNEL=<value>` — deprecated alias, only when `CODENOMAD_PROFILE` is unset or blank.
3. Unpackaged (npm/dev) runs — the `dev` profile, as before.
4. Packaged builds — the remembered choice, otherwise the one-time transition below, otherwise the default profile.

Updating CodeNomad or changing the update feed never changes the profile.

### `CODENOMAD_PROFILE` grammar

After trimming ASCII whitespace and lowercasing ASCII letters: 1–64 characters from `a-z`, `0-9`, `.`, `_`, `-`, starting with a letter or digit. Non-ASCII and other characters are rejected. `default` and `stable` both mean the default profile. An invalid value shows an error and quits; it never opens another profile. Both hosts run the shared vectors in `packages/electron-app/electron/main/data-profile-vectors.json`.

### Storage

The default profile with the default config uses the historical unscoped locations (`~/.codenomad/client-state/v2`, Electron's `userData`, Tauri's stable identifier and WebView directory). Every other profile/config pair uses `<scope> = <key>-sha256(key + "\0" + configIdentity)[0..16]`, i.e. `%APPDATA%/CodeNomad/scopes/<scope>` (Electron `userData` and both hosts' client state) and `…-v2/scopes/<scope>` (Tauri WebView), plus a scoped Tauri identifier. The default profile's key is `stable`, so existing folders such as `dev-<hash>` and `dev-v2-<hash>` are reached with `CODENOMAD_PROFILE=dev` / `dev-v2`.

The alias keeps each host's historical normalization exactly (Electron lowercases Unicode and turns each run of other characters into `-`; Tauri lowercases ASCII and collapses separators), so existing alias values map to the same scope as before. One quirk is preserved deliberately: `CODENOMAD_UPDATE_CHANNEL=default` still means the old `default-<hash>` scope, whereas `CODENOMAD_PROFILE=default` is the default profile.

Non-ASCII config paths on Windows: each host folds the config identity's case differently (Electron uses Unicode lowercase, Tauri ASCII lowercase), so for a path such as `C:\Users\Émile\…` the two hosts compute different scope hashes. This divergence predates profiles and is deliberately kept: changing either fold would move existing scoped folders. The new choices file does not inherit it (see below).

The host passes `CODENOMAD_DESKTOP_PROFILE=<name>` to its backend for non-default profiles; Settings → Info then shows a "Data profile" row. The default profile is never announced in that row. Separately, every backend launch (the default profile included, as key `stable`) receives the resolved scope that the backend uses as its Mission profile scope: `CODENOMAD_UPDATE_CHANNEL=<profile key>`, `CODENOMAD_PROFILE_CONFIG_IDENTITY=<config identity>` and the selected `CLI_CONFIG`. Tauri applies these only to the backend `Command`, never through a process-wide `set_var`. They are backend-only: the backend strips them, `CODENOMAD_PROFILE`, `CODENOMAD_DESKTOP_PROFILE` and the private hand-offs from the environment of the shared OpenCode daemon it starts (`workspaces/host-opencode-service.ts`), so agent shells never pin a desktop launched from them to this profile.

## One-time transition

Before this change, packaged builds picked `dev` or `dev-v2` from their version label, so installing `0.20.1` over `0.20.1-dev-…` silently switched to an empty profile. On a packaged launch without `CODENOMAD_PROFILE`/alias and without a remembered choice, the host:

1. Looks, read-only and size-bounded, at the default profile and the `dev` and `dev-v2` scopes for the same config identity, using the regular client-state parsers. A store counts only when a restore-enabled window has a workspace tab (more than the session partition, or a `workspace`-kind tab in a legacy monolithic snapshot; sidecar-only tabs never count). Legacy default files count only while the current shared file is missing.
2. None → default profile. One → that profile. Several → a native question, once, listing the candidates with their last-used dates (most recent first). Quit/dismissal remembers nothing.
3. Remembers the answer in `%APPDATA%/CodeNomad/profile-selection/choices.json` (macOS `~/Library/Application Support/CodeNomad`, Linux `$XDG_CONFIG_HOME/CodeNomad`), outside every profile: `{ "version": 1, "choices": { "<sha256(choice identity)>": "<profile name>" } }`. Names only, never paths; atomic write; at most 64 KiB/256 entries. A corrupt file or entry reruns detection; a remembered named profile whose `scopes/<scope>` folder definitely no longer exists under the userData base for this config (both hosts create it when they open a scoped profile) is ignored, so detection reruns and replaces it rather than silently opening an empty profile, even in a full file. This check follows a symlink/junction, because the hosts open a relocated profile through it (deletion never follows links). Only a definite absence of a plain entry (not found, or not a directory) counts as missing and is replaced. When `scopes/<scope>` is itself a link whose target is missing or not a folder (for example a disconnected removable or network drive), the profile is only unavailable: detection decides that launch, which is unremembered, and the choice is kept, so the profile is used again once its target returns. An unreadable entry, or any other error, keeps the choice and uses it. Both hosts run the same `rememberedProfileStates` vectors; any other valid choice is never overwritten; a newer-version file is left untouched (detection runs each launch). On Windows the choice identity is the config identity folded with Unicode lowercase on both hosts (idempotent over either host's identity), so Electron and Tauri share a choice even for non-ASCII paths; no folder depends on this key. Other platforms keep case-sensitive identities.

Remembering is best effort. If the selection folder, the lock or `choices.json` cannot be written (antivirus EPERM/EBUSY, full disk, read-only `%APPDATA%`), the launch still starts with the detected profile and the transition simply runs again next time; an answered question still applies to that launch. Without a usable lock, concurrent first launches are not serialized and may each ask.

The transition never moves, copies, merges, renames or deletes anything. Other profiles stay on disk until the user deletes them (see below).

Concurrent first launches serialize on `profile-selection/choices.lock` (exclusive create, 2 s heartbeat, taken over after 15 s without one): only the holder detects and asks, others wait and reuse its answer. Known, accepted race: taking over a stale lock moves it aside and restores it if it turns out to be fresh; if a third launcher creates a new lock in between, the restore fails and two launches may both ask. The first remembered answer wins; the other applies only to its own launch.

Electron fixes Chromium storage and the singleton before `ready`, so when it must ask it uses a throwaway `%TEMP%/codenomad-profile-selection-*` storage folder (never a profile), asks after `ready`, records the answer and relaunches into it. Chromium may still hold that folder while the asking process exits, so the relaunched process removes it (the path travels in a private `CODENOMAD_PROFILE_SELECTION_CLEANUP` variable, retried once after 10 s), and every Electron launch also sweeps temporary question folders not touched for 10 minutes (the asking process keeps its folder fresh while the question is open). An answer that could not be remembered still applies to the relaunch through a second private variable, `CODENOMAD_PROFILE_SELECTION_ANSWER`, validated with the `CODENOMAD_PROFILE` grammar and ranked below the user's own `CODENOMAD_PROFILE`/alias. Both are read and deleted before anything else starts and are also stripped from the backend's environment, so the backend and its terminals never inherit them; the backend still receives `CODENOMAD_DESKTOP_PROFILE`. Tauri asks synchronously before the builder exists and creates no temporary storage. The question is English-only like the native menus: it appears before any profile, and therefore any saved UI locale, is opened.

Dismissing the question: with one or two candidates the dialog has a Quit button. With three candidates (default, `dev`, `dev-v2` all with state) there are three profile buttons and no Quit button, because rfd offers at most three custom buttons. On Windows and Linux (GTK), closing the dialog quits without remembering. On macOS the Tauri dialog (an `NSAlert`) has no close button or Escape action in that case, so the user must pick a profile; picking is harmless because nothing is moved and the others stay reachable with `CODENOMAD_PROFILE`. Electron passes an out-of-range `cancelId` so Escape quits; its macOS behaviour is unverified.

## Deleting other saved profiles

A profile is only saved desktop state, so Settings → General → Startup offers to delete the others. The row "Other saved profiles: N profiles, X — Delete…" appears below the restore settings only when at least one other profile exists on this machine; a normal user with only the default profile never sees it. It works in main windows and in the desktop Preferences window, and is hidden in a plain browser and in remote windows. "Clear saved state" is unchanged and only affects the current window.

**Which profiles.** Every data profile on this machine except the open one: each `scopes/<key>-<hash>` folder under Electron's userData base or the Tauri WebView root (any config identity, including legacy-alias keys; profiles of another config are labelled "other configuration"), the default profile when the open one is scoped (named, or the default profile of a non-default config), and Tauri lock folders `ai.neuralnomads.codenomad.client.scope.s<hash>` whose hash matches no scope folder (shown as unused lock folders). The listing is computed when the card mounts or on explicit refresh, never polled, read-only, reading at most 10 000 names and keeping at most 512 profiles per root, with a size walk of at most 20 000 entries and depth 32 per profile (the size is then shown as "at least X").

**What is deleted.**

| Profile | Removed | Never touched |
|---|---|---|
| Named scope | `<appData>/CodeNomad/scopes/<scope>` (Electron data and both hosts' client state), `<localData>/ai.neuralnomads.codenomad.client-v2/scopes/<scope>` (WebView), `<dataDir>/ai.neuralnomads.codenomad.client.scope.s<hash>` (Tauri locks) | other scopes, `scopes/` itself, `profile-selection/` |
| Default | Electron `developer-mode-browser-v2/` and legacy `client-state.json` in `<appData>/CodeNomad`; `~/.codenomad/client-state/v2/client-state.json` and `v2/partitions/`; legacy `~/.codenomad/client-state/client-state.json`; WebView `developer-mode/`, `local/`, `remote/`, `browser/` in `client-v2`; legacy Tauri `client-state.json` | `scopes/`, `profile-selection/`, the election folders, lock/marker files; any other entry is kept and reported as not recognized |
| Unused lock folder | the folder | — |

The default profile's folders are parents of other roots, so they are never removed recursively: only the children above, which the host code creates, are deleted. Every target must be a plain direct child of a link-free root with the planned name; symlinks and junctions are neither listed nor followed. Links nested inside a removed folder are unlinked without traversal (Node's `fs.rm` and Rust's `remove_dir_all` both treat junctions and symlinks as links; regression tests cover a nested junction/symlink on both hosts).

**macOS WebKit storage is kept.** On macOS, Tauri windows of every scoped profile use the same WebKit data-store identifier (`profile_identifier("local")`) inside the app's single WebKit container, and the default profile uses WebKit's default store. No profile owns that store, so it is never deleted: removing it would also clear other profiles, including the open one. Electron keeps its web storage inside the profile folder, which is deleted. The listing reports `sharedWebKitStorage` on macOS and the confirmation says that Tauri's WebKit web storage, sign-ins and cache are shared and not deleted.

**In use.** A profile can be open in either host, so both hosts check the same evidence: Electron running markers and primary/registration locks; Chromium's process singleton, which Electron's `requestSingleInstanceLock()` takes while userData is still the profile folder itself (Chromium storage moves to `developer-mode-browser-v2` only afterwards), so it is read directly in `scopes/<scope>/` or, for the default profile, in `<appData>/CodeNomad`: Windows `lockfile` (delete-on-close, so present only while held) and POSIX `SingletonLock`, a symlink to `<hostname>-<pid>` (a lock of this host with a live PID is in use, with a dead PID is stale, another host's or an unparsable one is unknown; `SingletonSocket`/`SingletonCookie` carry no ownership); the cross-host client-state election (owner and participants); Tauri running markers and WebView2 `EBWebView/lockfile`. A live PID counts as in use even if it was reused; an unreadable marker or lock means "state unknown". In-use and unknown profiles are listed but skipped. The host rechecks immediately before removing each folder and stops at the first sign of activity; locked files make removal fail rather than succeed partially in silence. The result lists, per profile, deleted / in use / unknown / no longer found / incomplete with the exact paths that remain, and the row refreshes.

**Remembered choices.** After deleting a named profile of the open configuration, that configuration's entry in `profile-selection/choices.json` is removed if it names the profile (its choice key is known). Other configurations' keys cannot be mapped back to a scope, so their entries naming it are removed only when no folder of that profile remains for any configuration (a scope entry that is a symlink or junction, present or dangling, counts as remaining here, because a configuration may open its profile through it; links are still never listed or deleted); a remaining stale entry is still caught at launch, which ignores remembered profiles whose folder is gone. The update takes the selection lock; if a launch currently holds it, or the file is corrupt or newer, nothing is rewritten. Choices naming `default` are never removed.

**Contract.** Two host operations (Electron IPC `data-profiles:listOthers` / `data-profiles:deleteOthers`, Tauri commands `data_profiles_list_others` / `data_profiles_delete_others`, granted to local windows and Preferences only). The renderer sends only IDs from a listing (`default`, `scope:<scope>`, `orphan:<hash>`); the host re-enumerates, re-validates and rechecks activity before deleting and never accepts paths. Operations are serialized per host process. Implementation: Electron `data-profile-cleanup.ts`, Tauri `data_profile_cleanup.rs`, UI `components/settings/other-profiles-settings-row.tsx` over `lib/native/data-profiles.ts`.

Known limits: macOS WebKit storage of the Tauri app is shared and kept (see above); the Tauri singleton itself is not file-based; a Tauri instance is detected through the running marker it creates while starting, and its WebView2 locks. A profile opened between the last check and a removal is caught only by the operating system's file locks.

## Validation

- Electron: `data-profile.test.ts`, `profile-transition.test.ts` (including unwritable choices/lock and question-folder sweep), `startup.test.ts`, `data-profile-cleanup.test.ts`, `data-profile-cleanup-ipc.test.ts`.
- Tauri: `data_profile`, `profile_transition`, `profile_selection_dialog`, `client_state::restorable`, `identity`, `data_profile_cleanup` tests.
- UI: `tests/browser/server-info.test.ts` (Data profile row), `tests/browser/other-profiles.test.ts` (other profiles row in Preferences and inline).

The real native dialogs (Electron relaunch flow, rfd on Windows/macOS/Linux) are not covered by automated tests. Profile deletion is tested against temporary roots, not against a running second host; Chromium singleton files are simulated at the location derived from main.ts ordering, not captured from a live instance.
