use crate::{
    State,
    backend::Backend,
    chat::tools::duration::{ActiveClip, Clock},
    content::PictureSource,
    screen,
    strings::{locale, t},
};
use codenomad_client::{Receiver, Sender, bounded};
use rune::{El, Image, ImageCache};
use rune_theme_codenomad::{
    attachment, catalogue,
    layout::{self, DrawnRect},
};
use std::{
    cell::RefCell,
    collections::{HashMap, VecDeque},
    hash::{DefaultHasher, Hash, Hasher},
    rc::{Rc, Weak},
    sync::Arc,
};

const CONCURRENT: usize = 2;

#[cfg(all(feature = "test-support", target_arch = "wasm32"))]
pub(crate) mod browser_fixture;

pub(super) enum LocalImageState {
    Ready(Image),
    Pending,
    Failed,
}

#[derive(Default)]
pub(crate) struct Pictures {
    backend: Option<Backend>,
    cache: Option<ImageCache>,
    sentinel: RefCell<Option<Image>>,
    local_rects: RefCell<HashMap<String, Weak<DrawnRect>>>,
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
    clip_gate: Option<(Rc<DrawnRect>, ActiveClip)>,
    request: Option<(Sender<()>, Receiver<Option<Arc<Vec<u8>>>>)>,
    image: Option<Image>,
    settled: bool,
}

