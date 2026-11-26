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
const RETAINED_PIXELS: usize = 32 * 1024 * 1024;

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
    generation: u64,
    child_generations: HashMap<String, u64>,
    access_seq: u64,
}

struct Entry {
    lease: Weak<()>,
    media: PictureSource,
    mime: String,
    owner_session: Option<String>,
    visible: bool,
    request: Option<(Sender<()>, Receiver<Option<Arc<Vec<u8>>>>)>,
    image: Option<Image>,
    pixels: usize,
    last_used: u64,
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
        self.generation = self.generation.wrapping_add(1);
        self.child_generations.clear();
        self.images.clear();
        self.waiting.clear();
        self.cache = None;
        self.preview = None;
        self.hover = None;
    }

    pub(crate) fn clear_child_sessions(&mut self, sessions: &[String]) -> bool {
        if sessions.is_empty() {
            return false;
        }
        let mut affected = Vec::new();
        let removed: Vec<String> = self
            .images
            .iter()
            .filter_map(|(key, entry)| {
                let owner = entry.owner_session.as_deref()?;
                if sessions.iter().any(|revoked| revoked == owner) {
                    if !affected.iter().any(|seen: &String| seen == owner) {
                        affected.push(owner.to_owned());
                    }
                    Some(key.clone())
                } else {
                    None
                }
            })
            .collect();
        if removed.is_empty() {
            return false;
        }
        for owner in affected {
            let entry = self.child_generations.entry(owner).or_default();
            *entry = entry.wrapping_add(1);
        }
        for key in &removed {
            self.images.remove(key);
            self.waiting.retain(|queued| queued != key);
            if self
                .preview
                .as_ref()
                .is_some_and(|(anchor, _, _)| anchor == key || anchor == &format!("{key}-enlarge"))
            {
                self.preview = None;
            }
            if self.hover.as_ref().is_some_and(|(anchor, _)| anchor == key) {
                self.hover = None;
            }
        }
        true
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

    fn retained_pixels(&self) -> usize {
        self.images
            .values()
            .fold(0usize, |acc, entry| acc.saturating_add(entry.pixels))
    }

    fn is_pinned(&self, key: &str) -> bool {
        self.preview
            .as_ref()
            .is_some_and(|(anchor, _, _)| anchor == key || anchor == &format!("{key}-enlarge"))
            || self.hover.as_ref().is_some_and(|(anchor, _)| anchor == key)
    }

    fn evict_one_offscreen(&mut self) -> bool {
        let victim = self
            .images
            .iter()
            .filter(|(key, entry)| {
                !entry.visible && entry.image.is_some() && entry.pixels > 0 && !self.is_pinned(key)
            })
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(key, _)| key.clone());
        let Some(victim) = victim else {
            return false;
        };
        if let Some(entry) = self.images.get_mut(&victim) {
            entry.image = None;
            entry.pixels = 0;
            entry.settled = false;
            return true;
        }
        false
    }

    fn evict_pixels(&mut self, budget: usize) -> bool {
        let mut changed = false;
        while self.retained_pixels() > budget {
            if !self.evict_one_offscreen() {
                break;
            }
            changed = true;
        }
        changed
    }

    fn visibility(
        &mut self,
        key: &str,
        media: &PictureSource,
        mime: &str,
        owner_session: Option<&str>,
        lease: &Rc<()>,
        visible: bool,
    ) {
        if matches!(media, PictureSource::Unavailable) {
            return;
        }
        if visible {
            self.access_seq = self.access_seq.wrapping_add(1);
            let seq = self.access_seq;
            let entry = self.images.entry(key.into()).or_insert_with(|| Entry {
                lease: Rc::downgrade(lease),
                media: media.clone(),
                mime: mime.into(),
                owner_session: owner_session.map(str::to_owned),
                visible: false,
                request: None,
                image: None,
                pixels: 0,
                last_used: seq,
                settled: false,
            });
            entry.last_used = seq;
            if !entry.visible && entry.request.is_none() && entry.image.is_none() && !entry.settled
            {
                self.waiting.push_back(key.into());
            }
            entry.visible = true;
        } else if let Some(entry) = self.images.get_mut(key) {
            // Keep the acquired height and image until unmount or pixel-budget eviction.
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
        self.poll_with_budget(reads, wake, RETAINED_PIXELS)
    }

    fn poll_with_budget(
        &mut self,
        reads: &crate::platform::reads::Reads,
        wake: &rune::Waker,
        pixel_budget: usize,
    ) -> bool {
        self.images
            .retain(|_, entry| entry.lease.strong_count() > 0);
        self.waiting.retain(|key| {
            self.images.get(key).is_some_and(|entry| {
                entry.visible && !entry.settled && entry.request.is_none() && entry.image.is_none()
            })
        });
        let mut changed = false;
        let mut seq = self.access_seq;
        for entry in self.images.values_mut() {
            if let Some(bytes) = entry
                .request
                .as_ref()
                .and_then(|(_, result)| result.try_recv().ok())
            {
                entry.request = None;
                entry.settled = bytes.is_none();
                entry.pixels = 0;
                entry.image = bytes.map(|bytes| {
                    self.cache
                        .get_or_insert_with(|| ImageCache::new(wake.clone()))
                        .load(bytes.as_slice())
                });
                changed = true;
            }
            if !entry.settled && entry.image.as_ref().is_some_and(Image::is_ready) {
                if let Some([width, height]) =
                    entry.image.as_ref().and_then(attachment::decoded_size)
                {
                    if !codenomad_client::files::images::transcript_dimensions(
                        width as usize,
                        height as usize,
                    ) {
                        entry.image = None;
                        entry.pixels = 0;
                    } else {
                        entry.pixels = (width as usize).saturating_mul(height as usize);
                        seq = seq.wrapping_add(1);
                        entry.last_used = seq;
                    }
                } else {
                    entry.pixels = 0;
                }
                entry.settled = true;
                changed = true;
            }
        }
        self.access_seq = seq;
        changed |= self.evict_pixels(pixel_budget);
        let running = self
            .images
            .values()
            .filter(|entry| {
                entry.request.is_some()
                    || entry.image.as_ref().is_some_and(|image| !image.is_ready())
            })
            .count();
        let mut remaining = CONCURRENT.saturating_sub(running);
        while remaining > 0 && !self.waiting.is_empty() {
            if self.retained_pixels() >= pixel_budget {
                if !self.evict_one_offscreen() {
                    break;
                }
                changed = true;
                continue;
            }
            let Some(key) = self.waiting.pop_front() else {
                break;
            };
            let Some(entry) = self.images.get_mut(&key).filter(|entry| {
                entry.visible && !entry.settled && entry.request.is_none() && entry.image.is_none()
            }) else {
                continue;
            };
            remaining -= 1;
            let (cancel, cancelled) = bounded(1);
            let (out, result) = bounded(1);
            entry.request = Some((cancel, result));
            let mut backend = self.backend.clone();
            if let (PictureSource::Deferred(_), Some(owner), Some(conn)) = (
                &entry.media,
                entry.owner_session.as_deref(),
                backend.as_mut(),
            ) {
                conn.session = owner.to_owned();
            }
            let (media, mime, reads, wake) = (
                entry.media.clone(),
                entry.mime.clone(),
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
    owner_session: Option<&'a str>,
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
            owner_session,
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
    owner_session: Option<&str>,
) -> El {
    view_on_platform(
        s,
        key,
        source,
        name,
        mime,
        attachment,
        owner_session,
        cfg!(target_arch = "wasm32"),
    )
}

fn source_key(
    key: &str,
    generation: u64,
    child_generation: u64,
    source: &PictureSource,
    mime: &str,
) -> String {
    let mut stamp = DefaultHasher::new();
    (generation, child_generation, source, mime).hash(&mut stamp);
    format!("{key}-{:x}", stamp.finish())
}

#[allow(clippy::too_many_arguments)]
fn view_on_platform(
    s: &State,
    key: String,
    source: &PictureSource,
    name: &str,
    mime: &str,
    attachment: bool,
    owner_session: Option<&str>,
    web: bool,
) -> El {
    let child_generation = owner_session
        .and_then(|owner| s.transcript_display.pictures.child_generations.get(owner))
        .copied()
        .unwrap_or(0);
    let key = source_key(
        &key,
        s.transcript_display.pictures.generation,
        child_generation,
        source,
        mime,
    );
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
    let (request, mime, owner_session, scope, target) = (
        source.clone(),
        mime.to_owned(),
        owner_session.map(str::to_owned),
        s.input_scope.clone(),
        key.clone(),
    );
    content
        .key(key)
        .on_visible(move |s: &mut State, visible, tx| {
            if s.current_scope(&scope) {
                s.transcript_display.pictures.visibility(
                    &target,
                    &request,
                    &mime,
                    owner_session.as_deref(),
                    &lease,
                    visible,
                );
                if visible || !s.transcript_display.pictures.waiting.is_empty() {
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
