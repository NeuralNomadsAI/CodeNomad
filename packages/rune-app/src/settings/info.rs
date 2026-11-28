use super::{ExternalLink, Preferences};
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
    support_open: ExternalLink,
    release_open: ExternalLink,
    diagnostics: diagnostics::Diagnostics,
    #[cfg(target_arch = "wasm32")]
    announced: [Option<&'static str>; 4],
}

impl Info {
    #[cfg(target_arch = "wasm32")]
    pub fn announce(&mut self, prefs: &Preferences, tx: &mut rune::Tx) {
        let notices = [
            self.release_open
                .failed()
                .then_some("settings.info.actions.failed"),
            prefs
                .update_feed_failed()
                .then_some("settings.info.updates.feed.saveFailed"),
            self.failed
                .then_some("settings.info.connectivity.loadFailed"),
            self.diagnostics.feedback(),
        ];
        let changed: Vec<_> = notices
            .into_iter()
            .zip(self.announced)
            .filter_map(|(next, old)| next.filter(|key| Some(*key) != old))
            .collect();
        if !changed.is_empty() {
            // Rune keeps one announcement per frame. Say new notices together.
            let message = changed
                .iter()
                .map(|key| t(key))
                .collect::<Vec<_>>()
                .join(" · ");
            if changed.iter().all(|key| key.ends_with(".copied")) {
                layout::announce_polite(tx, message);
            } else {
                layout::announce_alert(tx, &message);
            }
        }
        self.announced = notices;
    }

