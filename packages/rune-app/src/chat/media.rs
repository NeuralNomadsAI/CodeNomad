use crate::{
    State,
    backend::Backend,
    content::PictureSource,
    screen,
    strings::{locale, t},
};
use codenomad_client::{Receiver, Sender, bounded};
use rune::{El, Image, ImageCache};
use rune_theme_codenomad::{attachment, catalogue, layout};
use std::{
    collections::{HashMap, VecDeque},
    hash::{DefaultHasher, Hash, Hasher},
    rc::{Rc, Weak},
    sync::Arc,
};

const CONCURRENT: usize = 2;

#[cfg(all(feature = "test-support", target_arch = "wasm32"))]
pub(crate) mod browser_fixture;

#[derive(Default)]
pub(crate) struct Pictures {
    backend: Option<Backend>,
    cache: Option<ImageCache>,
    images: HashMap<String, Entry>,
    waiting: VecDeque<String>,
    preview: Option<(String, String, Image)>,
    hover: Option<(String, String)>,
}

struct Entry {
    lease: Weak<()>,
    media: PictureSource,
    mime: String,
    visible: bool,
    request: Option<(Sender<()>, Receiver<Option<Arc<Vec<u8>>>>)>,
    image: Option<Image>,
    settled: bool,
}

impl Pictures {
    pub(crate) fn bind(&mut self, backend: Backend) {
        self.clear();
        self.backend = Some(backend);
    }

    pub(crate) fn clear(&mut self) {
        self.images.clear();
        self.waiting.clear();
        self.cache = None;
        self.preview = None;
        self.hover = None;
    }

    pub(crate) fn retry_interrupted(&mut self) {
        for (key, entry) in &mut self.images {
            if entry.image.is_none()
                && (entry.settled || entry.request.is_some())
                && matches!(
                    entry.media,
                    PictureSource::Attachment(_)
                        | PictureSource::Deferred(_)
                        | PictureSource::Http(_)
                )
            {
                entry.request = None;
                entry.settled = false;
                if entry.visible {
                    self.waiting.push_back(key.clone());
                }
            }
        }
    }

    fn visibility(
        &mut self,
        key: &str,
        media: &PictureSource,
        mime: &str,
        lease: &Rc<()>,
        visible: bool,
    ) {
        if matches!(media, PictureSource::Unavailable) {
            return;
        }
        if visible {
            let entry = self.images.entry(key.into()).or_insert_with(|| Entry {
                lease: Rc::downgrade(lease),
                media: media.clone(),
                mime: mime.into(),
                visible: false,
                request: None,
                image: None,
                settled: false,
            });
            if !entry.visible && entry.request.is_none() && entry.image.is_none() && !entry.settled
            {
                self.waiting.push_back(key.into());
            }
            entry.visible = true;
        } else if let Some(entry) = self.images.get_mut(key) {
            // Keep the acquired height and image until the card actually unmounts.
            entry.visible = false;
            self.waiting.retain(|queued| queued != key);
            if self.hover.as_ref().is_some_and(|(anchor, _)| anchor == key) {
                self.hover = None;
            }
        }
    }

    pub(crate) fn poll(
        &mut self,
        reads: &crate::platform::reads::Reads,
        wake: &rune::Waker,
    ) -> bool {
        self.images
            .retain(|_, entry| entry.lease.strong_count() > 0);
        self.waiting
            .retain(|key| self.images.get(key).is_some_and(|entry| entry.visible));
        let mut changed = false;
        for entry in self.images.values_mut() {
            if let Some(bytes) = entry
                .request
                .as_ref()
                .and_then(|(_, result)| result.try_recv().ok())
            {
                entry.request = None;
                entry.settled = bytes.is_none();
                entry.image = bytes.map(|bytes| {
                    self.cache
                        .get_or_insert_with(|| ImageCache::new(wake.clone()))
                        .load(bytes.as_slice())
                });
                changed = true;
            }
            if !entry.settled && entry.image.as_ref().is_some_and(Image::is_ready) {
                if entry
                    .image
                    .as_ref()
                    .and_then(attachment::decoded_size)
                    .is_some_and(|[width, height]| {
                        !codenomad_client::files::images::transcript_dimensions(
                            width as usize,
                            height as usize,
                        )
                    })
                {
                    entry.image = None;
                }
                entry.settled = true;
                changed = true;
            }
        }
        let running = self
            .images
            .values()
            .filter(|entry| {
                entry.request.is_some()
                    || entry.image.as_ref().is_some_and(|image| !image.is_ready())
            })
            .count();
        let mut remaining = CONCURRENT.saturating_sub(running);
        while remaining > 0
            && let Some(key) = self.waiting.pop_front()
        {
            let Some(entry) = self.images.get_mut(&key).filter(|entry| {
                entry.visible && !entry.settled && entry.request.is_none() && entry.image.is_none()
            }) else {
                continue;
            };
            remaining -= 1;
            let (cancel, cancelled) = bounded(1);
            let (out, result) = bounded(1);
            entry.request = Some((cancel, result));
            let (media, mime, backend, reads, wake) = (
                entry.media.clone(),
                entry.mime.clone(),
                self.backend.clone(),
                reads.clone(),
                wake.clone(),
            );
            crate::platform::spawn(async move {
                use crate::platform::reads::cancellable;
                let Some(_slot) = reads.background(&cancelled).await else {
                    return;
                };
                let Some(bytes) =
                    cancellable(&cancelled, media.bytes(backend.as_ref(), &mime)).await
                else {
                    return;
                };
                if out.send(bytes.ok()).await.is_ok() {
                    wake();
                }
            });
        }
        changed
    }
}

