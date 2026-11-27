use crate::{State, backend::Backend, platform, screen, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    provider_usage::{Usage, Watch},
};
use rune::{El, Tx, col, text};
use rune_theme_codenomad::{Space, layout::Layout, settings};

pub(crate) mod date;
mod view;

#[derive(Default)]
pub(crate) struct Panel {
    backend: Option<Backend>,
    model: Option<(String, String, String)>,
    expanded: bool,
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
        col().pad(Space::Sm).child(text(t(key)).role("status"))
    };
    Some(
        settings::disclosure(
            t("providerUsage.title"),
            panel.expanded,
            body,
            screen::action(&s.input_scope, |s| {
                s.status_usage.expanded = !s.status_usage.expanded;
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
}
