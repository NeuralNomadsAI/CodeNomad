use crate::{
    Message, State,
    content::{Part, Usage},
    screen,
    strings::t,
};
use rune::El;
use rune_theme_codenomad::usage as theme;
use rune_theme_codenomad::{
    Space,
    layout::{self, Layout},
};
pub(crate) mod family;

fn non_blank(text: &str) -> bool {
    !text
        .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .is_empty()
}

fn text_part(part: &Part) -> bool {
    matches!(part, Part::Text(text) if non_blank(&text.text))
}

fn boundary(part: &Part) -> bool {
    text_part(part)
        || matches!(part, Part::File(file) if file.name.as_deref().is_some_and(|name| !name.is_empty()))
}

pub(super) fn last_text(row: &Message) -> Option<usize> {
    (row.role == "assistant" && row.usage.is_some())
        .then(|| row.parts.iter().rposition(text_part))
        .flatten()
}

fn response_total(s: &State, index: usize, final_text: usize) -> Option<Usage> {
    let row = s.messages.get(index)?;
    let mut usage = row.usage?;
    for (i, row) in s.messages[..=index].iter().enumerate().rev() {
        if row.role == "user" {
            break;
        }
        if i != index && row.role == "assistant" && row.parts.is_empty() && non_blank(&row.body) {
            break;
        }
        let (head, tail) = super::transcript::part_window(
            row.parts.len(),
            s.transcript_display.steps(&format!("parts-gap-{}", row.id)),
        );
        let mut end = if i == index {
            final_text.min(row.parts.len())
        } else {
            row.parts.len()
        };
        // Solid starts technical cleanup from the first part of the content block containing
        // the final text fragment, so consecutive text/file parts stay inside one answer block.
        if i == index {
            while end > 0
                && !(head..tail).contains(&(end - 1))
                && !matches!(row.parts[end - 1], Part::Tool(_) | Part::Reasoning(_))
            {
                end -= 1;
            }
        }
        let mut technical = false;
        let mut stop = false;
        for (at, part) in row.parts[..end].iter().enumerate().rev() {
            if (head..tail).contains(&at) || boundary(part) {
                stop = true;
                break;
            }
            technical |= matches!(part, Part::Tool(_) | Part::Reasoning(_));
        }
        if technical
            && i != index
            && let Some(previous) = row.usage
        {
            usage = usage.plus(previous);
        }
        if stop {
            break;
        }
    }
    Some(usage)
}

pub(super) fn message(s: &State, index: usize, final_text: usize) -> Option<El> {
    let visibility = crate::settings::message_usage_visibility(s);
    if visibility == "hidden" {
        return None;
    }
    let usage = response_total(s, index, final_text)?;
    let key = format!("message-usage-{}", s.messages[index].id);
    Some(disclosure(
        s,
        key,
        usage,
        false,
        visibility == "expanded",
        false,
    ))
}