    pub fn close(&mut self) {
        let mut release_open = std::mem::take(&mut self.release_open);
        release_open.clear();
        let mut support_open = std::mem::take(&mut self.support_open);
        support_open.clear();
        let mut diagnostics = std::mem::take(&mut self.diagnostics);
        diagnostics.reset();
        *self = Self {
            release_open,
            support_open,
            diagnostics,
            ..Self::default()
        };
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

    pub(super) fn current<'a>(&'a self, prefs: &Preferences) -> Option<&'a Value> {
        let owner = prefs.backend.as_ref().filter(|_| prefs.can_retry())?;
        if self.owner.as_deref() != Some(&owner.client_id) {
            return None;
        }
        self.value.as_ref()
    }

    pub(super) fn change_feed(&mut self, prefs: &mut Preferences, feed: &'static str) {
        if !self.failed
            && self.flight.is_none()
            && !prefs.update_feed_pending()
            && self
                .current(prefs)
                .is_some_and(|value| value["updateFeed"] != feed)
        {
            prefs.stage_update_feed(feed);
            self.reread_feed = true;
        }
    }

    pub fn view<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        access: fn(&mut S) -> Option<&mut Info>,
        remote: Option<fn(&mut S)>,
    ) -> El {
        let prefs = shared.borrow();
        let value = self.current(&prefs).unwrap_or(&Value::Null);
        let feed = FEEDS.iter().position(|feed| value["updateFeed"] == *feed);
        let busy = self.flight.is_some() || prefs.update_feed_pending();
        let (latest, link) = release_offer(value);
        let release = (!busy && !self.failed && latest.is_some())
            .then_some(link)
            .flatten();
        let version =
            value_text(&value["serverVersion"]).or_else(|| value_text(&value["ui"]["version"]));
        let ui = value_text(&value["ui"]["version"]).filter(|ui| Some(*ui) != version);
        let mut about_rows = vec![row("settings.info.version.app", version)];
        if let Some(version) = ui {
            about_rows.push(row("settings.info.version.ui", Some(version)));
        }
        about_rows.push(row(
            "settings.info.version.uiSource",
            value_text(&value["ui"]["source"]),
        ));
        about_rows.push(row(
            "settings.info.runtime.type",
            Some(platform::diagnostics::RUNTIME),
        ));
        about_rows.push(row(
            "settings.info.runtime.platform",
            Some(platform::diagnostics::PLATFORM),
        ));
        about_rows.push(row(
            "settings.info.runtime.os",
            Some(&self.diagnostics.os()),
        ));
        let about = card("settings.section.info.title").child(chrome::divided_rows(about_rows));

        let update = shared.clone();
        let source = shared.clone();
        let update_actions = layout::action_row()
            .children(release.map(|release| {
                chrome::primary_action_tx(
                    t("settings.info.updates.download"),
                    false,
                    move |s: &mut S, tx| {
                        let Some(info) = access(s) else {
                            return;
                        };
                        let prefs = source.borrow();
                        if !info.failed
                            && info.flight.is_none()
                            && !prefs.update_feed_pending()
                            && info
                                .current(&prefs)
                                .and_then(|m| release_offer(m).1)
                                .as_ref()
                                == Some(&release)
                        {
                            info.release_open.open(&release, tx, move |s| {
                                access(s).map(|i| &mut i.release_open)
                            });
                        }
                    },
                )
            }))
            .child(layout::button(
                t("settings.info.updates.refresh"),
                busy || !prefs.can_retry(),
                move |s: &mut S| {
                    if let Some(info) = access(s) {
                        info.refresh = true;
                        info.release_open.clear();
                    }
                },
            ));
        let updates = card("settings.info.updates.title")
            .child(chrome::divided_rows([row(
                "settings.info.updates.latest",
                latest,
            )]))
            .child(update_actions)
            .children(
                self.release_open
                    .failed()
                    .then(|| text(t("settings.info.actions.failed")).wrap().role("alert")),
            )
            .children(feed.map(|feed| {
                col().full_width().role("group").label(t("settings.info.updates.feed"))
                    .child(chrome::info_link(t("settings.info.updates.feed.help"), move |s: &mut S, tx| {
                        if let Some(info) = access(s) {
                            let url = format!(
                                "https://neuralnomadsai.github.io/CodeNomad/{}/updates.html#feed",
                                locale()
                            );
                            info.release_open
                                .open(&url, tx, move |s| access(s).map(|i| &mut i.release_open));
                        }
                    }))
                    .child(chrome::segments(
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
                        if let Some(&feed) = FEEDS.get(index) {
                            info.change_feed(&mut prefs, feed);
                        }
                    },
                ))
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
            .children(self.support_open.failed().then(|| {
                text(t("commands.openSponsor.failed").replace("{url}", &sponsor))
                    .role("alert")
                    .wrap()
            }))
            .child(layout::action_row().child(layout::button_tx(
                t("settings.info.support.open"),
                false,
                move |s: &mut S, tx| {
                    if let Some(info) = access(s) {
                        info.support_open.open(&sponsor, tx, move |s| {
                            access(s).map(|i| &mut i.support_open)
                        });
                    }
                },
            )));

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
            .children(value.as_object().map(|_| connectivity(value)))
            .children(remote.map(|open| {
                layout::action_row().child(layout::button(t("settings.nav.remote"), false, open))
            }));
        col()
            .full_width()
            .children([about, updates, support].map(chrome::card))
            .child(
                self.diagnostics
                    .view(shared, access, value.as_object().is_some()),
            )
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
    chrome::info_row(t(label), value.unwrap_or("—"), value.is_none())
}

fn value_text(value: &Value) -> Option<&str> {
    value.as_str().filter(|value| {
        !value.is_empty() && value.len() <= 4096 && !value.contains(char::is_control)
    })
}

fn release_offer(meta: &Value) -> (Option<&str>, Option<String>) {
    use codenomad_client::settings::info::release_link;
    let support = (meta["updateFeed"] != "preview").then_some(&meta["support"]);
    let latest = value_text(&meta["update"]["version"])
        .or_else(|| support.and_then(|s| value_text(&s["latestServerVersion"])));
    let url = if let Some(url) = value_text(&meta["update"]["url"]) {
        release_link(url)
    } else {
        latest
            .zip(value_text(&meta["serverVersion"]))
            .filter(|&(latest, current)| {
                let numbers = |value: &str| {
                    value
                        .trim_start_matches('v')
                        .split('-')
                        .next()
                        .unwrap_or_default()
                        .split('.')
                        .take(3)
                        .map(str::parse::<u64>)
                        .collect::<Result<Vec<_>, _>>()
                        .ok()
                };
                numbers(latest)
                    .zip(numbers(current))
                    .is_none_or(|(latest, current)| latest > current)
            })
            .and_then(|_| support.and_then(|s| value_text(&s["latestServerUrl"])))
            .and_then(release_link)
    };
    (latest, url)
}

#[test]
fn stable_release_support_is_displayed_even_when_no_update_is_offered() {
    let url = "https://github.com/NeuralNomadsAI/CodeNomad/releases/latest";
    let mut meta = serde_json::json!({
        "updateFeed": "stable", "serverVersion": "2.0.0", "update": null,
        "support": {"latestServerVersion": "2.1.0", "latestServerUrl": url},
    });
    assert_eq!(release_offer(&meta), (Some("2.1.0"), Some(url.to_owned())));
    meta["serverVersion"] = "2.1.0".into();
    assert_eq!(release_offer(&meta), (Some("2.1.0"), None));
    meta["updateFeed"] = "preview".into();
    assert_eq!(release_offer(&meta), (None, None));
}

fn connectivity(value: &Value) -> El {
    let host = value_text(&value["host"]);
    let addresses = addresses(value);
    let mut rows = vec![
        row("settings.info.server.os", server_os(value)),
        row(
            "settings.info.server.arch",
            value_text(&value["system"]["arch"]),
        ),
        row(
            "remoteAccess.sections.listeningMode.label",
            Some(t(listening_mode(value))),
        ),
        row("settings.info.connectivity.host", host),
        row(
            "settings.info.connectivity.localListener",
            value_text(&value["localUrl"]),
        ),
    ];
    if let Some(url) = value_text(&value["remoteUrl"]) {
        rows.push(row("settings.info.connectivity.remoteListener", Some(url)));
    }
    rows.push(row(
        "settings.info.server.root",
        value_text(&value["workspaceRoot"]),
    ));
    let mut block = col()
        .full_width()
        .separate(Space::Sm)
        .child(chrome::divided_rows(rows))
        .child(
            text(t("remoteAccess.sections.addresses.label"))
                .text_role(TextRole::Title)
                .role("heading"),
        );
    if addresses.is_empty() {
        block = block.child(chrome::empty_box(t("remoteAccess.addresses.none")));
    } else {
        block = block.child(chrome::divided_rows(
            addresses
                .into_iter()
                .map(|(label, url)| chrome::info_row(&label, &url, false)),
        ));
    }
    block.child(
        text(t("settings.info.connectivity.disclaimer"))
            .text_role(TextRole::Small)
            .wrap(),
    )
}

fn server_os(value: &Value) -> Option<&str> {
    value_text(&value["system"]["name"]).or_else(|| match value["system"]["platform"].as_str() {
        Some("win32") => Some("Windows"),
        Some("darwin") => Some("macOS"),
        Some("linux") => Some("Linux"),
        _ => value_text(&value["system"]["platform"]),
    })
}

fn normalize_host(host: &str) -> &str {
    host.trim().trim_matches(['[', ']'])
}

fn wildcard(host: &str) -> bool {
    normalize_host(host)
        .parse::<std::net::IpAddr>()
        .is_ok_and(|ip| ip.is_unspecified())
}

fn listening_mode(value: &Value) -> &'static str {
    if value["host"].as_str().is_some_and(wildcard) {
        return "settings.info.connectivity.mode.all";
    }
    match value["listeningMode"].as_str() {
        Some("all" | "specific") => "settings.info.connectivity.mode.specific",
        _ => "settings.info.connectivity.mode.local",
    }
}

fn addresses(value: &Value) -> Vec<(String, String)> {
    let Some(host) = value_text(&value["host"]) else {
        return Vec::new();
    };
    value["addresses"]
        .as_array()
        .into_iter()
        .flatten()
        .take(128)
        .filter_map(|address| {
            let ip = value_text(&address["ip"])?;
            if !wildcard(host) && !normalize_host(host).eq_ignore_ascii_case(normalize_host(ip)) {
                return None;
            }
            let family = value_text(&address["family"])?;
            let scope = match address["scope"].as_str() {
                Some("external") => "remoteAccess.address.scope.network",
                Some("internal") => "remoteAccess.address.scope.internal",
                _ => "remoteAccess.address.scope.loopback",
            };
            let url = codenomad_client::settings::info::listener_origin(value_text(
                &address["remoteUrl"],
            )?)?;
            Some((format!("{} · {}", family.to_uppercase(), t(scope)), url))
        })
        .collect()
}
