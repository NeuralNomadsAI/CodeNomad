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
    collections::{HashMap, HashSet, VecDeque},
    hash::{DefaultHasher, Hash, Hasher},
    rc::{Rc, Weak},
    sync::Arc,
};

const CONCURRENT: usize = 2;
const DECODED_BUDGET: usize = 64 * 1024 * 1024;

#[cfg(all(feature = "test-support", target_arch = "wasm32"))]
pub(crate) mod browser_fixture;

pub(super) enum LocalImageState {
    Ready(Image),
    Pending(Option<[u32; 2]>),
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
    access_tick: u64,
}

struct Entry {
    lease: Weak<()>,
    media: PictureSource,
    mime: String,
    visible: bool,
    clip_gate: Option<(Rc<DrawnRect>, ActiveClip)>,
    request: Option<(Sender<()>, Receiver<Option<Arc<Vec<u8>>>>)>,
    image: Option<Image>,
    frames: usize,
    last_size: Option<[u32; 2]>,
    settled: bool,
    last_seen: u64,
}

fn mipmap_pixels(mut w: usize, mut h: usize) -> usize {
    let mut pixels = w.saturating_mul(h);
    while w > 1 || h > 1 {
        w = (w / 2).max(1);
        h = (h / 2).max(1);
        pixels = pixels.saturating_add(w.saturating_mul(h));
    }
    pixels
}

fn decoded_bytes_for(width: u32, height: u32, frames: usize) -> usize {
    mipmap_pixels(width as usize, height as usize)
        .saturating_mul(4)
        .saturating_mul(frames.max(1))
}

fn decoded_bytes(image: &Image, frames: usize) -> usize {
    attachment::decoded_size(image).map_or(0, |[w, h]| decoded_bytes_for(w, h, frames))
}

fn encoded_frame_count(bytes: &[u8]) -> usize {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return apng_frame_count(bytes);
    }
    if cfg!(target_arch = "wasm32") {
        return 1;
    }
    encoded_frame_count_native(bytes)
}

fn encoded_frame_count_native(bytes: &[u8]) -> usize {
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return gif_frame_count(bytes);
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return apng_frame_count(bytes);
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return webp_frame_count(bytes);
    }
    1
}

