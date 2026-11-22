use super::view::Window;
use crate::{backend::Backend, platform, strings::t};
use codenomad_client::{
    Receiver, bounded,
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
    flight: Option<Receiver<Option<OpenCodeStatus>>>,
    authority: Option<String>,
    failed: bool,
    pub details_open: bool,
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
            check_failed: false,
            state: "connected",
        });
    }

    pub fn read(&mut self, backend: Option<&Backend>, wake: Option<&rune::Waker>, recheck: bool) {
        let authority = backend.map(|backend| backend.client_id.as_str());
        if authority != self.authority.as_deref() {
            *self = Self {
                authority: authority.map(str::to_owned),
                ..Self::default()
            };
        }
        let (Some(backend), Some(wake)) = (backend.cloned(), wake.cloned()) else {
            return;
        };
        if self.flight.is_some() || (!recheck && (self.value.is_some() || self.failed)) {
            return;
        }
        let (sender, receiver) = bounded(1);
        self.flight = Some(receiver);
        platform::spawn(async move {
            let result = opencode_status(&backend, recheck).await.ok();
            if sender.send(result).await.is_ok() {
                wake();
            }
        });
    }

    pub fn poll(&mut self) -> bool {
        let Some(reply) = self
            .flight
            .as_ref()
            .and_then(|flight| flight.try_recv().ok())
        else {
            return false;
        };
        self.flight = None;
        self.failed = reply.is_none();
        if let Some(reply) = reply {
            self.value = Some(reply);
        }
        true
    }
}

pub(super) fn view(s: &Window) -> El {
    let status = &s.opencode;
    let pending = status.flight.is_some();
    let mut card = col().full_width().separate(Space::Sm).child(
        text(t("settings.opencode.update.title"))
            .text_role(TextRole::Title)
            .role("heading"),
    );
    if status.failed {
        card = card.child(text(t("settings.opencode.setup.serviceError")).role("alert"));
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
        if snapshot.current != snapshot.running || snapshot.running.is_none() {
            card = card.child(version(
                "settings.opencode.setup.daemon",
                snapshot.running.as_deref(),
            ));
        }
        if snapshot.update_available
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
        if snapshot.check_failed {
            card = card.child(text(t("settings.opencode.update.checkFailed")).role("status"));
        }
    }
    if pending {
        card = card.child(text(t("settings.opencode.update.checking")).role("status"));
    }
    card = card.child(layout::action_row().child(layout::button(
        t("settings.opencode.setup.check"),
        pending || !s.has_backend(),
        |s: &mut Window| s.check_opencode(true),
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
            |s: &mut Window| s.opencode.details_open = !s.opencode.details_open,
        ));
    }
    chrome::card(card)
}

fn version(label: &str, value: Option<&str>) -> El {
    chrome::setting_row(
        t(label),
        text(value.unwrap_or_default()).literal_direction(),
    )
}
