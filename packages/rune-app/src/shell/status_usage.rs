use crate::{State, backend::Backend, platform, screen, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    provider_usage::{Usage, Watch},
};
use rune::{El, Tx};
use rune_theme_codenomad::{git_panel, settings};

pub(crate) mod date;
mod view;

#[derive(Default)]
pub(crate) struct Panel {
    backend: Option<Backend>,
    model: Option<(String, String, String)>,
    expanded: bool,
    pub(super) console_info_open: bool,
    watch: Option<Watch>,
    authority: (u64, bool, u64),
    due: Option<f64>,
    scheduled_wake: Option<f64>,
    trailing: bool,
    read: Option<(Sender<()>, Receiver<Option<Usage>>)>,
    usage: Option<Usage>,
    failed: bool,
}

impl Panel {
    pub(crate) fn attach(&mut self) {
        *self = Self {
            expanded: self.expanded,
            ..Self::default()
        };
    }

    pub(crate) fn bind(&mut self, backend: &Backend) {
        self.attach();
        self.backend = backend
            .client
            .supports("provider-usage")
            .then(|| backend.clone());
    }

    pub(crate) fn invalidate(&mut self) {
        self.read = None;
        self.usage = None;
        self.failed = false;
        self.due = None;
        self.scheduled_wake = None;
        self.trailing = false;
        self.console_info_open = false;
    }

    pub(crate) fn watch(&mut self, watch: Watch) {
        self.disconnect();
        self.watch = Some(watch);
    }

    pub(crate) fn disconnect(&mut self) {
        self.watch = None;
        self.authority = (0, false, 0);
        self.invalidate();
    }

    fn sync_authority(&mut self) -> bool {
        self.observe_authority(self.watch.as_ref().map_or((0, false, 0), Watch::current))
    }

    fn observe_authority(&mut self, authority: (u64, bool, u64)) -> bool {
        if authority == self.authority {
            return false;
        }
        self.authority = authority;
        self.invalidate();
        true
    }

    pub(crate) fn refresh(&mut self, directory: Option<&str>) {
        if self.model.as_ref().is_some_and(|(active, _, _)| {
            directory.is_none_or(|directory| codenomad_client::same_server_path(directory, active))
        }) {
            if self.read.is_some() {
                self.trailing = true;
            } else {
                self.due = None;
                self.scheduled_wake = None;
            }
        }
    }

    fn select(&mut self, model: Option<(&str, &str, &str)>) -> bool {
        if self.model.as_ref().map(|(directory, provider, model)| {
            (directory.as_str(), provider.as_str(), model.as_str())
        }) != model
        {
            self.invalidate();
            self.model = model.map(|(directory, provider, model)| {
                (directory.to_owned(), provider.to_owned(), model.to_owned())
            });
            return true;
        }
        false
    }

    fn poll(&mut self, now: f64, tx: &mut Tx, wake: &rune::Waker) -> bool {
        let (Some(backend), Some((_, provider, model))) = (&self.backend, &self.model) else {
            return false;
        };
        let Some(watch) = self.watch.clone().filter(|_| self.authority.1) else {
            return false;
        };
        if self.read.is_some() {
            return watch
                .publish_if_current(self.authority, || {
                    let Some((_, reply)) = &self.read else {
                        return false;
                    };
                    let result = match reply.try_recv() {
                        Ok(result) => result,
                        Err(codenomad_client::TryRecvError::Empty) => return false,
                        Err(codenomad_client::TryRecvError::Closed) => None,
                    };
                    self.read = None;
                    self.failed = result.is_none();
                    self.usage = result;
                    self.due = if std::mem::take(&mut self.trailing) {
                        self.scheduled_wake = None;
                        tx.wake_at(now);
                        None
                    } else {
                        let due = now + 60.0;
                        self.scheduled_wake = Some(due);
                        tx.wake_at(due);
                        Some(due)
                    };
                    true
                })
                .unwrap_or_else(|| self.sync_authority());
        }
        if watch.backpressured() {
            return false;
        }
        if let Some(due) = self.due
            && due > now
        {
            if self.scheduled_wake != Some(due) {
                self.scheduled_wake = Some(due);
                tx.wake_at(due);
            }
            return false;
        }
        self.due = None;
        self.scheduled_wake = None;
        let (close, cancelled) = bounded(1);
        let (out, reply) = bounded(1);
        self.read = Some((close, reply));
        let (wake, backend, provider, model) = (
            wake.clone(),
            backend.clone(),
            provider.clone(),
            model.clone(),
        );
        platform::spawn(async move {
            if let Some(result) =
                platform::reads::cancellable(&cancelled, backend.provider_usage(&provider, &model))
                    .await
            {
                let _ = out.try_send(result.ok());
                wake();
            }
        });
        true
    }
}