pub(crate) fn session(s: &State) -> Option<El> {
    let agent = s.agent.as_ref()?;
    let mut usage = agent.usage?;
    let included = agent.current.as_ref().is_some_and(|model| {
        model["providerID"]
            .as_str()
            .zip(model["id"].as_str())
            .is_some_and(|(provider, id)| agent.includes_cost(provider, id))
    });
    if included {
        usage.cost = 0.0;
    }
    let mut panel = rune::col()
        .full_width()
        .separate(Space::Sm)
        .child(disclosure(
            s,
            family::KEY.into(),
            usage,
            true,
            false,
            included,
        ));
    let totals = &s.transcript_display.usage_family;
    if !s.transcript_display.toggled(family::KEY) {
        return Some(panel);
    }
    if let Some((total, complete)) =
        totals.including(usage, |provider, id| agent.includes_cost(provider, id))
    {
        if !complete {
            panel = panel.child(rune::text(t("contextUsagePanel.partialTotal")).role("status"));
        }
        let tokens = [
            counter(t("contextUsagePanel.labels.totalInput"), total.input),
            counter(t("contextUsagePanel.labels.totalOutput"), total.output),
            money(t("contextUsagePanel.labels.totalCost"), total.cost, true),
            counter(
                t("contextUsagePanel.labels.totalReasoning"),
                total.reasoning,
            ),
        ];
        panel = panel.child(
            rune_theme_codenomad::layout::action_row()
                .key("status-thread-usage")
                .children(
                    tokens
                        .into_iter()
                        .map(|(name, value, full)| theme::metric(name, &value, &full)),
                ),
        );
    }
    if totals.loading() {
        panel = panel.child(rune::text(t("rune.loading")).role("status"));
    } else if totals.failed {
        panel = panel.child(
            layout::action_row()
                .child(rune::text(t("contextUsagePanel.totalUnavailable")).role("status"))
                .child(layout::button(
                    t("sessionList.loadError.retry"),
                    false,
                    screen::action(&s.input_scope, |s| {
                        s.transcript_display.usage_family.refresh()
                    }),
                )),
        );
    }
    Some(panel)
}

fn disclosure(
    s: &State,
    key: String,
    usage: Usage,
    session: bool,
    open: bool,
    included: bool,
) -> El {
    let expanded = if session {
        s.transcript_display.toggled(&key)
    } else {
        s.transcript_display.expanded(&key, open)
    };
    let toggle = key.clone();
    let mut entries = vec![
        token("input", usage.input, session),
        token("output", usage.output, session),
    ];
    if expanded {
        entries.push(token("reasoning", usage.reasoning, session));
        if !session {
            entries.push(token("cacheRead", usage.cache_read, false));
            entries.push(token("cacheWrite", usage.cache_write, false));
        }
    }
    let cost_label = t(if session {
        "contextUsagePanel.labels.cost"
    } else {
        "messageBlock.usage.cost"
    });
    entries.push(if included {
        let value = t("contextUsagePanel.included");
        (cost_label, value.into(), value.into())
    } else {
        money(cost_label, usage.cost, session)
    });
    let label = t(if expanded {
        "messageBlock.usage.collapseAriaLabel"
    } else {
        "messageBlock.usage.expandAriaLabel"
    });
    let title = session.then(|| t("instanceShell.rightPanel.sections.tokens"));
    let detail = entries
        .iter()
        .map(|(label, _, full)| format!("{label}: {full}"))
        .collect::<Vec<_>>()
        .join(", ");
    let accessible = if let Some(title) = title {
        format!("{title}. {label}. {detail}")
    } else {
        format!("{label}. {detail}")
    };
    let metrics: Vec<_> = entries
        .iter()
        .map(|(label, value, full)| theme::Metric { label, value, full })
        .collect();
    theme::disclosure(
        &key,
        &accessible,
        title,
        expanded,
        &metrics,
        screen::action(&s.input_scope, move |s| {
            if session {
                super::actions::Display::toggle(s, &toggle);
            } else {
                super::actions::Display::set_expanded(s, &toggle, !expanded);
            }
        }),
    )
}

fn token(kind: &str, count: u64, session: bool) -> (&'static str, String, String) {
    let prefix = if session && kind != "reasoning" {
        "contextUsagePanel.labels"
    } else {
        "messageBlock.usage"
    };
    counter(t(&format!("{prefix}.{kind}")), count)
}

fn money(label: &'static str, cost: f64, session: bool) -> (&'static str, String, String) {
    let value = theme::numbers::usd(crate::strings::locale(), cost, !session);
    (label, value.clone(), value)
}

fn counter(label: &'static str, count: u64) -> (&'static str, String, String) {
    let locale = crate::strings::locale();
    (
        label,
        theme::numbers::compact(locale, count),
        theme::numbers::exact(locale, count),
    )
}

#[cfg(test)]
mod tests;
