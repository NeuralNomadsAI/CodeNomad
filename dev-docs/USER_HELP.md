# Public user help

The guide covers CodeNomad with OpenCode V2. Assume readers already know OpenCode:
document CodeNomad's controls, workflow differences and state/scope boundaries
instead of teaching agents, prompts, Git or MCP. Keep pages focused and link
to the official V2 docs for native configuration details.

## Sources and navigation

- `docs/help/site.json`: the ten app locales and the ordered section/page list.
  Section ids are `start`, `workflows`, `opencode-setup`, `remote-access`,
  `customize`, `extensions`, `desktop`, `help`. The approved 28 pages each appear once; `index` comes first,
  then `download`, which the header **Download** link (`download.label`) opens on every page. The `help`
  section ends with `support` (bug reports and source builds) and `sponsor` (**Support CodeNomad**:
  why and how to fund development).
- `docs/help/<locale>/<page>.md`: one H1 supplies the title and navigation label.
  Locales are `en`, `fr`, `de`, `es`, `he`, `ja`, `ne`, `ru`, `tr`, `zh-Hans`.
- `docs/help/i18n/<locale>.json`: translated site chrome, section labels, release strings, download-button and funding labels.
  Keep the same non-empty keys in every language. Page titles belong in Markdown, not here.
- `docs/help/help.css`: square, responsive chrome, light/dark palettes and
  logical properties for Hebrew RTL. Never import application styles/runtime.

Every H2/H3 (and deeper heading, if used) needs an explicit ASCII kebab-case id:

```md
## Answer requests {#answer-requests}
### Permissions {#permissions}

[Another page](permissions.md#answer-requests)
[This page](#permissions)
![Workspace](../../screenshots/workspace-0.20.png)
```

The builder strips the suffix and assigns the id. Do not translate or reorder
ids: every translated page must have exactly the English ordered (level, id) list.
The single H1 is the page title, without an explicit id; an H1 `{#id}` is an error,
never silently discarded. Link to an H2 section instead.
Ids are unique within a page; `content`, `help-query` and `help-results` are reserved
for site chrome. Avoid raw
HTML headings or images: Markdown supplies the metadata needed for validation.

Inter-page Markdown links become same-locale HTML links with their anchors
intact. HTTPS links stay unchanged. Relative repository-reference links outside
the guide become GitHub links; relative images (whose real path must stay inside
the repository) are copied once into shared `assets/media/`, not fetched from
remote hosts. Use paths relative to the source
page, including the locale directory.

## Release links and generated blocks

`docs/help/downloads.json` (untranslated, read from this repository even with
`--content`) lists the stable release assets in display order, Tauri first: each
entry has `id`, `platform` (`windows`/`macos`/`linux`), `host` (`tauri`/`electron`),
`arch` (`x64`/`arm64`) and an asset-name `template` with one `{version}` (the tag
without its `v`). Templates must match the real asset names of a published release.

`[label](release:<id>)` links to that asset. With release data the link is the
exact download URL followed by `<span class="download-size">`, decimal megabytes
formatted for the page locale; without release data (local and pull-request builds)
every release link opens `releases/latest` without a size. An id missing from
`downloads.json` is an `unknown-release-asset` problem.

