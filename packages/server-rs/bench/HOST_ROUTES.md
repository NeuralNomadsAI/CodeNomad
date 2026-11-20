# Routes the UI calls on its local host

Recorded by `node host-survey.mjs <opencode>`: the TS server of this checkout serves its own UI as the desktop hosts start it (`--unrestricted-root`, private profile, isolated daemon); the journey is start-up, folder picker (navigation, new folder, selection), conversation, Files, Git (Changes, Commits), worktree selector and creation dialog, recents, then every Settings section once. `:id`, `:ses` and `:slug` stand for identifiers; query keys are listed without values.

Rust state: **ported** before this change, **here** ported for this usage, **host-cli** served by the UI host work, **decided** not ported by decision, **to decide** not ported (below).

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
| GET | `/api/workspaces/:id/pending-requests?directories` | conversation | 200 | ported |
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
| GET | `/api/opencode/update` | start-up, project, OpenCode | 200 | to decide |
| GET | `/api/speech/capabilities` | start-up | 200 | decided (voice frozen while it is redesigned) |
| GET | `/api/config-files`, `/api/config-files/:id/content` | Config Files | 200 | to decide |
| GET | `/api/opencode/login-start` | Missions | 200 | to decide |
| GET | `/api/remote-control/status` | Remote Access | 200 | to decide |
| GET | `/api/sidecars` | SideCars | 200 | here, with POST, PUT, DELETE and the `/sidecars/:id/*` proxy (HTTP, WebSocket), compared by `sidecars` |
| POST | `/api/storage/binaries/validate` | Providers | 200 | to decide |
| GET | `/api/workspaces/:id/service-usage`, `/cache`, `/owner` | Stats | 200 | here, compared by `usage` |
| POST, DELETE, * | `/api/previews`, `/api/previews/:token`, `/previews/:token/*` | Local preview | 200, 204, upstream | source HTTP/WS compared by `previews` |
| POST, DELETE | `/api/backends/:id/preview-capabilities` | Preview of a remote project | 200, 204 | requires the backend relay and generation owner |

The TS worktree creation with a session move stayed pending on this fixture (over 120 s), so the journey stops at the dialog; the TS instance storage answered GET 403 and PUT 404 once the conversation started.

## Not ported, by decision

Voice (`/api/speech/*`, frozen while it is redesigned), Yolo (its read is removed from Rust), sign-out (`/api/auth/logout` and its relayed form), the remote window proxy (`remote-proxy`, `--connect-server`), the downloaded UI (`--ui-auto-update`), the release monitor, old migrations (`settings/migrate.ts`, legacy and retired installations), and the dead code of the usage audit's section 2: among ported routes, the reads `GET /api/workspaces/:id/files/content` (its `PUT` stays) and `GET /api/filesystem/files/content` are removed from Rust; `GET`/`PATCH /api/storage/config` and `/api/storage/state` stay unported. The bench no longer compares them (Yolo in `http`, file content reads in `files`, `links` and `hardening`, sign-out in every mode's qualification and in `launch`).

## To decide

Observed but not ported, then not observed and therefore not kept. Opinion: useful, doubtful or dead.

| Route | Called by, when | Reference behaviour | Opinion |
|---|---|---|---|
| GET `/api/opencode/update` | start-up, opening a project, Settings › OpenCode | installed and latest OpenCode versions, update availability | useful (with the OpenCode service work) |
| GET `/api/usage/:provider` | Conversation Status › Provider Usage | per-provider balances and quotas | pending |
| GET `/api/config-files`, `/:id/content` | Settings › Config Files | lists and reads the raw `opencode.json(c)` files (non-atomic editor) | doubtful |
| GET `/api/opencode/login-start` | Settings › Missions | OpenCode start at login for Mission calendars | doubtful while Missions are frozen |
| GET `/api/remote-control/status` | Settings › Remote Access | Remote Access listener and tunnel state | useful (remote access) |
| POST `/api/storage/binaries/validate` | Settings › Providers / OpenCode binary | probes an OpenCode executable (`--version`) | useful (with the OpenCode service work) |
| PATCH `/api/storage/config/:owner` | Preferences store, when a preference changes (not exercised by the journey) | merge patch with normalization, speech key pairing, host-only check, Missions conditional mode | useful |
| GET, PATCH `/api/storage/state/:owner` other than `ui` | not observed (`sessionFavorites` is refused) | owner merge patch | dead |
| GET `/api/workspaces/:id/git-branches` | Mission editor sources only | local `refs/heads/*` of an owned checkout inside the deletion fence | doubtful while Missions are frozen |
| `.git` in GET `/api/workspaces/:id/files` (and its reads and writes) | the Files panel tree, on opening a project and expanding folders (seen under Tauri) | lists `.git` like any folder and lets the editor read and write inside it | Rust omits it and refuses `.git` paths, since an edited Git configuration or hook runs during later Git commands: keep the Rust behaviour |

## Differences kept on purpose

- Settings are always read from disk: an edit outside the server is seen at once (the reference keeps its cache, and its `/api/meta` feed, until an event). An unreadable `state.yaml` refuses writes (503) instead of being replaced. Keys are written in sorted order.
- `PATCH /api/storage/state/ui` touching multi-backend profiles (`remoteServers`, remote project history) answers 501: this host does not serve them and does not compact their history.
- The unrestricted folder browser and workspace creation still refuse UNC shares and device paths (audit M2).
- Session favorites stay in the data folder rather than in `state.yaml`.
- SideCar content and WebSockets are served on the loopback listener only: the host's `sidecarsOverDirectHttps` opt-in is not served, so `/api/meta` reports `sidecarsAllowed: false` on the HTTPS listener (the reference's default). A refused SideCar upgrade carries the admission's JSON error body (the reference answers empty).
- HTTPS SideCars verify against `NODE_EXTRA_CA_CERTS` alone: public authorities never certify 127.0.0.1. A relayed JSON body is re-encoded like `JSON.stringify`, keeping integer-like keys in their received order.
