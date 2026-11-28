use super::date::reset;
use crate::{
    State, screen, settings,
    strings::{locale, t},
};
use codenomad_client::provider_usage::{Consumption, Usage, Window};
use rune::{El, text};
use rune_theme_codenomad::{
    TextRole, git_panel, layout::Layout, provider_usage as chrome, settings as theme_settings,
    shell, usage::numbers,
};

pub(super) fn usage(usage: &Usage, s: &State) -> El {
    let balance = settings::show_provider_usage_credit_balance(s);
    let windows = || {
        usage
            .windows
            .iter()
            .filter(|(key, _)| key.as_str() != "credits_balance" || balance)
    };
    if let Some((message, link)) = unavailable(usage) {
        let configure = matches!(
            usage.unavailable_reason.as_deref(),
            Some(
                "opencode-console-missing-credential"
                    | "opencode-console-access-denied"
                    | "opencode-console-invalid-credential"
            )
        );
        return chrome::card(
            [theme_settings::stats::caption(message)
                .role("status")
                .key("status-usage-unavailable")]
            .into_iter()
            .chain(link.map(|(caption, url)| chrome::external_link(t(caption), url)))
            .chain(configure.then(|| {
                rune_theme_codenomad::layout::button(
                    t("providerUsage.console.settings"),
                    false,
                    screen::action(&s.input_scope, settings::open_providers),
                )
            })),
        )
        .key("status-usage-card");
    }
    if !usage.supported
        || !usage.configured
        || !usage.ok
        || usage.console.is_none() && windows().next().is_none()
    {
        return git_panel::note(
            t(if !usage.supported {
                "providerUsage.unsupported"
            } else if !usage.configured {
                "providerUsage.notConfigured"
            } else {
                "providerUsage.unavailable"
            }),
            "status",
        )
        .key("status-usage-empty");
    }
    let mut rows = Vec::new();
    if let Some(console) = &usage.console {
        let requests_label = t("providerUsage.console.requests");
        let requests_info = theme_settings::info_tip(
            requests_label,
            t("providerUsage.console.info"),
            s.status_usage.console_info_open,
            screen::action(&s.input_scope, |s| {
                s.status_usage.console_info_open = !s.status_usage.console_info_open;
            }),
        )
        .key("status-usage-console-info");
        rows.push(shell::service_heading_row(requests_label, [requests_info]));
        for (range, label) in [
            ("24h", "providerUsage.console.today"),
            ("7d", "providerUsage.console.sevenDays"),
            ("30d", "providerUsage.console.thirtyDays"),
        ] {
            if let Some(count) = console.requests.get(range) {
                rows.push(chrome::reading(
                    t(label),
                    numbers::exact(locale(), *count),
                    None,
                    None,
                ));
            }
        }
        rows.push(shell::panel_title(t("providerUsage.console.models")).role("heading"));
        if console.models.is_empty() {
            rows.push(
                theme_settings::stats::caption(t("providerUsage.console.noRequests"))
                    .role("status"),
            );
        }
        for model in &console.models {
            let label = format!("{} · {}", model.model, model.provider);
            let count = numbers::exact(locale(), model.requests);
            let tip = format!("{label} — {count}");
            rows.push(chrome::reading(&label, count, None, None).help(tip));
        }
        if console.budgets.status == "unavailable" || !console.budgets.items.is_empty() {
            rows.push(shell::panel_title(t("providerUsage.console.budgets")).role("heading"));
            if console.budgets.status != "available" {
                rows.push(
                    theme_settings::stats::caption(t("providerUsage.console.budgetsUnavailable"))
                        .role("status"),
                );
            } else {
                for budget in &console.budgets.items {
                    let amount = ratio(money(budget.spent_usd), Some(money(budget.limit_usd)));
                    let resets = reset(Some(budget.reset_at));
                    let tip = reading_help(&budget.name, &amount, resets.as_deref());
                    rows.push(chrome::reading(&budget.name, amount, resets, None).help(tip));
                }
            }
        }
    }
    for (key, window) in windows() {
        let label = window_label(key);
        let displayed = value(usage, window);
        let resets = reset(window.reset_at);
        let tip = reading_help(&label, &displayed, resets.as_deref());
        let meter = window.used_percent.map(|percent| {
            (
                t("providerUsage.progressLabel").replace("{window}", &label),
                percent,
            )
        });
        rows.push(
            chrome::reading(&label, displayed, resets, meter)
                .help(tip)
                .key(key),
        );
    }
    let mut name = usage.provider_name.clone();
    if let Some(
        plan @ ("business" | "enterprise" | "free" | "max" | "pro" | "proPlus" | "student"),
    ) = usage.copilot_plan.as_deref()
    {
        name = format!(
            "{name} · {}",
            t(&format!("providerUsage.copilotPlans.{plan}"))
        );
    }
    rows.push(
        text(&name)
            .wrap_anywhere()
            .text_role(TextRole::Button)
            .help(&name)
            .key("status-usage-provider"),
    );
    chrome::card(rows).key("status-usage-card")
}

