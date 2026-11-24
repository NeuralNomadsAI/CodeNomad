use super::{Info, Preferences, addresses, card, listening_mode, server_os, value_text};
use crate::{
    backend::Backend,
    platform::{self, diagnostics as device},
    strings::t,
};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::{
        OpenCodeStatus,
        info::{bug_report_link, listener_origin, utc_stamp},
        opencode_status,
    },
};
use rune::{El, Tx, Waker, text};
use rune_theme_codenomad::{layout, settings as chrome};
use serde_json::Value;
use std::{cell::RefCell, rc::Rc};

type Access<S> = fn(&mut S) -> Option<&mut Info>;

#[derive(Default)]
pub(super) struct Diagnostics {
    probed: bool,
    #[cfg(target_arch = "wasm32")]
    os_read: Option<Receiver<Option<String>>>,
    client_os: Option<String>,
    version_read: Option<(Sender<()>, Receiver<Option<OpenCodeStatus>>)>,
    opencode: Option<OpenCodeStatus>,
    form_read: Option<Receiver<Option<bool>>>,
    form: Option<bool>,
    feedback: Option<&'static str>,
    copy: Option<Receiver<bool>>,
    saving: bool,
    save: Option<Receiver<bool>>,
}

impl Diagnostics {
    pub(super) fn os(&self) -> String {
        self.client_os
            .clone()
            .unwrap_or_else(|| device::Client::snapshot().os)
    }

    #[cfg(target_arch = "wasm32")]
    pub(super) fn feedback(&self) -> Option<&'static str> {
        self.feedback
    }

    pub fn poll(&mut self, backend: Option<&Backend>, wake: &Waker) -> bool {
        if !self.probed
            && let Some(backend) = backend
        {
            self.probed = true;
            #[cfg(target_arch = "wasm32")]
            {
                let (out, reply) = bounded(1);
                self.os_read = Some(reply);
                let wake = wake.clone();
                platform::spawn(async move {
                    send(out, device::client_os_hint().await, &wake);
                });
            }
            let (cancel, cancelled) = bounded(1);
            let (out, reply) = bounded(1);
            self.version_read = Some((cancel, reply));
            let (backend, version_wake) = (backend.clone(), wake.clone());
            platform::spawn(async move {
                if let Some(result) =
                    platform::reads::cancellable(&cancelled, opencode_status(&backend, false)).await
                {
                    send(out, result.ok(), &version_wake);
                }
            });
            let (out, reply) = bounded(1);
            self.form_read = Some(reply);
            let wake = wake.clone();
            platform::spawn(async move {
                #[cfg(not(test))]
                let form = codenomad_client::settings::info::published_bug_form().await;
                #[cfg(test)]
                let form = None;
                send(out, form, &wake);
            });
        }
        let version = self
            .version_read
            .as_ref()
            .and_then(|(_, reply)| reply.try_recv().ok());
        let form = self
            .form_read
            .as_ref()
            .and_then(|reply| reply.try_recv().ok());
        let copy = self.copy.as_ref().and_then(|reply| reply.try_recv().ok());
        let save = self.save.as_ref().and_then(|reply| reply.try_recv().ok());
        let changed = version.is_some() || form.is_some() || copy.is_some() || save.is_some();
        #[cfg(target_arch = "wasm32")]
        let mut changed = changed;
        #[cfg(target_arch = "wasm32")]
        if let Some(os) = self
            .os_read
            .as_ref()
            .and_then(|reply| reply.try_recv().ok())
        {
            self.os_read = None;
            self.client_os = os;
            changed = true;
        }
        if let Some(version) = version {
            self.version_read = None;
            self.opencode = version;
        }
        if let Some(form) = form {
            self.form_read = None;
            self.form = form;
        }
        if let Some(copied) = copy {
            self.copy = None;
            self.feedback = Some(if copied {
                "settings.info.diagnostics.copied"
            } else {
                "settings.info.diagnostics.copyFailed"
            });
        }
        if let Some(saved) = save {
            self.save = None;
            self.saving = false;
            self.feedback = (!saved).then_some("settings.info.actions.failed");
        }
        changed
    }

    pub fn view<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        access: Access<S>,
        ready: bool,
    ) -> El {
        let copy = shared.clone();
        let save = shared.clone();
        let bug = shared.clone();
        let disabled = !ready || self.saving || self.copy.is_some();
        chrome::card(
            card("settings.info.diagnostics.title")
                .child(text(t("settings.info.diagnostics.privacy")).wrap())
                .child(
                    layout::action_row()
                        .child(layout::button_tx(
                            t("settings.info.diagnostics.copy"),
                            disabled,
                            move |s, tx| {
                                let Some(info) = access(s) else {
                                    return;
                                };
                                let prefs = copy.borrow();
                                let Some(meta) = info.current(&prefs) else {
                                    return;
                                };
                                let report = report(
                                    meta,
                                    info.diagnostics.opencode.as_ref(),
                                    &info.diagnostics.os(),
                                );
                                info.diagnostics.feedback = None;
                                copy_report(info, &prefs, tx, access, report);
                            },
                        ))
                        .child(layout::button_tx(
                            t("settings.info.diagnostics.download"),
                            disabled,
                            move |s, tx| {
                                let Some(info) = access(s) else {
                                    return;
                                };
                                let prefs = save.borrow();
                                let Some(meta) = info.current(&prefs) else {
                                    return;
                                };
                                let report = report(
                                    meta,
                                    info.diagnostics.opencode.as_ref(),
                                    &info.diagnostics.os(),
                                );
                                let name = utc_stamp().map_or_else(
                                    || "codenomad-diagnostics.txt".into(),
                                    |stamp| {
                                        format!(
                                            "codenomad-diagnostics-{}.txt",
                                            stamp.replace(':', "-")
                                        )
                                    },
                                );
                                info.diagnostics.feedback = None;
                                save_report(info, &prefs, tx, access, name, report);
                            },
                        ))
                        .child(chrome::primary_action_tx(
                            t("settings.info.diagnostics.reportBug"),
                            !ready,
                            move |s, tx| {
                                let Some(info) = access(s) else {
                                    return;
                                };
                                let prefs = bug.borrow();
                                let Some(meta) = info.current(&prefs) else {
                                    return;
                                };
                                let link = bug_link(
                                    meta,
                                    info.diagnostics.opencode.as_ref(),
                                    info.diagnostics.form,
                                    info.diagnostics.client_os.as_deref(),
                                );
                                info.diagnostics.feedback = tx
                                    .open_url(&link)
                                    .is_err()
                                    .then_some("settings.info.actions.failed");
                            },
                        )),
                )
                .children(self.feedback.map(|key| {
                    text(t(key))
                        .role(if key.ends_with(".copied") {
                            "status"
                        } else {
                            "alert"
                        })
                        .wrap()
                })),
        )
    }
}