pub(super) fn tool<'a>(
    s: &'a State,
    key: &'a str,
    pictures: &'a [crate::content::Picture],
) -> impl Iterator<Item = El> + 'a {
    pictures.iter().enumerate().map(move |(i, picture)| {
        let name = picture.name.clone().unwrap_or_else(|| {
            catalogue::format(
                locale(),
                "toolCall.image.label",
                &[("number", &(i + 1).to_string())],
            )
        });
        view(
            s,
            format!("{key}-image-{i}"),
            &picture.source,
            &name,
            &picture.mime,
            false,
        )
    })
}

pub(super) fn view(
    s: &State,
    key: String,
    source: &PictureSource,
    name: &str,
    mime: &str,
    attachment: bool,
) -> El {
    view_on_platform(
        s,
        key,
        source,
        name,
        mime,
        attachment,
        cfg!(target_arch = "wasm32"),
    )
}

fn source_key(key: &str, source: &PictureSource, mime: &str) -> String {
    let mut stamp = DefaultHasher::new();
    (source, mime).hash(&mut stamp);
    format!("{key}-{:x}", stamp.finish())
}

fn view_on_platform(
    s: &State,
    key: String,
    source: &PictureSource,
    name: &str,
    mime: &str,
    attachment: bool,
    web: bool,
) -> El {
    let key = source_key(&key, source, mime);
    let entry = s
        .transcript_display
        .pictures
        .images
        .get(&key)
        .filter(|entry| entry.media == *source);
    let lease = entry
        .and_then(|entry| entry.lease.upgrade())
        .unwrap_or_default();
    let image = entry
        .and_then(|entry| entry.image.as_ref())
        .filter(|image| {
            attachment::decoded_size(image).is_none_or(|[width, height]| {
                codenomad_client::files::images::transcript_dimensions(
                    width as usize,
                    height as usize,
                )
            })
        });
    let unavailable = matches!(source, PictureSource::Unavailable)
        || entry.is_some_and(|entry| {
            entry.settled && image.is_none_or(|image| image.error().is_some())
        });
    let external = external_url(source, unavailable, web);
    let mut content = attachment::picture(
        image,
        name,
        mime,
        (unavailable && external.is_none()).then(|| t("toolCall.image.unavailable")),
        attachment,
    );
    if let Some(url) = external {
        let url = url.to_owned();
        content = content.child(
            layout::button_tx(
                t("toolCall.image.openExternal"),
                false,
                screen::action_tx(&s.input_scope, move |_, tx| {
                    let _ = tx.open_url(&url);
                }),
            )
            .key(format!("{key}-external"))
            .role("link"),
        );
    }
    if attachment && image.is_some_and(|image| image.is_ready() && image.error().is_none()) {
        let (preview_name, anchor, lookup) =
            (name.to_owned(), format!("{key}-enlarge"), key.clone());
        content = content.child(
            layout::button(
                t("messageItem.attachment.enlarge"),
                false,
                screen::action(&s.input_scope, {
                    let anchor = anchor.clone();
                    move |s| {
                        let pictures = &mut s.transcript_display.pictures;
                        pictures.hover = None;
                        if let Some(image) = pictures
                            .images
                            .get(&lookup)
                            .and_then(|entry| entry.image.clone())
                        {
                            pictures.preview = Some((anchor.clone(), preview_name.clone(), image));
                        }
                    }
                }),
            )
            .key(anchor),
        );
        let (anchor, label, scope) = (key.clone(), name.to_owned(), s.input_scope.clone());
        content = content.on_hover_change(move |s: &mut State, inside, _| {
            if !s.current_scope(&scope) {
                return;
            }
            let pictures = &mut s.transcript_display.pictures;
            if inside && pictures.preview.is_none() {
                pictures.hover = Some((anchor.clone(), label.clone()));
            } else if pictures
                .hover
                .as_ref()
                .is_some_and(|(key, _)| key == &anchor)
            {
                pictures.hover = None;
            }
        });
    }
    let (request, mime, scope, target) = (
        source.clone(),
        mime.to_owned(),
        s.input_scope.clone(),
        key.clone(),
    );
    content
        .key(key)
        .on_visible(move |s: &mut State, visible, tx| {
            if s.current_scope(&scope) {
                s.transcript_display
                    .pictures
                    .visibility(&target, &request, &mime, &lease, visible);
                if visible {
                    tx.wake_after(std::time::Duration::ZERO);
                }
            }
            tx.live_only();
        })
}

fn external_url(source: &PictureSource, unavailable: bool, web: bool) -> Option<&str> {
    match source {
        PictureSource::Http(url) if unavailable && web => Some(url),
        _ => None,
    }
}

pub(super) fn preview(s: &State) -> Option<El> {
    let pictures = &s.transcript_display.pictures;
    if let Some((anchor, name, image)) = &pictures.preview {
        return attachment::picture_preview(
            image,
            name,
            t("settings.close"),
            anchor,
            |s: &mut State| {
                s.transcript_display.pictures.preview = None;
            },
        );
    }
    let (anchor, name) = pictures.hover.as_ref()?;
    let image = pictures.images.get(anchor)?.image.as_ref()?;
    attachment::picture_hover(image, name, anchor)
}

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
            if super::events::poll_chat(s, 4) {
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

#[cfg(test)]
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
    let encoded = include_str!("../../fixtures/animated-32.avif.b64").trim();
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
