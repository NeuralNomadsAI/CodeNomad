use super::super::Preferences;
use crate::{history::Result, platform, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::{LoginStartError, LoginStartState, opencode_login_start, set_opencode_login_start},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole,
    layout::{self, Layout},
    settings as chrome,
};
use std::{cell::RefCell, rc::Rc};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Failure {
    Read,
    Failed,
    UnsupportedBinary,
}

impl Failure {
    fn key(self) -> &'static str {
        match self {
            Self::Read => "settings.loginStart.error.read",
            Self::Failed => "settings.loginStart.error.failed",
            Self::UnsupportedBinary => "settings.loginStart.error.unsupported-binary",
        }
    }
}

impl From<LoginStartError> for Failure {
    fn from(error: LoginStartError) -> Self {
        match error {
            LoginStartError::UnsupportedBinary => Self::UnsupportedBinary,
            LoginStartError::Failed => Self::Failed,
        }
    }
}

#[derive(Default)]
pub(super) struct State {
    authority: Option<String>,
    transport_epoch: Option<u64>,
    status: Option<LoginStartState>,
    failure: Option<Failure>,
    sequence: u64,
    read_flight: Option<(u64, Sender<()>, Receiver<Result<LoginStartState>>)>,
    write_flight: Option<(
        u64,
        Receiver<std::result::Result<LoginStartState, LoginStartError>>,
    )>,
    pending_write_error: Option<LoginStartError>,
    needs_reload: bool,
    info_open: bool,
}

impl State {
    pub(super) fn poll(&mut self, prefs: &Preferences, wake: &rune::Waker) -> bool {
        let transport = prefs.opencode_transport_generation();
        let epoch = transport.as_ref().map(|(_, epoch)| *epoch);
        let authority = prefs
            .backend
            .as_ref()
            .filter(|_| prefs.can_retry())
            .map(|backend| backend.client_id.as_str());
        let mut changed = authority != self.authority.as_deref();
        if changed {
            *self = Self {
                authority: authority.map(str::to_owned),
                transport_epoch: epoch,
                ..Self::default()
            };
        } else if epoch != self.transport_epoch {
            self.transport_epoch = epoch;
            changed = true;
            // Cancel pre-drop reads so stale responses cannot overwrite post-reconnect state;
            // never replay an in-flight POST.
            self.read_flight = None;
            if let Some(error) = self.pending_write_error.take() {
                self.failure = Some(Failure::from(error));
            }
            self.sequence = self.sequence.wrapping_add(1);
            self.needs_reload = true;
        }

        let write_done = self
            .write_flight
            .as_ref()
            .and_then(|(seq, rx)| rx.try_recv().ok().map(|res| (*seq, res)));
        if let Some((seq, result)) = write_done {
            self.write_flight = None;
            changed = true;
            if seq == self.sequence && self.transport_epoch.is_some() {
                match result {
                    Ok(state) => {
                        self.status = Some(state);
                        self.failure = None;
                        self.pending_write_error = None;
                        self.needs_reload = false;
                    }
                    Err(error) => {
                        // Reload actual host state after a refused change; keep the cause unless
                        // reading the host state also fails.
                        if self.start_read(prefs, wake) {
                            self.pending_write_error = Some(error);
                            self.needs_reload = false;
                        } else {
                            self.failure = Some(Failure::from(error));
                            self.needs_reload = true;
                        }
                    }
                }
            } else {
                // Transport dropped or reconnected while the POST was in flight: ignore the
                // pre-reconnect response and force an authoritative follow-up GET once online.
                self.pending_write_error = None;
                self.needs_reload = true;
            }
        }

        let read_done = self
            .read_flight
            .as_ref()
            .and_then(|(seq, _, rx)| rx.try_recv().ok().map(|res| (*seq, res)));
        if let Some((seq, result)) = read_done {
            self.read_flight = None;
            changed = true;
            if seq == self.sequence && self.transport_epoch.is_some() {
                let write_error = self.pending_write_error.take();
                match result {
                    Ok(state) => {
                        self.status = Some(state);
                        self.failure = write_error.map(Failure::from);
                    }
                    Err(_) => {
                        self.failure = Some(Failure::Read);
                    }
                }
            }
        }

        if transport.is_some()
            && !self.busy()
            && self.read_flight.is_none()
            && (self.needs_reload || (self.status.is_none() && self.failure.is_none()))
            && self.start_read(prefs, wake)
        {
            self.needs_reload = false;
            changed = true;
        }
        changed
    }