fn reading_help(label: &str, value: &str, reset: Option<&str>) -> String {
    match reset {
        Some(reset) => format!("{label}: {value} · {reset}"),
        None => format!("{label}: {value}"),
    }
}

fn money(amount: f64) -> String {
    numbers::usd(locale(), amount, false)
}

fn ratio(used: String, limit: Option<String>) -> String {
    match limit {
        Some(limit) => format!("\u{2066}{used} / {limit}\u{2069}"),
        None => format!("\u{2066}{used}\u{2069}"),
    }
}

fn value(usage: &Usage, window: &Window) -> String {
    let decimal = |amount| numbers::decimal(locale(), amount);
    match &window.consumption {
        Some(Consumption::Count { used, limit }) => {
            return t("providerUsage.usedCountOnly")
                .replace("{used}", &ratio(decimal(*used), limit.map(decimal)));
        }
        Some(Consumption::Credits { used }) => {
            return t("providerUsage.creditsUsed").replace("{used}", &ratio(decimal(*used), None));
        }
        Some(Consumption::Unlimited { unlimited: true }) => {
            return t("providerUsage.unlimited").into();
        }
        _ => {}
    }
    if let Some(limit) = window.limit_usd {
        return ratio(money(limit), None);
    }
    if let Some(balance) = &window.balance_usd {
        return ratio(money(balance.remaining), balance.total.map(money));
    }
    if let Some(label) = &window.value_label {
        if let Some(estimate) = &usage.free_estimate
            && let Some(requests) = estimate.requests
        {
            return ratio(
                numbers::exact(locale(), requests),
                Some(numbers::exact(locale(), estimate.reference)),
            );
        }
        // Like Solid, an opaque provider label is displayed without reparsing it as money.
        return ratio(label.clone(), None);
    }
    window.used_percent.map_or_else(
        || t("providerUsage.unavailableValue").into(),
        |percent| t("providerUsage.usedPercent").replace("{percent}", &decimal(percent.round())),
    )
}

fn window_label(key: &str) -> String {
    if let Some((window, scope)) = key.split_once(':') {
        return format!("{} · {scope}", window_label(window));
    }
    let suffix = match key {
        "5h" => "fiveHours",
        "7d" => "sevenDays",
        "7d-sonnet" => "sevenDaysSonnet",
        "7d-opus" => "sevenDaysOpus",
        "input_tokens" => "inputTokens",
        "output_tokens" => "outputTokens",
        "monthly-code" => "monthlyCode",
        "key_limit" => "keyLimit",
        "per_user_limit" => "perUserLimit",
        "team_limit" => "teamLimit",
        "credits_balance" => "credits",
        "billing_cycle" => "billingCycle",
        "mcp-tools" => "mcpTools",
        "weekly" | "daily" | "monthly" | "tokens" | "usage" | "credits" | "requests"
        | "session" | "premium" | "chat" | "completions" => key,
        _ => return key.into(),
    };
    t(&format!("providerUsage.windows.{suffix}")).into()
}

type Link = (&'static str, &'static str);

fn unavailable(usage: &Usage) -> Option<(String, Option<Link>)> {
    let reason = usage.unavailable_reason.as_deref()?;
    let key = match reason {
        "openai-token-sharing-unsupported" => "openaiTokenSharingUnsupported",
        "opencode-go-key-expired" => "openCodeGoKeyExpired",
        "minimax-limits-not-shared" => "minimaxLimitsNotShared",
        "invalid-base-url" => "invalidBaseURL",
        "cursor-token-expired" => "cursorTokenExpired",
        "cursor-team-unavailable" => "cursorTeamUnavailable",
        "cursor-access-denied" => "cursorAccessDenied",
        "cursor-usage-unavailable" => "cursorUsageUnavailable",
        "opencode-console-missing-credential" => "console.missingCredential",
        "opencode-console-access-denied" => "console.accessDenied",
        "opencode-console-invalid-credential" => "console.invalidCredential",
        "opencode-console-invalid-response" => "console.malformed",
        "opencode-console-network-error" => "console.network",
        "provider-error" => {
            let message = usage
                .provider_error_code
                .as_deref()
                .filter(|code| {
                    (1..=8).contains(&code.len()) && code.bytes().all(|byte| byte.is_ascii_digit())
                })
                .map_or_else(
                    || t("providerUsage.unavailable").into(),
                    |code| t("providerUsage.providerErrorCode").replace("{code}", code),
                );
            return Some((message, None));
        }
        _ => return None,
    };
    let link = match (reason, usage.unavailable_action.as_deref()) {
        ("openai-token-sharing-unsupported", Some("chatgpt-usage")) => Some((
            "providerUsage.viewChatGPTUsage",
            "https://chatgpt.com/settings/usage",
        )),
        ("opencode-go-key-expired", Some("opencode-go-new-key")) => Some((
            "providerUsage.createOpenCodeGoKey",
            "https://opencode.ai/console/login",
        )),
        _ => None,
    };
    Some((t(&format!("providerUsage.{key}")).into(), link))
}
