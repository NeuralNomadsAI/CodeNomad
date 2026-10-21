# Providers and accounts

Provider authentication belongs to the connected OpenCode service, not to the browser device or one CodeNomad project. Model-display preferences, subscription quotas and web-search choices have different scopes.

## Connect a model or search provider {#connect}

1. Open a workspace, then **Settings → Providers**. **Models** starts expanded; expand **Web search** for search providers.
2. In that group, choose **Select provider**, then **Connect**.
3. For a model provider, complete the native **Authentication method** offered: API key, OAuth or command. For OAuth, use **Open authorization page** and submit an authorization code only when requested. Search providers connect with an API key.
4. Check the configured-provider row after completion. **Models** rereads after connections, account changes and reconnects; **Web search** also has **Refresh**.

Search-only integrations appear under **Web search**, not **Models**. Saving authentication does not choose a model or change the default search provider. API keys and OAuth credentials are saved by the active OpenCode server. The browser receives connection metadata, not saved credential secrets. A connection sourced from environment variables is read-only in this UI: change its owning environment rather than trying to disconnect it here.

If the authorization window is blocked, use **Open authorization page**, **Open in this tab** or **Copy link** from the flow. Do not publish the authorization link or code in diagnostics.

## Select and manage accounts {#accounts}

1. In the provider's row, use **Active account** to select a saved credential.
2. Use **Add account** to authenticate another connection.
3. To manage a different saved account, select it first, then use **Rename account** or **Remove account**. Renaming uses **Account label** and **Save**; **Remove account** acts immediately, without a confirmation.

Selection, renaming and removal affect that integration across the OpenCode service, including other projects and clients. Removing a credential can leave those clients without authentication; it does not delete conversation history or revoke the provider's remote account. Environment connections cannot be selected as writable saved credentials or removed here. If an operation fails, CodeNomad rereads the accounts: check **Active account** again before acting.

### Automatic selection limits {#automatic-selection}

With multiple saved credentials on a supported integration, **Auto-select account** opts into quota-based selection before the next prompt/custom-command admission through CodeNomad. The setting is per integration in CodeNomad configuration; a resulting account selection is service-wide.

| Eligible integration | Eligible account type |
| --- | --- |
| OpenAI / Codex | Codex browser/device OAuth subscription accounts, not OpenAI pay-as-you-go keys or the ChatGPT sign-in method whose usage OpenAI does not provide. |
| OpenCode Go | Go key, or OpenCode Console sign-in/key used for the **Go provider only**, not Zen pay-as-you-go credits. |
| Anthropic | OpenCode's Claude Pro/Max OAuth login, **not** the Claude Code login. |
| GitHub Copilot | OAuth with readable premium-request quota; enterprise-endpoint credentials are not readable candidates. |
| Coding plans | Key-based `zai-coding-plan`, `zhipuai-coding-plan`, `kimi-for-coding`, `minimax-coding-plan`, `minimax-cn-coding-plan`. |

Only a full current account triggers switching; merely having a fuller alternative does not. Reads examine explicit saved credentials without activating candidates or exchanging refresh tokens. Codex, Copilot and coding plans require a demonstrably available candidate. Go, Console and Claude may use an unknown-quota candidate unless a recent native quota failure marks it exhausted. OpenCode Go's usage endpoint and Console OAuth usage remain unverified upstream, so availability is not guaranteed.

This is **not in-flight failover**. It neither retries failed requests nor replays prompts, commands or mutations. It does not rotate environment connections, arbitrary providers, pay-as-you-go balances or external Claude Code logins. Manual account changes are respected during selection preparation; there is no cross-client account lock. On quota/authentication errors, inspect **Active account**, refresh Usage and sign in with the credential's owner as needed before deliberately sending again.

## Model visibility, favorites and Thinking {#models}

1. Choose **Manage models** beside a model provider.
2. Search by name/ID and change visibility; **Show all** and **Hide all** affect that provider's selector list.
3. In a conversation's **Model** selector, use **Add to favorites** or **Remove from favorites**; **Show all models** leaves favorites-only filtering.
4. Use **Thinking** in the composer for variants the selected model exposes.

