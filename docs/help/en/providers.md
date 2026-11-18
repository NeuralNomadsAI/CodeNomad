# Providers and accounts

Provider authentication belongs to the connected OpenCode service, not to the browser device or one CodeNomad project. Model-display preferences, subscription quotas and web-search choices have different scopes.

## Connect a model or search provider {#connect}

1. Open a workspace, then **Settings → Providers**. **Models** starts expanded; expand **Web search** for search providers. **Images** holds the image settings.
2. In that group, choose **Select provider**, then **Connect**. For a model provider already listed below, use **Add account** (+) in its row, including for its first connection.
3. For a model provider, complete the native **Authentication method** offered: API key, OAuth or command. For OAuth, use **Open authorization page** and submit an authorization code only when requested. Search providers connect with an API key.
4. Check the configured-provider row after completion.

Search-only integrations appear under **Web search**, not **Models**. Saving authentication does not choose a model or change the default search provider. API keys and OAuth credentials are saved by the active OpenCode server. The browser receives connection metadata, not saved credential secrets. A connection sourced from environment variables is read-only in this UI: change its owning environment rather than trying to disconnect it here.

Do not publish the authorization link or code in diagnostics.

## Select and manage accounts {#accounts}

1. In the provider's row, use **Active account** to select a saved credential.
2. Use **Add account** to authenticate another connection.
3. To manage a different saved account, select it first, then use **Rename account** or **Remove account**. Renaming uses **Account label** and **Save**; **Remove account** acts immediately, without a confirmation.

Selection, renaming and removal affect that integration across the OpenCode service, including other projects and clients. Removing a credential can leave those clients without authentication; it does not delete conversation history or revoke the provider's remote account. Environment connections cannot be selected as writable saved credentials or removed here.

### Automatic selection limits {#automatic-selection}

With multiple saved credentials on a supported integration, **Auto-select account** opts into quota-based selection before the next prompt/custom-command admission through CodeNomad. The setting is per integration in CodeNomad configuration; a resulting account selection is service-wide.

| Eligible integration | Eligible account type |
| --- | --- |
| OpenAI / Codex | Codex browser/device OAuth subscription accounts, not OpenAI pay-as-you-go keys or the ChatGPT sign-in method whose usage OpenAI does not provide. |
| OpenCode Go | Go key, or OpenCode Console sign-in/key used for the **Go provider only**; paid Console models stay manual. |
| Anthropic | OpenCode's Claude Pro/Max OAuth login, **not** the Claude Code login. |
| GitHub Copilot | OAuth with readable premium-request quota; enterprise-endpoint credentials are not readable candidates. |
| Coding plans | Key-based `zai-coding-plan`, `zhipuai-coding-plan`, `kimi-for-coding`, `minimax-coding-plan`, `minimax-cn-coding-plan`. |

Only a full current account triggers switching; merely having a fuller alternative does not. Codex, Copilot and coding plans require a demonstrably available candidate. Go, Console and Claude may use an unknown-quota candidate unless a recent native quota failure marks it exhausted.

This is **not in-flight failover**. It neither retries failed requests nor replays prompts, commands or mutations. It does not rotate environment connections, arbitrary providers, pay-as-you-go balances or external Claude Code logins.

## Model visibility, favorites and Thinking {#models}

1. Choose **Manage models** beside a model provider.
2. Search by name/ID and change visibility; **Show all** and **Hide all** affect that provider's selector list. Drag across the checkboxes to change several models at once.
3. In a conversation's **Model** selector, use **Add to favorites** or **Remove from favorites**; **Show all models** leaves favorites-only filtering.
4. Use **Thinking** in the composer for variants the selected model exposes.

Visibility and favorites organize CodeNomad's selectors; they do not uninstall models, remove credentials or prevent other OpenCode clients from using them. Thinking selects a model variant for subsequent sends, not the visibility of reasoning already in the transcript. Restore hidden models with **Manage models → Show all**.

## Usage, token counts and expired logins {#usage}

Use **Usage** in the right panel for the active conversation's provider-plan windows, reset times and supported balances. These provider readings are different from per-message **Tokens** and cost estimates: a subscription quota is not a bill calculated from the visible transcript. A missing, stale or unknown reading is not zero usage or proof of remaining capacity. **Provider credit balance** in **Settings → Advanced** controls supplemental balance display.

Google's [Antigravity FAQ](https://antigravity.google/docs/faq/) states that using third-party software with an Antigravity login violates its terms and may lead to account suspension or termination.

For paid models on the `opencode` integration, **OpenCode Console** shows **Requests** for **24 hours**, **7 days** and **30 days**, as reported by Console. **Requests by model · 30 days** lists each model with its provider. Counts follow the connected Console account and use your app language's number formatting. **Service account budgets** shows **Budgets unavailable.** With **Provider credit balance** enabled, the Console credit balance appears as **Credits**. OpenCode Go uses its own quota reader.

Repair an invalid or expired Console OAuth connection through its owner, even when an API key is also saved.

For a Console connection error (401 or 403), check the login, its organization ID and its **Usage › Read** permission in **Settings → Providers**, then refresh **Usage**. OAuth requires `https://opencode.ai/console`.

For free OpenCode models (`big-pickle` and model IDs ending in `-free`), **Usage** shows one bar: the connected Console account's free-model requests over Console's last 24 hours, against a reference of **800**; actual limits may vary. The counter includes other clients using that account and has no reset time. With **Provider credit balance** enabled, the Console credit balance appears as **Credits**. Connect OpenCode Console through **Settings → Providers** to track free-model requests.

Free usage and paid Console counters are display-only; automatic account selection uses its separate quota readers and rules.

