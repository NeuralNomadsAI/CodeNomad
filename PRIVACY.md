# Privacy policy

CodeNomad is open-source software that runs on your own computer. It has no
accounts, telemetry, analytics or advertising. The CodeNomad maintainers do not
collect, receive, store or sell personal data from people who use it.

## Data on your computer

Projects, conversations, settings, credentials and logs stay on the machines
you run CodeNomad and OpenCode on. OpenCode is separate software that
CodeNomad connects to; it stores conversations and sends them to the AI model
providers you configure, under those providers' terms. CodeNomad does not send
your conversations, files or credentials anywhere else.

## Automatic connections

CodeNomad contacts the services below without a specific action from you.
These requests contain no conversation content, files, credentials or personal
data. As with any internet request, each service receives your IP address and
standard request details, handled under its own privacy policy.

| Service | When | Purpose |
|---|---|---|
| `api.github.com` | At startup and while running | Check for new CodeNomad releases and show the repository's star count |
| `ui.codenomad.neuralnomads.ai` (Cloudflare) | At startup | Check for and download an updated CodeNomad interface. Set the environment variable `CLI_UI_NO_UPDATE=true` to keep the bundled interface |
| `registry.npmjs.org` | When CodeNomad checks your OpenCode installation | Find the latest OpenCode version |
| `raw.githubusercontent.com` | While Settings → Info is open | Prepare the bug-report form |

## Connections you start

- **Remote Control** connects through the [OpenTunnel](https://github.com/anomalyco/opentunnel)
  relay while it is started. The connection is encrypted end to end; the relay
  can see hostnames, connection times and traffic sizes, not contents.
- **Voice input and speech** send audio or text to the speech service you
  configure.
- **Provider usage and account rotation** read quotas from your AI providers
  with the credentials you configured for them.
- **Installing or updating OpenCode or CodeNomad** downloads packages from npm
  or GitHub.
- **Panel extensions** read the official catalogue on GitHub and download the
  extensions you choose to install.
- **Browser previews, Git remotes and cloned repositories** connect to the
  addresses you open or configure.
- **Report a bug** opens a prefilled GitHub issue in your browser. Nothing is
  sent until you submit it on GitHub yourself.

## Questions

Open an issue at <https://github.com/NeuralNomadsAI/CodeNomad/issues>.
