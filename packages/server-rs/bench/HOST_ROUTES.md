# Routes the UI calls on its local host

Recorded by `node host-survey.mjs <opencode>`: the TS server of this checkout serves its own UI as the desktop hosts start it (`--unrestricted-root`, private profile, isolated daemon); the journey is start-up, folder picker (navigation, new folder, selection), conversation, Files, Git (Changes, Commits), worktree selector and creation dialog, recents, then every Settings section once. `:id`, `:ses` and `:slug` stand for identifiers; query keys are listed without values.

Rust state: **ported** before this survey, **here** ported for this usage, **host-cli** served by the UI host work, **decided** not ported (below).

| Method | Route | Steps | TS | Rust |
|---|---|---|---|---|
| GET | `/`, static assets, `/monaco/*` | all | 200 | host-cli |
| GET | `/api/events?clientId&connectionId` | start-up | 200 | ported |
| POST | `/api/client-connections/pong` | all | 204 | ported |
| GET | `/api/meta` | start-up, project, Remote Access | 200 | ported; here: `updateFeed` from `config.yaml` |
| GET | `/api/auth/status` | Remote Access | 200 | ported |
| GET | `/api/storage/config/server`, `/api/storage/config/ui` | start-up | 200 | here (`config.yaml`) |
| GET, PATCH | `/api/storage/state/ui` | start-up, project | 200 | here (`state.yaml`) |
| GET, PUT | `/api/storage/instances/:id` | project, conversation | GET 200 and 403, PUT 404 | ported; here: files under the profile's `instances/` |
| GET | `/api/filesystem?includeFiles&path` | folder picker | 200 | here: whole filesystem, drives, `directoryIdentity` |
| POST | `/api/filesystem/folders` | folder picker | 201 | here |
| GET, POST | `/api/workspaces` | start-up, project | 200, 201 | ported; here: folders outside the root |
| GET | `/api/workspaces/:id/files`, `files/preview` | project, Files | 200 | ported |
| GET | `/api/workspaces/:id/pending-requests?directories[&optionalDirectories]` | conversation, worktree | 200 | here: every owned directory (linked worktrees, optional history) |
| GET | `/api/workspaces/:id/session-favorites?reconcile` | project | 200 | ported |
| POST | `/api/workspaces/:id/session-history/outline`, `outlinePreview` | conversation | 200 | ported |
| GET | `/api/workspaces/:id/sessions/:ses/permission-receipts` | conversation | 200 | ported |
| GET | `/api/workspaces/:id/worktrees` | conversation, worktree | 200 | ported (POST/DELETE compared by `http`) |
| GET | `/api/workspaces/:id/worktrees/:slug/git-status`, `git-diff`, `git-history` | Git, worktree | 200 | ported |
| GET | `/api/workspaces/:id/subagent-depth?directory` | Missions | 200 | ported |
| GET | `/api/memory/settings` | Settings | 200 | ported |
| GET | `/api/panel-extensions` | project | 200 | ported |
| GET | `/api/remote-control/devices` | Remote Access | 200 | ported |
| * | `/workspaces/:id/instance/api/*` (agent, command, location, mcp, model, provider, project, session, prompt, model, inbox, instructions, integration, websearch/provider) | conversation, Providers | 200, 204 | ported (allow list) |
| GET | `/workspaces/:id/yolo/sessions/:ses` | conversation | 200 | decided |
| GET | `/api/opencode/update` | start-up, project, OpenCode | 200 | here |
| POST | `/api/storage/binaries/validate` | Providers | 200 | here |
| PATCH | `/api/storage/config/:owner` (preferences, `?conditional=missions-v1`) | any preference change | 200 | here |
| GET, PUT | `/api/config-files`, `/api/config-files/:id/content` | Config Files | 200 | here |
| GET | `/api/remote-control/status` | Remote Access | 200 | here |
| GET | `/api/opencode/login-start` | Missions | 200 | frozen with the Missions |
| GET | `/api/speech/capabilities` | start-up | 200 | separate work |
| GET | `/api/sidecars` | SideCars | 200 | separate work |
| GET | `/api/workspaces/:id/service-usage`, `/cache`, `/owner` | Stats | 200 | separate work |

The TS worktree creation with a session move stayed pending on this fixture (over 120 s), so the journey stops at the dialog; the TS instance storage answered GET 403 and PUT 404 once the conversation started.

## Not ported

- **By decision**: Yolo, sign-out (`/api/auth/logout` and its relayed form), the remote window proxy (`remote-proxy`, `--connect-server`), the downloaded UI (`--ui-auto-update`), the release monitor, old migrations (`settings/migrate.ts`, legacy and retired installations), the dead code of the usage audit's section 2 (`GET /api/workspaces/:id/files/content`, whose `PUT` is served; `GET /api/filesystem/files/content`; `GET`/`PATCH /api/storage/config` and `/api/storage/state`), and `GET`/`PATCH /api/storage/state/:owner` for owners other than `ui` (no caller).
- **Frozen with the Missions**: `GET`/`POST /api/opencode/login-start` (Mission calendars) and `GET /api/workspaces/:id/git-branches` (Mission editor sources).
- **Voice, SideCars and usage statistics** (`/api/speech/*`, `/api/sidecars`, `/api/workspaces/:id/service-usage*`): separate work.

## Capabilities

`/api/meta` declares `config-files` with the families already served. `remote-control` stays undeclared (start, stop and previews are not served, so the UI hides the Remote Access section that reads the status), and so does `opencode-admin` until the OpenCode service routes are complete.

## Local host checks

The `host` mode also reads, on both servers, the conversation list (by directory and by project) and `pending-requests` of a Git project, of a folder without Git inside and outside the root, right after a worktree is created and after it is deleted. A list scoped to `project=global` (the project OpenCode gives a folder without Git, which the UI's blank-session cleanup asks for) is refused by both servers.

## Differences kept on purpose

- Settings are always read from disk: an edit outside the server is seen at once (the reference keeps its cache, and its `/api/meta` feed, until an event). An unreadable `state.yaml` refuses writes (503) instead of being replaced. Keys are written in sorted order.
- `PATCH /api/storage/state/ui` touching multi-backend profiles (`remoteServers`, remote project history) answers 501: this host does not serve them and does not compact their history.
- The unrestricted folder browser and workspace creation still refuse UNC shares and device paths (audit M2).
- Session favorites stay in the data folder rather than in `state.yaml`.
- The Files tree omits `.git` and refuses paths inside it (the reference lists and edits it): an edited Git configuration or hook would run during later Git commands.
- `/api/opencode/update`: installing, upgrading, restarting and reloading OpenCode are not served, so `canUpgrade`, `canRestart` and `canReload` are false and no 1.x or foreign installation notice is reported; the status probes the executable saved in `config.yaml` (else the default installation) and discovers the daemon of the executable the server started with.
- `/api/remote-control/status`: this server has no tunnel and serves no web previews, so Remote Control is stopped, never resumes, and `previews` is false; the direct HTTPS origin and paired devices come from its own registry.