fn entry_in_view(entry: &Entry, view: Option<(&Clock, [f32; 4])>) -> bool {
    if entry.lease.strong_count() == 0 {
        return false;
    }
    let Some((drawn, clip)) = &entry.clip_gate else {
        return entry.visible;
    };
    let Some((clock, bounds)) = view else {
        return entry.visible;
    };
    let rect = drawn.get();
    if rect[2] > 0.0 && rect[3] > 0.0 {
        clock.rect_in_view(rect, bounds, clip)
    } else if clip.is_clipped() {
        false
    } else {
        entry.visible
    }
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
        self.local_rects.borrow_mut().clear();
        self.cache = None;
        self.preview = None;
        self.hover = None;
    }

    #[cfg(test)]
    pub(crate) fn retry_interrupted(&mut self) {
        self.retry_interrupted_with(None);
    }

    pub(crate) fn retry_interrupted_in_view(&mut self, clock: &Clock, bounds: [f32; 4]) {
        self.retry_interrupted_with(Some((clock, bounds)));
    }

    fn retry_interrupted_with(&mut self, view: Option<(&Clock, [f32; 4])>) {
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
                if entry_in_view(entry, view) && !self.waiting.iter().any(|queued| queued == key) {
                    self.waiting.push_back(key.clone());
                }
            }
        }
    }

    pub(super) fn blank_pixel(&self, wake: &rune::Waker) -> Option<Image> {
        let mut slot = self.sentinel.borrow_mut();
        let image =
            slot.get_or_insert_with(|| rune_theme_codenomad::markdown::blank_pixel(wake.clone()));
        (image.is_ready() && image.error().is_none()).then(|| image.clone())
    }

    pub(super) fn local_slot(
        &self,
        key: &str,
        source: &PictureSource,
        mime: &str,
    ) -> (String, Rc<()>, Rc<DrawnRect>, LocalImageState) {
        let key = source_key(key, source, mime);
        let entry = self.images.get(&key).filter(|entry| entry.media == *source);
        let lease = entry
            .and_then(|entry| entry.lease.upgrade())
            .unwrap_or_default();
        let drawn = {
            let mut rects = self.local_rects.borrow_mut();
            rects.retain(|_, rect| rect.strong_count() > 0);
            if let Some(existing) = rects.get(&key).and_then(Weak::upgrade) {
                existing
            } else {
                let rect = entry
                    .and_then(|entry| entry.clip_gate.as_ref().map(|(rect, _)| rect.clone()))
                    .unwrap_or_else(|| Rc::new(DrawnRect::new([0.0; 4])));
                rects.insert(key.clone(), Rc::downgrade(&rect));
                rect
            }
        };
        let ready = entry
            .and_then(|entry| entry.image.as_ref())
            .filter(|image| {
                image.is_ready()
                    && image.error().is_none()
                    && attachment::decoded_size(image).is_none_or(|[width, height]| {
                        codenomad_client::files::images::transcript_dimensions(
                            width as usize,
                            height as usize,
                        )
                    })
            })
            .cloned();
        let state = if let Some(image) = ready {
            LocalImageState::Ready(image)
        } else if entry
            .is_some_and(|entry| entry.settled || entry.image.as_ref().is_some_and(Image::is_ready))
        {
            LocalImageState::Failed
        } else {
            LocalImageState::Pending
        };
        (key, lease, drawn, state)
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn local_visibility(
        &mut self,
        key: &str,
        media: &PictureSource,
        mime: &str,
        lease: &Rc<()>,
        drawn: &Rc<DrawnRect>,
        clip: &ActiveClip,
        clock: &Clock,
        bounds: [f32; 4],
        visible: bool,
    ) -> bool {
        if matches!(media, PictureSource::Unavailable) {
            return false;
        }
        if visible {
            let entry = self.images.entry(key.into()).or_insert_with(|| Entry {
                lease: Rc::downgrade(lease),
                media: media.clone(),
                mime: mime.into(),
                visible: false,
                clip_gate: None,
                request: None,
                image: None,
                settled: false,
            });
            entry.visible = true;
            entry.clip_gate = Some((drawn.clone(), clip.clone()));
            let in_view = entry_in_view(entry, Some((clock, bounds)));
            if in_view
                && entry.request.is_none()
                && entry.image.is_none()
                && !entry.settled
                && !self.waiting.iter().any(|queued| queued == key)
            {
                self.waiting.push_back(key.into());
                return true;
            }
            if !in_view {
                self.waiting.retain(|queued| queued != key);
            }
            false
        } else {
            if let Some(entry) = self.images.get_mut(key) {
                entry.visible = false;
                self.waiting.retain(|queued| queued != key);
                if self.hover.as_ref().is_some_and(|(anchor, _)| anchor == key) {
                    self.hover = None;
                }
            }
            false
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn refresh_local_clip(
        &mut self,
        key: &str,
        media: &PictureSource,
        mime: &str,
        lease: &Rc<()>,
        drawn: &Rc<DrawnRect>,
        clip: &ActiveClip,
        clock: &Clock,
        bounds: [f32; 4],
    ) -> bool {
        if matches!(media, PictureSource::Unavailable) {
            return false;
        }
        let entry = self.images.entry(key.into()).or_insert_with(|| Entry {
            lease: Rc::downgrade(lease),
            media: media.clone(),
            mime: mime.into(),
            visible: true,
            clip_gate: None,
            request: None,
            image: None,
            settled: false,
        });
        entry.clip_gate = Some((drawn.clone(), clip.clone()));
        let in_view = entry_in_view(entry, Some((clock, bounds)));
        if in_view
            && entry.request.is_none()
            && entry.image.is_none()
            && !entry.settled
            && !self.waiting.iter().any(|queued| queued == key)
        {
            self.waiting.push_back(key.into());
            return true;
        }
        if !in_view {
            self.waiting.retain(|queued| queued != key);
        }
        false
    }

    #[cfg(test)]
    pub(super) fn local_visible_or_queued(
        &self,
        key: &str,
        source: &PictureSource,
        mime: &str,
        clock: &Clock,
        bounds: [f32; 4],
    ) -> bool {
        let key = source_key(key, source, mime);
        self.waiting.iter().any(|queued| queued == &key)
            || self.images.get(&key).is_some_and(|entry| {
                entry.request.is_some() || entry_in_view(entry, Some((clock, bounds)))
            })
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
                clip_gate: None,
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

    #[cfg(test)]
    pub(crate) fn poll(
        &mut self,
        reads: &crate::platform::reads::Reads,
        wake: &rune::Waker,
    ) -> bool {
        self.poll_with(reads, wake, None)
    }

    pub(crate) fn poll_in_view(
        &mut self,
        reads: &crate::platform::reads::Reads,
        wake: &rune::Waker,
        clock: &Clock,
        bounds: [f32; 4],
    ) -> bool {
        self.poll_with(reads, wake, Some((clock, bounds)))
    }

    fn poll_with(
        &mut self,
        reads: &crate::platform::reads::Reads,
        wake: &rune::Waker,
        view: Option<(&Clock, [f32; 4])>,
    ) -> bool {
        self.images
            .retain(|_, entry| entry.lease.strong_count() > 0);
        self.waiting.retain(|key| {
            self.images
                .get(key)
                .is_some_and(|entry| entry_in_view(entry, view))
        });
        for (key, entry) in &self.images {
            if entry.clip_gate.is_some()
                && !entry.settled
                && entry.request.is_none()
                && entry.image.is_none()
                && entry_in_view(entry, view)
                && !self.waiting.iter().any(|queued| queued == key)
            {
                self.waiting.push_back(key.clone());
            }
        }
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
                entry_in_view(entry, view)
                    && !entry.settled
                    && entry.request.is_none()
                    && entry.image.is_none()
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