A directive is a top-level paragraph containing only `{{name}}`; the builder
replaces it with generated HTML that has no headings and never becomes the meta
description. `{{release}}` renders a `release-line` paragraph from the
`release.published` chrome string (version and a long UTC date for the page locale)
or, without release data, `release.unavailable` linked to the latest release.
`{{download-button}}` is allowed only on `download.md` (elsewhere `misplaced-directive`)
and makes that page load `help-download.js` (see below). It renders a hidden
`div.download-primary` holding one hidden `data-download-os` block per target
(`windows`, `macos`, `linux`, `mobile`), each with its final `a.download-main` label and
href: the Tauri Windows x64, macOS arm64 and Linux x64 assets from `downloads.json`
with a detail line and size, a secondary Intel Mac link (macOS x64), and `mobile.html`
for phones and tablets. Without release data the desktop targets open `releases/latest`.
Labels are the `download.*` chrome strings; search excerpts omit the hidden block.
`{{tour-video}}` is allowed only on `index.md` and renders `figure.tour`: a silent
`<video autoplay muted loop playsinline controls preload="metadata">` (`tour.label` as
`aria-label`) whose poster and single `<source>` are `docs/screenshots/codenomad-tour-poster.jpg`
and `codenomad-tour.mp4`, copied to `assets/media/` like images; an `<img>` of the same
poster (`tour.poster` alt); and a caption linking `tour.caption` to the full YouTube tour.
The source's `media` is `(prefers-reduced-motion: no-preference) and (min-width: 721px)`,
so narrow screens and reduced motion download no video; `help.css` hides the player and
shows the image under the exact complement of that condition and in print, so no
player without a video appears. A browser that loads a narrow page and is then widened
keeps that sourceless player until reload. Keep the clip silent H.264 4:2:0, 1280x720,
40-50 s, faststart and at most 3.5 MB, and the poster a 1280x720 JPEG of at most 200 KB;
provenance and encoding live in `docs/screenshots/README.md`.
`{{funding}}` is allowed only on `sponsor.md` and `download.md` (`#support-development`, the
download page's last section, never gating the download) and renders `ul.funding`: one outlined
44px button per channel of `docs/help/funding.json`, in file order, labelled `funding.action`
with the channel name in `<bdi>`, followed by `funding.recipient` naming who receives the money.
With an empty `funding.json` a page using it is a fatal `missing-funding` problem.
Each directive appears at most once per page (`duplicate-directive`) and every
translation of a page carries the same directives as English (`directive-mismatch`).
Any other `{{` in rendered text, including a directive inside a list item, table
cell, quote or sentence, is an `unknown-directive` problem; inline code and code
blocks are exempt, so samples stay writable. All of these problems are fatal.

A paragraph containing nothing but one link to a help page (`[Download CodeNomad](download.md)`)
gets `class="action"` and renders as the accent button, full width under 720px. Only
the home page uses one; write such a lone link elsewhere only for a primary call to action.

Release data is `{ tag, version, publishedAt, assets: { <id>: { url, size } } }`,
passed as `buildHelp({ release })` or `--release <file>`; the builder never makes
network requests. It revalidates the data and throws on any deviation: exactly
these keys, a `vMAJOR.MINOR.PATCH` tag with `version` equal to it without `v`, a
real UTC timestamp, exactly the `downloads.json` ids, each URL equal to
`https://github.com/NeuralNomadsAI/CodeNomad/releases/download/<tag>/<asset>`
with URI-encoded components, and safe positive integer sizes. Version, date and
size are escaped before they fill chrome templates. Tests use the offline fixture
`scripts/fixtures/help-release.json` (v1.0.0) and fail if `fetch` is called.

## Funding channels

`docs/help/funding.json` (untranslated, read from this repository even with `--content`) lists
the funding channels in display order: each entry has exactly `id` (unique kebab-case), `name`
and `recipient` (non-empty display text, escaped) and `url`. URLs must match an allowlisted
canonical form, currently only `https://github.com/sponsors/<login>` (a valid GitHub login,
lowercase host, no credentials, port, query, fragment or trailing path); add a pattern to
`FUNDING_URLS` in `scripts/build-help.mjs`, with tests, before listing another platform.
Adding a channel needs no retranslation: pages reach channels only through `{{funding}}`.
Tests may inject channels with `buildHelp({ funding })`, validated like the file. The header
**Sponsor** link (`funding.label`, after **Download**) opens `sponsor.html` on every page only
when at least one channel exists and the `sponsor` page is built. Tests allow sponsorship URLs
(GitHub Sponsors, Open Collective, Liberapay, Polar, thanks.dev, PayPal, Patreon, Buy Me a
Coffee, Ko-fi) only inside the generated block, which must list exactly `funding.json`, and only
on `sponsor.html` and `download.html`; never hand-write a funding link in Markdown.

## Translation workflow

Write/update English first, then copy the page to the other locale directories
and translate its prose, H1 and link labels while preserving filenames, heading
ids and local link targets. Use the app's own terminology where relevant.
Add a new page to `site.json` and provide it in every locale.

Missing translations still build: the selected language's chrome remains, a
translated notice explains the fallback, and the English article has `lang="en"`
and `dir="ltr"`, including within Hebrew pages. The page's language menu and
`hreflang` alternates retain its identity in every language. An absent translation
offers a contribution link for that locale; existing pages link to their editor.

The full check fails for missing translations, heading-id drift, unresolved
links/anchors/images, duplicate or missing heading ids and invalid page
structure. `--locale en` checks English alone while translation is pending.

## Build and check

```sh
npm ci --ignore-scripts
npm run test:help -- --locale en
npm run test:help
npm run build:help
node --import tsx --test packages/ui/src/lib/help-url.test.ts
node scripts/test-help-browser.mjs
```

Output is `dist/help/<locale>/<page>.html`, with `index.html` also serving each
locale directory. Shared assets live under `dist/help/assets/`. Serve `dist/help`
with any static HTTP server; no backend, credentials or OpenCode service is
needed. The builder uses the `marked` dependency. To exercise a
throwaway source tree without editing real content:

```sh
node scripts/build-help.mjs <output-directory> --content <source-directory>
node scripts/build-help.mjs <output-directory> --release scripts/fixtures/help-release.json
node scripts/test-help.mjs --locale en --content <source-directory>
```

The source override needs its own `site.json` and locale directories; site CSS,
logo and chrome strings still come from this repository. Builder failures are
fatal except absent translations (warnings); heading drift is fatal in both build
and validation. Rebuilds delete only paths recorded by the previous build in
`.help-output.json`, preserving unrelated files in a caller-supplied output directory.
Tests create and remove only their own temporary directories.

The optional Playwright check renders English, Hebrew, Nepali, Japanese and Chinese
at desktop/intermediate/mobile widths in light/dark mode with all four header items
(Download, Sponsor, GitHub, language) inside the viewport, checks project-site links,
the funding buttons (exact label, square 44px targets spanning 390px screens, English and Hebrew),
search states/keyboard/IME, skip-link focus and the script-free fallback, the home tour
(muted playback at 1440px; at 720px, 390px and with reduced motion an empty `currentSrc`,
no clip request and the visible poster; 16:9 boxes without overflow), and writes captures to `%TEMP%/codenomad-help/` (the OS
temporary directory on other systems). It accepts the same `--content` override.

Locale navigation and articles need no JavaScript. The root chooser has a tiny inline script,
hash-authorized by its CSP, to select the best supported `navigator.languages`
match (including `zh-*` → `zh-Hans` and `iw` → `he`). Plain language links work
with scripting disabled. Never add analytics, remote fonts or remote runtime
requests. Navigation/alternate links work under the GitHub project-site path.

Article pages load first-party scripts only, copied unchanged to assets and allowed
by article CSP (`script-src 'self'`). Tests require exactly `help-search.js` on every
page plus `help-download.js` on `download.html` alone, and reject any other, inline or
remote script, `on*` attributes and inline styles. The build records both scripts in
`.help-output.json` like every owned output file.

The article CSP adds `media-src 'self'` for the home tour alone. Tests allow exactly its
`<video>` and `<source>` on `index.html`, reject media elsewhere and any iframe, audio,
embed, object or track, resolve `poster` like every local `href`/`src`, and check the
clip and poster files against their budget by parsing the MP4 boxes and JPEG header.
Never embed YouTube or other remote media; link to it.

`docs/help/help-download.js` makes no requests and never probes the architecture.
The named pure `detectDownloadPlatform(navigator)` checks phones and tablets first
(client-hint `mobile`, Android, iPhone/iPad/iPod, and iPadOS's Mac platform with more
than one touch point), then `navigator.userAgentData.platform`, then the user agent and
`navigator.platform`; Windows on ARM gets the x64 build, while ChromeOS, ARM Linux and
unknown systems get nothing. The script reveals the matching block and its container only
when that link has an href and a label, so without JavaScript, on failure or for an
unknown system the button stays hidden and the always-rendered table is the download
path. Print hides the button; under 720px it spans the article. The detector and reveal
tests (`scripts/test-help-download.mjs`, imported by `test-help.mjs`) run the script in
a `node:vm` context against the real built page with a minimal fake DOM; the Playwright
check verifies one revealed platform, its 44px target and the no-JavaScript state.

`docs/help/help-search.js` (`connect-src 'self'`) loads only the current locale's build-time `search-index.json`; entries contain
article title, explicit heading id/text and a short section excerpt. Tests resolve
every result to its real HTML anchor. Normalized substring matching supports CJK,
Devanagari and Hebrew without libraries or remote requests. Ctrl/Cmd+K focuses,
arrows select, Enter follows the real link, Escape dismisses/restores focus;
composition and browser Ctrl/Cmd+F are untouched. Empty/no-results/load-failure
states are localized. Search is hidden without JS. Desktop navigation and outline
use CSS-exclusive wide views; narrow layouts use native collapsed disclosures,
so responsive defaults require no extra script. Tables/code scroll locally, inline
code/key chords isolate LTR, and selected rows follow the app's 40%/50% accent-ink tint.

## Application entry points

Electron and both Tauri Help-menu branches put **CodeNomad Help** first, then
**Support CodeNomad**, before the update/About items. The hosts send `open-help`
or `open-sponsor` to the primary renderer; its palette-command dispatch executes
the localized **Open help** or **Support CodeNomad** command and uses the current
UI locale. Browser and remote users can run the same commands from the palette;
Settings → Info's Support CodeNomad card opens the same `sponsor` page.

`packages/ui/src/lib/help-url.ts` owns the base URL and locale→path mapping
(`helpUrl(locale, page)` accepts only `[a-z0-9-]` page names, else the locale home);
`openExternalUrl` opens the system browser on native hosts (Electron's
new-window policy handles `window.open` and reports asynchronous opener failures
through a visible host error) or a separate browser tab. Tauri remote windows
have no generic opener/native capability: their owned new-window/navigation policy
hands only credential-free HTTPS URLs under `https://neuralnomadsai.github.io/CodeNomad/`
on port 443 to the system browser, denying other external targets and native guests.
New-window callbacks recheck the registered window generation before opening.
Help never
navigates the application renderer. Preferences/remote/loading windows without
a primary menu listener fall back to the root chooser for help and to the
English `sponsor` page for Support CodeNomad (Tauri `SPONSOR_URL`). The custom Windows
titlebar's `help` menu opens the same native submenu.
Malformed locale tags are rejected before prefix mapping. Opening failures use
localized renderer alerts or a native host error; actions are never replayed.
Treat `window.open` returning null with `noopener` as success.

Search suppresses Chromium/WebKit's native search-cancel affordance; the single
labelled Clear button retains its 44px touch target.

## Publish on GitHub Pages

Pages is enabled with **GitHub Actions** as the source at
**https://neuralnomadsai.github.io/CodeNomad/**.

`.github/workflows/help-pages.yml` runs on `dev` pushes, manual runs, pull requests
and every completed **Release Binaries** run (`release.yml`, pushes to `main`), so a
new stable release republishes the download links. It deploys only from `dev`
(pushes, manual runs from `dev` and accepted release events, whose `github.ref` is
the default branch). Help sources, screenshots, images, help scripts, the
`scripts/fixtures/help-*.json` fixtures, shared URL module, manifests/lockfile and
`.node-version` trigger the push and pull-request runs. No extra hosting secret is needed.

- A release event is accepted only when that run succeeded and ran for a `push` to
  `main` of this repository; the job gate is checked before checkout. Accepted
  events check out the trusted `dev` sources; never use the release run's commit
  (`head_sha`) or artifacts.
- The build job has `contents: read` and a checkout without persisted credentials;
  only the resolver step receives `GH_TOKEN: ${{ github.token }}`. Deployment alone
  has `pages: write` and `id-token: write`.
- One workflow-level `help-pages-production` concurrency group serializes checkout,
  resolution, build and deployment for every `dev` run without cancelling the one in
  progress. Pull requests use per-PR groups that cancel superseded runs; rejected
  release events use a per-run group, leaving a pending production run in place.
- Pull requests run `npm run test:help` and build without release data, skipping
  resolution and deployment.

Every other run calls `scripts/resolve-help-release.mjs "$RUNNER_TEMP/help-release.json"`
after the tests, then `build-help.mjs --release` on that file. The resolver runs only
when `GITHUB_ACTIONS` is `true` and `GH_TOKEN` is set, so a local build cannot reach
the API; locally, omit `--release` or pass the fixture. It lists every release page
(`per_page=100`, at most 10 pages, 20-second timeout per request, no redirects) and
follows a `Link` `rel="next"` only to `https://api.github.com` release listings of
this repository. `selectRelease(releases, downloads)` is pure. Only non-draft,
non-prerelease `vMAJOR.MINOR.PATCH` tags are candidates (early builds such as
`v0.2.8-dev` were published without the prerelease flag). It rejects malformed
entries or assets, a candidate's invalid `published_at`, duplicate candidate tags
and duplicate asset names, orders candidates by `published_at` and picks the
newest where each `downloads.json` asset is exactly one
`uploaded` asset with a positive size at the expected download URL. Newer stable
releases still missing assets (a release exists before its uploads finish) produce a
`::notice::` naming the missing files, and the previous complete release is used.
API, authentication, pagination or validation failures and the absence of any
complete release exit nonzero with an `::error::`: the build fails and the previously
published site stays live. The written file is revalidated with `validateRelease`
before the resolver exits successfully. It reads release metadata only; never add
binary downloads to it.

Tests run the resolver offline against trimmed recordings of the real listing,
`scripts/fixtures/help-release-api-page1.json` (newer dev prereleases around `v1.0.0`)
and `help-release-api-page2.json` (older stable releases whose asset names predate
`downloads.json`, and `v0.2.8-dev`), with an injected fake `fetch`; the recorded `v1.0.0` must resolve
exactly to `scripts/fixtures/help-release.json`. A workflow test parses
`help-pages.yml` and checks the trigger, gate, permissions, token scope, concurrency
and pull-request path.

To republish by hand (for example after a release run whose help build failed), run
the workflow manually from `dev` or push a help change to `dev`.
The full multilingual check intentionally blocks publishing incomplete translations.
