# Authentication and security

Access to CodeNomad can execute work on the backend host through OpenCode. Treat server passwords, browser sessions and paired devices as powerful credentials. CodeNomad is not a multi-tenant execution sandbox.

## Choose how the server authenticates {#authentication}

| Method | Lifetime and scope |
| --- | --- |
| `--password` or `CODENOMAD_SERVER_PASSWORD` | Runtime override for that backend process. Required again on each start; not persisted. Overrides the managed password file. |
| Password set in Settings | Persists a salted scrypt hash in `auth.json` beside the active configuration YAML. Used on subsequent starts without a runtime override. |
| `--generate-token` | Enables local, one-time bootstrap; the printed token lasts 60 seconds. It is not a reusable API token or a Remote Control link. |
| Remote Control pairing | Separate device-cookie authentication, managed from the host; see [Remote Control](remote-control.md). |

The default username is `codenomad`. A stored auth file retains its username; changing only `--username` does not rename that stored identity. Without a configured password, bootstrap mode or explicitly skipped authentication, the server refuses startup.

Prefer a protected environment/service secret over embedding a password in command arguments or shell history. Anyone who can inspect your process environment or configuration directory may still be able to compromise the deployment.

## Bootstrap a persistent password {#bootstrap}

1. Start locally without a runtime password override. To bootstrap on loopback without a certificate setup first, use `codenomad --host 127.0.0.1 --https=false --http=true --generate-token --launch`.
2. On the backend machine, open `/auth/token` at the printed **Local Connection URL**, and submit the value printed after `CODENOMAD_BOOTSTRAP_TOKEN:`. Do not share that output.
3. Open **Settings → Remote Access → Direct access (local network, advanced) → Server password**.
4. Choose **Set password**, fill **New password** and **Confirm password** with at least eight characters, then choose **Save password**.
5. On the next launch, omit `--generate-token` and use the saved password for direct connections. Before enabling remote access, configure [trusted HTTPS](remote-access.md); the loopback HTTP setup command is not a remote deployment command.

Bootstrap is accepted only from the host's own loopback listener, not from a LAN client or Remote Control ingress. Keep the default loopback binding for setup. An expired or consumed token requires a fresh bootstrap start. If a persistent password already exists, the bootstrap session lets you choose **Change password** instead.

`auth.json` is app-managed; do not hand-edit a hash or publish the file. If the password came from CLI/environment, Settings refuses to replace it: restart without that override to use an existing managed password, or use local bootstrap to set one. An unreadable or unwritable auth file needs an OS permission/path repair, not disabled authentication.

## Browser sessions and revocation {#sessions}

Direct sign-in creates an opaque in-memory backend session and a `codenomad_session` cookie (or the configured cookie name). Cookies are `HttpOnly`, `SameSite=Lax`, scoped to `/`, and marked `Secure` when issued over HTTPS. They are browser-session cookies; backend restart invalidates the in-memory sessions. Reauthenticate in place when asked rather than resending failed mutations.

Changing a password changes subsequent credential checks; it does **not** invalidate already issued direct sessions or Remote Control devices. For suspected compromise:

1. Restrict network exposure and set a new password on the host, or change your runtime secret and restart.
2. Restart the backend to invalidate its existing direct sessions.
3. Under **Remote Control → Paired devices**, **Revoke** unknown devices separately. Stop Remote Control if you need to cut off its entire access path immediately.
4. Review affected files, provider accounts and native OpenCode activity. Stopping access is not a rollback of work already admitted.

See [Remote Control](remote-control.md) for its distinct 30-day inactivity expiry and five-minute pairing links. A password change is not device revocation, and stopping a tunnel is not device deletion.

## Protect transport and listener exposure {#transport}

Use trusted HTTPS for direct remote access. Plain HTTP exposes passwords, session cookies and working content to anyone able to observe that network hop. If TLS terminates at a reverse proxy, keep the backend hop on loopback or another protected network; proxy TLS does not encrypt an exposed upstream HTTP connection.

`--dangerously-skip-auth` / `CODENOMAD_SKIP_AUTH` disables CodeNomad's direct-listener login and treats requests as authenticated. It does **not** make the server safe to expose. A listener reachable without an enforcing perimeter grants access to whoever can reach it; a VPN connection alone does not distinguish trusted from untrusted VPN users. Keep authentication enabled unless you have independently engineered and verified every access path. Remote Control still requires a paired device, even with this flag.

Check the [binding matrix and TLS procedures](remote-access.md), especially standalone HTTP-only mode: it honors `--host` and can expose cleartext beyond loopback. Never solve certificate errors by disabling verification.

**`CODENOMAD_SKIP_AUTH=false` still disables authentication.** This switch environment variable is enabled whenever defined, even as `false`, `0` or an empty value. Unset it to disable the switch; see the [CLI reference](server.md#cli-reference).

## Understand the host boundary {#host-boundary}

`--workspace-root` restricts which workspaces can be opened, and `--unrestricted-root` relaxes browsing. Neither is an OS jail, container, filesystem sandbox or restriction on what an authorized native tool can do. Agents, shell commands, plugins and MCP tools act with the execution host's permissions and their own configured credentials.

Use OS accounts, containers/VMs and upstream permission configuration where actual isolation is required. Do not grant a device access merely because you expect it to see only one tab. Server configuration and the shared OpenCode service can affect other conversations/projects; see [OpenCode setup](opencode.md), [Permissions](permissions.md) and [Extensions](extensions.md) for their separate boundaries.

## Keep credentials and diagnostics private {#privacy}

OpenCode owns provider connections and its global conversation storage. CodeNomad reads connection metadata and selected credentials server-side for supported usage integrations; browser APIs do not return provider secret values. Externally owned OAuth login refresh belongs to its owner; CodeNomad does not exchange those refresh tokens. See [Providers](providers.md).

| Material | Handling |
| --- | --- |
| Passwords, bootstrap tokens, pairing links, cookies | Never paste into issues, screenshots, shell transcripts or shared logs. |
| `auth.json`, TLS private keys, tunnel identity, configuration secrets | Protect with OS permissions and encrypted backups; do not upload complete directories for support. |
| Conversation text, attachments, workspace paths and remote addresses | Review/redact before sharing; they can identify people, projects or infrastructure. |
| Provider keys and speech credentials | Enter only in the intended settings/credential owner; check which provider receives data. See [Voice](voice.md). |
| Debug/trace logs and network captures | Collect only what is needed, inspect locally and redact before reporting. Do not assume every downstream tool's output is secret-free. |

**Settings → Info → Report a bug** prepares bounded diagnostics without prefilling listeners, addresses, paths, credentials or conversation content. Review anything you add yourself before submitting. See [Support](support.md).
