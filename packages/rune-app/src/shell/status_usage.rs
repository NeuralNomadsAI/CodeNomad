use crate::{State, backend::Backend, platform, screen, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    provider_usage::{Hint, Usage},
    runtime::Instant,
};
use rune::{El, Tx, col, text};
use rune_theme_codenomad::{Space, layout::Layout, settings};
use std::time::Duration;

mod view;

#[derive(Default)]
pub(crate) struct Panel {
    backend: Option<Backend>,
    model: Option<(String, String, String)>,
    expanded: bool,
    online: bool,
    upstream: Option<(u64, bool)>,
    due: Option<Instant>,
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
        self.trailing = false;
    }

    pub(crate) fn online(&mut self, online: bool) {
        if self.online != online {
            self.online = online;
            self.invalidate();
        }
    }

    pub(crate) fn hint(&mut self, hint: Hint) {
        match hint {
            Hint::Revoke => self.invalidate(),
            Hint::Upstream {
                generation,
                connected,
            } => {
                let status = Some((generation, connected));
                if self.upstream != status {
                    self.upstream = status;
                    self.online = connected;
                    self.invalidate();
                }
            }
            Hint::Refresh(directory) => {
                if self.model.as_ref().is_some_and(|(active, _, _)| {
                    directory.as_deref().is_none_or(|directory| {
                        codenomad_client::same_server_path(directory, active)
                    })
                }) {
                    if self.read.is_some() {
                        self.trailing = true;
                    } else {
                        self.due = None;
                    }
                }
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

    fn poll(
        &mut self,
        now: f64,
        tx: &mut Tx,
        reads: &platform::reads::Reads,
        wake: &rune::Waker,
    ) -> bool {
        let (Some(backend), Some((_, provider, model))) = (&self.backend, &self.model) else {
            return false;
        };
        if !self.online {
            return false;
        }
        let clock = Instant::now();
        if let Some((_, reply)) = &self.read {
            let result = match reply.try_recv() {
                Ok(result) => result,
                Err(codenomad_client::TryRecvError::Empty) => return false,
                Err(codenomad_client::TryRecvError::Closed) => None,
            };
            self.read = None;
            self.failed = result.is_none();
            self.usage = result;
            self.due = if std::mem::take(&mut self.trailing) {
                tx.wake_at(now);
                None
            } else {
                tx.wake_at(now + 60.0);
                Some(clock + Duration::from_secs(60))
            };
            return true;
        }
        if let Some(due) = self.due
            && due > clock
        {
            tx.wake_at(now + (due - clock).as_secs_f64());
            return false;
        }
        let (close, cancelled) = bounded(1);
        let (out, reply) = bounded(1);
        self.read = Some((close, reply));
        let (reads, wake, backend, provider, model) = (
            reads.clone(),
            wake.clone(),
            backend.clone(),
            provider.clone(),
            model.clone(),
        );
        platform::spawn(async move {
            let Some(_slot) = reads.background(&cancelled).await else {
                return;
            };
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
    let panel = &mut s.status_usage;
    let active = panel.expanded
        && panel.backend.is_some()
        && !s.screen.is_launcher()
        && s.shell.visible(1)
        && crate::workspace::right_panel_tab(s) == crate::workspace::RightPanelTab::Status;
    let model = active
        .then(|| {
            let agent = s.agent.as_ref()?;
            let directory = agent.directory.as_deref()?;
            let model = agent.current.as_ref()?;
            let provider = model["providerID"].as_str()?.trim();
            (!provider.is_empty()).then_some((
                directory,
                provider,
                model["id"].as_str().unwrap_or_default().trim(),
            ))
        })
        .flatten();
    s.status_usage.select(model) | s.status_usage.poll(now, tx, &s.reads, &s.wake)
}

pub(super) fn section(s: &State) -> Option<El> {
    let panel = &s.status_usage;
    panel.backend.as_ref()?;
    let body = if let Some(usage) = &panel.usage {
        view::usage(usage, s)
    } else {
        let key = if !panel.online || panel.failed {
            "providerUsage.unavailable"
        } else if panel.model.is_none() {
            "providerUsage.noSession"
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
                        "windows":{"requests:example":{"usedPercent":64}}
                    }),
                )
                .await;
            let usage = wait(read).await.unwrap().unwrap();
            assert_eq!(usage.windows["requests:example"].used_percent, Some(64.0));
        });
    }

    #[test]
    fn quota_demand_and_authority_cancel_old_replies_but_passive_refresh_coalesces() {
        let mut panel = Panel::default();
        panel.select(Some(("/fixture/checkout", "openai", "first")));
        let (stop, cancelled) = bounded(1);
        let (send, reply) = bounded(1);
        panel.read = Some((stop, reply));
        panel.hint(Hint::Refresh(Some("/fixture/unrelated".into())));
        assert!(!panel.trailing);
        for _ in 0..5 {
            panel.hint(Hint::Refresh(Some("/fixture/checkout".into())));
        }
        assert!(panel.trailing && !cancelled.is_closed());
        panel.hint(Hint::Revoke);
        assert!(cancelled.is_closed() && send.is_closed() && !panel.trailing);

        panel.hint(Hint::Upstream {
            generation: 1,
            connected: true,
        });
        let (stop, cancelled) = bounded(1);
        let (send, reply) = bounded(1);
        panel.read = Some((stop, reply));
        panel.hint(Hint::Upstream {
            generation: 1,
            connected: true,
        });
        assert!(!cancelled.is_closed());
        panel.hint(Hint::Upstream {
            generation: 2,
            connected: true,
        });
        assert!(cancelled.is_closed() && send.is_closed());

        let (stop, cancelled) = bounded(1);
        let (send, reply) = bounded(1);
        panel.read = Some((stop, reply));
        assert!(panel.select(None));
        assert!(cancelled.is_closed() && send.is_closed());
        assert!(!panel.select(None));
    }
}
