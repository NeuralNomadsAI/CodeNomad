# Remote Control

Remote Control lets a paired browser or desktop client use your running CodeNomad backend without opening an inbound network port. It does not require a server password, a non-loopback `--host`, or a VPN. It is a separate access path from [direct connections](remote-access.md).

## Start and pair {#start-and-pair}

1. On the host, open **Settings → Remote Access**.
2. Choose **Start Remote Control**. Wait for **Ready for remote connections**; first use may take time to provision the tunnel identity and certificate.
3. Under **Connect another device**, scan the QR code or choose **Copy link**, then open that one-use link on the intended device.
4. Keep the paired browser's site data. Reopen the tunnel address to reconnect while the backend is running.

The link is valid for **five minutes** and succeeds **once**. Treat it as a credential: anyone who consumes it can become a paired device. The code lives in the URL fragment, not the query string. **Create new pairing link** immediately invalidates the preceding unused link. Stop, backend shutdown and tunnel failure cancel outstanding pairing links.

To pair another desktop CodeNomad, choose **Connect CodeNomad Server** on its home page, paste the link into **Server URL**, and choose **Connect**. A pairing link opens its window even from **Save**, because opening it consumes the code. Only the tunnel origin is saved as the bookmark; the code is not retained. TLS verification stays enabled for pairing links.

## Manage paired devices {#paired-devices}

1. On the host, return to **Settings → Remote Access → Remote Control**.
2. Review **Paired devices** and their **Last seen** time. Each device is named after the platform and browser that paired it, such as `iPhone · Safari`.
3. Choose **Revoke** for a device that should no longer connect.

Revocation ends that device's current HTTP/SSE connections as well as future access. Pair again with a new link to restore access. A device expires after **30 days without use**. At the **32-device limit**, a new pairing replaces the least recently seen device and closes its connections.

The backend stores credential hashes, not raw device credentials, in `remote-control-devices.json` under its configuration base. The client holds a host-scoped `Secure`, `HttpOnly`, `SameSite=Lax` device cookie. Its browser lifetime can be longer than the server's 30-day inactivity limit; the registry remains authoritative. Clearing site data, switching browser profiles or using private browsing can require pairing again.

Changing the direct-access password does **not** revoke devices. **Stop Remote Control** disconnects the tunnel but retains the paired-device list; use **Revoke** when you want to remove authorization.

### Re-pair without losing your place {#re-pair}

1. If the client shows **Pair this device again**, leave that page open.
2. On the host, choose **Create new pairing link** and open it in the **same client browser/profile**. For a saved desktop server, reconnect using the fresh pairing link so its existing remote-window storage is reused.
3. Return to the waiting page and choose **Check connection**; it also checks again when the page regains focus.

Recovery preserves the open page and drafts; it does not replay a failed action. Check whether a send, answer or delete took effect before retrying it. A direct-access password cannot recover Remote Control pairing.

## Availability and lifetime {#lifetime}

| Action/state | Effect |
| --- | --- |
| Start Remote Control | Connects this backend and remembers the choice for future launches. |
| Close the remote browser | Does not stop the host backend or revoke the device. |
| Stop Remote Control | Disconnects access and clears automatic launch-resume; keeps device records. |
| Backend shutdown / last desktop window closes and the app quits | Remote Control goes offline. OpenCode's shared service can remain running, but cannot serve this UI through a stopped backend. |
| Launch after leaving Remote Control started | Reconnects in the background without issuing a new pairing link. Installations never started do not enable themselves. |
| Failed resume or fatal tunnel error | The remembered choice remains and the host shows the error; the Remote Control card's refresh icon rereads its state. **Start Remote Control** retries now; **Stop Remote Control** clears the choice. Otherwise a later launch retries. |

Automatic launch-resume is limited to one backend per configuration directory. Do not start competing hosts with the same configuration to obtain extra tunnel capacity. For a host that must stay reachable after a desktop exit, deploy a separately managed [standalone server](server.md); Remote Control is not an independent daemon.

## Available and unavailable surfaces {#remote-surface}

Paired devices can use ordinary project/conversation APIs, send prompts, inspect files, and answer permissions/Forms subject to the same ownership checks. Pairing is powerful access, not a read-only sharing link. It never grants loopback privileges, even though the tunnel forwards traffic internally on the host.

| Surface | Through Remote Control |
| --- | --- |
| Normal authenticated UI, workspaces, conversations and SSE | Available to a paired device. |
| Password login/logout, password changes, local token bootstrap | Unavailable; device credentials are required even if direct authentication is disabled. |
| Remote Control status | Readable by a paired device; management is unavailable. Start/Stop, pairing creation, device list and revocation stay on the host access path. |
| Desktop remote-window/server management and proxy routes | Unavailable (`/api/remote-servers/`, `/api/remote-proxy/`). |
| SideCar **content proxy** | Unavailable (`/sidecars/`). This does **not** mean all SideCar APIs are blocked: paired clients can still access the `/api/sidecars` registration APIs. |
| Web preview content | Available while **Web previews** is on (the default) under **Settings → Remote Access → Remote Control** on the host. Each preview address opens its page without pairing, so keep it private. Turning the switch off stops served previews and their WebSockets; paired devices hide **Open web preview** once they reload. |
| Automation bridge | Unavailable (`/api/opencode-plugin/`). Native desktop capabilities do not become browser capabilities. |
| WebSocket upgrades | Available for web previews only. |

Use a suitably protected [direct connection](remote-access.md) when a workflow requires a blocked proxy/WebSocket surface. Remote Control does not automatically switch to that path.

## Relay and privacy {#relay-privacy}

CodeNomad uses [OpenTunnel](https://github.com/anomalyco/opentunnel) and claims one random route on the machine's shared default tunnel identity. Stopping releases CodeNomad's bridge, not the shared identity used by other applications.

TLS terminates in the CodeNomad backend. The relay forwards ciphertext and cannot read application contents, but can observe hostnames, connection timing and traffic sizes. The tunnel certificate/private key remain on the host. Protect the host's tunnel storage and CodeNomad configuration as credentials; an unguessable address is not authorization.

`CODENOMAD_REMOTE_CONTROL_API` selects a self-hosted OpenTunnel API; unset uses the hosted service. This changes the tunnel deployment, not pairing requirements or the blocked surfaces. See [Security](security.md) for credential and diagnostic handling.
