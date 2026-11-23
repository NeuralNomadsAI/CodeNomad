use super::Preferences;
use crate::{
    platform,
    strings::{locale, t},
};
use codenomad_client::{Receiver, Sender, bounded, settings::info::metadata};
use rune::{El, Waker, col, text};
use rune_theme_codenomad::{
    Space, TextRole,
    layout::{self, Layout},
    settings as chrome,
};
use serde_json::Value;
use std::{cell::RefCell, rc::Rc};

mod diagnostics;

const FEEDS: [&str; 2] = ["stable", "preview"];

#[derive(Default)]
pub(super) struct Info {
    owner: Option<String>,
    value: Option<Value>,
    flight: Option<(Sender<()>, Receiver<Option<Value>>)>,
    failed: bool,
    refresh: bool,
    reread_feed: bool,
    support_failed: bool,
    release_failed: bool,
    diagnostics: diagnostics::Diagnostics,
}

impl Info {
    pub fn close(&mut self) {
        *self = Self::default();
    }

    pub fn poll(&mut self, prefs: &Preferences, wake: &Waker) -> bool {
        let backend = prefs.backend.as_ref().filter(|_| prefs.can_retry());
        let owner = backend.map(|backend| backend.client_id.as_str());
        let mut changed = owner != self.owner.as_deref();
        if changed {
            self.close();
            self.owner = owner.map(str::to_owned);
            self.refresh = true;
        }
        changed |= self.diagnostics.poll(backend, wake);
        if let Some((_, reply)) = &self.flight {
            let value = match reply.try_recv() {
                Ok(value) => value,
                Err(_) if reply.is_closed() => None,
                Err(_) => return changed,
            };
            self.flight = None;
            self.failed = value.is_none();
            if let Some(value) = value {
                self.value = Some(value);
            }
            changed = true;
        }
        if prefs.update_feed_pending() {
            return changed;
        }
        self.refresh |= std::mem::take(&mut self.reread_feed);
        if let Some(backend) = backend
            && std::mem::take(&mut self.refresh)
        {
            let (cancel, cancelled) = bounded(1);
            let (out, reply) = bounded(1);
            self.flight = Some((cancel, reply));
            let (backend, wake) = (backend.clone(), wake.clone());
            platform::spawn(async move {
                if let Some(result) =
                    platform::reads::cancellable(&cancelled, metadata(&backend)).await
                    && out.send(result.ok()).await.is_ok()
                {
                    wake();
                }
            });
            changed = true;
        }
        changed
    }