    pub(super) fn reload(&mut self, prefs: &Preferences, wake: Option<&rune::Waker>) {
        if self.busy() || self.read_flight.is_some() {
            return;
        }
        let Some(wake) = wake else {
            return;
        };
        self.pending_write_error = None;
        if self.start_read(prefs, wake) {
            self.needs_reload = false;
        }
    }

    fn start_read(&mut self, prefs: &Preferences, wake: &rune::Waker) -> bool {
        if prefs.opencode_transport_generation().is_none() {
            return false;
        }
        let Some(backend) = prefs.backend.clone() else {
            return false;
        };
        self.sequence = self.sequence.wrapping_add(1);
        let seq = self.sequence;
        let (out, rx) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        self.read_flight = Some((seq, cancel, rx));
        let wake = wake.clone();
        platform::spawn(async move {
            if let Some(result) =
                platform::reads::cancellable(&cancelled, opencode_login_start(&backend)).await
                && out.send(result).await.is_ok()
            {
                wake();
            }
        });
        true
    }

    fn toggle(&mut self, prefs: &Preferences, wake: Option<rune::Waker>, enabled: bool) {
        if self.busy()
            || self.read_flight.is_some()
            || self.needs_reload
            || self.status.is_none()
            || self.status == Some(LoginStartState::Unavailable)
            || prefs.opencode_transport_generation().is_none()
        {
            return;
        }
        let (Some(backend), Some(wake)) = (prefs.backend.clone(), wake) else {
            return;
        };
        self.sequence = self.sequence.wrapping_add(1);
        let seq = self.sequence;
        self.read_flight = None;
        self.failure = None;
        self.pending_write_error = None;
        let (out, rx) = bounded(1);
        self.write_flight = Some((seq, rx));
        platform::spawn(async move {
            let result = set_opencode_login_start(&backend, enabled).await;
            if out.send(result).await.is_ok() {
                wake();
            }
        });
    }

    fn busy(&self) -> bool {
        self.write_flight.is_some()
            || (self.pending_write_error.is_some() && self.read_flight.is_some())
    }

