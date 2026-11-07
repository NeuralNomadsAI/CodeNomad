# Direct remote access

Direct access connects to CodeNomad's HTTP/HTTPS listeners using its server password. It is separate from [Remote Control](remote-control.md): pairing needs no LAN binding or inbound port, and neither path silently falls back to the other.

## Choose an access path {#access-paths}

| Path | What you administer |
| --- | --- |
| Same-machine browser | Keep loopback binding; use the printed local URL. |
| LAN or VPN | Bind a reachable interface, restrict the firewall to intended clients, and use trusted HTTPS. A VPN does not configure the CodeNomad listener for you. |
| SSH forwarding | Keep the backend loopback-bound; forward its actual printed port. The tunnel protects transport but does not replace CodeNomad authentication. |
| Reverse proxy | Keep the backend on a private/loopback interface; terminate trusted TLS at the proxy, protect the upstream hop, and support long-lived SSE and any WebSockets needed by your direct-access tools. |
| Remote Control | Pair the device from the host; see [Remote Control](remote-control.md) for its narrower surface and lifetime. |

Binding does not create firewall rules, port forwarding, DNS or a VPN. Do not publish an unauthenticated HTTP listener to the Internet. A workspace root is not a security sandbox; read [Security](security.md) before exposing the server.

## Enable direct access {#enable-direct-access}

1. On the host, open **Settings → Remote Access** and expand **Direct access (local network, advanced)**.
2. Under **Server password**, choose **Set password** or **Change password**, enter **New password** and **Confirm password**, then **Save password**. Runtime-supplied passwords cannot be changed here; see [Security](security.md).
3. Turn on **Allow connections from other IPs** under **Listening mode**. Read the restart warning and choose **Restart now** only when ready for the temporary interruption.
4. After restart, use **Refresh** and check **Reachable addresses**. Open the reachable HTTPS address on the other device, or choose **Show QR** on the host and scan it with the other device, then sign in.

This changes the host's direct listening mode, not one project and not Remote Control. The disclosure opens automatically while the server listens beyond localhost. If automatic restart is unavailable, restart CodeNomad manually; standalone deployments must set their launch-time `--host` consistently. To remove exposure, turn the switch off and restart, or relaunch the CLI with loopback binding. This does not revoke paired Remote Control devices.

### Listener binding matrix {#binding-matrix}

`--host` defaults to `127.0.0.1`; `localhost` normalizes to that address. The following rules apply to the enabled listeners:

| Launch/mode | HTTP binds to | HTTPS binds to |
| --- | --- | --- |
| Standalone, HTTPS only (default) | Private loopback listener only (see below) | `--host` |
| Standalone, HTTP only | **`--host`**, including a LAN/wildcard address | Not enabled |
| Standalone, both listeners | `127.0.0.1` regardless of `--host` | `--host` |
| Native desktop backend | Its HTTP listener stays on `127.0.0.1`, including its host-internal listener | `--host` when HTTPS is enabled |

Every backend also keeps an HTTP listener on `127.0.0.1` for CodeNomad's own bundled OpenCode plugins, such as Missions. When HTTP was not requested, or the requested HTTP listener is bound to an address other than `127.0.0.1` or `0.0.0.0`, the backend adds a private HTTP listener on a random `127.0.0.1` port. It is never printed or offered as a connection address, is not reachable from other machines, and serves the same authenticated application.

A concrete LAN address need not accept loopback connections. `0.0.0.0` means all IPv4 interfaces; `::` is the dual-stack wildcard listener. Use an actual reachable address in a browser, not a wildcard. IPv6 zone identifiers are not supported in `--host`.

For a standalone HTTPS deployment, set a password through the [bootstrap procedure](security.md), then run:

```sh
codenomad --host 0.0.0.0 --https=true --http=false
```

For loopback-only HTTP, for example behind a local trusted proxy:

```sh
codenomad --host 127.0.0.1 --https=false --http=true
```

Do not assume port 9898 or 9899: omitted ports can fall back when busy. An explicit nonzero `--https-port`, or `--http-port` with HTTP enabled, pins the port and fails if it cannot bind; `0` asks the OS to assign one. The printed **Local Connection URL** and **Remote Connection URL**, and refreshed **Reachable addresses**, are authoritative for that run. See the complete [server CLI reference](server.md).

## Configure trusted TLS {#tls}

### Supply your own certificate {#custom-certificates}

1. Obtain a certificate whose Subject Alternative Names (SANs) cover the hostname or IP clients actually use.
2. Supply both `--tls-key <path>` and `--tls-cert <path>` as PEM files. Add `--tls-ca <path>` if your deployment needs a CA chain/bundle.
3. Restart CodeNomad and verify the certificate and printed HTTPS address from the client device.

Custom certificate files are read at startup and are never rewritten by CodeNomad. You own renewal and the restart needed to load renewed files. `--tlsSANs` configures generated certificates; it cannot add names to a supplied certificate. Protect private keys and trust only certificates whose host identity you have verified.

### Use the generated local CA {#generated-certificates}

With HTTPS enabled and no supplied key/certificate pair, CodeNomad creates a local CA and server certificate under the configuration base:

| File | Purpose |
| --- | --- |
| `tls/ca-cert.pem` | Public CA certificate to distribute securely to clients you administer. |
| `tls/ca-key.pem` | CA private key; never distribute. |
| `tls/server-cert.pem` | Server certificate. |
| `tls/server-key.pem` | Server private key; never distribute. |