    fn current<'a>(&'a self, prefs: &Preferences) -> Option<&'a Value> {
        let owner = prefs.backend.as_ref().filter(|_| prefs.can_retry())?;
        if self.owner.as_deref() != Some(&owner.client_id) {
            return None;
        }
        self.value.as_ref()
    }

    pub fn view<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        access: fn(&mut S) -> Option<&mut Info>,
    ) -> El {
        let prefs = shared.borrow();
        let value = self.current(&prefs).unwrap_or(&Value::Null);
        let feed = FEEDS.iter().position(|feed| value["updateFeed"] == *feed);
        let busy = self.flight.is_some() || prefs.update_feed_pending();
        let offer = value.get("update").filter(|offer| offer.is_object());
        let latest = offer.and_then(|offer| value_text(&offer["version"]));
        let release = (!busy && !self.failed && latest.is_some()).then(|| {
            offer.and_then(|offer| value_text(&offer["url"])).and_then(codenomad_client::settings::info::release_link)
        }).flatten();
        let version =
            value_text(&value["serverVersion"]).or_else(|| value_text(&value["ui"]["version"]));
        let ui = value_text(&value["ui"]["version"]).filter(|ui| Some(*ui) != version);
        let about = card("settings.section.info.title")
            .child(row("settings.info.version.app", version))
            .children(ui.map(|version| row("settings.info.version.ui", Some(version))))
            .child(row(
                "settings.info.version.uiSource",
                value_text(&value["ui"]["source"]),
            ))
            .child(row(
                "settings.info.runtime.type",
                Some(if cfg!(target_arch = "wasm32") {
                    "Web"
                } else {
                    "Rune"
                }),
            ));

        let update = shared.clone();
        let source = shared.clone();
        let updates = card("settings.info.updates.title")
            .child(row("settings.info.updates.latest", latest))
            .children(release.map(|release| chrome::primary_action_tx(
                t("settings.info.updates.download"), false, move |s: &mut S, tx| {
                    let Some(info) = access(s) else { return; };
                    let prefs = source.borrow();
                    if !info.failed && info.flight.is_none() && !prefs.update_feed_pending()
                        && info.current(&prefs).and_then(|m| value_text(&m["update"]["url"]))
                            .and_then(codenomad_client::settings::info::release_link).as_ref() == Some(&release)
                    {
                        info.release_failed = tx.open_url(&release).is_err();
                    }
                })))
            .children(self.release_failed.then(|| text(t("settings.info.actions.failed")).wrap().role("alert")))
            .child(layout::button(
                t("settings.info.updates.refresh"),
                busy || !prefs.can_retry(),
                move |s: &mut S| {
                    if let Some(info) = access(s) {
                        info.refresh = true;
                        info.release_failed = false;
                    }
                },
            ))
            .children(feed.map(|feed| {
                chrome::segments(
                    t("settings.info.updates.feed"),
                    &[
                        t("settings.info.updates.feed.stable"),
                        t("settings.info.updates.feed.preview"),
                    ],
                    Some(feed),
                    busy || self.failed,
                    move |s: &mut S, index| {
                        let Some(info) = access(s) else {
                            return;
                        };
                        let mut prefs = update.borrow_mut();
                        if !info.failed
                            && info.flight.is_none()
                            && let Some(&feed) = FEEDS.get(index)
                            && info
                                .current(&prefs)
                                .is_some_and(|value| value["updateFeed"] != feed)
                        {
                            prefs.stage_update_feed(feed);
                            info.reread_feed = true;
                        }
                    },
                )
            }))
            .children(prefs.update_feed_failed().then(|| {
                text(t("settings.info.updates.feed.saveFailed"))
                    .role("alert")
                    .wrap()
            }));

        let sponsor = format!(
            "https://neuralnomadsai.github.io/CodeNomad/{}/sponsor.html",
            locale()
        );
        let support = card("settings.info.support.title")
            .children(self.support_failed.then(|| {
                text(t("commands.openSponsor.failed").replace("{url}", &sponsor))
                    .role("alert")
                    .wrap()
            }))
            .child(layout::button_tx(
                t("settings.info.support.open"),
                false,
                move |s: &mut S, tx| {
                    if let Some(info) = access(s) {
                        info.support_failed = tx.open_url(&sponsor).is_err();
                    }
                },
            ));

        let connectivity = card("settings.info.connectivity.title")
            .children(self.failed.then(|| {
                text(t("settings.info.connectivity.loadFailed"))
                    .role("alert")
                    .wrap()
            }))
            .children(
                self.flight
                    .is_some()
                    .then(|| text(t("remoteAccess.addresses.loading")).role("status")),
            )
            .children(value.as_object().map(|_| connectivity(value)));
        col()
            .full_width()
            .children([about, updates, support, connectivity].map(chrome::card).into_iter().take(3))
            .child(self.diagnostics.view(shared, access, value.as_object().is_some()))
            .child(chrome::card(connectivity))
    }
}

fn card(title: &str) -> El {
    col()
        .full_width()
        .separate(Space::Sm)
        .child(text(t(title)).text_role(TextRole::Title).role("heading"))
}

fn row(label: &str, value: Option<&str>) -> El {
    chrome::setting_row(
        t(label),
        text(value.unwrap_or("—")).literal_direction().wrap(),
    )
}

fn value_text(value: &Value) -> Option<&str> {
    value.as_str().filter(|value| {
        !value.is_empty() && value.len() <= 4096 && !value.contains(char::is_control)
    })
}

fn connectivity(value: &Value) -> El {
    let host = value_text(&value["host"]);
    let os = value_text(&value["system"]["name"]).or_else(|| {
        match value["system"]["platform"].as_str() {
            Some("win32") => Some("Windows"),
            Some("darwin") => Some("macOS"),
            Some("linux") => Some("Linux"),
            _ => value_text(&value["system"]["platform"]),
        }
    });
    let mode = match (host, value["listeningMode"].as_str()) {
        (Some("0.0.0.0" | "::" | "[::]"), _) => "settings.info.connectivity.mode.all",
        (_, Some("all" | "specific")) => "settings.info.connectivity.mode.specific",
        _ => "settings.info.connectivity.mode.local",
    };
    col()
        .full_width()
        .separate(Space::Sm)
        .child(row("settings.info.server.os", os))
        .child(row(
            "settings.info.server.arch",
            value_text(&value["system"]["arch"]),
        ))
        .child(row(
            "remoteAccess.sections.listeningMode.label",
            Some(t(mode)),
        ))
        .child(row("settings.info.connectivity.host", host))
        .child(row(
            "settings.info.connectivity.localListener",
            value_text(&value["localUrl"]),
        ))
        .children(
            value_text(&value["remoteUrl"])
                .map(|url| row("settings.info.connectivity.remoteListener", Some(url))),
        )
        .child(row(
            "settings.info.server.root",
            value_text(&value["workspaceRoot"]),
        ))
}
