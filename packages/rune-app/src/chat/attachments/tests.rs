use super::*;
use crate::{Phase, history, init};
use rune::{Env, Runtime};
use serde_json::json;

const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNQSFjwHx9moL0CAFNzQ+EMxFw9AAAAAElFTkSuQmCC";

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn inline_image_attachment_downloads_without_reference_while_file_and_invalid_stay_excluded() {
    let user = history::decode_message(&json!({
        "id":"m1","type":"user","text":"Attachments",
        "files":[
            {"name":"Inline.png","mime":"image/png","source":{"type":"inline"},"data":PNG},
            {"name":"Local.png","mime":"image/png","source":{"type":"uri","uri":"file:///local.png"}},
            {"name":"Bad.png","mime":"image/png","source":{"type":"inline"},"data":"PRIVATE-BYTES"},
            {"name":"Notes.txt","mime":"text/plain","source":{"type":"uri","uri":"file:///notes.txt"}}
        ]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages = vec![user.into()];
    let mut rt = Runtime::new(
        state,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 900.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    assert!(rt.find("download-m1-file-0").is_some());
    assert!(rt.find("download-m1-file-1").is_none());
    assert!(rt.find("download-m1-file-2").is_none());
    assert!(rt.find("download-m1-file-3").is_none());

    // Trigger explicit download without any bound backend.
    let (x, y) = rt.find("download-m1-file-0").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let mut done = false;
        rt.update(|s, tx| {
            if poll(s, tx) {
                tx.instant();
            }
            done = s.attachments.saving;
        });
        rt.frame(1.0 / 60.0);
        if done {
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    rt.update(|s, _| {
        assert!(s.attachments.saving);
        assert!(!s.attachments.error);
    });
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn admitted_http_image_attachment_downloads_and_enforces_passive_raster_admission() {
    use crate::files::test_http::Http;
    use base64::{Engine, engine::general_purpose::STANDARD};

    let png_bytes = STANDARD.decode(PNG).unwrap();
    crate::platform::block_on(async {
        let http = Http::new().await;
        let base = http.backend.base.trim_end_matches('/');
        let ok_url = format!("{base}/ok.png");
        let bad_url = format!("{base}/bad.png");
        let user = history::decode_message(&json!({
            "id":"m2","type":"user","text":"Remote attachments",
            "files":[
                {"name":"Remote.png","mime":"image/png","source":{"type":"uri","uri":ok_url}},
                {"name":"Html.png","mime":"image/png","source":{"type":"uri","uri":bad_url}},
                {"name":"Deferred.txt","mime":"text/plain","source":{"type":"deferred","sha256":"a".repeat(64)}}
            ]
        }))
        .unwrap();
        let mut state = init();
        state.phase = Phase::Ready;
        state.messages = vec![user.into()];
        let crate::content::Part::File(ok_file) = &state.messages[0].parts[0] else {
            panic!("missing ok file")
        };
        let crate::content::Part::File(bad_file) = &state.messages[0].parts[1] else {
            panic!("missing bad file")
        };
        let crate::content::Part::File(deferred_file) = &state.messages[0].parts[2] else {
            panic!("missing deferred file")
        };
        let ok_source = download_source(ok_file).expect("admitted http source");
        let bad_source = download_source(bad_file).expect("admitted http source");
        let deferred_source = download_source(deferred_file).expect("deferred reference");
        assert!(!ok_source.needs_backend());
        assert!(deferred_source.needs_backend());
        assert!(state.attachments.available_for(&ok_source));
        assert!(!state.attachments.available_for(&deferred_source));

        // Valid PNG over HTTP without CORS headers downloads cleanly.
        Reader::request_source(&mut state, ok_source, "Remote.png");
        let request = http.accept().await;
        assert!(request.header.starts_with("GET /ok.png "));
        assert!(!request.header.to_ascii_lowercase().contains("referer:"));
        request
            .send(
                &format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    png_bytes.len()
                ),
                &png_bytes,
            )
            .await;
        let received = state
            .attachments
            .pending
            .as_ref()
            .unwrap()
            .result
            .recv()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(received.as_slice(), png_bytes.as_slice());
        state.attachments.cancel();

        // Active HTML payload disguised as image/png is rejected by passive_raster admission.
        Reader::request_source(&mut state, bad_source, "Html.png");
        let request = http.accept().await;
        assert!(request.header.starts_with("GET /bad.png "));
        let html = b"<!doctype html><script>alert(1)</script>";
        request
            .send(
                &format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    html.len()
                ),
                html,
            )
            .await;
        let result = state
            .attachments
            .pending
            .as_ref()
            .unwrap()
            .result
            .recv()
            .await
            .unwrap();
        assert!(result.is_err());
        http.quiet().await;
    });
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn evicting_message_cancels_pending_admitted_download() {
    let user = history::decode_message(&json!({
        "id":"m3","type":"user","text":"Evict",
        "files":[
            {"name":"Inline.png","mime":"image/png","source":{"type":"inline"},"data":PNG}
        ]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages = vec![user.into()];
    let crate::content::Part::File(file) = &state.messages[0].parts[0] else {
        panic!("missing file")
    };
    let source = download_source(file).expect("inline source");
    Reader::request_source(&mut state, source, "Inline.png");
    assert!(state.attachments.pending.is_some());
    state.messages.clear();

    let mut rt = Runtime::new(
        state,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (640.0, 480.0),
        Env::new(false, 1.0),
    );
    rt.update(|s, tx| {
        assert!(poll(s, tx));
        assert!(s.attachments.pending.is_none());
        assert!(!s.attachments.saving);
        assert!(!s.attachments.error);
    });
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn stale_save_dialog_after_cancel_or_message_eviction_does_not_write() {
    let user = history::decode_message(&json!({
        "id":"m4","type":"user","text":"Save dialog",
        "files":[
            {"name":"Inline.png","mime":"image/png","source":{"type":"inline"},"data":PNG}
        ]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages = vec![user.into()];
    let crate::content::Part::File(file) = &state.messages[0].parts[0] else {
        panic!("missing file")
    };
    let source = download_source(file).expect("inline source");

    // 1. Cancel invalidates the active save dialog token.
    let stale_token = state.attachments.begin_save(source.clone());
    state.attachments.cancel();
    assert!(!Reader::confirm_save_dialog(&mut state, stale_token));

    // 2. Evicting the message while the dialog is open refuses commit and clears saving.
    let evicted_token = state.attachments.begin_save(source.clone());
    state.messages.clear();
    assert!(!Reader::confirm_save_dialog(&mut state, evicted_token));
    assert!(!state.attachments.saving);

    // 3. Dismissing a stale dialog does not clobber a newer active save.
    let fresh_user = history::decode_message(&json!({
        "id":"m4","type":"user","text":"Save dialog",
        "files":[
            {"name":"Inline.png","mime":"image/png","source":{"type":"inline"},"data":PNG}
        ]
    }))
    .unwrap();
    state.messages = vec![fresh_user.into()];
    let fresh_token = state.attachments.begin_save(source);
    Reader::dismiss_save_dialog(&mut state, stale_token, true);
    assert!(state.attachments.saving);
    assert!(!state.attachments.error);
    assert!(Reader::confirm_save_dialog(&mut state, fresh_token));

    // 4. Transient offline/disconnect preserves an already-fetched open save dialog.
    state.attachments.offline();
    assert!(state.attachments.saving);
    assert!(Reader::confirm_save_dialog(&mut state, fresh_token));
}
