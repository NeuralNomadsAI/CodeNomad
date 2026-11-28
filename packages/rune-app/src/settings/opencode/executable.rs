use super::super::Preferences;
use crate::{history::Result, platform, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::{BinaryValidation, OpenCodeStatus, validate_opencode_binary},
};
use rune::{El, TextEdit, col};
use rune_theme_codenomad::{
    Space, field_kit,
    layout::{self, Layout},
    settings as chrome,
};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
};

struct SubmitFlight {
    path: String,
    intent: u64,
    transport_epoch: u64,
    _cancel: Sender<()>,
    rx: Receiver<Result<BinaryValidation>>,
}

struct BgFlight {
    path: String,
    transport_epoch: u64,
    _cancel: Sender<()>,
    rx: Receiver<Result<BinaryValidation>>,
}

#[derive(Default)]
pub(super) struct State {
    authority: Option<String>,
    transport_epoch: Option<u64>,
    selection_intent: u64,
    custom_open: bool,
    custom_path: TextEdit,
    validation_error: Option<String>,
    versions: BTreeMap<String, String>,
    validated: BTreeSet<String>,
    bg_flight: Option<BgFlight>,
    submit_flight: Option<SubmitFlight>,
    last_selected: Option<String>,
}

impl State {
    pub(super) fn poll(
        &mut self,
        prefs: &mut Preferences,
        wake: &rune::Waker,
        status: Option<&OpenCodeStatus>,
    ) -> (bool, bool) {
        let transport = prefs.opencode_transport_generation();
        let epoch = transport.as_ref().map(|(_, epoch)| *epoch);
        let backend = prefs
            .backend
            .as_ref()
            .filter(|_| prefs.can_retry())
            .cloned();
        let authority = backend.as_ref().map(|backend| backend.client_id.as_str());
        let mut changed = authority != self.authority.as_deref();
        if changed {
            *self = Self {
                authority: authority.map(str::to_owned),
                transport_epoch: epoch,
                ..Self::default()
            };
        } else if epoch != self.transport_epoch {
            self.transport_epoch = epoch;
            self.selection_intent = self.selection_intent.wrapping_add(1);
            self.bg_flight = None;
            self.submit_flight = None;
            changed = true;
        }
        let mut binary_changed = false;
        let current_selected = prefs.opencode_binary();
        if current_selected != self.last_selected {
            if self.last_selected.is_some() && current_selected.is_some() {
                binary_changed = true;
                self.selection_intent = self.selection_intent.wrapping_add(1);
                self.submit_flight = None;
            }
            self.last_selected = current_selected;
            changed = true;
        }
        for entry in prefs.opencode_binaries() {
            if let Some(version) = entry.version
                && !self.versions.contains_key(&entry.path)
            {
                self.versions.insert(entry.path, version);
                changed = true;
            }
        }
        if let Some(status) = status
            && status.has_installation_source
            && let Some(version) = &status.current
            && self.versions.get("opencode2") != Some(version)
        {
            self.versions.insert("opencode2".into(), version.clone());
            self.validated.insert("opencode2".into());
            changed = true;
        }

        if prefs.opencode_install.busy() {
            if self.submit_flight.take().is_some() || self.bg_flight.take().is_some() {
                self.selection_intent = self.selection_intent.wrapping_add(1);
                changed = true;
            }
            return (changed, binary_changed);
        }

        let submit_done = self.submit_flight.as_ref().and_then(|flight| {
            flight.rx.try_recv().ok().map(|res| {
                (
                    flight.path.clone(),
                    flight.intent,
                    flight.transport_epoch,
                    res,
                )
            })
        });
        if let Some((path, intent, flight_epoch, result)) = submit_done {
            self.submit_flight = None;
            changed = true;
            if intent == self.selection_intent && Some(flight_epoch) == self.transport_epoch {
                match result {
                    Ok(validation) if validation.valid => {
                        self.validated.insert(path.clone());
                        if let Some(version) = &validation.version {
                            self.versions.insert(path.clone(), version.clone());
                        }
                        self.validation_error = None;
                        if !prefs.opencode_install.busy()
                            && prefs.opencode_binary_available()
                            && !prefs.opencode_binary_pending()
                            && prefs.select_opencode_binary(
                                &path,
                                validation.version,
                                platform::storage::unix_millis(),
                            )
                        {
                            self.custom_path = TextEdit::default();
                        }
                    }
                    Ok(validation) => {
                        self.validated.insert(path);
                        self.validation_error = Some(validation_message(&validation));
                    }
                    Err(_) => {
                        self.validation_error =
                            Some(t("settings.opencode.setup.actionFailed").into());
                    }
                }
            }
        }

        let bg_done = self.bg_flight.as_ref().and_then(|flight| {
            flight
                .rx
                .try_recv()
                .ok()
                .map(|res| (flight.path.clone(), flight.transport_epoch, res))
        });
        if let Some((path, flight_epoch, result)) = bg_done {
            self.bg_flight = None;
            changed = true;
            if Some(flight_epoch) == self.transport_epoch {
                self.validated.insert(path.clone());
                if let Ok(validation) = result
                    && validation.valid
                    && let Some(version) = validation.version
                {
                    self.versions.insert(path, version);
                }
            }
        }

        if let Some(backend) = backend
            && let Some(epoch) = self.transport_epoch
            && !prefs.opencode_install.busy()
            && self.bg_flight.is_none()
            && self.submit_flight.is_none()
            && prefs.opencode_binary_available()
        {
            let mut candidates = vec!["opencode2".to_owned()];
            for entry in prefs.opencode_binaries() {
                candidates.push(entry.path);
            }
            if let Some(next_path) = candidates
                .into_iter()
                .find(|path| !self.versions.contains_key(path) && !self.validated.contains(path))
            {
                let (out, rx) = bounded(1);
                let (cancel, cancelled) = bounded(1);
                let path = next_path.clone();
                let wake = wake.clone();
                self.bg_flight = Some(BgFlight {
                    path: next_path,
                    transport_epoch: epoch,
                    _cancel: cancel,
                    rx,
                });
                changed = true;
                platform::spawn(async move {
                    if let Some(result) = platform::reads::cancellable(
                        &cancelled,
                        validate_opencode_binary(&backend, &path),
                    )
                    .await
                        && out.send(result).await.is_ok()
                    {
                        wake();
                    }
                });
            }
        }

        (changed, binary_changed)
    }

