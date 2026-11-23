use super::Preferences;
pub(super) mod install;
pub(super) mod logging;
use crate::{platform, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::{OpenCodeStatus, opencode_status},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole,
    layout::{self, Layout},
    settings as chrome,
};

#[derive(Default)]
pub(super) struct Status {
    value: Option<OpenCodeStatus>,
    flight: Option<(Sender<()>, Receiver<Option<OpenCodeStatus>>)>,
    authority: Option<String>,
    trailing: Option<bool>,
    failed: bool,
    details_open: bool,
}

impl Status {
    #[cfg(any(test, feature = "test-support"))]
    pub fn fixture(&mut self) {
        self.value = Some(OpenCodeStatus {
            current: Some("2.3.0".into()),
            running: Some("2.2.5".into()),
            minimum: Some("2.2.3".into()),
            recommended: Some("2.2.5".into()),
            latest: None,
            update_available: false,
            check_failed: true,
            state: "connected",
            restart: Some("settings.opencode.setup.restartAvailable"),
            can_upgrade: false,
            needs_shared_installation: false,
            foreign_installation: false,
            binary_path: None,
        });
    }

    pub fn read(
        &mut self,
        prefs: &mut Preferences,
        wake: Option<&rune::Waker>,
        refresh: Option<bool>,
    ) -> bool {
        let backend = prefs.backend.as_ref().filter(|_| prefs.can_retry());
        let authority = backend.map(|backend| backend.client_id.as_str());
        let mut changed = authority != self.authority.as_deref();
        if changed {
            *self = Self {
                authority: authority.map(str::to_owned),
                ..Self::default()
            };
        }
        if prefs.opencode_install.busy() {
            return changed;
        }
        if let Some(install::Diagnostic(status)) = prefs.opencode_install.take_status(backend) {
            self.flight = None;
            self.trailing = None;
            self.set_status(status);
            changed = true;
        }
        let (Some(backend), Some(wake)) = (backend.cloned(), wake.cloned()) else {
            return changed;
        };
        if let Some(recheck) = refresh {
            self.trailing = Some(self.trailing == Some(true) || recheck);
        }
        if self.flight.is_some() {
            return changed;
        }
        let refresh = self.trailing.take();
        if refresh.is_none() && (self.value.is_some() || self.failed) {
            return changed;
        }
        let recheck = refresh == Some(true);
        let (sender, receiver) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        self.flight = Some((cancel, receiver));
        platform::spawn(async move {
            if let Some(result) =
                platform::reads::cancellable(&cancelled, opencode_status(&backend, recheck)).await
                && sender.send(result.ok()).await.is_ok()
            {
                wake();
            }
        });
        true
    }

    pub fn poll(&mut self) -> bool {
        let Some(reply) = self
            .flight
            .as_ref()
            .and_then(|(_, reply)| reply.try_recv().ok())
        else {
            return false;
        };
        self.flight = None;
        self.set_status(reply);
        true
    }

    fn set_status(&mut self, reply: Option<OpenCodeStatus>) {
        self.failed = reply.is_none();
        if let Some(reply) = reply {
            self.value = Some(reply);
        }
    }

    pub fn step(&mut self, prefs: &mut Preferences, wake: &rune::Waker) -> bool {
        let allowed = prefs.can_retry();
        let admitted = prefs.opencode_install.admit(
            prefs.backend.as_ref().filter(|_| allowed),
            prefs.main_wake.clone(),
            wake.clone(),
        );
        let changed = self.poll();
        changed | admitted | self.read(prefs, Some(wake), None)
    }

    pub fn start(&self, prefs: &mut Preferences, wake: Option<rune::Waker>) {
        if let (Some(snapshot), Some(backend), Some(wake)) = (&self.value, &prefs.backend, wake)
            && !self.failed
            && self.flight.is_none()
            && prefs.can_retry()
            && self.authority.as_deref() == Some(&backend.client_id)
        {
            prefs.opencode_install.start(backend, snapshot, wake);
        }
    }
}

