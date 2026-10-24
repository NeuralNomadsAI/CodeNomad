# Mobile and PWA

Use the browser UI on a phone or tablet to continue work on the backend host. Installing the PWA changes how the UI opens, not where projects, credentials or agent execution live.

## Connect from a phone or tablet {#connect}

1. On the host, open **Settings → Remote Access → Remote Control**, then choose **Start Remote Control**.
2. Scan the pairing QR code with your mobile device and open the link in the browser you intend to keep using.
3. Alternatively, configure [direct access](remote-access.md), open the host's reachable trusted HTTPS URL, and sign in with its server password.

Remote Control requires device pairing; direct connections require routing, a reachable listener and authentication. Do not use `localhost` on the phone to reach your workstation. Losing site data or switching browser profiles can require sign-in or pairing again; see [Remote Control](remote-control.md).

## Install the PWA {#install-pwa}

1. Open the working CodeNomad URL over trusted HTTPS in a browser that supports installation.
2. In Chrome/Edge and similar browsers, use the address-bar install action or the browser's **Install CodeNomad** action when offered. On iPhone/iPad Safari, use **Share → Add to Home Screen**; the exact wording depends on the OS/browser.
3. Open the new launcher and complete sign-in or pairing there if its browser storage is separate.

Installation is per device/browser and origin. It does not install Node, Git or OpenCode on the phone, start a backend, or grant native desktop integrations. Removing the launcher does not delete host conversations; revoke a paired device separately when removing access.

### Secure context and certificates {#secure-context}

Remote PWA installation and microphone access need a browser-recognized secure context. Use a trusted HTTPS certificate matching the exact hostname/IP. A generated local certificate must be explicitly trusted by the client device/browser; a warning page or bypass is not a reliable installation setup. Browser localhost exceptions apply to that device, not to an HTTP LAN address for another host.

If installation is missing, first confirm HTTPS trust and browser support, then reopen the page in the full browser rather than an embedded QR/in-app browser. For microphone failures, review browser/OS site permission and [Voice](voice.md). Do not turn off authentication or TLS verification to fix installation.

## Work with touch layouts {#touch-layout}

Use **Left panel** and **Right panel** controls to open navigation and tools. On narrow layouts, panels overlay the conversation rather than forcing a desktop-width canvas; opening one floating panel closes the other. Conversation-header actions move into their overflow menu when space is limited.

The composer keeps Agent, Model and Thinking in its footer. The field resizes with the visible conversation, including the on-screen keyboard; long drafts remain scrollable. On touch-only devices, sending does not reopen the on-screen keyboard, so you can read the reply; tap the composer to continue. While a session runs, the composer's **More actions** menu offers **Queue message** or **Steer now**, whichever your normal send does not do, without needing a hardware-keyboard shortcut. Opening an interruption temporarily compacts the composer without changing its saved height or draft. Answer permissions/questions in the dock above it, keeping the dock's action footer reachable. See [Conversations](conversations.md) and [Permissions](permissions.md).

## Capability and connectivity limits {#limits}

| Capability | Mobile browser / PWA |
| --- | --- |
| Projects, conversations, files and permissions | Operate on the connected backend host, subject to its access controls. Device attachments upload from the phone; project references resolve on the host. |
| Native desktop windows, OS menus and host-native automation | Not supplied by installing the PWA. |
| Browser preview | Does not acquire native guest-browser capabilities; fallback rendering remains browser-limited. |
| SideCar content and WebSockets | Depend on connection path; Remote Control blocks the SideCar content proxy and serves web previews, with their WebSockets, while the host allows them. See its [exact restrictions](remote-control.md). |
| Microphone, clipboard, notifications and install prompt | Depend on browser/OS support, secure context and user permissions. |
| Offline work | No offline backend or cached API history. Static UI assets may be cached, but documents and API responses are not an offline workspace. |

Keep the backend reachable. Mobile OS suspension or a network switch can disconnect the event stream; returning reconnects and refetches current state, with no guaranteed event replay. Check whether an action completed before retrying it. Closing the PWA does not stop a standalone backend; quitting the host desktop app and its backend makes Remote Control unavailable until the next launch.
