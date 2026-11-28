use super::{Dashboard, dates};
use crate::strings::{locale, t};
use codenomad_client::settings::stats::{PERIODS, Stats};
use rune::{Cx, El, col, text};
use rune_theme_codenomad::{
    Space, TextRole,
    layout::Layout,
    settings::{self as chrome, stats as style},
    usage::numbers,
};

pub(in crate::settings) fn view<S: 'static>(
    cx: &Cx<S>,
    stats: &Dashboard,
    layers: &mut Vec<El>,
    access: fn(&mut S) -> Option<&mut Dashboard>,
) -> El {
    let mut body = col()
        .full_width()
        .separate(Space::Sm)
        .child(
            text(t("settings.usage.title"))
                .text_role(TextRole::Title)
                .role("heading"),
        )
        .child(style::caption(t("settings.usage.scope")));
    if stats.scope.is_none() {
        return chrome::card(body.child(status("settings.usage.noProject", "status")));
    }
    let days = stats.days.unwrap_or(30);
    let period = t("settings.usage.period");
    let labels = PERIODS.map(|days| {
        t("settings.usage.days").replace("{count}", &numbers::exact(locale(), days.into()))
    });
    let options = labels.each_ref().map(String::as_str);
    let selected = PERIODS
        .iter()
        .position(|&d| d == days)
        .map(|index| options[index]);
    // Rune's web mirror exposes a Kit select as a button, without its current value.
    #[cfg(target_arch = "wasm32")]
    let name = format!("{period} · {}", selected.unwrap_or_default());
    #[cfg(not(target_arch = "wasm32"))]
    let name = period;
    let picker = chrome::stepping_picker("stats-period", name.as_ref(), &options)
        .current(selected)
        .open(stats.picker)
        .on_toggle(move |s| {
            if let Some(stats) = access(s) {
                stats.picker = !stats.picker;
            }
        })
        .on_close(move |s| {
            if let Some(stats) = access(s) {
                stats.picker = false;
            }
        })
        .on_choose(move |s, value, _| {
            if let Some(stats) = access(s)
                && let Some(index) = labels.iter().position(|label| label == value)
            {
                stats.select(PERIODS[index]);
            }
        });
    let refresh = style::refresh(
        t("settings.providers.refresh"),
        stats.busy || !stats.visible,
        move |s, _| {
            if let Some(stats) = access(s).filter(|stats| !stats.busy && stats.visible) {
                stats.invalidate(0.0);
            }
        },
    );
    body = body.child(style::period(
        period,
        chrome::build_picker(picker, layers),
        refresh,
    ));
    if stats.busy && stats.snapshot.is_none() {
        body = body.child(status("settings.usage.loading", "status"));
    }
    if stats.stale && stats.snapshot.is_some() {
        body = body.child(status("settings.usage.cached", "status"));
    }
    if stats.failed {
        let label = t("settings.usage.error");
        body = body.child(chrome::palette::save_error(label).label(label));
    }
    if let Some(snapshot) = &stats.snapshot {
        let hint = t("settings.usage.costHint");
        let help = chrome::info_link(hint, move |s, _| {
            if let Some(stats) = access(s) {
                stats.help = !stats.help;
            }
        })
        .expanded(stats.help);
        body = body.children(contents(
            &snapshot.stats,
            stats.zone.as_deref().unwrap_or("UTC"),
            cx.window_layout_with("stats-metrics", |rect| style::metric_columns(rect[2]))
                .unwrap_or(2),
            help,
            stats.help.then(|| style::caption(hint)),
        ));
    }
    chrome::card(body)
}

fn status(key: &str, role: &'static str) -> El {
    let label = t(key);
    style::caption(label).role(role).label(label)
}

fn contents(
    stats: &Stats,
    timezone: &str,
    columns: usize,
    help: El,
    detail: Option<El>,
) -> [El; 5] {
    let locale = locale();
    let number = |value| numbers::exact(locale, value);
    let money = |value| numbers::dashboard_usd(locale, value);
    let from = dates::date_time(stats.range.from, locale, timezone);
    let to = dates::date_time(stats.range.to, locale, timezone);
    let labels = |key: &str| t(&format!("settings.usage.{key}"));
    let metrics = [
        ("sessions", stats.sessions),
        ("subagents", stats.subagents),
        ("prompts", stats.prompts),
        ("steps", stats.steps),
        ("input", stats.tokens.input),
        ("output", stats.tokens.output),
        ("reasoning", stats.tokens.reasoning),
        ("cacheRead", stats.tokens.cache.read),
        ("cacheWrite", stats.tokens.cache.write),
        ("activeDays", stats.active_days),
        ("streak", stats.streak),
    ]
    .map(|(key, value)| style::metric(labels(key), number(value), None, None));
    let cost = style::metric(labels("cost"), money(stats.cost), Some(help), detail);
    let header = ["model", "steps", "input", "output", "cost"].map(|key| labels(key).to_owned());
    let models = stats.models.iter().map(|m| {
        let mut name = format!("{}/{}", m.model.provider, m.model.id);
        if let Some(variant) = &m.model.variant {
            name.push_str(" · ");
            name.push_str(variant);
        }
        style::model_row(
            [
                name,
                number(m.steps),
                number(m.tokens.input),
                number(m.tokens.output),
                money(m.cost),
            ],
            false,
        )
    });
    let max = stats
        .activity
        .iter()
        .map(|day| day.steps)
        .max()
        .unwrap_or(0)
        .max(1);
    let activity = stats.activity.iter().map(|day| {
        let steps = number(day.steps);
        let name = format!("{} · {}: {steps}", day.date, labels("steps"));
        style::activity(&day.date, steps, day.steps as f32 / max as f32, name)
    });
    [
        style::caption(format!("{from} – {to} · {timezone}")),
        style::metrics(columns, metrics.into_iter().chain([cost])),
        style::heading(labels("models")),
        col()
            .full_width()
            .role("table")
            .label(labels("models"))
            .child(style::model_row(header, true))
            .children(models),
        col()
            .full_width()
            .separate(Space::Xs)
            .child(style::heading(labels("activity")))
            .children(activity),
    ]
}
