# Android transport policy

The recovery plugin owns `android/src/main/AndroidManifest.xml` and
`res/xml/codenomad_mobile_network_security.xml`. Gradle merges its
`android:networkSecurityConfig` into the generated application's manifest.
No ignored `gen/android` file is patched. The uniquely named policy applies to
debug and release builds: cleartext denied, **system CA trust only**, no user CA,
debug CA, custom trust manager or SSL bypass.

On supported Android versions (API 26+), a Network Security Configuration is
authoritative even if Tauri's generated debug manifest sets
`usesCleartextTraffic=true`. Do not judge the APK from that legacy flag alone;
inspect its actual application NSC reference **and packaged XML resource**.
This build does not change Tauri's generated flag or enable HTTP development.

## API 37 localhost behavior

[Official Android guidance](https://developer.android.com/privacy-and-security/security-config#localhost)
describes the new implicit localhost rule allowing cleartext from API 37.
`localhost`, `ip6-localhost`, and numerical loopbacks count as localhost.

Confirmed against Android 17's official AOSP Conscrypt source at revision
`fd1a430323b5ab9945a15fce6c4a824aeffff685`:

- [XmlConfigSource.java](https://android.googlesource.com/platform/external/conscrypt/+/fd1a430323b5ab9945a15fce6c4a824aeffff685/nsc/src/android/security/net/config/XmlConfigSource.java):
  any explicit loopback domain sets `isLocalhostDefined`; the implicit permitting
  configuration is created **only if no such domain exists**.
- [ApplicationConfig.java](https://android.googlesource.com/platform/external/conscrypt/+/fd1a430323b5ab9945a15fce6c4a824aeffff685/nsc/src/android/security/net/config/ApplicationConfig.java):
  explicit domain rules win; without an implicit localhost configuration,
  unmatched hostnames use the base configuration.

Our explicit denying domains are `localhost` / `ip6-localhost` (including
subdomains), `127.0.0.1`, and `::1`. Other 127/8 addresses, bracketed/expanded
IPv6 loopbacks and alternate spellings fall back to the denying base, not an
implicit permitting localhost configuration. No cleartext exception is added.

`RecoveryPlugin.load` synchronously sets `MIXED_CONTENT_NEVER_ALLOW` before
hosted navigation. Wry's `use_https_scheme(true)` continues to serve bundled
`https://tauri.localhost` assets and `https://ipc.localhost` IPC through protocol
interception; these are not real loopback HTTP servers. The adapter delegates
subresource/IPC interception to Wry, without applying selected-origin
main-frame admission to fetch/XHR. Hosted HTTPS login POST, uploads and SSE
are unchanged; top-level non-GET denial, TLS-error cancellation, native
generation/lifecycle fencing and zero remote native capabilities remain intact.

## Regression checks

`npm run test --workspace @codenomad/mobile-app` runs source contracts and, with
an existing JDK 17+, parses the **production XML and manifest** using Java's XML
parser (`tests/native/TransportPolicyTest.java`). With no JDK, that XML check
reports a skip; an Android artifact build must not treat a skip as qualification.
The test checks the actual manifest resource reference, explicit denying base
and domain rules, inherited system-only trust, no debug override, and structural
hostname-rule selection for named/IPv4/IPv6 loopback variants and Wry hosts.

To check a real Gradle-merged manifest, from `packages/mobile-app`:

```powershell
java --source 17 tests/native/TransportPolicyTest.java <merged-manifest-path>
```

APK inspection must additionally check binary manifest, resource table and
binary NSC, signature, ABI/alignment, packaged recovery classes and current
launcher assets. Reusable read-only artifact checks (writes are evidence only):

```powershell
# Existing isolated SDK/JDK tools must already be on PATH; no tools are installed.
./tests/native/verify-transport-apk.ps1 -Apk <apk-path> -Evidence <evidence-directory>
node tests/native/verify-embedded-assets.mjs <evidence-directory>/packaged-libcodenomad_mobile_lib.so <evidence-directory>/embedded-assets.json
```

The APK check binds the binary manifest NSC ID to the actual resource table,
then checks the packaged XML. SDK `apkanalyzer resources xml` drops domain text
nodes; the verifier instead uses `aapt dump xmltree`'s strict E/A/C output,
preserving those text nodes and failing on unknown lines. It never substitutes
the source XML for the APK policy. DEX checks confirm the actual `load` method
sets mixed-content mode to 1 (`MIXED_CONTENT_NEVER_ALLOW`).

Static/JVM tests and a successful build **do not prove absence
of WebView network traffic**. No device/emulator was used for these checks.

## Required authorized device pilot

Use fixture servers and traffic capture on supported Android/API 26 and API 37
with an updated System WebView. Verify bundled launcher + IPC, hosted trusted
HTTPS sign-in/cookies/upload/SSE/reconnect and native return/reopen. From the
HTTPS fixture, attempt HTTP fetch/XHR, image/script/frame, WebSocket, navigation
and HTTPS-to-HTTP redirects to a remote host, `localhost`, `ip6-localhost`,
127/8 variants, `[::1]` and expanded IPv6: neither cleartext destination should
receive a request. Include mixed-content targets and TLS bad-chain/hostname,
user-CA-only and self-signed failures (no bypass). Verify GET redirect fencing,
307/308 top-level non-GET rejection, denied remote native invoke, competing
connections/return, renderer death/Activity close and explicit reopening.

This is a development-signed ARM64 pilot APK, not device-qualified delivery,
a release-signed artifact, a public-server qualification, or an iOS result.