fn send<T>(out: Sender<T>, value: T, wake: &Waker) {
    if out.try_send(value).is_ok() {
        wake();
    }
}

fn copy_report<S: 'static>(
    info: &mut Info,
    prefs: &Preferences,
    tx: &mut Tx,
    access: Access<S>,
    report: String,
) {
    let (out, reply) = bounded(1);
    info.diagnostics.copy = Some(reply);
    crate::chat::tools::children::note_clipboard_write();
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = prefs;
        let owner = info.owner.clone();
        tx.copy(report.clone());
        tx.read_clipboard(move |s, contents, _| {
            if access(s).is_some_and(|info| info.owner == owner) {
                let _ = out.try_send(contents.text() == report);
            }
        });
    }
    #[cfg(target_arch = "wasm32")]
    {
        let _ = (tx, access);
        if let Some(wake) = prefs.main_wake.clone() {
            device::copy(&report, move |copied| send(out, copied, &wake));
        } else {
            let _ = out.try_send(false);
        }
    }
}

fn save_report<S: 'static>(
    info: &mut Info,
    prefs: &Preferences,
    tx: &mut Tx,
    access: Access<S>,
    name: String,
    report: String,
) {
    #[cfg(target_arch = "wasm32")]
    {
        let _ = (prefs, tx, access);
        info.diagnostics.feedback = platform::download_file(&name, report.as_bytes())
            .is_err()
            .then_some("settings.info.actions.failed");
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let Some(wake) = prefs.window_wake.clone() else {
            return;
        };
        let owner = info.owner.clone();
        info.diagnostics.saving = true;
        tx.save_file(
            rune::file_dialog::FileDialogOptions {
                file_name: Some(name),
                ..Default::default()
            },
            move |s, result, _| {
                let Some(info) = access(s).filter(|info| info.owner == owner) else {
                    return;
                };
                match result {
                    Ok(Some(path)) => {
                        let (out, reply) = bounded(1);
                        info.diagnostics.save = Some(reply);
                        platform::spawn(async move {
                            send(out, device::save(path, report).await, &wake);
                        });
                    }
                    result => {
                        info.diagnostics.saving = false;
                        info.diagnostics.feedback =
                            result.is_err().then_some("settings.info.actions.failed");
                    }
                }
            },
        );
    }
}

