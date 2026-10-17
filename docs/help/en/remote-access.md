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

This changes the host's direct listening mode, not one project and not Remote Control. The disclosure starts collapsed even while the server listens beyond localhost. If automatic restart is unavailable, restart CodeNomad manually; standalone deployments must set their launch-time `--host` consistently. To remove exposure, turn the switch off and restart, or relaunch the CLI with loopback binding. This does not revoke paired Remote Control devices.

### Listener binding matrix {#binding-matrix}

`--host` defaults to `127.0.0.1`; `localhost` normalizes to that address. The following rules apply to the enabled listeners:

| Launch/mode | HTTP binds to | HTTPS binds to |
| --- | --- | --- |
| Standalone, HTTPS only (default) | Not enabled | `--host` |
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

Do not assume port 9898 or 9899: omitted ports can fall back when busy. An explicit nonzero `--https-port` or `--http-port` pins the port and fails if it cannot bind; `0` asks the OS to assign one. The printed **Local Connection URL** and **Remote Connection URL**, and refreshed **Reachable addresses**, are authoritative for that run. See the complete [server CLI reference](server.md).

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

1. In the desktop home page, select **Servers**, then **Connect to Server**.
2. Enter **Server name** and **Server URL** using a trusted HTTPS origin. Leave **Skip TLS verification for self-signed certificates.** unchecked; establish trust instead.
3. Choose **Save** to bookmark, or **Connect** to save and open it. Sign in on that server.

Bookmarks belong to this CodeNomad configuration, not the remote server's projects. Saving a URL does not start the server or grant access. **Remove saved server** removes the bookmark, not remote conversations, the backend or its credentials. Saved servers can also be opened from the new-instance launcher's **Remote servers** list.

For Remote Control, paste a fresh pairing link into **Server URL** instead. The bookmark retains only the tunnel origin, never the one-use pairing code; see [Remote Control](remote-control.md) for re-pairing after device-cookie loss.
