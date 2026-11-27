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

    pub(crate) fn preview_open(&self) -> bool {
        self.preview.is_some()
    }

    #[cfg(test)]
    pub(crate) fn fixture_preview(&mut self, open: bool) {
        self.preview = open.then(|| {
            let image = self
                .cache
                .get_or_insert_with(|| ImageCache::new(Arc::new(|| {})))
                .load(Vec::new());
            ("preview".into(), "image.png".into(), image)
        });
    }

    pub(crate) fn clear(&mut self) {
        self.images.clear();
        self.waiting.clear();
        self.cache = None;
        self.preview = None;
        self.hover = None;
    }

    pub(crate) fn retained_bytes(&self) -> usize {
        let entries = self.images.iter().fold(0usize, |total, (key, entry)| {
            let decoded = entry
                .image
                .as_ref()
                .and_then(attachment::decoded_size)
                .map_or(0, |[w, h]| {
                    (w as usize).saturating_mul(h as usize).saturating_mul(4)
                });
            let source = match &entry.media {
                PictureSource::Inline(bytes) => bytes.len(),
                PictureSource::Http(url) => url.len(),
                PictureSource::Attachment(_)
                | PictureSource::Deferred(_)
                | PictureSource::Unavailable => 0,
            };
            total
                .saturating_add(key.len())
                .saturating_add(entry.mime.len())
                .saturating_add(source)
                .saturating_add(decoded)
        });
        let preview = self
            .preview
            .as_ref()
            .and_then(|(_, _, image)| attachment::decoded_size(image))
            .map_or(0, |[w, h]| {
                (w as usize).saturating_mul(h as usize).saturating_mul(4)
            });
        entries.saturating_add(preview)
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

#[cfg(test)]
mod tests;
