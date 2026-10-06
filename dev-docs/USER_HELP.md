# Public user help

The English guide in `docs/help/` covers current CodeNomad with OpenCode V2,
not the old runtime or every upstream configuration option. Assume readers
already know OpenCode: document CodeNomad's controls, workflow differences,
and state/scope boundaries instead of teaching agents, prompts, Git, or MCP.
Keep pages short, use current English interface labels, and link to the
official V2 docs for native configuration details.

## Build and check

```sh
npm ci --ignore-scripts
npm run test:help
npm run build:help
```

Output is `dist/help/`. Serve that directory with any static HTTP server to
preview it; no app backend, credentials, or OpenCode service is needed. The
builder uses the existing `marked` dependency, copies local screenshots/logo,
and generates relative links that work under a GitHub project-site path.
The site has no client JavaScript, remote fonts, analytics, or runtime requests.

## Publish on GitHub Pages

In **Repository Settings → Pages → Build and deployment**, select **GitHub
Actions** as the source. The repository currently has no Pages site; this is a
one-time administrator setup, not something the workflow silently enables.
Allow the `github-pages` environment to deploy from `dev` if its protection
rules require a branch allowlist.

After merging the workflow into `dev`, it builds and publishes changes to the
help sources. It can also be started manually from `dev`. Pull requests build
and check the site but never deploy it. Deployment needs `pages: write` and
`id-token: write`; the build job only reads repository contents.

Expected URL: **https://neuralnomadsai.github.io/CodeNomad/**. No separate
repository, paid hosting, domain, or additional deployment secret is needed.
The site follows `dev` (the current implementation); it is not an archive of
versioned guides. Update the help alongside user-visible behavior changes.

The desktop Help link should use this URL once deployment is available. Native
Help menu items are maintained in both desktop hosts; the updater work from
issue #606 remains separate from documentation hosting.