1. Add every client-facing DNS name/IP using `--tlsSANs "host.example.test,192.0.2.10"`. Wildcard binding does not discover all your LAN addresses for SANs.
2. Restart the backend to generate/recheck the certificate.
3. Verify the host/CA through a trusted channel, then import **only the CA certificate** into each intended client/browser trust store. Alternatively use a publicly trusted certificate or TLS reverse proxy.

The generated server certificate lasts 30 days. Startup renews it within three days of expiry, when required SANs are missing, when the certificate fails its checks, or when its private-key file is missing. The generated CA lasts 365 days and is replaced when expired, when its certificate fails its checks, or when its private-key file is missing; replacing it also reissues the server certificate. Existing corrupt, unreadable or mismatched private keys are not automatically repaired. Clients must trust the replacement CA. There is no continuous in-process renewal: arrange a deliberate restart before expiry in long-running deployments.

If a client reports a certificate warning, stop and check the hostname, SANs, trust store and expiry. Do not disable verification or make clicking through warnings your deployment procedure. Trusted HTTPS is also required for remote browser features such as [PWA installation and microphone access](mobile.md).

## Save a remote server {#saved-servers}

1. Use **Browse** on Home or the right-hand panel of an empty tab, and enter the address or pairing link in **Server address or link**. Pasting adds immediately; Enter adds typed text. Adding saves the server, focuses its row and keeps the selector in place; a pairing link also pairs the local backend for browsing. Click the row to browse. **Settings → Servers** offers the same field.
2. Use a trusted HTTPS origin. Certificate and unreachable-server errors are localized; request details with the information control for the technical diagnostic. **Skip TLS verification** requires your explicit choice: use it only for a trusted server, then submit again. Opening a project on this profile uses a separate window; the opening action announces this at selection time.
3. Choose the saved **Browse** row. The server name stays visible during sign-in and navigation, with labelled sign-in fields and distinct **Recent** and **Folders** sections. **Edit server** in **Settings → Servers** changes its URL or name; its `i` controls reveal address and TLS help on demand.

**Settings → Servers** manages saved profiles (**Edit server**, **Remove saved server**). Removing a profile first forgets its backend-held browsing credentials and session, then removes the bookmark and closes its tabs. Remote projects and conversations stay on their server. The local backend stores browsing secrets privately in `remote-server-credentials.json` beside its configuration; protect that file as a password. Embedded views keep their own authentication separately.

To open a saved server straight from the command line, start the desktop app with `--connect-server <name>` (or `--connect-server=<name>`), using the server's saved name, or with its `https://` URL. CodeNomad opens only the remote window, using the profile's TLS checks and the native remote window's own sign-in; when CodeNomad is already running, its current window opens it instead of a new one. A URL that matches no saved server is saved under its host name. Launch values never carry credentials: a URL with a user name, password or pairing code is refused. If the name is unknown, the URL is invalid or the connection fails, CodeNomad starts normally and shows the error. When the connection needs a confirmation, such as installing the local certificate for a self-signed server, CodeNomad also starts normally and asks there. On Windows, the Tauri build refuses to start when a launch argument contains `|`; use the server's URL instead, or rename the server.

A remote window always leaves a way back to this computer. Closing the last local window while remote windows stay open keeps its tabs: **Window → New Window** in a remote window, or starting CodeNomad again, reopens it. If a server cannot be loaded, its window says so and offers **Try again**, **Open a local window** and **Close window**; in the Tauri build, use the page's reload button and **Window → New Window**.

Pasting a fresh Remote Control pairing link saves its tunnel origin and pairs the local backend for browsing, with its device credential kept privately across launches. The code is discarded after the attempt. Pairing errors name the affected server. After revocation, choose **Back to Browse** and paste a fresh link into **Server address or link**. Known limitation: embedded views authenticate independently and may require their own pairing. If server-side pairing is unavailable, update the remote server or use its direct-listener URL for password login; tunnel addresses require pairing. See [Remote Control](remote-control.md).

## Open a remote project in a tab {#remote-project-tabs}

In the desktop app (Electron, or Tauri on Windows), a saved server can also open one of its projects in a tab of this window, beside your local projects:

1. On Home or an empty tab, open **Browse** and choose a saved server. To add a server, use **Server address or link**, then click its new row.
2. The named server's **Recent** and **Folders** sections appear in place. Sign in using the labelled inline form if needed. Choose a recent project, or navigate folders and choose **Open this folder**. **Back to Browse** returns to the server list.
3. Choosing the folder creates a new remote project occurrence, replacing the originating empty tab. The project joins **Recent**. To join an existing occurrence instead, use its separate **Open** action.

The tab's conversations, files, Git, settings and Missions run on the remote server. Its embedded view shares that server's remote-window storage and may ask you to sign in separately from Browse. Remote tabs participate in startup restoration. Servers without embedded mode show their full interface; profiles that skip TLS verification and Tauri on macOS/Linux open a separate remote window, explicitly indicated by the opening action when choosing the project. The embedded page stays on its server and has only notification access to the host. Web clients and Remote Control devices have no remote tabs.

Backend browsing accepts every saved profile's destination address, including loopback, RFC1918 LAN, Docker, Hyper-V, CGNAT/Tailscale (`100.64.0.0/10`), MagicDNS and `*.ts.net`, IPv6 ULA/link-local, and names resolving to these addresses. Your network routes and TLS setup must allow the connection. Certificate verification follows the saved profile and its explicit TLS confirmation.