fn report(meta: &Value, opencode: Option<&OpenCodeStatus>, os: &str) -> String {
    let text = |key: &str| value_text(&meta[key]);
    let date = utc_stamp();
    let local = text("localUrl").and_then(listener_origin);
    let remote = text("remoteUrl").and_then(listener_origin);
    let mut result = format!(
        "{}\n============================\n",
        t("settings.info.diagnostics.reportTitle")
    );
    let installed = opencode.and_then(|value| value.current.as_deref());
    let daemon = opencode.and_then(|value| value.running.as_deref());
    for (key, value) in [
        ("settings.info.diagnostics.generated", date.as_deref()),
        ("settings.info.version.server", text("serverVersion")),
        ("instanceInfo.labels.opencodeVersion", installed.or(daemon)),
        ("settings.opencode.setup.daemon", daemon),
        ("settings.info.server.os", server_os(meta)),
        (
            "settings.info.server.arch",
            value_text(&meta["system"]["arch"]),
        ),
        (
            "settings.info.version.ui",
            value_text(&meta["ui"]["version"]),
        ),
        (
            "settings.info.version.uiSource",
            value_text(&meta["ui"]["source"]),
        ),
        ("settings.info.runtime.type", Some(device::RUNTIME)),
        ("settings.info.runtime.platform", Some(device::PLATFORM)),
        ("settings.info.runtime.os", Some(os)),
        (
            "remoteAccess.sections.listeningMode.label",
            Some(t(listening_mode(meta))),
        ),
        ("settings.info.connectivity.host", text("host")),
        ("settings.info.connectivity.localListener", local.as_deref()),
        (
            "settings.info.connectivity.remoteListener",
            remote.as_deref(),
        ),
        ("settings.info.server.root", text("workspaceRoot")),
    ] {
        if key != "settings.opencode.setup.daemon"
            || installed.is_some() && daemon.is_some() && installed != daemon
        {
            result.push_str(&format!("{}: {}\n", t(key), value.unwrap_or("—")));
        }
    }
    let addresses = addresses(meta);
    result.push_str(&format!(
        "{}: {}\n",
        t("remoteAccess.sections.addresses.label"),
        addresses.len()
    ));
    for (family, address) in addresses {
        result.push_str(&format!("- {family}: {address}\n"));
    }
    result
}

fn public_word(value: Option<&str>) -> &str {
    value
        .filter(|word| {
            word.len() <= 128
                && !word.is_empty()
                && word
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+'))
        })
        .unwrap_or("")
}

fn bug_link(
    meta: &Value,
    opencode: Option<&OpenCodeStatus>,
    form: Option<bool>,
    client_os: Option<&str>,
) -> String {
    let server = public_word(meta["serverVersion"].as_str());
    let ui = public_word(meta["ui"]["version"].as_str());
    let version = match (server, ui) {
        ("", _) => ui.to_owned(),
        (_, "") => server.to_owned(),
        (server, ui) if server != ui => format!("{server} (UI {ui})"),
        _ => server.to_owned(),
    };
    let installed = public_word(opencode.and_then(|notice| notice.current.as_deref()));
    let running = public_word(opencode.and_then(|notice| notice.running.as_deref()));
    let opencode = match (installed, running) {
        ("", _) => running.to_owned(),
        (_, "") => installed.to_owned(),
        _ if installed != running => format!("{installed} (running daemon {running})"),
        _ => installed.to_owned(),
    };
    let platform = match meta["system"]["platform"].as_str() {
        Some("win32" | "windows") => "Windows",
        Some("darwin" | "macos") => "macOS",
        Some("linux") => "Linux",
        Some("freebsd") => "FreeBSD",
        _ => "—",
    };
    let os = meta["system"]["name"]
        .as_str()
        .filter(|name| {
            !name.is_empty()
                && name.len() <= 128
                && name
                    .chars()
                    .all(|c| c.is_alphanumeric() || " ()._-".contains(c))
                && !name
                    .split(|c: char| !c.is_ascii_digit() && c != '.')
                    .any(|word| word.parse::<std::net::Ipv4Addr>().is_ok())
        })
        .unwrap_or(platform);
    let arch = public_word(meta["system"]["arch"].as_str());
    let client = device::Client::snapshot();
    let mut context = format!(
        "- Client: {} ({}, {} window)\n- UI source: {}\n- Server OS: {os} {arch}",
        client.runtime,
        client.platform,
        client.context,
        public_word(meta["ui"]["source"].as_str())
    );
    if let Some(browser) = &client.browser {
        context.push_str(&format!("\n- Browser: {browser}"));
    }
    bug_report_link(
        [
            &version,
            &opencode,
            client_os.unwrap_or(&client.os),
            &context,
        ],
        form,
    )
}

#[cfg(test)]
#[test]
fn report_and_public_issue_have_different_data_boundaries() {
    let meta = serde_json::json!({
        "serverVersion":"9.0.1", "ui":{"version":"9.0.2","source":"fixture"},
        "host":"192.0.2.10", "localUrl":"http://127.0.0.1:3456",
        "remoteUrl":"https://192.0.2.10:3457/path?token=private",
        "workspaceRoot":"D:/private/project", "password":"not-in-either",
        "addresses":[
            {"ip":"192.0.2.10","family":"ipv4","remoteUrl":"https://192.0.2.10:3457"},
            {"ip":"192.0.2.11","family":"ipv4","remoteUrl":"https://192.0.2.11:3457"}
        ]
    });
    let local = report(&meta, None, "Windows x64");
    assert!(local.contains("D:/private/project") && local.contains("192.0.2.10:3457"));
    assert!(
        !local.contains("token=private")
            && !local.contains("192.0.2.11")
            && !local.contains("not-in-either")
    );
    let issue = bug_link(&meta, None, None, None);
    assert!(issue.contains("9.0.1") && issue.contains("9.0.2"));
    assert!(
        !issue.contains("192.0.2") && !issue.contains("127.0.0.1") && !issue.contains("private")
    );
}