    pub(super) fn select_saved(&mut self, prefs: &mut Preferences, path: &str) -> bool {
        if prefs.opencode_install.busy() {
            return false;
        }
        if !prefs.select_opencode_binary(path, None, platform::storage::unix_millis()) {
            return false;
        }
        self.selection_intent = self.selection_intent.wrapping_add(1);
        self.submit_flight = None;
        self.validation_error = None;
        true
    }

    pub(super) fn remove_saved(&mut self, prefs: &mut Preferences, path: &str) -> bool {
        if prefs.opencode_install.busy() {
            return false;
        }
        if !prefs.remove_opencode_binary(path) {
            return false;
        }
        self.selection_intent = self.selection_intent.wrapping_add(1);
        self.submit_flight = None;
        true
    }

    pub(super) fn submit_custom(&mut self, prefs: &Preferences, wake: Option<rune::Waker>) {
        if prefs.opencode_install.busy()
            || !prefs.opencode_binary_available()
            || prefs.opencode_binary_pending()
        {
            return;
        }
        let path = self.custom_path.text.trim().to_owned();
        if path.is_empty() {
            return;
        }
        if self.submit_flight.is_some()
            || self
                .bg_flight
                .as_ref()
                .is_some_and(|flight| flight.path == path)
        {
            self.validation_error =
                Some(t("opencodeBinarySelector.validation.alreadyValidating").into());
            return;
        }
        let (Some((_, epoch)), Some(backend), Some(wake)) = (
            prefs.opencode_transport_generation(),
            prefs.backend.clone(),
            wake,
        ) else {
            return;
        };
        self.validation_error = None;
        self.selection_intent = self.selection_intent.wrapping_add(1);
        let intent = self.selection_intent;
        let (out, rx) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        let target = path.clone();
        self.submit_flight = Some(SubmitFlight {
            path,
            intent,
            transport_epoch: epoch,
            _cancel: cancel,
            rx,
        });
        platform::spawn(async move {
            if let Some(result) = platform::reads::cancellable(
                &cancelled,
                validate_opencode_binary(&backend, &target),
            )
            .await
                && out.send(result).await.is_ok()
            {
                wake();
            }
        });
    }