Visibility and favorites organize CodeNomad's selectors; they do not uninstall models, remove credentials or prevent other OpenCode clients from using them. Hiding a model is not account disconnection. Thinking selects a model variant for subsequent sends, not the visibility of reasoning already in the transcript. Restore hidden models with **Manage models → Show all**.

## Usage, token counts and expired logins {#usage}

Use **Usage** in the right panel for the active conversation's provider-plan windows, reset times and supported balances. These provider readings are different from per-message **Tokens** and cost estimates: a subscription quota is not a bill calculated from the visible transcript. A missing, stale or unknown reading is not zero usage or proof of remaining capacity. **Provider credit balance** in **Settings → Advanced** controls supplemental balance display.

OpenAI does not provide usage for one ChatGPT sign-in method: Usage says so instead of showing quota windows. Chatting still works, and reconnecting the same login does not restore the reading.

Usage follows the selected native credential. Claude through `anthropic`/`claude` uses OpenCode's Anthropic OAuth. The `claude-code` provider uses the Claude Code login on the daemon's host, including its WSL distribution: `CLAUDE_CODE_OAUTH_TOKEN`, then the stored login, with `CLAUDE_SECURESTORAGE_CONFIG_DIR` / `CLAUDE_CONFIG_DIR` or `~/.claude` determining file storage; local macOS can use Keychain. CodeNomad does not substitute one Claude login for the other.

For an expired provider login, refresh/sign in through its owner—OpenCode, Claude Code or Codex CLI—then refresh CodeNomad. CodeNomad does not exchange externally owned refresh tokens. A CodeNomad server-login expiry is separate: reconnect/sign in to CodeNomad without assuming a failed provider request will be resent. See [Troubleshooting](troubleshooting.md).

### Optional usage environment variables {#usage-environment}

Set these in the environment of the **CodeNomad backend process** before launching it. They are usage-reader credentials, not browser settings or model-selection controls. Changing the session **Environment Variables** editor does not update a running backend's `process.env` for these readers. Restart the backend under the intended environment when changing them; do not restart the shared OpenCode service just for a usage-reader variable.

| Usage integration | Environment variable |
| --- | --- |
| Cursor | `CURSOR_ACCESS_TOKEN`, falling back to `CURSOR_TOKEN` |
| Ollama Cloud | `OLLAMA_CLOUD_COOKIE` |
| OpenCode Go supplemental usage | `OPENCODE_GO_WORKSPACE_ID` and `OPENCODE_GO_AUTH_COOKIE` together |
| ZenMux | `ZENMUX_PLATFORM_API_KEY` — platform key, distinct from the inference key |
| exe.dev | `EXE_DEV_USAGE_TOKEN` |
| Command Code | `COMMAND_CODE_API_KEY` fallback when a native credential is unavailable |

Keep tokens/cookies out of shell history, screenshots and reports. Optional readers depend on provider APIs and credential validity; configuring a variable is not a guarantee of usable quota data.

## Web-search default and Project override {#web-search}

1. In **Settings → Providers**, expand **Web search** and connect the search integration with its API key if it needs one.
2. Choose **Default search** for Global configuration.
3. Use **For the current project** to override it for the active Location. Hover or focus that selector to see **Search in this project** with the effective result.

Changes save automatically. **Default / inherited** uses inherited configuration or the saved native choice; a Project override wins over Global. **Disabled** turns search off at the selected scope; **Automatic provider** requests native automatic provider selection. **Web search** loads its connections and choices only while expanded. **Disconnect** removes a saved search key; a connection supplied by an environment variable is labelled read-only and has no **Disconnect**.

Search credentials remain service-global even when the provider choice is Project-scoped. Saving a key does not select it as the search default. If reading/saving fails, refresh before retrying; do not replace configuration blindly. For native configuration details, see [OpenCode documentation](https://opencode.ai/v2/docs/) and [OpenCode setup](opencode.md).
