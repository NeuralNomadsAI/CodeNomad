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
fn png_with_tag(base: &[u8], tag: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(base.len() + 15);
    out.extend_from_slice(&base[..base.len() - 12]);
    let payload = [b't', b'E', b'X', b't', b'k', 0, b'0' + tag];
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in &payload {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    out.extend_from_slice(&3u32.to_be_bytes());
    out.extend_from_slice(&payload);
    out.extend_from_slice(&(!crc).to_be_bytes());
    out.extend_from_slice(&base[base.len() - 12..]);
    out
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn offscreen_decoded_images_evict_lru_past_budget_while_keeping_visible_images() {
    use base64::{Engine, engine::general_purpose::STANDARD};

    // 8x4 RGBA = 128 bytes each (172 bytes with mipmaps). Tag each copy with a valid ancillary
    // `tEXt` chunk before `IEND` so `ImageCache` assigns distinct handles for distinct images.
    let png = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNQSFjwHx9moL0CAFNzQ+EMxFw9AAAAAElFTkSuQmCC").unwrap();
    let cache = ImageCache::new(Arc::new(|| {}));
    let mut pictures = Pictures::default();
    let leases = [Rc::new(()), Rc::new(()), Rc::new(())];
    let make_ready = |tag: u8| {
        let bytes = png_with_tag(&png, tag);
        let img = cache.load(bytes.as_slice());
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
                image: Some(make_ready(idx as u8)),
                frames: 1,
                last_size: Some([8, 4]),
                settled: true,
                last_seen,
            },
        );
    }
    // 3 images = 3 * 172 = 516 bytes (exact mipmap sum); budget 344 evicts only oldest
    // offscreen (`off-old`) and keeps visible.
    assert!(pictures.evict_offscreen_decoded(None, 344));
    assert!(pictures.images["off-old"].image.is_none());
    assert!(!pictures.images["off-old"].settled);
    assert_eq!(
        pictures.images["off-old"].last_size,
        Some([8, 4]),
        "evicted offscreen image must preserve its last decoded dimensions for layout stability"
    );
    assert!(pictures.images["off-new"].image.is_some());
    assert!(pictures.images["on-screen"].image.is_some());
    // Budget 100 evicts the remaining offscreen image (`off-new`) but never evicts `on-screen`.
    assert!(pictures.evict_offscreen_decoded(None, 100));
    assert!(pictures.images["off-new"].image.is_none());
    assert_eq!(pictures.images["off-new"].last_size, Some([8, 4]));
    assert!(pictures.images["on-screen"].image.is_some());

    // Multi-frame animation accounting: a 32-frame 8x4 entry accounts for 5504 bytes with mipmaps.
    let anim_lease = Rc::new(());
    pictures.images.insert(
        "off-gif".into(),
        Entry {
            lease: Rc::downgrade(&anim_lease),
            media: PictureSource::Inline("gif".into()),
            mime: "image/gif".into(),
            visible: false,
            clip_gate: None,
            request: None,
            image: Some(make_ready(9)),
            frames: 32,
            last_size: Some([8, 4]),
            settled: true,
            last_seen: 4,
        },
    );
    // Budget 1024 exceeds a single frame (170) but is exceeded by 32 frames (5461) -> evicts `off-gif`.
    assert!(pictures.evict_offscreen_decoded(None, 1024));
    assert!(pictures.images["off-gif"].image.is_none());

    // An in-flight download that leaves the viewport cancels immediately so its slot is freed.
    let (cancel_tx, cancel_rx) = bounded(1);
    let (_out_tx, res_rx) = bounded(1);
    let req_lease = Rc::new(());
    pictures.images.insert(
        "off-req".into(),
        Entry {
            lease: Rc::downgrade(&req_lease),
            media: PictureSource::Http("https://example.test/slow.png".into()),
            mime: "image/png".into(),
            visible: true,
            clip_gate: None,
            request: Some((cancel_tx, res_rx)),
            image: None,
            frames: 1,
            last_size: None,
            settled: false,
            last_seen: 5,
        },
    );
    pictures.visibility(
        "off-req",
        &PictureSource::Http("https://example.test/slow.png".into()),
        "image/png",
        &req_lease,
        false,
    );
    assert!(pictures.images["off-req"].request.is_none());
    assert!(cancel_rx.is_closed());
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn evicted_tool_picture_keeps_placeholder_height_while_redecoding() {
    use rune::{Env, Runtime};
    const URL: &str = "https://example.invalid/redecode.png";
    let source = PictureSource::Http(URL.into());
    let mut state = crate::init();
    let lease = Rc::new(());
    let key = source_key("tool-pic", &source, "image/png");
    // Simulate an image whose download just completed and returned an unready decode handle
    // (`image.size() == None`) while `last_size` retains the pre-eviction dimensions.
    let pending_handle = ImageCache::new(Arc::new(|| {})).load(Vec::new());
    state.transcript_display.pictures.images.insert(
        key.clone(),
        Entry {
            lease: Rc::downgrade(&lease),
            media: source,
            mime: "image/png".into(),
            visible: true,
            clip_gate: None,
            request: None,
            image: Some(pending_handle),
            frames: 1,
            last_size: Some([640, 320]),
            settled: false,
            last_seen: 1,
        },
    );
    let mut rt = Runtime::new(
        state,
        |s, _| {
            crate::strings::with_locale("en", || {
                view_on_platform(
                    s,
                    "tool-pic".into(),
                    &PictureSource::Http(URL.into()),
                    "Re-decoding chart",
                    "image/png",
                    false,
                    false,
                )
            })
        },
        (640.0, 480.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("\"role\":\"image\"") && tree.contains("Re-decoding chart"),
        "evicted tool picture must keep its image placeholder box while re-decoding: {tree}"
    );
}

#[test]
fn encoded_frame_count_detects_gif_apng_and_webp_frames() {
    // Minimal 3-frame GIF89a with no color tables.
    let mut gif = Vec::new();
    gif.extend_from_slice(b"GIF89a");
    gif.extend_from_slice(&[1, 0, 1, 0, 0x00, 0, 0]);
    for _ in 0..3 {
        // Image descriptor (10 bytes) + LZW min code size (1 byte) + empty sub-block terminator (0).
        gif.extend_from_slice(&[0x2C, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 0x02, 0x00]);
    }
    gif.push(0x3B);
    assert_eq!(encoded_frame_count_native(&gif), 3);

    // Oversized 1024x1024 40-frame GIF exceeds DECODED_BUDGET (~213 MiB) and is rejected pre-decode.
    let mut huge_gif = Vec::new();
    huge_gif.extend_from_slice(b"GIF89a");
    huge_gif.extend_from_slice(&1024u16.to_le_bytes());
    huge_gif.extend_from_slice(&1024u16.to_le_bytes());
    huge_gif.extend_from_slice(&[0x00, 0, 0]);
    for _ in 0..40 {
        huge_gif.extend_from_slice(&[0x2C, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 0x02, 0x00]);
    }
    huge_gif.push(0x3B);
    let huge_frames = encoded_frame_count_native(&huge_gif);
    assert_eq!(huge_frames, 40);
    assert!(!animated_within_budget(&huge_gif, huge_frames));
    assert!(animated_within_budget(&gif, 3));

    // Narrow 8192x1 1400-frame GIF needs ~2x mipmap storage (~91.7 MiB > 64 MiB) and is rejected.
    let mut narrow_gif = Vec::new();
    narrow_gif.extend_from_slice(b"GIF89a");
    narrow_gif.extend_from_slice(&8192u16.to_le_bytes());
    narrow_gif.extend_from_slice(&1u16.to_le_bytes());
    narrow_gif.extend_from_slice(&[0x00, 0, 0]);
    for _ in 0..1400 {
        narrow_gif.extend_from_slice(&[0x2C, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 0x02, 0x00]);
    }
    narrow_gif.push(0x3B);
    let narrow_frames = encoded_frame_count_native(&narrow_gif);
    assert_eq!(narrow_frames, 1400);
    assert!(!animated_within_budget(&narrow_gif, narrow_frames));

    // Minimal APNG header with acTL num_frames = 12 before IDAT (counted on both native & wasm32).
    let mut apng = Vec::new();
    apng.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    apng.extend_from_slice(&8u32.to_be_bytes());
    apng.extend_from_slice(b"acTL");
    apng.extend_from_slice(&12u32.to_be_bytes());
    apng.extend_from_slice(&0u32.to_be_bytes());
    apng.extend_from_slice(&0u32.to_be_bytes()); // CRC placeholder
    assert_eq!(encoded_frame_count(&apng), 12);

    // Minimal WebP container with 4 ANMF chunks.
    let mut webp = Vec::new();
    webp.extend_from_slice(b"RIFF");
    webp.extend_from_slice(&40u32.to_le_bytes());
    webp.extend_from_slice(b"WEBP");
    for _ in 0..4 {
        webp.extend_from_slice(b"ANMF");
        webp.extend_from_slice(&0u32.to_le_bytes());
    }
    assert_eq!(encoded_frame_count_native(&webp), 4);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn shared_decoded_image_deduplicates_accounting_and_eviction() {
    use base64::{Engine, engine::general_purpose::STANDARD};

    let base = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNQSFjwHx9moL0CAFNzQ+EMxFw9AAAAAElFTkSuQmCC").unwrap();
    let png_a = png_with_tag(&base, 1);
    let png_b = png_with_tag(&base, 2);
    let mut pictures = Pictures::default();
    let cache = pictures
        .cache
        .get_or_insert_with(|| ImageCache::new(Arc::new(|| {})));
    let shared = cache.load(png_a.as_slice());
    let unique = cache.load(png_b.as_slice());
    shared.wait().unwrap();
    unique.wait().unwrap();
    let shared_bytes = decoded_bytes(&shared, 1);
    let unique_bytes = decoded_bytes(&unique, 1);
    assert!(shared_bytes > 0 && unique_bytes > 0);
    assert_ne!(shared.id(), unique.id());

    let lease_visible = Rc::new(());
    let lease_dup = Rc::new(());
    let lease_unique_a = Rc::new(());
    let lease_unique_b = Rc::new(());
    let make_entry = |lease: &Rc<()>, visible: bool, image: Image, last_seen: u64| Entry {
        lease: Rc::downgrade(lease),
        media: PictureSource::Unavailable,
        mime: String::new(),
        visible,
        clip_gate: None,
        request: None,
        image: Some(image),
        frames: 1,
        last_size: None,
        settled: true,
        last_seen,
    };
    pictures.images.insert(
        "a".into(),
        make_entry(&lease_visible, true, shared.clone(), 10),
    );
    pictures
        .images
        .insert("b".into(), make_entry(&lease_dup, false, shared.clone(), 1));
    pictures.images.insert(
        "c".into(),
        make_entry(&lease_unique_a, false, unique.clone(), 2),
    );
    pictures.images.insert(
        "d".into(),
        make_entry(&lease_unique_b, false, unique.clone(), 3),
    );

    // Two pairs of entries share two unique `Image` handles; retained_bytes counts each handle once.
    let expected = 4 + shared_bytes + unique_bytes;
    assert_eq!(pictures.retained_bytes(), expected);

    // With budget = shared_bytes, the offscreen duplicate `b` shares pixels with visible `a`
    // and must NOT be evicted; both offscreen holders (`c` and `d`) of `unique` are evicted
    // together so its decoded pixels are actually released.
    assert!(pictures.evict_offscreen_decoded(None, shared_bytes));
    assert!(
        pictures.images["a"].image.is_some(),
        "visible entry stays ready"
    );
    assert!(
        pictures.images["b"].image.is_some(),
        "offscreen duplicate sharing pixels with a visible entry must not be evicted"
    );
    assert!(
        pictures.images["c"].image.is_none() && pictures.images["d"].image.is_none(),
        "all offscreen holders of an evicted unique Image must be cleared together"
    );
    assert_eq!(pictures.retained_bytes(), 4 + shared_bytes);
}