fn encoded_animation_dimensions(bytes: &[u8]) -> Option<[u32; 2]> {
    if (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) && bytes.len() >= 10 {
        let w = u16::from_le_bytes([bytes[6], bytes[7]]) as u32;
        let h = u16::from_le_bytes([bytes[8], bytes[9]]) as u32;
        return Some([w, h]);
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        && bytes.get(12..16) == Some(b"IHDR")
        && bytes.len() >= 24
    {
        let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
        return Some([w, h]);
    }
    if bytes.len() >= 30
        && &bytes[0..4] == b"RIFF"
        && &bytes[8..12] == b"WEBP"
        && &bytes[12..16] == b"VP8X"
    {
        let w = (bytes[24] as u32 | ((bytes[25] as u32) << 8) | ((bytes[26] as u32) << 16)) + 1;
        let h = (bytes[27] as u32 | ((bytes[28] as u32) << 8) | ((bytes[29] as u32) << 16)) + 1;
        return Some([w, h]);
    }
    None
}

fn animated_within_budget(bytes: &[u8], frames: usize) -> bool {
    if frames <= 1 {
        return true;
    }
    encoded_animation_dimensions(bytes)
        .is_none_or(|[w, h]| decoded_bytes_for(w, h, frames) <= DECODED_BUDGET)
}

fn skip_gif_subblocks(bytes: &[u8], mut pos: usize) -> Option<usize> {
    loop {
        let len = *bytes.get(pos)? as usize;
        pos += 1;
        if len == 0 {
            return Some(pos);
        }
        pos = pos.checked_add(len)?;
        if pos > bytes.len() {
            return None;
        }
    }
}

fn gif_frame_count(bytes: &[u8]) -> usize {
    let Some(&packed) = bytes.get(10) else {
        return 1;
    };
    let mut pos = 13usize;
    if packed & 0x80 != 0 {
        let table = 3usize << ((packed & 0x07) + 1);
        pos = pos.saturating_add(table);
    }
    let mut frames = 0usize;
    while let Some(&introducer) = bytes.get(pos) {
        match introducer {
            0x2C => {
                frames += 1;
                let Some(&img_packed) = bytes.get(pos + 9) else {
                    break;
                };
                pos += 10;
                if img_packed & 0x80 != 0 {
                    let table = 3usize << ((img_packed & 0x07) + 1);
                    pos = pos.saturating_add(table);
                }
                // Skip LZW minimum code size byte, then compressed data sub-blocks.
                pos = pos.saturating_add(1);
                let Some(next) = skip_gif_subblocks(bytes, pos) else {
                    break;
                };
                pos = next;
            }
            0x21 => {
                pos = pos.saturating_add(2);
                let Some(next) = skip_gif_subblocks(bytes, pos) else {
                    break;
                };
                pos = next;
            }
            0x3B => break,
            _ => break,
        }
    }
    frames.max(1)
}

fn apng_frame_count(bytes: &[u8]) -> usize {
    let mut pos = 8usize;
    while let Some(header) = bytes.get(pos..pos + 8) {
        let len = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
        let kind = &header[4..8];
        let data_start = pos + 8;
        let Some(next) = data_start
            .checked_add(len)
            .and_then(|end| end.checked_add(4))
        else {
            break;
        };
        if next > bytes.len() {
            break;
        }
        if kind == b"acTL" && len >= 4 {
            let count = u32::from_be_bytes([
                bytes[data_start],
                bytes[data_start + 1],
                bytes[data_start + 2],
                bytes[data_start + 3],
            ]) as usize;
            return count.max(1);
        }
        if kind == b"IDAT" || kind == b"IEND" {
            break;
        }
        pos = next;
    }
    1
}

fn webp_frame_count(bytes: &[u8]) -> usize {
    let mut pos = 12usize;
    let mut frames = 0usize;
    while let Some(header) = bytes.get(pos..pos + 8) {
        let kind = &header[0..4];
        let len = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
        let padded = len.saturating_add(len & 1);
        let Some(next) = (pos + 8).checked_add(padded) else {
            break;
        };
        if kind == b"ANMF" {
            frames += 1;
        }
        if next > bytes.len() {
            break;
        }
        pos = next;
    }
    frames.max(1)
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

    pub(crate) fn retained_bytes(&self) -> usize {
        let mut decoded_by_id = HashMap::new();
        let mut total = self.images.iter().fold(0usize, |total, (key, entry)| {
            if let Some(image) = entry.image.as_ref() {
                let bytes = decoded_bytes(image, entry.frames);
                decoded_by_id
                    .entry(image.id())
                    .and_modify(|existing: &mut usize| *existing = (*existing).max(bytes))
                    .or_insert(bytes);
            }
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
        });
        if let Some((_, _, image)) = &self.preview {
            let bytes = decoded_bytes(image, 1);
            decoded_by_id
                .entry(image.id())
                .and_modify(|existing: &mut usize| *existing = (*existing).max(bytes))
                .or_insert(bytes);
        }
        for bytes in decoded_by_id.into_values() {
            total = total.saturating_add(bytes);
        }
        total
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
        self.local_slot_for(key, source, mime, None)
    }

    pub(super) fn local_slot_for(
        &self,
        key: &str,
        source: &PictureSource,
        mime: &str,
        origin: Option<u64>,
    ) -> (String, Rc<()>, Rc<DrawnRect>, LocalImageState) {
        let key = source_key_with_origin(key, source, mime, origin);
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
            LocalImageState::Pending(entry.and_then(|entry| entry.last_size))
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
            self.access_tick = self.access_tick.wrapping_add(1);
            let tick = self.access_tick;
            let entry = self.images.entry(key.into()).or_insert_with(|| Entry {
                lease: Rc::downgrade(lease),
                media: media.clone(),
                mime: mime.into(),
                visible: false,
                clip_gate: None,
                request: None,
                image: None,
                frames: 1,
                last_size: None,
                settled: false,
                last_seen: tick,
            });
            entry.visible = true;
            entry.clip_gate = Some((drawn.clone(), clip.clone()));
            let in_view = entry_in_view(entry, Some((clock, bounds)));
            if in_view {
                entry.last_seen = tick;
            }
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
                if entry.request.take().is_some() {
                    return !self.waiting.is_empty();
                }
            }
            false
        } else {
            let mut freed = false;
            if let Some(entry) = self.images.get_mut(key) {
                entry.visible = false;
                freed = entry.request.take().is_some();
                self.waiting.retain(|queued| queued != key);
                if self.hover.as_ref().is_some_and(|(anchor, _)| anchor == key) {
                    self.hover = None;
                }
            }
            freed && !self.waiting.is_empty()
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
        self.access_tick = self.access_tick.wrapping_add(1);
        let tick = self.access_tick;
        let entry = self.images.entry(key.into()).or_insert_with(|| Entry {
            lease: Rc::downgrade(lease),
            media: media.clone(),
            mime: mime.into(),
            visible: true,
            clip_gate: None,
            request: None,
            image: None,
            frames: 1,
            last_size: None,
            settled: false,
            last_seen: tick,
        });
        entry.clip_gate = Some((drawn.clone(), clip.clone()));
        let in_view = entry_in_view(entry, Some((clock, bounds)));
        if in_view {
            entry.last_seen = tick;
        }
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
            if entry.request.take().is_some() {
                return !self.waiting.is_empty();
            }
        }
        false
    }

    #[cfg(test)]
    pub(super) fn local_visible_or_queued_for(
        &self,
        key: &str,
        source: &PictureSource,
        mime: &str,
        origin: Option<u64>,
        clock: &Clock,
        bounds: [f32; 4],
    ) -> bool {
        let key = source_key_with_origin(key, source, mime, origin);
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
    ) -> bool {
        if matches!(media, PictureSource::Unavailable) {
            return false;
        }
        if visible {
            self.access_tick = self.access_tick.wrapping_add(1);
            let tick = self.access_tick;
            let entry = self.images.entry(key.into()).or_insert_with(|| Entry {
                lease: Rc::downgrade(lease),
                media: media.clone(),
                mime: mime.into(),
                visible: false,
                clip_gate: None,
                request: None,
                image: None,
                frames: 1,
                last_size: None,
                settled: false,
                last_seen: tick,
            });
            entry.last_seen = tick;
            if !entry.visible && entry.request.is_none() && entry.image.is_none() && !entry.settled
            {
                self.waiting.push_back(key.into());
            }
            entry.visible = true;
            true
        } else if let Some(entry) = self.images.get_mut(key) {
            // Keep the acquired height and image until the card actually unmounts.
            entry.visible = false;
            let freed = entry.request.take().is_some();
            self.waiting.retain(|queued| queued != key);
            if self.hover.as_ref().is_some_and(|(anchor, _)| anchor == key) {
                self.hover = None;
            }
            freed && !self.waiting.is_empty()
        } else {
            false
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
        self.access_tick = self.access_tick.wrapping_add(1);
        let tick = self.access_tick;
        for entry in self.images.values_mut() {
            if entry_in_view(entry, view) {
                entry.last_seen = tick;
            } else if entry.request.is_some() {
                entry.request = None;
            }
            if let Some(bytes) = entry
                .request
                .as_ref()
                .and_then(|(_, result)| result.try_recv().ok())
            {
                entry.request = None;
                let frames = bytes
                    .as_deref()
                    .map_or(1, |raw| encoded_frame_count(raw.as_slice()));
                let admitted = bytes.filter(|raw| animated_within_budget(raw.as_slice(), frames));
                entry.frames = frames;
                entry.settled = admitted.is_none();
                entry.image = admitted.map(|bytes| {
                    self.cache
                        .get_or_insert_with(|| ImageCache::new(wake.clone()))
                        .load(bytes.as_slice())
                });
                changed = true;
            }
            if !entry.settled && entry.image.as_ref().is_some_and(Image::is_ready) {
                let decoded = entry.image.as_ref().and_then(attachment::decoded_size);
                if decoded.is_some_and(|[width, height]| {
                    !codenomad_client::files::images::transcript_dimensions(
                        width as usize,
                        height as usize,
                    ) || (entry.frames > 1
                        && decoded_bytes_for(width, height, entry.frames) > DECODED_BUDGET)
                }) {
                    entry.image = None;
                    entry.last_size = None;
                } else if let Some(size) = decoded {
                    entry.last_size = Some(size);
                }
                entry.settled = true;
                changed = true;
            }
        }
        if self.evict_offscreen_decoded(view, DECODED_BUDGET) {
            changed = true;
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

    fn evict_offscreen_decoded(&mut self, view: Option<(&Clock, [f32; 4])>, budget: usize) -> bool {
        let preview_key = self
            .preview
            .as_ref()
            .and_then(|(anchor, _, _)| anchor.strip_suffix("-enlarge"));
        let hover_key = self.hover.as_ref().map(|(anchor, _)| anchor.as_str());
        let mut bytes_by_id = HashMap::new();
        let mut protected_ids = HashSet::new();
        let mut offscreen_by_id: HashMap<_, (u64, Vec<String>)> = HashMap::new();
        for (key, entry) in &self.images {
            let Some(image) = entry.image.as_ref().filter(|image| image.is_ready()) else {
                continue;
            };
            let id = image.id();
            let bytes = decoded_bytes(image, entry.frames);
            bytes_by_id
                .entry(id)
                .and_modify(|existing: &mut usize| *existing = (*existing).max(bytes))
                .or_insert(bytes);
            if entry_in_view(entry, view)
                || preview_key == Some(key.as_str())
                || hover_key == Some(key.as_str())
            {
                protected_ids.insert(id);
            } else {
                offscreen_by_id
                    .entry(id)
                    .and_modify(|(last_seen, keys)| {
                        *last_seen = (*last_seen).max(entry.last_seen);
                        keys.push(key.clone());
                    })
                    .or_insert_with(|| (entry.last_seen, vec![key.clone()]));
            }
        }
        if let Some((_, _, image)) = &self.preview
            && image.is_ready()
        {
            let id = image.id();
            let bytes = decoded_bytes(image, 1);
            bytes_by_id
                .entry(id)
                .and_modify(|existing: &mut usize| *existing = (*existing).max(bytes))
                .or_insert(bytes);
            protected_ids.insert(id);
        }
        let mut total = bytes_by_id
            .values()
            .copied()
            .fold(0usize, usize::saturating_add);
        if total <= budget {
            return false;
        }
        let mut candidates: Vec<(u64, usize, Vec<String>)> = offscreen_by_id
            .into_iter()
            .filter_map(|(id, (last_seen, keys))| {
                if protected_ids.contains(&id) {
                    return None;
                }
                let bytes = bytes_by_id.get(&id).copied().filter(|&bytes| bytes > 0)?;
                Some((last_seen, bytes, keys))
            })
            .collect();
        candidates.sort_by_key(|(last_seen, _, _)| *last_seen);
        let mut evicted = false;
        for (_, bytes, keys) in candidates {
            if total <= budget {
                break;
            }
            for key in keys {
                if let Some(entry) = self.images.get_mut(&key) {
                    if let Some(size) = entry.image.as_ref().and_then(attachment::decoded_size) {
                        entry.last_size = Some(size);
                    }
                    entry.image = None;
                    entry.settled = false;
                    evicted = true;
                }
            }
            total = total.saturating_sub(bytes);
        }
        evicted
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
    source_key_with_origin(key, source, mime, None)
}

fn source_key_with_origin(
    key: &str,
    source: &PictureSource,
    mime: &str,
    origin: Option<u64>,
) -> String {
    let mut stamp = DefaultHasher::new();
    (source, mime, origin).hash(&mut stamp);
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
    let placeholder_size = (!unavailable)
        .then(|| entry.and_then(|entry| entry.last_size))
        .flatten();
    let external = external_url(source, unavailable, web);
    let mut content = attachment::picture_with_placeholder(
        image,
        placeholder_size,
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
            if s.current_scope(&scope)
                && s.transcript_display
                    .pictures
                    .visibility(&target, &request, &mime, &lease, visible)
            {
                tx.wake_after(std::time::Duration::ZERO);
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
