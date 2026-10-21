# Public user help

The guide covers current CodeNomad with OpenCode V2, not the old runtime or
every upstream configuration option. Assume readers already know OpenCode:
document CodeNomad's controls, workflow differences and state/scope boundaries
instead of teaching agents, prompts, Git or MCP. Keep pages focused and link
to the official V2 docs for native configuration details.

## Sources and navigation

- `docs/help/site.json`: the ten app locales and the ordered section/page list.
  Section ids are `start`, `workflows`, `opencode-setup`, `remote-access`,
  `customize`, `extensions`, `desktop`, `help`. The approved 25 pages each appear once; `index` comes first.
- `docs/help/<locale>/<page>.md`: one H1 supplies the title and navigation label.
  Locales are `en`, `fr`, `de`, `es`, `he`, `ja`, `ne`, `ru`, `tr`, `zh-Hans`.
- `docs/help/i18n/<locale>.json`: translated site chrome and section labels.
  Keep the same non-empty keys in every language. Page titles belong in Markdown, not here.
- `docs/help/help.css`: square, responsive chrome, light/dark palettes and
  logical properties for Hebrew RTL. No application styles/runtime are imported.

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

Fallback is not validation success. The full check fails for missing translations,
heading-id drift, unresolved links/anchors/images, duplicate or missing heading
ids and invalid page structure. `--locale en` checks English alone while the
translation work is pending; it does not claim the other locales are ready.

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
needed. The builder uses the existing `marked` dependency. To exercise a
throwaway source tree without editing real content:

```sh
node scripts/build-help.mjs <output-directory> --content <source-directory>
node scripts/test-help.mjs --locale en --content <source-directory>
```

The source override needs its own `site.json` and locale directories; site CSS,
logo and chrome strings still come from this repository. Builder failures are
fatal except absent translations (warnings); heading drift is fatal in both build
and validation. Rebuilds delete only paths recorded by the previous build in
`.help-output.json`, preserving unrelated files in a caller-supplied output directory.
Tests create and remove only their own temporary directories.

The optional Playwright check renders English, Hebrew, Nepali, Japanese and Chinese
at desktop/intermediate/mobile widths in light/dark mode, checks project-site links,
search states/keyboard/IME, skip-link focus and the script-free fallback, and writes captures to `%TEMP%/codenomad-help/` (the OS
temporary directory on other systems). It accepts the same `--content` override.

Locale navigation and articles need no JavaScript. The root chooser has a tiny inline script,
hash-authorized by its CSP, to select the best supported `navigator.languages`
match (including `zh-*` → `zh-Hans` and `iw` → `he`). Plain language links work
with scripting disabled. There are no analytics, remote fonts or remote runtime
requests. Navigation/alternate links work under the GitHub project-site path.

The only other script is first-party `docs/help/help-search.js`, copied unchanged
to assets and allowed by article CSP (`script-src 'self'`, `connect-src 'self'`).
It loads only the current locale's build-time `search-index.json`; entries contain
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

Electron and both Tauri Help-menu branches put **CodeNomad Help** first, before
the existing update/About items. The hosts send `open-help` to the primary renderer; its existing palette-command dispatch
executes the localized **Open help** command and uses the current UI locale.
Browser and remote users can run the same command from the palette.

`packages/ui/src/lib/help-url.ts` owns the base URL and locale→path mapping;
`openExternalUrl` opens the system browser on native hosts (Electron's existing
new-window policy handles `window.open` and reports asynchronous opener failures
through a visible host error) or a separate browser tab. Tauri remote windows
have no generic opener/native capability: their owned new-window/navigation policy
hands only credential-free HTTPS URLs under `https://neuralnomadsai.github.io/CodeNomad/`
on port 443 to the system browser, denying other external targets and native guests.
New-window callbacks recheck the registered window generation before opening.
Help never
navigates the application renderer. Preferences/remote/loading windows without
a primary menu listener fall back to the root chooser. The custom Windows
titlebar's `help` menu still opens the same native submenu.
Malformed locale tags are rejected before prefix mapping. Opening failures use
localized renderer alerts or a native host error; actions are never replayed.
`window.open` returning null with `noopener` is not evidence of failure.

Search suppresses Chromium/WebKit's native search-cancel affordance; the single
labelled Clear button retains its 44px touch target.

## Publish on GitHub Pages

Pages is enabled with **GitHub Actions** as the source at
**https://neuralnomadsai.github.io/CodeNomad/**.

`.github/workflows/help-pages.yml` checks and builds help on pull requests, but
deploys only `dev` pushes/manual runs from `dev`. The build job is read-only;
deployment uses `pages: write` and `id-token: write`. Help sources, screenshots,
images, help scripts, shared URL module, manifests/lockfile and `.node-version`
trigger the workflow. No extra hosting secret is needed.
The full multilingual check intentionally blocks publishing incomplete translations.
