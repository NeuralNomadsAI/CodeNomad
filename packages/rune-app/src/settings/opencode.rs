use super::Preferences;
mod executable;
pub(super) mod install;
pub(super) mod logging;
mod login_start;
mod logs;
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
use std::{cell::RefCell, rc::Rc};

#[derive(Default)]
pub(super) struct Status {
    value: Option<OpenCodeStatus>,
    flight: Option<(Sender<()>, Receiver<Option<OpenCodeStatus>>)>,
    authority: Option<String>,
    trailing: Option<bool>,
    failed: bool,
    details_open: bool,
    executable: executable::State,
    login_start: login_start::State,
    logs: logs::State,
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
            has_installation_source: true,
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
        let authority = prefs
            .backend
            .as_ref()
            .filter(|_| allowed)
            .map(|backend| backend.client_id.as_str());
        let mut changed = authority != self.authority.as_deref();
        if changed {
            *self = Self {
                authority: authority.map(str::to_owned),
                ..Self::default()
            };
        }
        let admitted = prefs.opencode_install.admit(
            prefs.backend.as_ref().filter(|_| allowed),
            prefs.main_wake.clone(),
            wake.clone(),
        );
        changed |= self.poll();
        let (exec_changed, binary_changed) = self.executable.poll(prefs, wake, self.value.as_ref());
        let login_changed = self.login_start.poll(prefs, wake);
        let logs_changed = self.logs.poll(prefs, wake);
        let refresh = binary_changed.then_some(false);
        let changed = changed
            | admitted
            | exec_changed
            | login_changed
            | logs_changed
            | self.read(prefs, Some(wake), refresh);
        if self.authority.as_deref()
            == prefs
                .backend
                .as_ref()
                .map(|backend| backend.client_id.as_str())
            && !self.failed
            && let Some(version) = self
                .value
                .as_ref()
                .filter(|status| status.update_available)
                .and_then(|status| status.latest.as_ref())
            && prefs.announced_update.as_ref() != Some(version)
        {
            prefs.announced_update = Some(version.clone());
            prefs.notification_update = Some(version.clone());
            if let Some(wake) = &prefs.main_wake {
                wake();
            }
        }
        changed
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
    let header_status = status.value.as_ref().map(|snapshot| {
        let label = if status.failed {
            "disconnected"
        } else {
            snapshot.state
        };
        t(&format!("settings.opencode.setup.{label}"))
    });
    let mut card = col()
        .full_width()
        .separate(Space::Sm)
        .child(chrome::card_header(
            t("settings.opencode.update.title"),
            header_status,
        ));
    if status.failed {
        card = card.child(chrome::palette::save_error(t(
            "settings.opencode.setup.serviceError",
        )));
    }
    if let Some(error) = install.error(prefs.backend.as_ref()) {
        card = card.child(chrome::palette::save_error(t(error)));
    }
    let mut install_button = None;
    if let Some(snapshot) = &status.value {
        let mut versions = vec![version(
            "settings.opencode.update.installed",
            snapshot.current.as_deref(),
        )];
        if snapshot.running.is_none() || snapshot.running != snapshot.current {
            versions.push(version(
                "settings.opencode.setup.daemon",
                snapshot.running.as_deref(),
            ));
        }
        card = card.child(chrome::divided_rows(versions));
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
                .text_role(TextRole::Small)
                .role("status"),
            );
        }
        if !status.failed {
            if let Some(restart) = snapshot.restart {
                card = card.child(
                    text(t(restart))
                        .text_role(TextRole::Small)
                        .full_width()
                        .wrap()
                        .role("status")
                        .key("opencode-restart-status"),
                );
            }
            if snapshot.check_failed {
                card = card.child(
                    text(t("settings.opencode.update.checkFailed"))
                        .text_role(TextRole::Small)
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
            install_button = Some(
                chrome::primary_action(&label, pending || !prefs.can_retry(), start)
                    .key("opencode-install"),
            );
        }
    }
    if let Some(progress) = install.label() {
        card = card.child(text(t(progress)).text_role(TextRole::Small).role("status"));
    } else if pending {
        card = card.child(
            text(t("settings.opencode.update.checking"))
                .text_role(TextRole::Small)
                .role("status"),
        );
    }
    card = card.child(
        layout::action_row()
            .children(install_button)
            .child(layout::button(
                t("settings.opencode.setup.check"),
                pending || !prefs.can_retry(),
                check,
            )),
    );
    if let Some(snapshot) = &status.value {
        let mut detail_rows = vec![version(
            "settings.opencode.setup.minimum",
            snapshot.minimum.as_deref(),
        )];
        if snapshot.recommended != snapshot.minimum {
            detail_rows.push(version(
                "settings.opencode.setup.recommended",
                snapshot.recommended.as_deref(),
            ));
        }
        let details = chrome::divided_rows(detail_rows);
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
    chrome::info_row(t(label), value.unwrap_or("—"), value.is_none())
}

pub(super) fn executable_view<S: 'static>(
    status: &Status,
    prefs: &Preferences,
    shared: &Rc<RefCell<Preferences>>,
    wake: Option<rune::Waker>,
    access: fn(&mut S) -> &mut Status,
) -> El {
    status
        .executable
        .view(prefs, shared, status.value.as_ref(), wake, access)
}

pub(super) fn login_start_view<S: 'static>(
    status: &Status,
    prefs: &Preferences,
    shared: &Rc<RefCell<Preferences>>,
    wake: Option<rune::Waker>,
    access: fn(&mut S) -> &mut Status,
) -> El {
    status.login_start.view(prefs, shared, wake, access)
}

pub(super) fn logs_action_view<S: 'static>(
    status: &Status,
    prefs: &Preferences,
    shared: &Rc<RefCell<Preferences>>,
    wake: Option<rune::Waker>,
    layers: &mut Vec<El>,
    access: fn(&mut S) -> &mut Status,
) -> El {
    status.logs.action_view(prefs, shared, wake, layers, access)
}

#[cfg(test)]
#[test]
fn opencode_status_card_renders_header_and_error_in_both_themes() {
    struct Harness {
        dark: bool,
        status: Status,
        prefs: Preferences,
    }
    for dark in [false, true] {
        let mut prefs = Preferences::default();
        prefs.fixture();
        prefs.fixture_locale("en");
        let mut status = Status::default();
        status.fixture();
        status.failed = true;
        let mut rt = rune::Runtime::new(
            Harness {
                dark,
                status,
                prefs,
            },
            |s, cx| {
                rune_theme_codenomad::settings::render(cx, s.dark, None, |_| {
                    crate::strings::with_locale("en", || {
                        view(
                            &s.status,
                            &s.prefs,
                            |_: &mut Harness| {},
                            |_: &mut Harness| {},
                            |s: &mut Harness| &mut s.status,
                        )
                    })
                })
            },
            (720.0, 560.0),
            rune::Env::new(dark, 1.0),
        );
        rt.frame(0.02);
        let tree = rt.accessibility_json().to_string();
        assert!(tree.contains("\"role\":\"heading\""), "dark={dark}");
        assert!(tree.contains("\"role\":\"status\""), "dark={dark}");
        assert!(tree.contains("\"role\":\"alert\""), "dark={dark}");
    }
}