pub(crate) fn poll(s: &mut State, now: f64, tx: &mut Tx) -> bool {
    let changed = s.status_usage.sync_authority();
    let generation = s.status_usage.authority.2;
    let active = s.status_usage.expanded
        && s.status_usage.backend.is_some()
        && !s.screen.is_launcher()
        && s.shell.visible(1)
        && crate::workspace::right_panel_tab(s) == crate::workspace::RightPanelTab::Status;
    let model = (active && s.status_usage.authority.1)
        .then(|| {
            let agent = s.agent.as_mut()?;
            agent.refresh_usage_model(generation);
            let (directory, model) = agent.usage_model(generation)?;
            let provider = model["providerID"].as_str()?.trim();
            (!provider.is_empty()).then_some((
                directory,
                provider,
                model["id"].as_str().unwrap_or_default().trim(),
            ))
        })
        .flatten();
    changed | s.status_usage.select(model) | s.status_usage.poll(now, tx, &s.wake)
}

pub(super) fn section(s: &State) -> Option<El> {
    let panel = &s.status_usage;
    let no_session = s.screen.is_launcher();
    if panel.backend.is_none()
        && !(no_session
            && s.screen
                .launcher()
                .and_then(|l| l.connection.as_ref())
                .is_some_and(|backend| backend.client.supports("provider-usage")))
    {
        return None;
    }
    let body = if let Some(usage) = &panel.usage {
        view::usage(usage, s)
    } else {
        let key = if no_session {
            "providerUsage.noSession"
        } else if !panel.authority.1 || panel.failed {
            "providerUsage.unavailable"
        } else {
            "providerUsage.loading"
        };
        git_panel::note(t(key), "status").key("status-usage-empty")
    };
    Some(
        settings::disclosure(
            t("providerUsage.title"),
            panel.expanded,
            body,
            screen::action(&s.input_scope, |s| {
                s.status_usage.expanded = !s.status_usage.expanded;
                s.status_usage.console_info_open = false;
            }),
        )
        .key("status-provider-usage"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn usage_reads_the_attached_backend_and_encodes_the_selected_model() {
        use crate::files::test_http::{Http, wait};
        use serde_json::json;

        platform::block_on(async {
            let mut http = Http::new().await;
            http.backend.session = "ses_quota".into();
            let backend = http.backend.clone();
            let read =
                tokio::spawn(
                    async move { backend.provider_usage("google", "models/example").await },
                );
            let request = http.accept().await;
            assert!(request.header.starts_with(
                "GET /api/usage/google?instanceId=owned&sessionId=ses_quota&modelId=models%2Fexample HTTP/"
            ), "{}", request.header);
            request
                .reply(
                    200,
                    json!({
                        "requestedProviderId":"google", "modelId":"models/example",
                        "providerName":"Fixture", "configured":true, "supported":true, "ok":true,
                        "windows":{"requests:example":{"usedPercent":64,"resetAt":1800000000000.0}}
                    }),
                )
                .await;
            let usage = wait(read).await.unwrap().unwrap();
            assert_eq!(usage.windows["requests:example"].used_percent, Some(64.0));
            assert_eq!(
                usage.windows["requests:example"].reset_at,
                Some(1800000000000.0)
            );

            let backend = http.backend.clone();
            let read =
                tokio::spawn(async move { backend.provider_usage("opencode-console", "").await });
            let request = http.accept().await;
            let name = "用".repeat(256);
            let usage = json!({
                "requestedProviderId":"opencode-console", "providerName":"Console",
                "supported":true, "configured":true, "ok":true, "windows":{},
                "console":{
                    "requests":{"30d":1000},
                    "models":vec![json!({"provider":name,"model":name,"requests":1}); 1000],
                    "budgets":{"status":"unavailable","items":[]}
                }
            });
            assert!(usage.to_string().len() > 1024 * 1024);
            request.reply(200, usage).await;
            let console = wait(read).await.unwrap().unwrap().console.unwrap();
            assert_eq!(console.requests["30d"], 1000);
            assert_eq!(console.models.len(), 1000);
        });
    }

    #[test]
    fn quota_demand_and_authority_cancel_old_replies_but_passive_refresh_coalesces() {
        let mut panel = Panel::default();
        panel.select(Some(("/fixture/checkout", "openai", "first")));
        let (stop, cancelled) = bounded(1);
        let (send, reply) = bounded(1);
        panel.read = Some((stop, reply));
        panel.refresh(Some("/fixture/unrelated"));
        assert!(!panel.trailing);
        for _ in 0..5 {
            panel.refresh(Some("/fixture/checkout"));
        }
        assert!(panel.trailing && !cancelled.is_closed());
        assert!(panel.observe_authority((1, true, 0)));
        assert!(cancelled.is_closed() && send.is_closed() && !panel.trailing);

        let (stop, cancelled) = bounded(1);
        let (send, reply) = bounded(1);
        panel.read = Some((stop, reply));
        assert!(!panel.observe_authority((1, true, 0)));
        assert!(!cancelled.is_closed());
        assert!(panel.observe_authority((2, true, 1)));
        assert!(cancelled.is_closed() && send.is_closed());

        let (stop, cancelled) = bounded(1);
        let (send, reply) = bounded(1);
        panel.read = Some((stop, reply));
        assert!(panel.select(None));
        assert!(cancelled.is_closed() && send.is_closed());
        assert!(!panel.select(None));
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn status_usage_refresh_wake_tracks_logical_clock_without_drifting() {
        use crate::files::test_http::Http;

        platform::block_on(async {
            let http = Http::new().await;
            let wake: rune::Waker = std::sync::Arc::new(|| {});

            let mut panel = Panel::default();
            panel.backend = Some(http.backend.clone());
            panel.watch(Watch::default());
            panel.authority = (1, true, 0);
            panel.select(Some(("/fixture/checkout", "openai", "first")));
            panel.due = Some(65.0);

            let mut rt = rune::Runtime::new(
                (panel, wake),
                |_, _| rune::el(),
                (200.0, 100.0),
                rune::Env::new(false, 1.0),
            );
            rt.poll =
                Some(|(panel, wake): &mut (Panel, rune::Waker), now, tx| panel.poll(now, tx, wake));
            rt.frame(5.0);
            let first_wake = rt
                .wake_deadline()
                .expect("waiting refresh must schedule its 60s wake");
            for _ in 0..180 {
                rt.frame(1.0 / 60.0);
                let wake = rt
                    .wake_deadline()
                    .expect("refresh wake must remain scheduled before 60s");
                assert!(
                    (wake - first_wake).abs() < 1e-6,
                    "usage refresh wake must stay pinned on logical clock: first={first_wake}, now={wake}"
                );
            }
            // Advancing to the logical 60s deadline must trigger the next read without waiting 60 real seconds.
            let step = (first_wake - rt.clock).max(0.0);
            rt.frame(step);
            assert!(
                rt.state.0.read.is_some(),
                "refresh must start once logical clock reaches due (clock={}, due={:?})",
                rt.clock,
                rt.state.0.due
            );
            assert!(
                rt.wake_deadline().is_none(),
                "in-flight refresh must leave no residual timer wakes: {:?}",
                rt.wake_deadline()
            );
        });
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn status_usage_renders_muted_empty_states_inset_cards_and_console_info_in_both_themes() {
        use rune::{Env, Runtime, col};
        use rune_theme_codenomad::layout::{self, Layout};
        use serde_json::json;

        fn render(s: &State, cx: &mut rune::Cx<State>) -> El {
            layout::render(cx, |_| {
                col()
                    .full_width()
                    .full_height()
                    .child(section(s).unwrap())
                    .child(git_panel::note("ref-muted", "status").key("ref-muted"))
                    .child(col().inset_surface().key("ref-inset"))
            })
        }

        let backend = platform::block_on(Backend::connect("http://127.0.0.1:9/", "")).unwrap();
        let make_state = |usage: Option<Usage>, failed: bool| {
            let mut s = crate::init();
            s.status_usage.backend = Some(backend.clone());
            s.status_usage.expanded = true;
            s.status_usage.authority = (1, true, 0);
            s.status_usage.failed = failed;
            s.status_usage.usage = usage;
            s
        };

        for dark in [false, true] {
            crate::strings::with_locale("en", || {
                // Empty / loading state renders muted note without inset card.
                let mut rt = Runtime::new(
                    make_state(None, false),
                    render,
                    (320.0, 420.0),
                    Env::new(dark, 1.0),
                );
                rt.frame(0.0);
                let nodes = rt.elements();
                let find = |key: &str| {
                    nodes
                        .iter()
                        .find(|node| node.key.as_deref() == Some(key))
                        .unwrap_or_else(|| panic!("missing key `{key}` in dark={dark}"))
                };
                let empty = find("status-usage-empty");
                let ref_muted = find("ref-muted");
                assert_eq!(empty.role, "status");
                assert_eq!(empty.text_color, ref_muted.text_color);
                assert!(
                    nodes
                        .iter()
                        .all(|node| node.key.as_deref() != Some("status-usage-card")),
                    "loading state must not wrap empty copy in an inset card"
                );

                // Unsupported usage renders muted note without inset card.
                let unsupported: Usage = serde_json::from_value(json!({
                    "requestedProviderId": "acme",
                    "providerName": "Acme",
                    "supported": false,
                    "configured": true,
                    "ok": true,
                    "windows": {}
                }))
                .unwrap();
                let mut rt = Runtime::new(
                    make_state(Some(unsupported), false),
                    render,
                    (320.0, 420.0),
                    Env::new(dark, 1.0),
                );
                rt.frame(0.0);
                let nodes = rt.elements();
                let empty = nodes
                    .iter()
                    .find(|n| n.key.as_deref() == Some("status-usage-empty"))
                    .expect("unsupported muted note");
                let ref_muted = nodes
                    .iter()
                    .find(|n| n.key.as_deref() == Some("ref-muted"))
                    .unwrap();
                assert_eq!(empty.text_color, ref_muted.text_color);
                assert!(
                    nodes
                        .iter()
                        .all(|n| n.key.as_deref() != Some("status-usage-card"))
                );

                // Unavailable reason renders inset card with caption + settings action.
                let missing_cred: Usage = serde_json::from_value(json!({
                    "requestedProviderId": "opencode-console",
                    "providerName": "OpenCode Console",
                    "supported": true,
                    "configured": false,
                    "ok": false,
                    "unavailableReason": "opencode-console-missing-credential",
                    "windows": {}
                }))
                .unwrap();
                let mut rt = Runtime::new(
                    make_state(Some(missing_cred), false),
                    render,
                    (320.0, 420.0),
                    Env::new(dark, 1.0),
                );
                rt.frame(0.0);
                let nodes = rt.elements();
                let card = nodes
                    .iter()
                    .find(|n| n.key.as_deref() == Some("status-usage-card"))
                    .expect("unavailable inset card");
                let ref_inset = nodes
                    .iter()
                    .find(|n| n.key.as_deref() == Some("ref-inset"))
                    .unwrap();
                assert_eq!(card.fill, ref_inset.fill);
                assert_eq!(card.radius, 0.0, "usage card must keep square corners");
                assert!(
                    nodes
                        .iter()
                        .any(|n| n.key.as_deref() == Some("status-usage-unavailable")
                            && n.role == "status")
                );

                // Active windows + Console usage renders inset card, meter, tooltips, and console info tip.
                let active: Usage = serde_json::from_value(json!({
                    "requestedProviderId": "opencode-console",
                    "providerName": "OpenCode Console",
                    "supported": true,
                    "configured": true,
                    "ok": true,
                    "copilotPlan": "pro",
                    "windows": {
                        "5h": { "usedPercent": 64.0, "resetAt": 1800000000000.0 }
                    },
                    "console": {
                        "requests": { "24h": 12, "7d": 48, "30d": 120 },
                        "models": [{ "provider": "anthropic", "model": "claude-sonnet", "requests": 42 }],
                        "budgets": {
                            "status": "available",
                            "items": [{ "name": "CI Bot", "spentUsd": 12.5, "limitUsd": 50.0, "resetAt": 1800000000000.0 }]
                        }
                    }
                }))
                .unwrap();
                let mut rt = Runtime::new(
                    make_state(Some(active), false),
                    render,
                    (320.0, 600.0),
                    Env::new(dark, 1.0),
                );
                rt.frame(0.0);
                let nodes = rt.elements();
                let card = nodes
                    .iter()
                    .find(|n| n.key.as_deref() == Some("status-usage-card"))
                    .expect("active usage card");
                let ref_inset = nodes
                    .iter()
                    .find(|n| n.key.as_deref() == Some("ref-inset"))
                    .unwrap();
                assert_eq!(card.fill, ref_inset.fill);
                assert_eq!(card.radius, 0.0);

                let window = nodes
                    .iter()
                    .find(|n| n.key.as_deref() == Some("5h"))
                    .expect("5h window row");
                assert!(
                    window.help.as_deref().is_some_and(|h| {
                        h.contains(t("providerUsage.windows.fiveHours"))
                            && h.contains("64%")
                            && h.contains("Resets")
                    }),
                    "window tooltip must summarize reading: {:?}",
                    window.help
                );
                assert!(
                    nodes.iter().any(|n| n.role == "progressbar"),
                    "window meter must render a progressbar"
                );

                let console_info = nodes
                    .iter()
                    .find(|n| n.key.as_deref() == Some("status-usage-console-info"))
                    .expect("console info button");
                assert_eq!(
                    console_info.help.as_deref(),
                    Some(t("providerUsage.console.info"))
                );
                assert_eq!(console_info.radius, 0.0);

                let provider = nodes
                    .iter()
                    .find(|n| n.key.as_deref() == Some("status-usage-provider"))
                    .expect("provider footer");
                assert!(
                    provider
                        .help
                        .as_deref()
                        .is_some_and(|h| h.contains("OpenCode Console") && h.contains("Pro")),
                    "provider footer must expose full name + plan tooltip: {:?}",
                    provider.help
                );
            });
        }
    }
}
