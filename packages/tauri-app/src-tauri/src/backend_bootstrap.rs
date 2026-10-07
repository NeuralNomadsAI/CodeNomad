//! Native-only one-shot bootstrap exchange; cookies stay in existing webview auth.
use reqwest::{blocking::Client, header::SET_COOKIE, redirect::Policy, StatusCode};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use tauri::webview::cookie::{Cookie, SameSite};

const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_BODY_BYTES: u64 = 4096;
const MAX_HEADER_BYTES: usize = 8192;

/// Native cookie-store serialization, deliberately independent of CLI lifecycle
/// locks: wry cookie readback pumps native messages. Reset never clears this fence.
#[derive(Debug, Default)]
pub(super) struct CookiePublication {
    serial: parking_lot::Mutex<()>,
    fenced: AtomicBool,
}

impl CookiePublication {
    pub(super) fn available(&self, deadline: Instant) -> bool {
        !self.fenced.load(Ordering::SeqCst) && Instant::now() < deadline
    }

    pub(super) fn run_until(
        self: &Arc<Self>,
        deadline: Instant,
        operation: impl FnOnce(Arc<Self>) -> anyhow::Result<bool> + Send + 'static,
    ) -> anyhow::Result<bool> {
        anyhow::ensure!(self.available(deadline), "Native cookie publication unavailable");
        let publication = self.clone();
        let (sender, receiver) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let result = (|| {
                let _serial = publication.serial.try_lock_until(deadline)
                    .ok_or_else(|| anyhow::anyhow!("Native cookie publication timed out"))?;
                anyhow::ensure!(publication.available(deadline), "Native cookie publication unavailable");
                operation(publication.clone())
            })();
            let _ = sender.send(result);
        });
        match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Err(error)) => Err(error),
            Ok(result) if self.available(deadline) => result,
            Ok(_) | Err(_) => {
                // The native operation may still finish. Its worker retains serial
                // ownership and performs exact cleanup; no successor can be admitted.
                self.fenced.store(true, Ordering::SeqCst);
                Err(anyhow::anyhow!("Native cookie receipt remains unconfirmed"))
            }
        }
    }
}

fn same_cookie_key(candidate: &Cookie<'_>, cookie: &Cookie<'_>) -> bool {
    candidate.name() == cookie.name() && candidate.domain() == cookie.domain()
        && candidate.path() == cookie.path()
}

fn owned_cookie(candidate: &Cookie<'_>, cookie: &Cookie<'_>) -> bool {
    same_cookie_key(candidate, cookie) && candidate.value() == cookie.value()
}