    fn is_validating(&self, path: &str) -> bool {
        self.bg_flight
            .as_ref()
            .is_some_and(|flight| flight.path == path)
            || self
                .submit_flight
                .as_ref()
                .is_some_and(|flight| flight.path == path)
    }

    pub(super) fn view<S: 'static>(
        &self,
        prefs: &Preferences,
        shared: &Rc<RefCell<Preferences>>,
        status: Option<&OpenCodeStatus>,
        wake: Option<rune::Waker>,
        access: fn(&mut S) -> &mut super::Status,
    ) -> El {
        let disabled = prefs.opencode_install.busy()
            || !prefs.opencode_binary_available()
            || prefs.opencode_binary_pending();
        let validating = self.bg_flight.is_some() || self.submit_flight.is_some();
        let selected = prefs
            .opencode_binary()
            .unwrap_or_else(|| "opencode2".into());
        let default_version = status
            .filter(|s| s.has_installation_source)
            .and_then(|s| s.current.as_deref())
            .or_else(|| self.versions.get("opencode2").map(String::as_str));

        let header = chrome::card_header(
            t("opencodeBinarySelector.title"),
            validating.then(|| t("opencodeBinarySelector.status.checkingVersions")),
        );

        let placeholder = rune_theme_codenomad::catalogue::format(
            crate::strings::locale(),
            "opencodeBinarySelector.customPath.placeholder",
            &[("name", "opencode2")],
        );
        let add_shared = shared.clone();
        let add_wake = wake.clone();
        let enter_shared = shared.clone();
        let enter_wake = wake;
        let can_add =
            !disabled && self.submit_flight.is_none() && !self.custom_path.text.trim().is_empty();
        let mut custom_body =
            col()
                .full_width()
                .separate(Space::Sm)
                .child(chrome::input_action_row(
                    layout::hinted_field(&self.custom_path, &placeholder)
                        .label(&placeholder)
                        .disabled(disabled || self.submit_flight.is_some())
                        .on_edit(move |s| &mut access(s).executable.custom_path)
                        .build(&field_kit(layout::dark()))
                        .key("opencode-binary-path")
                        .on_key(move |s, event, tx| {
                            if event.key == rune::Key::Enter
                                && event.mods == rune::Mods::default()
                                && !tx.key_repeat()
                            {
                                let prefs = enter_shared.borrow();
                                access(s)
                                    .executable
                                    .submit_custom(&prefs, enter_wake.clone());
                                true
                            } else {
                                false
                            }
                        }),
                    chrome::primary_action(
                        t("opencodeBinarySelector.actions.add"),
                        !can_add,
                        move |s| {
                            let prefs = add_shared.borrow();
                            access(s).executable.submit_custom(&prefs, add_wake.clone());
                        },
                    )
                    .key("opencode-binary-add"),
                ));
        if let Some(error) = &self.validation_error {
            custom_body = custom_body
                .child(chrome::palette::save_error(error).key("opencode-binary-validation-error"));
        }

        let default_label = rune_theme_codenomad::catalogue::format(
            crate::strings::locale(),
            "opencodeBinarySelector.display.systemPath",
            &[("name", "opencode2")],
        );
        let mut items = vec![self.binary_row::<S>(
            shared,
            &default_label,
            "opencode2",
            true,
            selected == "opencode2",
            default_version,
            disabled,
            access,
        )];
        for entry in prefs.opencode_binaries() {
            let version = self
                .versions
                .get(&entry.path)
                .map(String::as_str)
                .or(entry.version.as_deref());
            let name = display_name(&entry.path);
            items.push(self.binary_row::<S>(
                shared,
                name,
                &entry.path,
                false,
                selected == entry.path,
                version,
                disabled,
                access,
            ));
        }
        let list = chrome::binary_list(items);

        let mut card = col()
            .full_width()
            .separate(Space::Sm)
            .child(header)
            .child(
                chrome::disclosure(
                    t("opencodeBinarySelector.actions.chooseOther"),
                    self.custom_open,
                    custom_body,
                    move |s| {
                        let state = &mut access(s).executable;
                        state.custom_open = !state.custom_open;
                    },
                )
                .key("opencode-binary-other"),
            )
            .child(list);

        if let Some(error) = prefs.opencode_binary_failed() {
            let retry_shared = shared.clone();
            card = card.child(
                layout::action_row()
                    .child(chrome::palette::save_error(t(error)))
                    .child(layout::button(
                        t("sessionList.loadError.retry"),
                        !prefs.can_retry() || prefs.opencode_binary_pending(),
                        move |_: &mut S| retry_shared.borrow_mut().retry_opencode_binary(),
                    )),
            );
        }
        chrome::card(card)
    }

    #[allow(clippy::too_many_arguments)]
    fn binary_row<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        label: &str,
        path: &str,
        is_default: bool,
        selected: bool,
        version: Option<&str>,
        disabled: bool,
        access: fn(&mut S) -> &mut super::Status,
    ) -> El {
        let mut caption = String::new();
        if let Some(version) = version {
            caption.push_str(&rune_theme_codenomad::catalogue::format(
                crate::strings::locale(),
                "opencodeBinarySelector.versionLabel",
                &[("version", version)],
            ));
        }
        if self.is_validating(path) {
            if !caption.is_empty() {
                caption.push_str(" · ");
            }
            caption.push_str(t("opencodeBinarySelector.status.checking"));
        }
        let select_shared = shared.clone();
        let select_path = path.to_owned();
        let key = if is_default {
            "opencode-binary-default".to_owned()
        } else {
            format!("opencode-binary-item-{path}")
        };
        let remove = (!is_default).then(|| {
            let remove_shared = shared.clone();
            let remove_path = path.to_owned();
            (
                format!("opencode-binary-remove-{path}"),
                t("opencodeBinarySelector.actions.removeTitle"),
                move |s: &mut S| {
                    access(s)
                        .executable
                        .remove_saved(&mut remove_shared.borrow_mut(), &remove_path);
                },
            )
        });
        chrome::binary_row_item(
            label,
            (!is_default).then_some(path),
            (!caption.is_empty()).then_some(caption.as_str()),
            selected,
            disabled,
            key,
            move |s: &mut S| {
                if !selected {
                    access(s)
                        .executable
                        .select_saved(&mut select_shared.borrow_mut(), &select_path);
                }
            },
            remove,
        )
    }
}