pub(super) fn view<S: 'static>(
    status: &Status,
    prefs: &Preferences,
    start: impl Fn(&mut S) + 'static,
    check: impl Fn(&mut S) + 'static,
    status_mut: impl Fn(&mut S) -> &mut Status + 'static,
) -> El {
    let install = &prefs.opencode_install;
    let pending = status.flight.is_some() || install.busy();
    let mut card = col().full_width().separate(Space::Sm).child(
        text(t("settings.opencode.update.title"))
            .text_role(TextRole::Title)
            .role("heading"),
    );
    if status.failed {
        card = card.child(
            text(t("settings.opencode.setup.serviceError"))
                .full_width()
                .wrap()
                .role("alert"),
        );
    }
    if let Some(error) = install.error(prefs.backend.as_ref()) {
        card = card.child(text(t(error)).wrap().role("alert"));
    }
    if let Some(snapshot) = &status.value {
        let label = if status.failed {
            "disconnected"
        } else {
            snapshot.state
        };
        card = card
            .child(text(t(&format!("settings.opencode.setup.{label}"))).role("status"))
            .child(version(
                "settings.opencode.update.installed",
                snapshot.current.as_deref(),
            ));
        if snapshot.running.is_none() || snapshot.running != snapshot.current {
            card = card.child(version(
                "settings.opencode.setup.daemon",
                snapshot.running.as_deref(),
            ));
        }
        if !status.failed
            && snapshot.update_available
            && let Some(latest) = &snapshot.latest
        {
            card = card.child(
                text(rune_theme_codenomad::catalogue::format(
                    crate::strings::locale(),
                    "settings.opencode.update.available",
                    &[("version", latest)],
                ))
                .role("status"),
            );
        }
        if !status.failed {
            if let Some(restart) = snapshot.restart {
                card = card.child(
                    text(t(restart))
                        .full_width()
                        .wrap()
                        .role("status")
                        .key("opencode-restart-status"),
                );
            }
            if snapshot.check_failed {
                card = card.child(
                    text(t("settings.opencode.update.checkFailed"))
                        .full_width()
                        .wrap()
                        .role("status")
                        .key("opencode-check-failed"),
                );
            }
        }
        if !status.failed && install::Install::offered(snapshot) {
            let label = if snapshot.foreign_installation {
                t("settings.opencode.setup.foreign.install").into()
            } else if snapshot.needs_shared_installation {
                t("settings.opencode.setup.sharedInstall").into()
            } else if snapshot.state == "missing" {
                t("settings.opencode.setup.install").into()
            } else {
                rune_theme_codenomad::catalogue::format(
                    crate::strings::locale(),
                    "settings.opencode.update.action",
                    &[("version", snapshot.latest.as_deref().unwrap_or(""))],
                )
            };
            card = card.child(
                layout::action_row().child(
                    chrome::primary_action(&label, pending || !prefs.can_retry(), start)
                        .key("opencode-install"),
                ),
            );
        }
    }
    if let Some(progress) = install.label() {
        card = card.child(text(t(progress)).role("status"));
    } else if pending {
        card = card.child(text(t("settings.opencode.update.checking")).role("status"));
    }
    card = card.child(layout::action_row().child(layout::button(
        t("settings.opencode.setup.check"),
        pending || !prefs.can_retry(),
        check,
    )));
    if let Some(snapshot) = &status.value {
        let mut details = col().full_width().child(version(
            "settings.opencode.setup.minimum",
            snapshot.minimum.as_deref(),
        ));
        if snapshot.recommended != snapshot.minimum {
            details = details.child(version(
                "settings.opencode.setup.recommended",
                snapshot.recommended.as_deref(),
            ));
        }
        card = card.child(chrome::disclosure(
            t("settings.opencode.setup.diagnostics"),
            status.details_open,
            details,
            move |s: &mut S| {
                let status = status_mut(s);
                status.details_open = !status.details_open;
            },
        ));
    }
    chrome::card(card)
}

fn version(label: &str, value: Option<&str>) -> El {
    chrome::setting_row(t(label), text(value.unwrap_or("—")).literal_direction())
}
