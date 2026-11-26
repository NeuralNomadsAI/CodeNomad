use super::*;

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn inline_user_and_tool_images_render_while_active_content_stays_a_label() {
    use crate::{Phase, history, init};
    use rune::{Env, Runtime};
    use serde_json::json;
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNQSFjwHx9moL0CAFNzQ+EMxFw9AAAAAElFTkSuQmCC";
    let user = history::decode_message(&json!({
        "id":"sample","type":"user","text":"Image plus a file",
        "files":[{"name":"Attached sample","mime":"image/png","source":{"type":"inline"},"data":png},
                 {"name":"Notes.txt","mime":"text/plain","source":{"type":"uri","uri":"file:///notes.txt"}}]
    })).unwrap();
    let tool = history::decode_message(&json!({
        "id":"reply","type":"assistant","time":{"completed":1},
        "content":[{"id":"read","type":"tool","name":"read","state":{
            "status":"completed","content":[{"type":"file","name":"Tool sample","mime":"image/png","uri":format!("data:image/png;base64,{png}")},
                {"type":"file","name":"HTML as image","mime":"image/png","uri":"data:image/png;base64,PGh0bWw+"}]}
        }]
    })).unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages = vec![user.into(), tool.into()];
    let mut rt = Runtime::new(
        state,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 900.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    let initial = rt.accessibility_json().to_string();
    assert!(initial.contains("Notes.txt") && !initial.contains("Tool sample"));
    let (x, y) = rt.find("toggle-tool-reply:4:read").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        rt.update(|s, tx| {
            if super::super::events::poll_chat(s, 4) {
                tx.instant();
            }
        });
        rt.frame(1.0 / 60.0);
        let tree = rt.accessibility_json().to_string();
        if tree.contains("Unable to display this image.")
            && tree.matches("\"role\":\"image\"").count() >= 2
        {
            assert!(tree.contains("Attached sample") && tree.contains("Tool sample"));
            break;
        }
        assert!(std::time::Instant::now() < deadline, "{tree}");
        std::thread::yield_now();
    }
    let attach_key = rt
        .elements()
        .into_iter()
        .filter_map(|element| element.key)
        .find(|key| key.ends_with("-enlarge"))
        .unwrap();
    let (x, y) = rt.find(&attach_key).unwrap();
    rt.pointer_move(x, y);
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    assert!(rt.find("attachment-image-hover").is_some());
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    assert!(rt.find("close-attachment-preview").is_some());
    assert!(rt.find("attachment-image-hover").is_none());
    rt.key(rune::KeyEvent {
        key: rune::Key::Escape,
        mods: Default::default(),
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    assert!(rt.find("close-attachment-preview").is_none());
    assert!(
        rt.elements()
            .iter()
            .any(|element| element.focused && element.key.as_deref() == Some(attach_key.as_str()))
    );
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn queue_drains_and_leaving_the_viewport_keeps_the_acquired_image() {
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNQSFjwHx9moL0CAFNzQ+EMxFw9AAAAAElFTkSuQmCC";
    let mut photos = Pictures::default();
    let origin = PictureSource::Inline(png.into());
    let slots: Vec<_> = (0..12)
        .map(|index| (index.to_string(), Rc::new(())))
        .collect();
    for (key, lease) in &slots {
        photos.visibility(key, &origin, "image/png", None, lease, true);
    }
    let reads = crate::platform::reads::Reads::default();
    let wake: rune::Waker = Arc::new(|| {});
    photos.poll(&reads, &wake);
    assert_eq!(photos.waiting.len(), slots.len() - CONCURRENT);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
    while photos.images.values().any(|entry| !entry.settled) {
        assert!(std::time::Instant::now() < deadline);
        photos.poll(&reads, &wake);
        std::thread::yield_now();
    }
    assert!(photos.waiting.is_empty());
    for (key, lease) in slots {
        let before = photos.images[&key].image.as_ref().unwrap().id();
        photos.visibility(&key, &origin, "image/png", None, &lease, false);
        photos.poll(&reads, &wake);
        photos.visibility(&key, &origin, "image/png", None, &lease, true);
        assert_eq!(photos.images[&key].image.as_ref().unwrap().id(), before);
    }
}

#[test]
fn reconnect_requeues_network_failures_and_only_web_links_to_unavailable_http() {
    let mut photos = Pictures::default();
    let lease = Rc::new(());
    let http = PictureSource::Http("https://example.invalid/sample.png".into());
    let inline = PictureSource::Inline("data".into());
    photos.visibility("remote", &http, "image/png", None, &lease, true);
    photos.visibility("inline", &inline, "image/png", None, &lease, true);
    photos.waiting.clear();
    photos
        .images
        .values_mut()
        .for_each(|entry| entry.settled = true);
    photos.retry_interrupted();
    assert_eq!(photos.waiting.pop_front().as_deref(), Some("remote"));
    assert!(photos.waiting.is_empty() && photos.images["inline"].settled);
    assert_eq!(
        external_url(&http, true, true),
        Some("https://example.invalid/sample.png")
    );
    assert!(external_url(&http, false, true).is_none());
    assert!(external_url(&http, true, false).is_none());
    assert!(external_url(&inline, true, true).is_none());
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn web_fallback_is_a_link_and_opens_only_the_qualified_image_url() {
    use rune::{Env, Runtime};
    const URL: &str = "https://example.invalid/sample.png";
    let source = PictureSource::Http(URL.into());
    let mut state = crate::init();
    let lease = Rc::new(());
    let key = source_key(
        "remote",
        state.transcript_display.pictures.generation,
        0,
        &source,
        "image/png",
    );
    state
        .transcript_display
        .pictures
        .visibility(&key, &source, "image/png", None, &lease, true);
    state
        .transcript_display
        .pictures
        .images
        .get_mut(&key)
        .unwrap()
        .settled = true;
    let mut rt = Runtime::new(
        state,
        |s, _| {
            crate::strings::with_locale("en", || {
                view_on_platform(
                    s,
                    "remote".into(),
                    &PictureSource::Http(URL.into()),
                    "Remote image",
                    "image/png",
                    false,
                    None,
                    true,
                )
            })
        },
        (640.0, 360.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("Open image in browser") && !tree.contains("Unable to display"));
    let (x, y) = rt.find(&format!("{key}-external")).unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    assert_eq!(rt.take_url_requests(), [URL]);
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn native_animated_avif_falls_back_while_oversized_tracks_are_refused_before_decode() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let encoded = include_str!("../../../fixtures/animated-32.avif.b64").trim();
    let mut native = STANDARD.decode(encoded).unwrap();
    let source = PictureSource::Inline(encoded.into());
    let bytes = crate::platform::block_on(source.bytes(None, "image/avif")).unwrap();
    let cache = ImageCache::new(Arc::new(|| {}));
    let image = cache.load(bytes.as_slice());
    assert!(image.wait().is_err());
    assert!(attachment::decoded_size(&image).is_none());
    let width = native
        .windows(4)
        .position(|bytes| bytes == b"tkhd")
        .unwrap()
        + 4
        + 88;
    native[width..width + 4].copy_from_slice(&(8193_u32 << 16).to_be_bytes());
    let oversized = PictureSource::Inline(STANDARD.encode(native).into());
    assert!(crate::platform::block_on(oversized.bytes(None, "image/avif")).is_err());
}

#[cfg(all(test, not(target_arch = "wasm32")))]
fn large_valid_png(pad_bytes: usize) -> Vec<u8> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let base = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNQSFjwHx9moL0CAFNzQ+EMxFw9AAAAAElFTkSuQmCC").unwrap();
    let split = base.len() - 12; // 12-byte IEND chunk
    let mut data = b"Comment\0".to_vec();
    data.resize(data.len() + pad_bytes, b'x');
    let mut crc = 0xffff_ffff_u32;
    for &byte in b"tEXt".iter().chain(data.iter()) {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    crc ^= 0xffff_ffff_u32;
    let mut out = Vec::with_capacity(base.len() + 12 + data.len());
    out.extend_from_slice(&base[..split]);
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(b"tEXt");
    out.extend_from_slice(&data);
    out.extend_from_slice(&crc.to_be_bytes());
    out.extend_from_slice(&base[split..]);
    out
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn owned_deferred_image_fetches_passive_bytes_and_refuses_other_sessions() {
    use crate::files::test_http::Http;
    use codenomad_client::content::deferred_media_digest;
    use serde_json::json;
    crate::platform::block_on(async {
        let http = Http::new().await;
        let png = large_valid_png(300 * 1024);
        assert!(png.len() > 256 * 1024);
        let digest = deferred_media_digest("image/png", &png);
        let path = format!("/api/workspaces/owned/session-media/session/message/0/1/{digest}");
        let message = crate::history::decode_message(&json!({
            "id":"message","type":"assistant","content":[
                {"type":"tool","id":"call","name":"read","state":{"status":"completed","content":[
                    {"type":"text","text":"Never copy image bytes"},
                    {"type":"file","mime":"image/png","uri":path}
                ]}}
            ]
        }))
        .unwrap();
        assert_eq!(message.body, "");
        let crate::content::Part::Tool(tool) = &message.parts[0] else {
            panic!("missing native tool")
        };
        assert_eq!(tool.output, "Never copy image bytes");
        let source = tool.pictures[0].source.clone();
        assert!(matches!(source, PictureSource::Deferred(_)));

        // Foreign session and foreign workspace must be refused without making an HTTP request.
        let mut foreign_session = http.backend.clone();
        foreign_session.session = "other".into();
        assert!(
            source
                .bytes(Some(&foreign_session), "image/png")
                .await
                .is_err()
        );
        let mut foreign_workspace = http.backend.clone();
        foreign_workspace.workspace = "other".into();
        assert!(
            source
                .bytes(Some(&foreign_workspace), "image/png")
                .await
                .is_err()
        );

        // Wrong MIME header must be refused.
        let backend = http.backend.clone();
        let src = source.clone();
        let wrong_mime = tokio::spawn(async move { src.bytes(Some(&backend), "image/png").await });
        let req = http.accept().await;
        assert!(req.header.starts_with(&format!("GET {path} ")));
        assert!(
            req.header
                .to_ascii_lowercase()
                .contains("cache-control: no-store"),
            "deferred media fetch must bypass HTTP/Fetch caches: {}",
            req.header
        );
        req.send(
            &format!(
                "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                png.len()
            ),
            &png,
        )
        .await;
        assert!(wrong_mime.await.unwrap().is_err());

        // Mismatched SHA-256 digest must be refused even when bytes are a valid PNG.
        let wrong_digest_path = format!(
            "/api/workspaces/owned/session-media/session/message/0/1/{}",
            "0".repeat(64)
        );
        let wrong_msg = crate::history::decode_message(&json!({
            "id":"message","type":"assistant","content":[
                {"type":"tool","id":"call","name":"read","state":{"status":"completed","content":[
                    {"type":"text","text":"x"},
                    {"type":"file","mime":"image/png","uri":wrong_digest_path}
                ]}}
            ]
        }))
        .unwrap();
        let crate::content::Part::Tool(wrong_tool) = &wrong_msg.parts[0] else {
            panic!("missing tool")
        };
        let wrong_src = wrong_tool.pictures[0].source.clone();
        let backend = http.backend.clone();
        let bad_digest =
            tokio::spawn(async move { wrong_src.bytes(Some(&backend), "image/png").await });
        let req = http.accept().await;
        assert!(req.header.starts_with(&format!("GET {wrong_digest_path} ")));
        req.send(
            &format!(
                "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                png.len()
            ),
            &png,
        )
        .await;
        assert!(bad_digest.await.unwrap().is_err());

        // 404 Not Found and oversized (> MAX_FILE_BYTES) responses must be refused.
        let backend = http.backend.clone();
        let src = source.clone();
        let not_found = tokio::spawn(async move { src.bytes(Some(&backend), "image/png").await });
        let req = http.accept().await;
        req.send(
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            b"",
        )
        .await;
        assert!(not_found.await.unwrap().is_err());

        let backend = http.backend.clone();
        let src = source.clone();
        let too_large = tokio::spawn(async move { src.bytes(Some(&backend), "image/png").await });
        let req = http.accept().await;
        req.send(
            &format!(
                "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                codenomad_client::files::MAX_FILE_BYTES + 1
            ),
            b"",
        )
        .await;
        assert!(too_large.await.unwrap().is_err());

        // Valid > 256 KiB deferred PNG matching owner, MIME, size, and SHA-256 succeeds.
        let backend = http.backend.clone();
        let src = source.clone();
        let read =
            tokio::spawn(async move { src.bytes(Some(&backend), "image/png").await.unwrap() });
        let request = http.accept().await;
        assert!(request.header.starts_with(&format!("GET {path} ")));
        request
            .send(
                &format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    png.len()
                ),
                &png,
            )
            .await;
        assert_eq!(read.await.unwrap().as_slice(), &png);
        http.quiet().await;
    });
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn window_and_fork_requests_send_deferred_media_opt_in_header() {
    use crate::files::test_http::Http;
    use serde_json::json;
    crate::platform::block_on(async {
        let http = Http::new().await;
        let backend = http.backend.clone();
        let page_task = tokio::spawn(async move { backend.page(json!({"kind": "latest"})).await });
        let req = http.accept().await;
        assert!(
            req.header
                .starts_with("POST /api/workspaces/owned/session-history/window "),
            "{}",
            req.header
        );
        assert!(
            req.header
                .to_ascii_lowercase()
                .contains("x-codenomad-media: deferred"),
            "window read must opt in to deferred tool media: {}",
            req.header
        );
        let body = json!({
            "status": "window",
            "latest": true,
            "older": null,
            "newer": null,
            "messages": []
        })
        .to_string();
        req.send(
            &format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            ),
            body.as_bytes(),
        )
        .await;
        assert!(page_task.await.unwrap().is_ok());

        let backend = http.backend.clone();
        let (_cancel, cancelled) = codenomad_client::bounded(1);
        let fork_task =
            tokio::spawn(async move { backend.fork_after_message("msg1", &cancelled).await });
        let req = http.accept().await;
        assert!(
            req.header
                .starts_with("GET /workspaces/owned/instance/api/session/session/message?"),
            "{}",
            req.header
        );
        assert!(
            req.header
                .to_ascii_lowercase()
                .contains("x-codenomad-media: deferred"),
            "message.list read must opt in to deferred tool media: {}",
            req.header
        );
        let list_body = json!({"data": [{"id": "msg1", "type": "user", "text": "hi"}]}).to_string();
        req.send(
            &format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                list_body.len()
            ),
            list_body.as_bytes(),
        )
        .await;
        let fork_req = http.accept().await;
        assert!(
            fork_req
                .header
                .starts_with("POST /workspaces/owned/instance/api/session/session/fork ")
        );
        let fork_body = json!({
            "data": {
                "id": "forked",
                "fork": {
                    "sessionID": "session",
                    "boundary": {"type": "through", "messageID": "msg1"}
                }
            }
        })
        .to_string();
        fork_req
            .send(
                &format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    fork_body.len()
                ),
                fork_body.as_bytes(),
            )
            .await;
        assert_eq!(fork_task.await.unwrap().unwrap(), "forked");
        http.quiet().await;
    });
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn large_deferred_tool_image_renders_and_clears_on_session_move_and_revert() {
    use crate::{Phase, files::test_http::Http, history, init, transport};
    use base64::{Engine, engine::general_purpose::STANDARD};
    use codenomad_client::content::deferred_media_digest;
    use rune::{Env, Runtime};
    use serde_json::json;

    let rt_tokio = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _guard = rt_tokio.enter();
    let http = rt_tokio.block_on(Http::new());

    let png = large_valid_png(300 * 1024);
    let digest = deferred_media_digest("image/png", &png);
    let path = format!("/api/workspaces/owned/session-media/session/reply/0/0/{digest}");
    let oversized_inline = format!("data:image/png;base64,{}", STANDARD.encode(&png));

    let row = history::decode_message(&json!({
        "id": "reply",
        "type": "assistant",
        "time": {"completed": 1},
        "content": [{
            "id": "read",
            "type": "tool",
            "name": "read",
            "state": {
                "status": "completed",
                "content": [
                    {"type": "file", "name": "Large deferred PNG", "mime": "image/png", "uri": path},
                    {"type": "file", "name": "Unprojected large inline", "mime": "image/png", "uri": oversized_inline}
                ]
            }
        }]
    }))
    .unwrap();

    let (tx_ev, rx_ev) = codenomad_client::bounded(16);
    let mut state = init();
    state.phase = Phase::Ready;
    state.incoming = Some(rx_ev);
    state.transcript_display.pictures.bind(http.backend.clone());
    state.messages = vec![row.into()];

    let mut rt = Runtime::new(
        state,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 900.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    // Expand the tool card to trigger lazy deferred media fetch.
    let (x, y) = rt.find("toggle-tool-reply:4:read").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);

    // Serve the deferred > 256 KiB PNG over the real loopback HTTP server.
    let png_for_server = png.clone();
    let path_for_server = path.clone();
    let server_serve = || async {
        let req = http.accept().await;
        assert!(req.header.starts_with(&format!("GET {path_for_server} ")));
        req.send(
            &format!(
                "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                png_for_server.len()
            ),
            &png_for_server,
        )
        .await;
    };

    let mut served = false;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
    loop {
        rt.update(|s, tx| {
            if super::super::events::poll_chat(s, 8) {
                tx.instant();
            }
        });
        if !served
            && rt
                .state
                .transcript_display
                .pictures
                .images
                .values()
                .any(|e| e.request.is_some())
        {
            rt_tokio.block_on(server_serve());
            served = true;
        }
        rt.frame(1.0 / 60.0);
        let tree = rt.accessibility_json().to_string();
        if tree.contains("Large deferred PNG")
            && tree.matches("\"role\":\"image\"").count() >= 1
            && tree.contains("Unprojected large inline")
            && tree.contains("Unable to display this image.")
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "initial deferred fetch did not settle (served={served}, images={}): {tree}",
            rt.state.transcript_display.pictures.images.len()
        );
        std::thread::yield_now();
    }

    // RevertChanged (undo/redo) must clear cached pictures and bump generation so surviving
    // cards remount and re-fetch cleanly instead of retaining stale pre-revert bytes.
    let gen_before = rt.state.transcript_display.pictures.generation;
    rt.state.transcript_display.pictures.fixture_preview(true);
    assert!(rt.state.transcript_display.pictures.preview_open());
    tx_ev.try_send(transport::Event::RevertChanged).unwrap();
    rt.update(|s, tx| {
        super::super::events::poll_chat(s, 8);
        tx.instant();
    });
    assert!(!rt.state.transcript_display.pictures.preview_open());
    assert!(rt.state.transcript_display.pictures.images.is_empty());
    assert_ne!(rt.state.transcript_display.pictures.generation, gen_before);
    // Surviving visible card remounts with the bumped key and re-fetches cleanly.
    let mut served_after_revert = false;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
    loop {
        rt.frame(1.0 / 60.0);
        rt.update(|s, tx| {
            if super::super::events::poll_chat(s, 8) {
                tx.instant();
            }
        });
        if !served_after_revert
            && rt
                .state
                .transcript_display
                .pictures
                .images
                .values()
                .any(|e| e.request.is_some())
        {
            rt_tokio.block_on(server_serve());
            served_after_revert = true;
        }
        if rt
            .state
            .transcript_display
            .pictures
            .images
            .values()
            .any(|e| e.image.as_ref().is_some_and(Image::is_ready))
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "revert re-fetch did not settle (served={served_after_revert}, images={})",
            rt.state.transcript_display.pictures.images.len()
        );
        std::thread::yield_now();
    }

    // SessionMoved must clear pictures, cancel any open preview, and empty the transcript.
    rt.state.transcript_display.pictures.fixture_preview(true);
    tx_ev
        .try_send(transport::Event::Workspace(
            codenomad_client::transport::WorkspaceEvent::SessionMoved {
                workspace_id: "owned".into(),
                session_id: "session".into(),
            },
        ))
        .unwrap();
    rt.update(|s, tx| {
        super::super::events::poll_chat(s, 8);
        tx.instant();
    });
    assert!(!rt.state.transcript_display.pictures.preview_open());
    assert!(rt.state.transcript_display.pictures.images.is_empty());
    assert!(rt.state.messages.is_empty());
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn child_task_deferred_tool_image_uses_verified_child_session() {
    use crate::files::test_http::Http;
    use codenomad_client::content::deferred_media_digest;
    use serde_json::json;
    crate::platform::block_on(async {
        let http = Http::new().await;
        let png = large_valid_png(40 * 1024);
        let digest = deferred_media_digest("image/png", &png);
        let child_path =
            format!("/api/workspaces/owned/session-media/child_ses/child_msg/0/0/{digest}");
        let msg = crate::history::decode_message(&json!({
            "id": "child_msg",
            "type": "assistant",
            "content": [{
                "type": "tool",
                "id": "call",
                "name": "read",
                "state": {
                    "status": "completed",
                    "content": [{"type": "file", "mime": "image/png", "uri": child_path}]
                }
            }]
        }))
        .unwrap();
        let crate::content::Part::Tool(tool) = &msg.parts[0] else {
            panic!("missing tool")
        };
        let source = tool.pictures[0].source.clone();

        let mut photos = Pictures::default();
        photos.bind(http.backend.clone()); // root session == "session"
        let lease = Rc::new(());
        let reads = crate::platform::reads::Reads::default();
        let wake: rune::Waker = Arc::new(|| {});

        // Without child owner_session, parent session refuses the child URI with no HTTP call.
        photos.visibility("parent_scope", &source, "image/png", None, &lease, true);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !photos.images["parent_scope"].settled {
            assert!(std::time::Instant::now() < deadline);
            photos.poll(&reads, &wake);
            tokio::task::yield_now().await;
        }
        assert!(photos.images["parent_scope"].image.is_none());

        // With verified child owner_session, Pictures fetches under child_ses cleanly.
        photos.visibility(
            "child_scope",
            &source,
            "image/png",
            Some("child_ses"),
            &lease,
            true,
        );
        photos.poll(&reads, &wake);
        let req = http.accept().await;
        assert!(req.header.starts_with(&format!("GET {child_path} ")));
        assert!(
            req.header
                .to_ascii_lowercase()
                .contains("cache-control: no-store")
        );
        req.send(
            &format!(
                "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                png.len()
            ),
            &png,
        )
        .await;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !photos.images["child_scope"].settled {
            assert!(std::time::Instant::now() < deadline);
            photos.poll(&reads, &wake);
            tokio::task::yield_now().await;
        }
        assert!(
            photos.images["child_scope"]
                .image
                .as_ref()
                .is_some_and(|img| img.is_ready() && img.error().is_none())
        );

        // Revoking the child session clears its cached images and bumps its child generation
        // while keeping unrelated parent/sibling entries intact.
        let key_before = source_key(
            "child_card",
            photos.generation,
            photos
                .child_generations
                .get("child_ses")
                .copied()
                .unwrap_or(0),
            &source,
            "image/png",
        );
        assert!(photos.clear_child_sessions(&["child_ses".into()]));
        assert!(!photos.images.contains_key("child_scope"));
        assert!(photos.images.contains_key("parent_scope"));
        let key_after = source_key(
            "child_card",
            photos.generation,
            photos
                .child_generations
                .get("child_ses")
                .copied()
                .unwrap_or(0),
            &source,
            "image/png",
        );
        assert_ne!(key_before, key_after);
        http.quiet().await;
    });
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn offscreen_images_evict_lru_under_retained_pixel_budget_and_reacquire_when_visible() {
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNQSFjwHx9moL0CAFNzQ+EMxFw9AAAAAElFTkSuQmCC";
    // Each decoded PNG is 8x4 = 32 pixels; allow 64 pixels (two images) simultaneously.
    const TEST_BUDGET: usize = 64;
    let mut photos = Pictures::default();
    let origin = PictureSource::Inline(png.into());
    let slots: Vec<_> = (0..4)
        .map(|index| (format!("img-{index}"), Rc::new(())))
        .collect();
    let reads = crate::platform::reads::Reads::default();
    let wake: rune::Waker = Arc::new(|| {});

    // Mount all 4 visible: budget admits 2 decoded images and pauses dispatching the remaining 2.
    for (key, lease) in &slots {
        photos.visibility(key, &origin, "image/png", None, lease, true);
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
    loop {
        photos.poll_with_budget(&reads, &wake, TEST_BUDGET);
        let ready = photos
            .images
            .values()
            .filter(|e| e.image.as_ref().is_some_and(Image::is_ready))
            .count();
        if ready == 2 && photos.retained_pixels() == TEST_BUDGET {
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    assert_eq!(photos.waiting.len(), 2);
    assert!(photos.images["img-2"].image.is_none());
    assert!(photos.images["img-3"].image.is_none());

    // Scroll img-0 and img-1 off-screen: poll must evict them to admit img-2 and img-3.
    photos.visibility("img-0", &origin, "image/png", None, &slots[0].1, false);
    photos.visibility("img-1", &origin, "image/png", None, &slots[1].1, false);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
    loop {
        photos.poll_with_budget(&reads, &wake, TEST_BUDGET);
        if photos.images["img-2"]
            .image
            .as_ref()
            .is_some_and(Image::is_ready)
            && photos.images["img-3"]
                .image
                .as_ref()
                .is_some_and(Image::is_ready)
        {
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    assert!(photos.images["img-0"].image.is_none() && !photos.images["img-0"].settled);
    assert!(photos.images["img-1"].image.is_none() && !photos.images["img-1"].settled);
    assert!(photos.retained_pixels() <= TEST_BUDGET);

    // Scroll img-0 back into view while img-2 leaves: img-0 must re-acquire cleanly.
    photos.visibility("img-2", &origin, "image/png", None, &slots[2].1, false);
    photos.visibility("img-0", &origin, "image/png", None, &slots[0].1, true);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
    loop {
        photos.poll_with_budget(&reads, &wake, TEST_BUDGET);
        if photos.images["img-0"]
            .image
            .as_ref()
            .is_some_and(Image::is_ready)
        {
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    assert!(photos.images["img-2"].image.is_none());
    assert!(photos.retained_pixels() <= TEST_BUDGET);
}