fn display_name(path: &str) -> &str {
    path.rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(path)
}

fn validation_message(validation: &BinaryValidation) -> String {
    if validation.v2_required {
        t("opencodeBinarySelector.validation.v2Required").into()
    } else if let Some(error) = &validation.error {
        error.clone()
    } else {
        t("opencodeBinarySelector.validation.invalidBinary").into()
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use codenomad_client::backend::Backend;
    use serde_json::{Value, json};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::time::timeout;

    struct HttpRequest {
        first: String,
        body: Value,
        stream: TcpStream,
    }

    impl HttpRequest {
        async fn read(listener: &TcpListener) -> Self {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut raw = Vec::new();
            let mut chunk = [0u8; 4096];
            let header_end = loop {
                let n = stream.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                raw.extend_from_slice(&chunk[..n]);
                if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    break pos + 4;
                }
            };
            let head = String::from_utf8_lossy(&raw[..header_end]).into_owned();
            let first = head.lines().next().unwrap_or_default().to_owned();
            let content_len = head
                .lines()
                .find_map(|line| {
                    let (name, val) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| val.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            while raw.len() < header_end + content_len {
                let n = stream.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break;
                }
                raw.extend_from_slice(&chunk[..n]);
            }
            let body = if content_len > 0 {
                serde_json::from_slice(&raw[header_end..header_end + content_len])
                    .unwrap_or(Value::Null)
            } else {
                Value::Null
            };
            Self {
                first,
                body,
                stream,
            }
        }

        async fn reply(mut self, status: u16, body: Value) {
            let payload = body.to_string();
            let reason = match status {
                200 => "OK",
                _ => "ERR",
            };
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                payload.len()
            );
            self.stream.write_all(response.as_bytes()).await.unwrap();
        }
    }

    #[test]
    fn saved_selection_passes_none_version_and_supersedes_late_validation() {
        platform::block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let backend =
                Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
                    .await
                    .unwrap();
            let wake: rune::Waker = Arc::new(|| {});
            let mut prefs = Preferences::default();
            prefs.bind(Some(backend));
            prefs.show_opencode();

            let mut server_doc = json!({ "logLevel": "INFO", "opencodeBinary": "opencode2" });
            let mut state_doc = json!({
                "opencodeBinaries": [
                    { "path": "/saved/opencode2", "version": "2.3.1", "lastUsed": 10 }
                ]
            });

            // Hydrate Preferences snapshots through real loopback reads.
            for _ in 0..16 {
                prefs.poll();
                let mut handled = 0usize;
                while let Ok(req) =
                    timeout(Duration::from_millis(50), HttpRequest::read(&listener)).await
                {
                    handled += 1;
                    match req.first.as_str() {
                        "GET /api/meta HTTP/1.1" => {
                            req.reply(200, json!({"version": "1.0.0"})).await
                        }
                        "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" => {
                            req.reply(200, json!({})).await;
                        }
                        "GET /api/storage/config/server?authoritative=1 HTTP/1.1" => {
                            req.reply(200, server_doc.clone()).await;
                        }
                        "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" => {
                            req.reply(200, state_doc.clone()).await;
                        }
                        other => panic!("unexpected setup request: {other}"),
                    }
                }
                if handled == 0 && prefs.opencode_binary_available() {
                    break;
                }
            }
            assert!(prefs.opencode_binary_available());

            let status = OpenCodeStatus {
                current: Some("2.3.1".into()),
                running: None,
                minimum: None,
                recommended: None,
                latest: None,
                update_available: false,
                check_failed: false,
                state: "ready",
                restart: None,
                can_upgrade: false,
                needs_shared_installation: false,
                foreign_installation: false,
                has_installation_source: true,
                binary_path: None,
            };
            let mut exec = State::default();
            exec.poll(&mut prefs, &wake, Some(&status));
            assert!(exec.bg_flight.is_none());
            // Put a different locally cached version to prove ordinary saved selection does not
            // overwrite the persisted version with a cached one (passes None instead).
            exec.versions
                .insert("/saved/opencode2".into(), "9.9.9".into());

            // Start custom binary validation; hold the HTTP response open.
            exec.custom_path = TextEdit::new("/custom/late");
            exec.submit_custom(&prefs, Some(wake.clone()));
            assert!(exec.submit_flight.is_some());
            let late_validation_req = timeout(Duration::from_secs(2), HttpRequest::read(&listener))
                .await
                .expect("validate-binary request");
            assert_eq!(
                late_validation_req.first,
                "POST /api/storage/binaries/validate HTTP/1.1"
            );
            assert_eq!(late_validation_req.body["path"], "/custom/late");

            // User selects a saved binary while custom validation is still in flight.
            assert!(exec.select_saved(&mut prefs, "/saved/opencode2"));
            assert!(
                exec.submit_flight.is_none(),
                "selecting a saved binary must cancel in-flight custom validation"
            );

            // Complete the saved selection PATCHes and verify persisted version "2.3.1" was kept.
            let mut saw_binaries_patch = false;
            for _ in 0..16 {
                prefs.poll();
                let mut handled = 0usize;
                while let Ok(req) =
                    timeout(Duration::from_millis(50), HttpRequest::read(&listener)).await
                {
                    handled += 1;
                    match req.first.as_str() {
                        "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" => {
                            req.reply(200, state_doc.clone()).await;
                        }
                        "POST /api/storage/binaries/validate HTTP/1.1" => {
                            assert_eq!(req.body["path"], "/saved/opencode2");
                            req.reply(200, json!({"valid": true, "version": "2.3.1"}))
                                .await;
                        }
                        "PATCH /api/storage/config/server HTTP/1.1" => {
                            assert_eq!(req.body["opencodeBinary"], "/saved/opencode2");
                            server_doc["opencodeBinary"] = req.body["opencodeBinary"].clone();
                            req.reply(200, server_doc.clone()).await;
                        }
                        "PATCH /api/storage/state/ui HTTP/1.1" => {
                            saw_binaries_patch = true;
                            let saved_entry = &req.body["opencodeBinaries"][0];
                            assert_eq!(saved_entry["path"], "/saved/opencode2");
                            assert_eq!(
                                saved_entry["version"], "2.3.1",
                                "ordinary saved selection must pass None and preserve persisted version"
                            );
                            state_doc["opencodeBinaries"] = req.body["opencodeBinaries"].clone();
                            req.reply(200, state_doc.clone()).await;
                        }
                        other => panic!("unexpected selection request: {other}"),
                    }
                }
                if handled == 0 && !prefs.opencode_binary_pending() {
                    break;
                }
            }
            assert!(saw_binaries_patch);
            assert_eq!(prefs.opencode_binary().as_deref(), Some("/saved/opencode2"));
            exec.poll(&mut prefs, &wake, None);

            // Even if the late validation response completes now, it must never overwrite the newer
            // selection (both through the cancelled channel and via stale intent/epoch fencing).
            late_validation_req
                .reply(200, json!({"valid": true, "version": "2.5.0"}))
                .await;
            let (tx_stale, rx_stale) = bounded(1);
            let (cancel_stale, _cancelled) = bounded(1);
            tx_stale
                .try_send(Ok(BinaryValidation {
                    valid: true,
                    version: Some("2.5.0".into()),
                    error: None,
                    v2_required: false,
                }))
                .unwrap();
            let current_epoch = exec.transport_epoch.unwrap();
            exec.submit_flight = Some(SubmitFlight {
                path: "/custom/late".into(),
                intent: exec.selection_intent.wrapping_sub(1),
                transport_epoch: current_epoch,
                _cancel: cancel_stale,
                rx: rx_stale,
            });
            exec.poll(&mut prefs, &wake, None);
            assert_eq!(prefs.opencode_binary().as_deref(), Some("/saved/opencode2"));
            assert!(!prefs.opencode_binary_pending());
            assert!(exec.submit_flight.is_none());

            // A stale transport epoch also prevents a pre-drop validation from applying.
            let (tx_epoch, rx_epoch) = bounded(1);
            let (cancel_epoch, _cancelled_epoch) = bounded(1);
            tx_epoch
                .try_send(Ok(BinaryValidation {
                    valid: true,
                    version: Some("2.5.0".into()),
                    error: None,
                    v2_required: false,
                }))
                .unwrap();
            exec.submit_flight = Some(SubmitFlight {
                path: "/custom/pre-drop".into(),
                intent: exec.selection_intent,
                transport_epoch: current_epoch.wrapping_sub(1),
                _cancel: cancel_epoch,
                rx: rx_epoch,
            });
            exec.poll(&mut prefs, &wake, None);
            assert_eq!(prefs.opencode_binary().as_deref(), Some("/saved/opencode2"));
            assert!(!prefs.opencode_binary_pending());
        });
    }
}
