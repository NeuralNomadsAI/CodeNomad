use crate::{State, settings, strings::t};
use codenomad_client::provider_usage::{Consumption, Usage, Window};
use rune::{El, text};
use rune_theme_codenomad::{TextRole, layout::Layout, provider_usage as chrome};

pub(super) fn usage(usage: &Usage, s: &State) -> El {
    let balance = settings::show_provider_usage_credit_balance(s);
    let windows = || {
        usage
            .windows
            .iter()
            .filter(|(key, _)| key.as_str() != "credits_balance" || balance)
    };
    if let Some((message, link)) = unavailable(usage) {
        return chrome::card(
            [text(message).role("status").wrap()]
                .into_iter()
                .chain(link.map(|(caption, url)| {
                    rune_theme_codenomad::layout::button_tx(
                        t(caption),
                        false,
                        move |_: &mut State, tx| {
                            let _ = tx.open_url(url);
                        },
                    )
                })),
        );
    }
    if !usage.supported
        || !usage.configured
        || !usage.ok
        || usage.console.is_none() && windows().next().is_none()
    {
        return chrome::card([text(t(if !usage.supported {
            "providerUsage.unsupported"
        } else if !usage.configured {
            "providerUsage.notConfigured"
        } else {
            "providerUsage.unavailable"
        }))
        .role("status")
        .wrap()]);
    }
    let mut rows = Vec::new();
    if let Some(console) = &usage.console {
        rows.push(text(t("providerUsage.console.requests")).role("heading"));
        for (range, label) in [
            ("24h", "providerUsage.console.today"),
            ("7d", "providerUsage.console.sevenDays"),
            ("30d", "providerUsage.console.thirtyDays"),
        ] {
            if let Some(count) = console.requests.get(range) {
                rows.push(chrome::reading(t(label), count.to_string(), None));
            }
        }
        rows.push(text(t("providerUsage.console.models")).role("heading"));
        if console.models.is_empty() {
            rows.push(text(t("providerUsage.console.noRequests")).wrap());
        }
        for model in &console.models {
            rows.push(chrome::reading(
                &format!("{} · {}", model.model, model.provider),
                model.requests.to_string(),
                None,
            ));
        }
        if console.budgets.status == "unavailable" || !console.budgets.items.is_empty() {
            rows.push(text(t("providerUsage.console.budgets")).role("heading"));
            if console.budgets.status != "available" {
                rows.push(text(t("providerUsage.console.budgetsUnavailable")).wrap());
            } else {
                for budget in &console.budgets.items {
                    rows.push(chrome::reading(
                        &budget.name,
                        format!("${:.2} / ${:.2}", budget.spent_usd, budget.limit_usd),
                        None,
                    ));
                }
            }
        }
    }
    for (key, window) in windows() {
        let label = window_label(key);
        let meter = window.used_percent.map(|percent| {
            (
                t("providerUsage.progressLabel").replace("{window}", &label),
                percent,
            )
        });
        rows.push(chrome::reading(&label, value(usage, window), meter).key(key));
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
    rows.push(text(name).wrap_anywhere().text_role(TextRole::Button));
    chrome::card(rows)
}

fn value(usage: &Usage, window: &Window) -> String {
    let ratio = |used: String, limit: Option<String>| {
        let value = limit.map_or(used.clone(), |limit| format!("{used} / {limit}"));
        format!("\u{2066}{value}\u{2069}")
    };
    match &window.consumption {
        Some(Consumption::Count { used, limit }) => {
            return t("providerUsage.usedCountOnly").replace(
                "{used}",
                &ratio(used.to_string(), limit.map(|amount| amount.to_string())),
            );
        }
        Some(Consumption::Credits { used }) => {
            return t("providerUsage.creditsUsed").replace("{used}", &used.to_string());
        }
        Some(Consumption::Unlimited { unlimited: true }) => {
            return t("providerUsage.unlimited").into();
        }
        _ => {}
    }
    if let Some(limit) = window.limit_usd {
        return format!("${limit:.2}");
    }
    if let Some(balance) = &window.balance_usd {
        return ratio(
            format!("${:.2}", balance.remaining),
            balance.total.map(|amount| format!("${amount:.2}")),
        );
    }
    if let Some(label) = &window.value_label {
        if let Some(estimate) = &usage.free_estimate
            && let Some(requests) = estimate.requests
        {
            return ratio(requests.to_string(), Some(estimate.reference.to_string()));
        }
        return label.clone();
    }
    window.used_percent.map_or_else(
        || t("providerUsage.unavailableValue").into(),
        |percent| t("providerUsage.usedPercent").replace("{percent}", &percent.round().to_string()),
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
