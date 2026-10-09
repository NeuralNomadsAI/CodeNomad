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

The host passes `CODENOMAD_DESKTOP_PROFILE=<name>` to its backend for non-default profiles; Settings → Info then shows a "Data profile" row. The default profile is never announced. Tauri applies it only to the backend `Command`, never through a process-wide `set_var`.

## One-time transition

Before this change, packaged builds picked `dev` or `dev-v2` from their version label, so installing `0.20.1` over `0.20.1-dev-…` silently switched to an empty profile. On a packaged launch without `CODENOMAD_PROFILE`/alias and without a remembered choice, the host:

1. Looks, read-only and size-bounded, at the default profile and the `dev` and `dev-v2` scopes for the same config identity, using the regular client-state parsers. A store counts only when a restore-enabled window has a workspace tab (more than the session partition, or a `workspace`-kind tab in a legacy monolithic snapshot; sidecar-only tabs never count). Legacy default files count only while the current shared file is missing.
2. None → default profile. One → that profile. Several → a native question, once, listing the candidates with their last-used dates (most recent first). Quit/dismissal remembers nothing.
3. Remembers the answer in `%APPDATA%/CodeNomad/profile-selection/choices.json` (macOS `~/Library/Application Support/CodeNomad`, Linux `$XDG_CONFIG_HOME/CodeNomad`), outside every profile: `{ "version": 1, "choices": { "<sha256(choice identity)>": "<profile name>" } }`. Names only, never paths; atomic write; at most 64 KiB/256 entries. A corrupt file or entry reruns detection; a valid choice is never overwritten; a newer-version file is left untouched (detection runs each launch). On Windows the choice identity is the config identity folded with Unicode lowercase on both hosts (idempotent over either host's identity), so Electron and Tauri share a choice even for non-ASCII paths; no folder depends on this key. Other platforms keep case-sensitive identities.

Remembering is best effort. If the selection folder, the lock or `choices.json` cannot be written (antivirus EPERM/EBUSY, full disk, read-only `%APPDATA%`), the launch still starts with the detected profile and the transition simply runs again next time; an answered question still applies to that launch. Without a usable lock, concurrent first launches are not serialized and may each ask.

Nothing is moved, copied, merged, renamed or deleted. Other profiles stay on disk.

Concurrent first launches serialize on `profile-selection/choices.lock` (exclusive create, 2 s heartbeat, taken over after 15 s without one): only the holder detects and asks, others wait and reuse its answer. Known, accepted race: taking over a stale lock moves it aside and restores it if it turns out to be fresh; if a third launcher creates a new lock in between, the restore fails and two launches may both ask. The first remembered answer wins; the other applies only to its own launch.

Electron fixes Chromium storage and the singleton before `ready`, so when it must ask it uses a throwaway `%TEMP%/codenomad-profile-selection-*` storage folder (never a profile), asks after `ready`, records the answer and relaunches into it. Chromium may still hold that folder while the asking process exits, so the relaunched process removes it (the path travels in a private `CODENOMAD_PROFILE_SELECTION_CLEANUP` variable, retried once after 10 s), and every Electron launch sweeps such folders not touched for 10 minutes (the asking process keeps its folder fresh while the question is open). Tauri asks synchronously before the builder exists and creates no temporary storage. The question is English-only like the native menus: it appears before any profile, and therefore any saved UI locale, is opened.

Dismissing the question: with one or two candidates the dialog has a Quit button. With three candidates (default, `dev`, `dev-v2` all with state) there are three profile buttons and no Quit button, because rfd offers at most three custom buttons. On Windows and Linux (GTK), closing the dialog quits without remembering. On macOS the Tauri dialog (an `NSAlert`) has no close button or Escape action in that case, so the user must pick a profile; picking is harmless because nothing is moved and the others stay reachable with `CODENOMAD_PROFILE`. Electron passes an out-of-range `cancelId` so Escape quits; its macOS behaviour is unverified.

## Validation

- Electron: `data-profile.test.ts`, `profile-transition.test.ts` (including unwritable choices/lock and question-folder sweep), `startup.test.ts`.
- Tauri: `data_profile`, `profile_transition`, `profile_selection_dialog`, `client_state::restorable`, `identity` tests.
- UI: `tests/browser/server-info.test.ts` (Data profile row).

The real native dialogs (Electron relaunch flow, rfd on Windows/macOS/Linux) are not covered by automated tests.
