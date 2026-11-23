use crate::{
    State,
    backend::Backend,
    content::PictureSource,
    strings::{locale, t},
};
use codenomad_client::{Receiver, Sender, bounded};
use rune::{El, Image, ImageCache};
use rune_theme_codenomad::{attachment, catalogue};
use std::{
    collections::HashMap,
    rc::{Rc, Weak},
    sync::Arc,
};

const MAX_VISIBLE: usize = 8;

#[derive(Default)]
pub(crate) struct Pictures {
    backend: Option<Backend>,
    cache: Option<ImageCache>,
    images: HashMap<String, Entry>,
}

struct Entry {
    lease: Weak<()>,
    media: PictureSource,
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
        self.cache = None;
    }

    fn demand(s: &mut State, key: &str, media: &PictureSource, mime: &str, lease: &Rc<()>) {
        let photos = &mut s.transcript_display.pictures;
        photos
            .images
            .retain(|_, entry| entry.lease.strong_count() > 0);
        if photos
            .images
            .get(key)
            .is_some_and(|entry| entry.media == *media)
            || matches!(media, PictureSource::Unavailable)
            || photos.images.len() >= MAX_VISIBLE
        {
            return;
        }
        let (cancel, cancelled) = bounded(1);
        let (out, result) = bounded(1);
        photos.images.insert(
            key.into(),
            Entry {
                lease: Rc::downgrade(lease),
                media: media.clone(),
                request: Some((cancel, result)),
                image: None,
                settled: false,
            },
        );
        let (media, mime, backend, reads, wake) = (
            media.clone(),
            mime.to_owned(),
            photos.backend.clone(),
            s.reads.clone(),
            s.wake.clone(),
        );
        crate::platform::spawn(async move {
            use crate::platform::reads::cancellable;
            let Some(_slot) = reads.background(&cancelled).await else {
                return;
            };
            let Some(bytes) = cancellable(&cancelled, media.bytes(backend.as_ref(), &mime)).await
            else {
                return;
            };
            if out.send(bytes.ok()).await.is_ok() {
                wake();
            }
        });
    }

    pub(crate) fn poll(&mut self, wake: &rune::Waker) -> bool {
        self.images
            .retain(|_, entry| entry.lease.strong_count() > 0);
        let mut changed = false;
        for entry in self.images.values_mut() {
            if let Some(bytes) = entry
                .request
                .as_ref()
                .and_then(|(_, result)| result.try_recv().ok())
            {
                entry.request = None;
                entry.image = bytes.map(|bytes| {
                    self.cache
                        .get_or_insert_with(|| ImageCache::new(wake.clone()))
                        .load(bytes.as_slice())
                });
                changed = true;
            }
            let settled =
                entry.request.is_none() && entry.image.as_ref().is_none_or(Image::is_ready);
            changed |= std::mem::replace(&mut entry.settled, settled) != settled;
        }
        changed
    }
}

pub(super) fn tool<'a>(
    s: &'a State,
    key: &'a str,
    pictures: &'a [crate::content::Picture],
) -> impl Iterator<Item = El> + 'a {
    pictures.iter().enumerate().map(|(i, picture)| {
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
        )
    })
}

pub(super) fn view(s: &State, key: String, source: &PictureSource, name: &str, mime: &str) -> El {
    let entry = s
        .transcript_display
        .pictures
        .images
        .get(&key)
        .filter(|entry| entry.media == *source);
    let lease = entry
        .and_then(|entry| entry.lease.upgrade())
        .unwrap_or_default();
    let image = entry.and_then(|entry| entry.image.as_ref());
    let unavailable = matches!(source, PictureSource::Unavailable)
        || entry.is_some_and(|entry| {
            entry.settled && image.is_none_or(|image| image.error().is_some())
        });
    let content = attachment::picture(
        image,
        name,
        mime,
        unavailable.then(|| t("toolCall.image.unavailable")),
    );
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
                if visible {
                    Pictures::demand(s, &target, &request, &mime, &lease);
                } else if s
                    .transcript_display
                    .pictures
                    .images
                    .remove(&target)
                    .is_some()
                {
                    s.revision += 1;
                    return;
                }
            }
            tx.live_only();
        })
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
    let mut rt = Runtime::new(state, |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 900.0), Env::new(false, 1.0));
    rt.frame(0.0);
    let initial = rt.accessibility_json().to_string();
    assert!(initial.contains("Notes.txt") && !initial.contains("Tool sample"));
    let (x, y) = rt.find("toggle-tool-reply:4:read").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        rt.update(|s, tx| { if super::super::events::poll_chat(s, 4) { tx.instant(); } });
        rt.frame(1.0 / 60.0);
        let tree = rt.accessibility_json().to_string();
        if tree.contains("Unable to display this image.")
            && tree.matches("\"role\":\"img\"").count() >= 2 {
            assert!(tree.contains("Attached sample") && tree.contains("Tool sample"));
            break;
        }
        assert!(std::time::Instant::now() < deadline, "{tree}");
        std::thread::yield_now();
    }
}