fn cleanup_cookies(
    publication: &CookiePublication,
    cookie: &Cookie<'static>,
    count: usize,
    read: &impl Fn(usize) -> anyhow::Result<Vec<Cookie<'static>>>,
    remove: &impl Fn(usize, Cookie<'static>) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    // Attempt every already-touched store even if one cleanup fails.
    let mut confirmed = true;
    for index in 0..count {
        let result = (|| {
            for candidate in read(index)?.into_iter().filter(|candidate| owned_cookie(candidate, cookie)) {
                remove(index, candidate)?;
            }
            anyhow::ensure!(!read(index)?.iter().any(|candidate| owned_cookie(candidate, cookie)),
                "Native cookie removal was not confirmed");
            Ok::<_, anyhow::Error>(())
        })();
        confirmed &= result.is_ok();
    }
    if !confirmed {
        publication.fenced.store(true, Ordering::SeqCst);
        return Err(anyhow::anyhow!("Native cookie cleanup remains unconfirmed"));
    }
    Ok(())
}

/// Run only under CookiePublication's retained serial ownership. A set receipt
/// means main-thread execution, not native success; same-webview readback proves it.
pub(super) fn publish_verified_cookies(
    publication: &CookiePublication,
    cookie: &Cookie<'static>,
    count: usize,
    current: impl Fn() -> bool,
    read: impl Fn(usize) -> anyhow::Result<Vec<Cookie<'static>>>,
    install: impl Fn(usize) -> anyhow::Result<bool>,
    remove: impl Fn(usize, Cookie<'static>) -> anyhow::Result<()>,
) -> anyhow::Result<bool> {
    if !current() { return Ok(false); }
    anyhow::ensure!(count > 0, "No native cookie store available");
    for index in 0..count {
        anyhow::ensure!(!read(index)?.iter().any(|candidate| same_cookie_key(candidate, cookie)
            && candidate.value() != cookie.value()), "Native cookie identity is already occupied");
    }
    let mut attempted = 0;
    let result = (|| {
        for index in 0..count {
            if !current() { return Ok(false); }
            attempted = index + 1; // A failed native set may already have written.
            if !install(index)? { return Ok(false); }
            let installed = read(index)?.iter().any(|candidate| owned_cookie(candidate, cookie)
                && candidate.http_only() == Some(true) && candidate.same_site() == Some(SameSite::Lax)
                && candidate.secure() != Some(true));
            anyhow::ensure!(installed, "Native cookie installation was not confirmed");
        }
        Ok(current())
    })();
    if matches!(result, Ok(true)) { return result; }
    cleanup_cookies(publication, cookie, attempted, &read, &remove)?;
    result
}

fn valid_origin(origin: &str) -> bool {
    let Some(port) = origin.strip_prefix("http://127.0.0.1:") else {
        return false;
    };
    !port.is_empty()
        && port.len() <= 5
        && !port.starts_with('0')
        && port.bytes().all(|byte| byte.is_ascii_digit())
        && port.parse::<u16>().is_ok_and(|port| port != 0)
}

fn valid_identifier(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn session_value(header: &str, expected_name: &str) -> Option<String> {
    let mut parts = header.split(';');
    let (name, value) = parts.next()?.split_once('=')?;
    if name != expected_name || value.len() != 43 || !valid_identifier(value) {
        return None;
    }
    let mut http_only = false;
    let mut path = false;
    let mut same_site = false;
    for attribute in parts.map(str::trim) {
        if attribute.eq_ignore_ascii_case("HttpOnly") && !http_only {
            http_only = true;
        } else if attribute.eq_ignore_ascii_case("Path=/") && !path {
            path = true;
        } else if attribute.eq_ignore_ascii_case("SameSite=Lax") && !same_site {
            same_site = true;
        } else {
            // Native bootstrap cookies have no Domain or additional attributes.
            return None;
        }
    }
    (http_only && path && same_site).then(|| value.to_string())
}

pub(crate) fn exchange_bootstrap_token(
    origin: &str,
    token: &str,
    expected_cookie_name: &str,
) -> anyhow::Result<Option<String>> {
    anyhow::ensure!(
        valid_origin(origin)
            && token.len() == 43
            && valid_identifier(token)
            && !expected_cookie_name.is_empty()
            && expected_cookie_name.len() <= 256
            && valid_identifier(expected_cookie_name),
        "Invalid local bootstrap input"
    );
    let deadline = Instant::now() + TIMEOUT;
    let client = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .timeout(TIMEOUT)
        .build()?;
    let remaining = deadline.saturating_duration_since(Instant::now());
    anyhow::ensure!(!remaining.is_zero(), "Local bootstrap timed out");
    let mut response = client
        .post(format!("{origin}/api/auth/token"))
        // Request timeout is absolute through body completion; Client timeout alone
        // only bounds individual blocking operations and permits trickling bodies.
        .timeout(remaining)
        .json(&serde_json::json!({ "token": token }))
        .send()?;
    let headers = response.headers();
    let header_bytes: usize = headers
        .iter()
        .map(|(name, value)| name.as_str().len() + value.as_bytes().len() + 4)
        .sum();
    anyhow::ensure!(
        headers.len() <= 64 && header_bytes <= MAX_HEADER_BYTES,
        "Local bootstrap headers too large"
    );
    anyhow::ensure!(
        response
            .content_length()
            .is_none_or(|length| length <= MAX_BODY_BYTES),
        "Local bootstrap body too large"
    );
    let mut cookies = headers.get_all(SET_COOKIE).iter();
    let session = cookies
        .next()
        .and_then(|header| header.to_str().ok())
        .and_then(|header| session_value(header, expected_cookie_name));
    let session = if cookies.next().is_none() && response.status() == StatusCode::OK {
        session
    } else {
        None
    };
    // Drain through EOF before accepting the cookie; truncated/oversized bodies fail.
    let mut body = Vec::new();
    response
        .by_ref()
        .take(MAX_BODY_BYTES + 1)
        .read_to_end(&mut body)?;
    anyhow::ensure!(
        body.len() as u64 <= MAX_BODY_BYTES,
        "Local bootstrap body too large"
    );
    anyhow::ensure!(Instant::now() < deadline, "Local bootstrap timed out");
    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    const TOKEN: &str = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const COOKIE: &str = "codenomad_session_fixture";

    fn native_cookie(value: &str) -> Cookie<'static> {
        Cookie::build((COOKIE.to_string(), value.to_string())).domain("127.0.0.1")
            .path("/").http_only(true).same_site(SameSite::Lax).build()
    }

    #[test]
    fn raw_store_verifies_ipv4_cookie_and_reset_cleans_exact_owned_cookie() {
        let url = tauri::Url::parse("http://127.0.0.1:1234").unwrap();
        let cookie = native_cookie("owned");
        assert_eq!(url.domain(), None);
        let legacy_store = parking_lot::Mutex::new(Vec::new());
        let publication = CookiePublication::default();
        // Locked Wry 0.54.4 on macOS filters by cookie.domain() == url.domain().
        // For this mandatory IPv4 origin, both readback and cleanup miss the write.
        let legacy = publish_verified_cookies(&publication, &cookie, 1, || true,
            |_| Ok(legacy_store.lock().iter().filter(|candidate: &&Cookie<'static>| {
                candidate.domain() == url.domain() && !candidate.secure().unwrap_or_default()
            }).cloned().collect()),
            |_| { legacy_store.lock().push(cookie.clone()); Ok(true) },
            |_, _| panic!("The old URL filter incorrectly reports no owned cookie"),
        );
        assert!(legacy.unwrap_err().to_string().contains("installation was not confirmed"));
        assert!(legacy_store.lock().iter().any(|candidate| owned_cookie(candidate, &cookie)));

        let unrelated = vec![
            Cookie::build(("unrelated", "retained")).domain("127.0.0.1").path("/").build(),
            Cookie::build((COOKIE, "other-domain")).domain("127.0.0.2").path("/").build(),
            Cookie::build((COOKIE, "other-path")).domain("127.0.0.1").path("/other").build(),
        ];
        for reset in [false, true] {
            let publication = CookiePublication::default();
            let store = parking_lot::Mutex::new(unrelated.clone());
            let current = std::cell::Cell::new(true);
            let result = publish_verified_cookies(&publication, &cookie, 1, || current.get(),
                |_| Ok(store.lock().clone()),
                |_| { store.lock().push(cookie.clone()); current.set(!reset); Ok(true) },
                |_, removed| {
                    assert!(owned_cookie(&removed, &cookie));
                    store.lock().retain(|candidate| !owned_cookie(candidate, &removed));
                    Ok(())
                },
            );
            assert_eq!(result.unwrap(), !reset);
            assert_eq!(store.lock().iter().any(|candidate| owned_cookie(candidate, &cookie)), !reset);
            assert!(unrelated.iter().all(|candidate| store.lock().contains(candidate)));
            if reset { assert_eq!(*store.lock(), unrelated); }
        }
    }

    #[test]
    fn reset_during_native_install_cleans_stale_before_successor_and_preserves_unrelated() {
        use std::sync::atomic::AtomicU64;
        let publication = Arc::new(CookiePublication::default());
        let generation = Arc::new(AtomicU64::new(1));
        let unrelated = Cookie::build(("unrelated", "retained")).domain("127.0.0.1").path("/").build();
        let store = Arc::new(parking_lot::Mutex::new(vec![unrelated.clone()]));
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let old_publication = publication.clone();
        let old_store = store.clone();
        let old_generation = generation.clone();
        let old = std::thread::spawn(move || old_publication.run_until(Instant::now() + TIMEOUT, move |authority| {
            let cookie = native_cookie("old");
            publish_verified_cookies(&authority, &cookie, 1,
                || old_generation.load(Ordering::SeqCst) == 1,
                |_| Ok(old_store.lock().clone()),
                |_| { started_tx.send(()).unwrap(); release_rx.recv().unwrap(); old_store.lock().push(cookie.clone()); Ok(true) },
                |_, cookie| { old_store.lock().retain(|candidate| !owned_cookie(candidate, &cookie)); Ok(()) },
            )
        }));
        started_rx.recv_timeout(TIMEOUT).unwrap();
        generation.store(2, Ordering::SeqCst);
        let next_publication = publication.clone();
        let next_store = store.clone();
        let next = std::thread::spawn(move || next_publication.run_until(Instant::now() + TIMEOUT, move |authority| {
            let cookie = native_cookie("successor");
            publish_verified_cookies(&authority, &cookie, 1,
                || generation.load(Ordering::SeqCst) == 2,
                |_| Ok(next_store.lock().clone()),
                |_| { next_store.lock().push(cookie.clone()); Ok(true) },
                |_, cookie| { next_store.lock().retain(|candidate| !owned_cookie(candidate, &cookie)); Ok(()) },
            )
        }));
        release_tx.send(()).unwrap();
        assert!(!old.join().unwrap().unwrap());
        assert!(next.join().unwrap().unwrap());
        assert_eq!(store.lock().len(), 2);
        assert!(store.lock().contains(&unrelated));
        assert!(store.lock().iter().any(|cookie| owned_cookie(cookie, &native_cookie("successor"))));
        assert!(!store.lock().iter().any(|cookie| owned_cookie(cookie, &native_cookie("old"))));
    }

    #[test]
    fn native_failures_missing_receipts_and_partial_installation_clean_only_owned_cookies() {
        for failure in ["native-error", "missing-readback", "partial", "replacement", "invalid-attributes"] {
            let publication = CookiePublication::default();
            let cookie = native_cookie("owned");
            let store = parking_lot::Mutex::new(vec![Vec::new(), Vec::new()]);
            let result = publish_verified_cookies(&publication, &cookie, 2, || true,
                |index| Ok(store.lock()[index].clone()),
                |index| {
                    if failure != "missing-readback" { store.lock()[index].push(cookie.clone()); }
                    if failure == "replacement" { store.lock()[index] = vec![native_cookie("replacement")]; }
                    if failure == "invalid-attributes" { store.lock()[index][0].set_http_only(false); }
                    if failure == "native-error" || (failure == "partial" && index == 1) {
                        anyhow::bail!("late native failure");
                    }
                    Ok(true)
                },
                |index, cookie| { store.lock()[index].retain(|candidate| !owned_cookie(candidate, &cookie)); Ok(()) },
            );
            assert!(result.is_err());
            assert!(store.lock().iter().flatten().all(|candidate| !owned_cookie(candidate, &cookie)));
            if failure == "replacement" { assert_eq!(store.lock()[0][0].value(), "replacement"); }
            assert!(publication.available(Instant::now() + TIMEOUT));
        }
    }

    #[test]
    fn failed_cleanup_fences_successors_but_attempts_every_partially_installed_store() {
        let publication = Arc::new(CookiePublication::default());
        let cookie = native_cookie("owned");
        let store = parking_lot::Mutex::new(vec![Vec::new(), Vec::new()]);
        let result = publish_verified_cookies(&publication, &cookie, 2, || true,
            |index| Ok(store.lock()[index].clone()),
            |index| { store.lock()[index].push(cookie.clone()); if index == 1 { anyhow::bail!("native rejected"); } Ok(true) },
            |index, _| { if index == 0 { anyhow::bail!("cleanup rejected"); } store.lock()[index].clear(); Ok(()) },
        );
        assert!(result.unwrap_err().to_string().contains("cleanup remains unconfirmed"));
        assert!(!publication.available(Instant::now() + TIMEOUT));
        assert!(store.lock()[1].is_empty());
        assert!(publication.run_until(Instant::now() + TIMEOUT, |_| panic!("Unconfirmed cleanup cannot admit successor")).is_err());
    }

    #[test]
    fn queued_native_execution_rechecks_generation_and_set_success_requires_readback() {
        let publication = CookiePublication::default();
        let cookie = native_cookie("owned");
        let current = std::cell::Cell::new(true);
        let writes = std::cell::Cell::new(0);
        // Dispatch was admitted while current; reset occurs before native execution.
        let result = publish_verified_cookies(&publication, &cookie, 1, || current.get(),
            |_| Ok(Vec::new()),
            |_| { current.set(false); if current.get() { writes.set(writes.get() + 1); } Ok(false) },
            |_, _| panic!("An unexecuted native install owns no cookie"),
        );
        assert!(!result.unwrap());
        assert_eq!(writes.get(), 0);
    }

    #[test]
    fn timed_out_receipt_keeps_serial_ownership_and_late_effect_is_cleaned_without_readmission() {
        let publication = Arc::new(CookiePublication::default());
        let store = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let worker_store = store.clone();
        let deadline = Instant::now() + Duration::from_millis(250);
        let (release_tx, release_rx) = mpsc::channel();
        let (cleaned_tx, cleaned_rx) = mpsc::channel();
        assert!(publication.run_until(deadline, move |authority| {
            let cookie = native_cookie("owned");
            let result = publish_verified_cookies(&authority, &cookie, 1, || authority.available(deadline),
                |_| Ok(worker_store.lock().clone()),
                |_| { release_rx.recv().unwrap(); worker_store.lock().push(cookie.clone()); Ok(true) },
                |_, cookie| { worker_store.lock().retain(|candidate| !owned_cookie(candidate, &cookie)); Ok(()) },
            );
            cleaned_tx.send(()).unwrap();
            result
        }).unwrap_err().to_string().contains("receipt remains unconfirmed"));
        assert!(publication.run_until(Instant::now() + TIMEOUT, |_| panic!("Unknown receipt cannot admit successor")).is_err());
        release_tx.send(()).unwrap();
        cleaned_rx.recv_timeout(TIMEOUT).unwrap();
        assert!(store.lock().is_empty());
        assert!(!publication.available(Instant::now() + TIMEOUT));
    }

    fn read_request(stream: &mut TcpStream) {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert_eq!(line, "POST /api/auth/token HTTP/1.1\r\n");
        let mut length = 0;
        loop {
            line.clear();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
            if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse::<usize>().unwrap();
            }
        }
        assert!(length > 0 && length < 256);
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({ "token": TOKEN })
        );
    }

    fn fixture(response: String) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_request(&mut stream);
            stream.write_all(response.as_bytes()).unwrap();
        });
        (origin, worker)
    }

    fn response(status: &str, headers: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[test]
    fn exchanges_one_shot_proof_and_drains_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let worker = thread::spawn(move || {
            for status in ["200 OK", "401 Unauthorized"] {
                let (mut stream, _) = listener.accept().unwrap();
                read_request(&mut stream);
                stream
                    .write_all(
                        response(
                            status,
                            &format!(
                                "Set-Cookie: {COOKIE}={TOKEN}; SameSite=Lax; HttpOnly; Path=/\r\n"
                            ),
                            "{}",
                        )
                        .as_bytes(),
                    )
                    .unwrap();
            }
        });
        assert_eq!(
            exchange_bootstrap_token(&origin, TOKEN, COOKIE).unwrap(),
            Some(TOKEN.into())
        );
        assert_eq!(
            exchange_bootstrap_token(&origin, TOKEN, COOKIE).unwrap(),
            None
        );
        worker.join().unwrap();
    }

    #[test]
    fn rejects_untrusted_inputs_before_network_access() {
        for origin in [
            "http://localhost:1234",
            "http://[::1]:1234",
            "https://127.0.0.1:1234",
            "http://127.0.0.1",
            "http://127.0.0.1:0",
            "http://127.0.0.1:65536",
            "http://127.0.0.1:0123",
            "http://127.0.0.1:1234/",
            "http://127.0.0.1:1234/path",
            "http://127.0.0.1:1234//",
            "http://127.0.0.1:1234?",
            "http://127.0.0.1:1234#",
            "http://user@127.0.0.1:1234",
        ] {
            assert!(exchange_bootstrap_token(origin, TOKEN, COOKIE).is_err());
        }
        for token in ["", "short", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF+"] {
            assert!(exchange_bootstrap_token("http://127.0.0.1:1", token, COOKIE).is_err());
        }
        for cookie in ["", "cookie=name", "cookie\r\nheader", &"x".repeat(257)] {
            assert!(exchange_bootstrap_token("http://127.0.0.1:1", TOKEN, cookie).is_err());
        }
    }

    #[test]
    fn accepts_only_one_exact_nonempty_cookie() {
        for header in [
            format!("Set-Cookie: other=value\r\n"),
            format!("Set-Cookie: {COOKIE}=\r\n"),
            format!("Set-Cookie: {COOKIE}=bad value\r\n"),
            format!("Set-Cookie: {COOKIE}=value\r\nSet-Cookie: {COOKIE}=other\r\n"),
            format!("Set-Cookie: {COOKIE}={TOKEN}; Path=/; SameSite=Lax\r\n"),
            format!("Set-Cookie: {COOKIE}={TOKEN}; HttpOnly; Path=/other; SameSite=Lax\r\n"),
            format!("Set-Cookie: {COOKIE}={TOKEN}; HttpOnly; Path=/; SameSite=Lax; Domain=127.0.0.1\r\n"),
        ] {
            let (origin, worker) = fixture(response("200 OK", &header, "{}"));
            assert_eq!(
                exchange_bootstrap_token(&origin, TOKEN, COOKIE).unwrap(),
                None
            );
            worker.join().unwrap();
        }
    }

    #[test]
    fn does_not_follow_redirects() {
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let headers = format!(
            "Location: http://{}/api/auth/token\r\nSet-Cookie: {COOKIE}=value\r\n",
            target.local_addr().unwrap()
        );
        let (origin, worker) = fixture(response("302 Found", &headers, ""));
        assert_eq!(
            exchange_bootstrap_token(&origin, TOKEN, COOKIE).unwrap(),
            None
        );
        worker.join().unwrap();
        assert_eq!(
            target.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn rejects_oversized_headers_bodies_and_truncated_body() {
        let cookie = format!("Set-Cookie: {COOKIE}={TOKEN}; HttpOnly; Path=/; SameSite=Lax\r\n");
        for response in [response("200 OK", &format!("{cookie}X-Large: {}\r\n", "x".repeat(MAX_HEADER_BYTES)), ""), response("200 OK", &cookie, &"x".repeat(4097)), format!("HTTP/1.1 200 OK\r\n{cookie}Transfer-Encoding: chunked\r\n\r\n1001\r\n{}\r\n0\r\n\r\n", "x".repeat(4097)), format!("HTTP/1.1 200 OK\r\n{cookie}Content-Length: 2\r\n\r\nx")] {
            let (origin, worker) = fixture(response);
            assert!(exchange_bootstrap_token(&origin, TOKEN, COOKIE).is_err());
            worker.join().unwrap();
        }
    }

    #[test]
    fn absolute_timeout_includes_headers_and_trickling_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_request(&mut stream);
            thread::sleep(Duration::from_secs(2));
            if stream.write_all(format!("HTTP/1.1 200 OK\r\nSet-Cookie: {COOKIE}={TOKEN}; HttpOnly; Path=/; SameSite=Lax\r\nContent-Length: 16\r\n\r\n").as_bytes()).is_err() { return; }
            for _ in 0..16 {
                thread::sleep(Duration::from_millis(400));
                if stream.write_all(b"x").is_err() {
                    break;
                }
            }
        });
        let started = Instant::now();
        assert!(exchange_bootstrap_token(&origin, TOKEN, COOKIE).is_err());
        assert!(started.elapsed() < Duration::from_secs(6));
        worker.join().unwrap();
    }

    #[test]
    fn real_auth_routes_bootstrap_cookie_authenticates_and_proof_cannot_replay() {
        // Real AuthManager/routes only; this does not qualify a persistent bridge.
        use std::path::Path;
        use std::process::{Child, Command, Stdio};
        use std::sync::mpsc;

        // Only this concrete isolated Node child is owned, never a PID/tree/daemon.
        struct AuthServer(Child);
        impl Drop for AuthServer {
            fn drop(&mut self) {
                if matches!(self.0.try_wait(), Ok(Some(_))) {
                    return;
                }
                let _ = self.0.kill();
                let deadline = Instant::now() + Duration::from_secs(2);
                while Instant::now() < deadline {
                    if matches!(self.0.try_wait(), Ok(Some(_))) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                eprintln!("Isolated auth fixture cleanup remains unconfirmed");
            }
        }

        let repo = std::path::PathBuf::from(super::super::normalize_path(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."),
        ));
        let fixture = repo.join("packages/electron-app/electron/main/backend-bootstrap-fixture.ts");
        let temporary_parent = if cfg!(windows) {
            std::env::temp_dir().join("opencode")
        } else {
            std::env::temp_dir()
        };
        let root = tempfile::Builder::new()
            .prefix("rust-backend-auth-")
            .tempdir_in(temporary_parent)
            .unwrap();
        let mut command = Command::new(which::which("node").expect("Cached Node is required"));
        command
            .current_dir(&repo)
            .args(["--import", "tsx"])
            .arg(fixture)
            .arg(root.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut server = AuthServer(
            command
                .spawn()
                .expect("Unable to start isolated auth fixture"),
        );
        let stdout = server.0.stdout.take().unwrap();
        let (sender, receiver) = mpsc::sync_channel(1);
        let readiness = thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::new();
            let result = reader.by_ref().take(8193).read_until(b'\n', &mut line);
            // Retain stdout until shutdown, so the fixed completion receipt can write.
            let _ = sender.send((result, line, reader));
        });
        let (read_result, line, _stdout) = receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("Isolated auth fixture readiness timed out");
        readiness
            .join()
            .expect("Auth fixture readiness reader failed");
        assert!(
            read_result.is_ok() && line.len() <= 8192 && line.last() == Some(&b'\n'),
            "Invalid isolated auth fixture readiness"
        );
        let ready: serde_json::Value =
            serde_json::from_slice(&line).expect("Invalid auth fixture readiness JSON");
        let origin = ready["origin"].as_str().expect("Missing fixture origin");
        let proof = ready["proof"].as_str().expect("Missing fixture proof");
        let cookie_name = ready["cookieName"]
            .as_str()
            .expect("Missing fixture cookie name");
        let session = exchange_bootstrap_token(origin, proof, cookie_name)
            .expect("Real auth bootstrap failed")
            .expect("Real auth cookie was refused");
        assert!(
            session.len() == 43 && valid_identifier(&session),
            "Invalid native session value"
        );
        assert!(
            exchange_bootstrap_token(origin, proof, cookie_name)
                .expect("Real auth replay request failed")
                .is_none(),
            "Proof replay was accepted"
        );
        let mut status = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .build()
            .unwrap()
            .get(format!("{origin}/api/auth/status"))
            .timeout(TIMEOUT)
            .header("Connection", "close")
            .header("Cookie", format!("{cookie_name}={session}"))
            .send()
            .expect("Real auth status request failed");
        assert!(status.status() == StatusCode::OK, "Real auth status failed");
        let mut body = Vec::new();
        status
            .by_ref()
            .take(MAX_BODY_BYTES + 1)
            .read_to_end(&mut body)
            .unwrap();
        assert!(
            body.len() as u64 <= MAX_BODY_BYTES,
            "Auth status body exceeded limit"
        );
        drop(status);
        let status: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(
            status["authenticated"].as_bool() == Some(true),
            "Native cookie did not authenticate"
        );

        let mut stdin = server.0.stdin.take().unwrap();
        stdin.write_all(b"codenomad:shutdown\n").unwrap();
        stdin.flush().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let (sender, receiver) = mpsc::sync_channel(1);
        let completion = thread::spawn(move || {
            let mut receipt = Vec::new();
            let result = _stdout.take(129).read_until(b'\n', &mut receipt);
            let _ =
                sender.send(result.is_ok() && receipt == b"CODENOMAD_SHUTDOWN_STATUS:complete\n");
        });
        assert!(
            receiver
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("Isolated auth fixture shutdown receipt timed out"),
            "Invalid auth fixture shutdown receipt"
        );
        completion
            .join()
            .expect("Auth fixture shutdown reader failed");
        loop {
            if let Some(exit) = server.0.try_wait().unwrap() {
                assert!(exit.success(), "Isolated auth fixture shutdown failed");
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Isolated auth fixture shutdown timed out"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}