    pub(super) fn view<S: 'static>(
        &self,
        prefs: &Preferences,
        shared: &Rc<RefCell<Preferences>>,
        wake: Option<rune::Waker>,
        access: fn(&mut S) -> &mut super::Status,
    ) -> El {
        let title = t("settings.loginStart.title");
        let unavailable = self.status == Some(LoginStartState::Unavailable);
        let checked = self.status == Some(LoginStartState::On);
        let online = prefs.opencode_transport_generation().is_some();
        let disabled = self.busy()
            || self.read_flight.is_some()
            || self.needs_reload
            || self.status.is_none()
            || unavailable
            || !online;
        let toggle_shared = shared.clone();
        let toggle_wake = wake.clone();
        let switch = chrome::setting_switch(title, checked, disabled, move |s: &mut S| {
            let prefs = toggle_shared.borrow();
            access(s)
                .login_start
                .toggle(&prefs, toggle_wake.clone(), !checked);
        })
        .key("opencode-login-start-switch");
        let info = chrome::info_tip(
            t("settings.loginStart.info"),
            t("settings.loginStart.info"),
            self.info_open,
            move |s: &mut S| {
                let state = &mut access(s).login_start;
                state.info_open = !state.info_open;
            },
        )
        .key("opencode-login-start-info");

        let mut card = col()
            .full_width()
            .separate(Space::Sm)
            .child(chrome::setting_row_with_info(title, Some(info), switch));

        if unavailable {
            card = card.child(
                text(t("settings.loginStart.unavailable"))
                    .text_role(TextRole::Small)
                    .wrap()
                    .role("status")
                    .key("opencode-login-start-unavailable"),
            );
        }
        if let Some(failure) = self.failure {
            let mut row = layout::action_row().child(
                chrome::palette::save_error(t(failure.key())).key("opencode-login-start-error"),
            );
            if failure == Failure::Read {
                let retry_shared = shared.clone();
                let retry_wake = wake;
                row = row.child(
                    chrome::secondary_action(
                        t("settings.loginStart.retry"),
                        self.read_flight.is_some() || !online,
                        move |s: &mut S| {
                            let prefs = retry_shared.borrow();
                            access(s).login_start.reload(&prefs, retry_wake.as_ref());
                        },
                    )
                    .key("opencode-login-start-retry"),
                );
            }
            card = card.child(row);
        }
        chrome::card(card)
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
            Self { first, stream }
        }

        async fn reply(mut self, status: u16, body: Value) {
            let payload = body.to_string();
            let reason = match status {
                200 => "OK",
                422 => "Unprocessable Entity",
                _ => "ERR",
            };
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                payload.len()
            );
            self.stream.write_all(response.as_bytes()).await.unwrap();
        }
    }

    async fn wait_for_request(listener: &TcpListener, expected: &str) -> HttpRequest {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let remaining = deadline
                .checked_duration_since(std::time::Instant::now())
                .expect("timed out waiting for expected HTTP request");
            let req = timeout(remaining, HttpRequest::read(listener))
                .await
                .expect("request deadline");
            if req.first == expected {
                return req;
            }
            match req.first.as_str() {
                "GET /api/meta HTTP/1.1" => req.reply(200, json!({"version": "1.0.0"})).await,
                "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
                | "GET /api/storage/state/ui?authoritative=1 HTTP/1.1"
                | "GET /api/storage/config/server?authoritative=1 HTTP/1.1" => {
                    req.reply(200, json!({})).await;
                }
                other => panic!("unexpected request while waiting for {expected}: {other}"),
            }
        }
    }

    async fn revalidate_prefs(prefs: &mut Preferences, listener: &TcpListener) {
        prefs.revalidate_transport();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while prefs.is_transport_lost() {
            prefs.poll();
            if let Ok(req) = timeout(Duration::from_millis(40), HttpRequest::read(listener)).await {
                match req.first.as_str() {
                    "GET /api/meta HTTP/1.1" => req.reply(200, json!({"version": "1.0.0"})).await,
                    "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
                    | "GET /api/storage/state/ui?authoritative=1 HTTP/1.1"
                    | "GET /api/storage/config/server?authoritative=1 HTTP/1.1" => {
                        req.reply(200, json!({})).await;
                    }
                    other => panic!("unexpected revalidation request: {other}"),
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timed out revalidating transport"
            );
        }
    }

    #[test]
    fn transport_drop_during_post_422_reload_unblocks_busy_and_reloads_on_reconnect() {
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

            let mut state = State::default();
            state.poll(&prefs, &wake);
            let initial_get =
                wait_for_request(&listener, "GET /api/opencode/login-start HTTP/1.1").await;
            initial_get.reply(200, json!({"state": "off"})).await;

            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while state.status.is_none() {
                state.poll(&prefs, &wake);
                assert!(std::time::Instant::now() < deadline);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert_eq!(state.status, Some(LoginStartState::Off));

            // Toggle triggers POST -> server refuses with 422 -> client starts post-422 reload GET.
            state.toggle(&prefs, Some(wake.clone()), true);
            let post_req =
                wait_for_request(&listener, "POST /api/opencode/login-start HTTP/1.1").await;
            post_req
                .reply(422, json!({"error": "login-start-unsupported-binary"}))
                .await;

            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while state.read_flight.is_none() {
                state.poll(&prefs, &wake);
                assert!(std::time::Instant::now() < deadline);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert!(state.busy());
            assert!(state.pending_write_error.is_some());
            let _held_reload_get =
                wait_for_request(&listener, "GET /api/opencode/login-start HTTP/1.1").await;

            // Transport drops while the post-422 reload GET is in flight.
            prefs.mark_transport_lost();
            state.poll(&prefs, &wake);
            assert!(
                !state.busy(),
                "pending_write_error must not keep busy() true after transport drop"
            );
            assert!(state.pending_write_error.is_none());
            assert_eq!(state.failure, Some(Failure::UnsupportedBinary));
            assert!(prefs.can_retry());

            // While offline, toggle must remain inert even though can_retry() is true.
            state.toggle(&prefs, Some(wake.clone()), true);
            assert!(state.write_flight.is_none());

            // Reconnect must immediately dispatch an authoritative reload GET.
            revalidate_prefs(&mut prefs, &listener).await;
            state.poll(&prefs, &wake);
            assert!(state.read_flight.is_some());
            let reconnect_get =
                wait_for_request(&listener, "GET /api/opencode/login-start HTTP/1.1").await;
            reconnect_get.reply(200, json!({"state": "off"})).await;

            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while state.read_flight.is_some() {
                state.poll(&prefs, &wake);
                assert!(std::time::Instant::now() < deadline);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert_eq!(state.status, Some(LoginStartState::Off));
            assert_eq!(state.failure, None);
            assert!(!state.busy());
        });
    }

    #[test]
    fn reconnect_during_inflight_post_schedules_followup_get_and_disables_switch_offline() {
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

            let mut state = State::default();
            state.poll(&prefs, &wake);
            let initial_get =
                wait_for_request(&listener, "GET /api/opencode/login-start HTTP/1.1").await;
            initial_get.reply(200, json!({"state": "off"})).await;

            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while state.status.is_none() {
                state.poll(&prefs, &wake);
                assert!(std::time::Instant::now() < deadline);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }

            // Start POST and hold its response across a drop + reconnect.
            state.toggle(&prefs, Some(wake.clone()), true);
            assert!(state.write_flight.is_some());
            let inflight_post =
                wait_for_request(&listener, "POST /api/opencode/login-start HTTP/1.1").await;

            // Drop transport while POST is in flight; then reconnect before POST finishes.
            prefs.mark_transport_lost();
            state.poll(&prefs, &wake);
            assert!(state.write_flight.is_some());
            assert!(state.needs_reload);

            revalidate_prefs(&mut prefs, &listener).await;
            state.poll(&prefs, &wake);
            assert!(
                state.read_flight.is_none(),
                "must wait for in-flight POST to settle before issuing follow-up GET"
            );

            // Late POST response arrives after reconnect: must be ignored and trigger a fresh GET.
            inflight_post.reply(200, json!({"state": "on"})).await;
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while state.write_flight.is_some() {
                state.poll(&prefs, &wake);
                assert!(std::time::Instant::now() < deadline);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert_eq!(
                state.status,
                Some(LoginStartState::Off),
                "stale pre-reconnect POST reply must not be applied directly"
            );
            assert!(
                state.read_flight.is_some(),
                "settling a pre-reconnect POST must immediately schedule an authoritative GET"
            );

            let followup_get =
                wait_for_request(&listener, "GET /api/opencode/login-start HTTP/1.1").await;
            followup_get.reply(200, json!({"state": "on"})).await;

            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while state.read_flight.is_some() {
                state.poll(&prefs, &wake);
                assert!(std::time::Instant::now() < deadline);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert_eq!(state.status, Some(LoginStartState::On));
            assert!(!state.busy());
            assert!(!state.needs_reload);

            // Even when completely idle, dropping transport must disable the rendered switch
            // despite can_retry() staying true.
            prefs.mark_transport_lost();
            state.poll(&prefs, &wake);
            assert!(prefs.can_retry());
            struct Harness {
                status: super::super::Status,
                shared: Rc<RefCell<Preferences>>,
                wake: rune::Waker,
            }
            let shared = Rc::new(RefCell::new(prefs));
            let mut status = super::super::Status::default();
            status.login_start = state;
            let mut rt = rune::Runtime::new(
                Harness {
                    status,
                    shared,
                    wake,
                },
                |h: &Harness, _| {
                    let prefs = h.shared.borrow();
                    h.status.login_start.view(
                        &prefs,
                        &h.shared,
                        Some(h.wake.clone()),
                        |h: &mut Harness| &mut h.status,
                    )
                },
                (640.0, 240.0),
                rune::Env::new(false, 1.0),
            );
            rt.frame(0.0);
            let (x, y) = rt.find("opencode-login-start-switch").unwrap();
            rt.pointer_down(x, y);
            rt.pointer_up(x, y);
            rt.frame(0.02);
            assert!(
                rt.state.status.login_start.write_flight.is_none(),
                "login-start switch must stay disabled during transport outage"
            );
        });
    }
}