OpenAI does not provide usage for one ChatGPT sign-in method: Usage says so instead of showing quota windows. Choose [View ChatGPT usage](https://chatgpt.com/settings/usage) to review app usage and manage access to your plan and credits in ChatGPT.

Claude through `anthropic`/`claude` uses OpenCode's Anthropic OAuth. OpenCode's **Claude Agent** provider (`claude-agent`) and the `claude-code` provider use the Claude Code login on the daemon's host, including its WSL distribution: `CLAUDE_CODE_OAUTH_TOKEN`, then the stored login, with `CLAUDE_SECURESTORAGE_CONFIG_DIR` / `CLAUDE_CONFIG_DIR` or `~/.claude` determining file storage; local macOS can use Keychain.

OpenRouter **Key Limit** shows the key's remaining USD allowance against its spending limit; a key without a spending limit has no such row. Usage uses the provider's configured `baseURL`, including its path prefix, or `https://openrouter.ai/api/v1` when absent. Use a public HTTPS hostname without credentials, an explicit port, query or fragment; IP addresses and localhost are rejected. An invalid URL or a gateway without `/key` makes usage unavailable; the key stays at the configured destination and redirects are rejected.

GitHub Copilot **Usage** shows consumed allowance as **used / limit used**, or consumed credits for an unlimited pool when GitHub supplies them; otherwise it shows **Unlimited**. Enterprise connections use `https://api.<host>/copilot_internal/user` from the saved connection's host or HTTPS root URL. Use a qualified hostname without credentials, an explicit port (even `:443`), a path beyond `/`, query or fragment; IP addresses and localhost are rejected before sending the token. Redirects are rejected. Enterprise connections stay outside automatic account selection.

Kimi supports `kimi-code-plan-cn`, `kimi-code-plan-global`, `kimi-for-coding` and `kimi`. It shows available five-hour, weekly, **Monthly** and **Monthly coding** caps as percentages used.

Monthly caps follow the provider's reset date; a `kimi-for-coding` account with either monthly cap exhausted is unavailable for automatic selection even when a shorter window has capacity.

OpenCode Go API keys show the available used percentages and reset times. OpenCode Console sign-in also reads the wallet balance in USD when billing access permits it. Enable **Provider credit balance** to show that separate balance (off by default); Go quotas and Extra Usage remain separate. A wallet balance alone leaves automatic selection's quota unknown.

For **Usage is temporarily unavailable.** or **Cannot reach OpenCode Console.**, check the network connection and refresh **Usage**.

For an expired OpenCode Go key, create a replacement in [OpenCode Console](https://opencode.ai/console/login) under **Account → Personal API keys**, then replace the saved key through the provider connection flow.

### Optional usage environment variables {#usage-environment}

Supply a current Cursor access token through the variables below. Enterprise reads require permission to read that team's dashboard data; the [Admin API](https://cursor.com/docs/account/teams/admin-api) uses a separate administrative key. Update an expired token and restart the backend with the updated environment.

Set these in the environment of the **CodeNomad backend process** before launching it. Changing the session **Environment Variables** editor does not update a running backend's `process.env` for these readers. Restart the backend under the intended environment when changing them; do not restart the shared OpenCode service just for a usage-reader variable.

| Usage integration | Environment variable |
| --- | --- |
| Cursor | `CURSOR_ACCESS_TOKEN`, falling back to `CURSOR_TOKEN` |
| Ollama Cloud | `OLLAMA_CLOUD_COOKIE` |
| OpenCode Go supplemental usage | `OPENCODE_GO_WORKSPACE_ID` and `OPENCODE_GO_AUTH_COOKIE` together |
| ZenMux | `ZENMUX_PLATFORM_API_KEY` — platform key, distinct from the inference key |
| exe.dev | `EXE_DEV_USAGE_TOKEN` |
| Command Code | `COMMAND_CODE_API_KEY` fallback when a native credential is unavailable |

Keep tokens/cookies out of shell history, screenshots and reports.

## Web-search default and Project override {#web-search}

1. In **Settings → Providers**, expand **Web search** and connect the search integration with its API key if it needs one.
2. Choose **Default search** for Global configuration.
3. Use **For the current project** to override it for the active Location. Hover or focus that selector to see **Search in this project** with the effective result.

Changes save automatically. **Default / inherited** uses inherited configuration or the saved native choice; a Project override wins over Global. **Disabled** turns search off at the selected scope; **Automatic provider** requests native automatic provider selection. **Disconnect** removes a saved search key; a connection supplied by an environment variable is labelled read-only and has no **Disconnect**.

Search credentials remain service-global even when the provider choice is Project-scoped. Saving a key does not select it as the search default. For native configuration details, see [OpenCode documentation](https://opencode.ai/v2/docs/) and [OpenCode setup](opencode.md).

## Image generation and storage {#images}

1. In **Settings → Providers**, expand **Images**.
2. **Image generation** is **On, automatic model** unless you change it: choose one of the image models offered by your connected providers instead, or **Off** to turn it off in the Global configuration.
3. Check **Store images once** to keep each attached or generated image a single time instead of inside every message that uses it.

Changes save automatically to the Global OpenCode configuration and apply to every project. Both are experimental OpenCode features: **Images** shows only the settings the connected OpenCode version supports. Agents get the image tool only while a connected provider offers an image model. **Store images once** applies to new messages. If the project's own OpenCode configuration file decides **Store images once**, the box shows the value used there and saving also writes it to that file. If saving would hide other OpenCode settings, **Images** stays read-only; change the options in the configuration file named in the warning's tooltip.

To create, compare and refine images in a dedicated conversation, see [Create images with the Design extension](extensions.md#design).
