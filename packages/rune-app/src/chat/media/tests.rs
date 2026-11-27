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
        photos.visibility(key, &origin, "image/png", lease, true);
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
        photos.visibility(&key, &origin, "image/png", &lease, false);
        photos.poll(&reads, &wake);
        photos.visibility(&key, &origin, "image/png", &lease, true);
        assert_eq!(photos.images[&key].image.as_ref().unwrap().id(), before);
    }
}

#[test]
fn reconnect_requeues_network_failures_and_only_web_links_to_unavailable_http() {
    let mut photos = Pictures::default();
    let lease = Rc::new(());
    let http = PictureSource::Http("https://example.invalid/sample.png".into());
    let inline = PictureSource::Inline("data".into());
    photos.visibility("remote", &http, "image/png", &lease, true);
    photos.visibility("inline", &inline, "image/png", &lease, true);
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
    let key = source_key("remote", &source, "image/png");
    state
        .transcript_display
        .pictures
        .visibility(&key, &source, "image/png", &lease, true);
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
#[test]
fn owned_deferred_image_fetches_passive_bytes_and_refuses_other_sessions() {
    use crate::files::test_http::Http;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use serde_json::json;
    crate::platform::block_on(async {
        let http = Http::new().await;
        let path = format!(
            "/api/workspaces/owned/session-media/session/message/0/1/{}",
            "a".repeat(64)
        );
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
        let mut foreign = http.backend.clone();
        foreign.session = "other".into();
        assert!(source.bytes(Some(&foreign), "image/png").await.is_err());
        let png = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNQSFjwHx9moL0CAFNzQ+EMxFw9AAAAAElFTkSuQmCC").unwrap();
        let backend = http.backend.clone();
        let read =
            tokio::spawn(async move { source.bytes(Some(&backend), "image/png").await.unwrap() });
        let request = http.accept().await;
        assert!(request.header.starts_with(&format!("GET {path} ")));
        request.send(&format!("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", png.len()), &png).await;
        assert_eq!(read.await.unwrap().as_slice(), &png);
        http.quiet().await;
    });
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn offscreen_decoded_images_evict_lru_past_budget_while_keeping_visible_images() {
    use base64::{Engine, engine::general_purpose::STANDARD};

    // 8x4 RGBA = 128 bytes each.
    let png = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNQSFjwHx9moL0CAFNzQ+EMxFw9AAAAAElFTkSuQmCC").unwrap();
    let cache = ImageCache::new(Arc::new(|| {}));
    let mut pictures = Pictures::default();
    let leases = [Rc::new(()), Rc::new(()), Rc::new(())];
    let make_ready = || {
        let img = cache.load(png.as_slice());
        img.wait().unwrap();
        img
    };
    for (idx, (key, visible, last_seen)) in [
        ("off-old", false, 1),
        ("off-new", false, 2),
        ("on-screen", true, 3),
    ]
    .into_iter()
    .enumerate()
    {
        pictures.images.insert(
            key.into(),
            Entry {
                lease: Rc::downgrade(&leases[idx]),
                media: PictureSource::Inline(key.into()),
                mime: "image/png".into(),
                visible,
                clip_gate: None,
                request: None,
                image: Some(make_ready()),
                settled: true,
                last_seen,
            },
        );
    }
    // 3 images = 384 bytes; budget 256 evicts only oldest offscreen (`off-old`) and keeps visible.
    assert!(pictures.evict_offscreen_decoded(None, 256));
    assert!(pictures.images["off-old"].image.is_none());
    assert!(!pictures.images["off-old"].settled);
    assert!(pictures.images["off-new"].image.is_some());
    assert!(pictures.images["on-screen"].image.is_some());
    // Budget 64 evicts the remaining offscreen image (`off-new`) but never evicts `on-screen`.
    assert!(pictures.evict_offscreen_decoded(None, 64));
    assert!(pictures.images["off-new"].image.is_none());
    assert!(pictures.images["on-screen"].image.is_some());
}
