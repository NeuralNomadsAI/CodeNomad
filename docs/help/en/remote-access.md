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
| Standalone, HTTPS only (default) | Private loopback listener only | `--host` |
| Standalone, HTTP only | **`--host`**, including a LAN/wildcard address | Not enabled |
| Standalone, both listeners | `127.0.0.1` regardless of `--host` | `--host` |
| Native desktop backend | Its HTTP listener stays on `127.0.0.1`, including its host-internal listener | `--host` when HTTPS is enabled |

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

## Administrator policy {#administrator-policy}

An administrator can fix the listening address: set `CODENOMAD_LOCKED_HOST` machine-wide to the address the server must use, then restart CodeNomad. It wins over `--host`, `CLI_HOST` and **Allow connections from other IPs**, which shows the result but cannot change it. Use an intranet address so colleagues reach the server over the company network, or `127.0.0.1` to keep it on this computer. To keep all access inside the company network, also set `CODENOMAD_REMOTE_CONTROL=disabled` ([Remote Control](remote-control.md#administrator-policy)).

## Allowed origins {#upgrading}

For a hostname alias, reverse proxy or separately hosted UI, set `CODENOMAD_ALLOWED_ORIGINS` on the backend to the trusted UI origins (scheme, hostname and port). Native LAN clients must supply an allowed `Origin` header for mutations. Its HTTPS origins also let the host pair devices without the tunnel; see [Pair over direct HTTPS](remote-control.md#direct-https).

When updating a separately hosted UI, deploy the UI and reload open tabs and windows before updating the server. If the server serves the UI, reload open tabs and windows after the update.

Use a loopback connection for host-only operations: SideCar content (`/sidecars/`) and WebSockets, Remote Control management (`/api/remote-control/`), the plugin bridge (`/api/opencode-plugin/`), remote proxies (`/api/remote-proxy/`), password changes and token bootstrap. These require loopback even when signed in through direct LAN access. Only SideCars have an exception: the host's **Open SideCars over HTTPS** setting opens their content and WebSockets to browsers signed in through a trusted HTTPS origin ([SideCars](browser-sidecars.md#register-sidecar)). Live preview content (`/previews/`) is available over direct LAN access with a valid capability token.

The `/api/sidecars` registration APIs remain available to authenticated direct LAN clients and paired devices. Remote Control web previews remain available with their capability token while enabled on the host. For authenticated server management and secure credential entry, see [Save a remote server](remote-access.md#saved-servers).

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

The generated server certificate lasts 30 days. Startup renews it within three days of expiry, when required SANs are missing, when the certificate fails its checks, or when its private-key file is missing. The generated CA lasts 365 days and is replaced when expired, when its certificate fails its checks, or when its private-key file is missing; replacing it also reissues the server certificate. Clients must trust the replacement CA. There is no continuous in-process renewal: arrange a deliberate restart before expiry in long-running deployments.

If a client reports a certificate warning, stop and check the hostname, SANs, trust store and expiry. Do not disable verification or make clicking through warnings your deployment procedure. Trusted HTTPS is also required for remote browser features such as [PWA installation and microphone access](mobile.md).

## Save a remote server {#saved-servers}

Authenticated remote clients can use and manage the same saved servers as local clients. Entering a new server password or pairing link requires HTTPS or Remote Control.

In **Settings → Servers**, paste an address or pairing link into **Server address or link**, or type it and press Enter. This saves the server without opening a project. **Edit server** changes its **URL** or optional **Name**; renaming with the same URL and TLS policy works offline. After confirmation, **Remove** closes that server's tabs in this window and removes its recent shortcuts. For temporary projects, choose **Keep** or **Discard**; discarding deletes their files and conversations. Other projects and conversations remain on the server.

The CodeNomad host needs OpenSSH, and CodeNomad must already be running at the destination. In **Settings → Servers**, choose **Add SSH server**. Enter the CodeNomad **URL** as seen from the SSH host, then the **SSH host (optional)** or alias, and choose **Save**. The profile saves offline. OpenSSH requires key authentication and a verified host key in `known_hosts`. Sign in to CodeNomad on that server; HTTPS certificate checks still apply.

The server editor has a **Skip TLS verification** checkbox. The inline **Server address or link** field offers **Skip TLS verification** only after a certificate failure for that address; changing the address clears that choice. Pairing always verifies TLS.

Only if `multiBackend` is set to `false`, use the separate desktop-window flow below:

1. **Settings → Remote Access → Servers** → **Connect CodeNomad Server**.
2. In **Connect to Server**, enter **Server name** and **Server URL** using a trusted HTTPS origin. Leave **Skip TLS verification for self-signed certificates.** unchecked; establish trust instead.
3. Choose **Save** to bookmark, or **Connect** to save and open it. Sign in on that server.

Closing the last local window while remote windows stay open keeps its tabs: **Window → New Window** in a remote window, or starting CodeNomad again, reopens it.

For Remote Control, paste a fresh pairing link into **Server URL** instead. The bookmark retains only the tunnel origin, never the one-use pairing code; see [Remote Control](remote-control.md) for re-pairing after device-cookie loss.

## Open a remote project in a tab {#remote-project-tabs}

In an empty tab, choose **Browse**, then a server. Paste an address or pairing link into **Server address or link** to save a server. Sign in if asked. Click a folder to enter it; press Enter in the path field or choose **Open** (the arrow) to open it. **Back to Browse** returns to the server list.

Local and remote projects share the same window. **Recent tabs** shows the selected server’s shortcuts while you browse; mixed recents show the server icon and name for projects opened here. [Restore remote tabs](projects.md#restore-remote-tabs).

In **Settings → Servers**, **Open** selects the server in **Browse**, reusing an empty tab if one is open.

### `--connect-server` {#connect-server}

`--connect-server <name-or-url>` opens a separate remote window regardless of `multiBackend`. Use a saved name, saved ID or HTTP(S) URL. A new URL is saved under its host name. Launch URLs cannot carry a username, password or pairing code. See the [desktop launch table](desktop.md#desktop-cli) for syntax and remote-only startup.
