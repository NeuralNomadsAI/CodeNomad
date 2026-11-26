use crate::platform::{self, reads::cancellable};
use codenomad_client::{
    Receiver, Sender, Wake, bounded,
    files::{MAX_FILE_BYTES, images},
};
use rune::{Image, ImageCache};
use std::{
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
};

const MAX_IMAGES: usize = 8;
type Item = (u64, String, Option<Vec<u8>>);

pub(super) struct Pictures {
    pub shown: Rc<BTreeMap<String, Image>>,
    requested: BTreeSet<String>,
    generation: u64,
    scope: Option<(u64, u64)>,
    cancel: Option<Sender<()>>,
    results: Receiver<Item>,
    send: Sender<Item>,
    wake: Wake,
    cache: ImageCache,
    budget: usize,
    ready: usize,
    visible: bool,
}

impl Pictures {
    pub fn new(wake: Wake) -> Self {
        let (send, results) = bounded(MAX_IMAGES);
        Self {
            shown: Rc::default(),
            requested: BTreeSet::new(),
            generation: 0,
            scope: None,
            cancel: None,
            results,
            send,
            cache: ImageCache::new(wake.clone()),
            wake,
            budget: MAX_FILE_BYTES,
            ready: 0,
            visible: false,
        }
    }
    pub fn suspend(&mut self) {
        if self.visible {
            self.visible = false;
            self.cancel = None;
            self.generation += 1;
        }
    }
    pub(crate) fn retained_bytes(&self) -> usize {
        let encoded = MAX_FILE_BYTES.saturating_sub(self.budget);
        let decoded = self.shown.values().fold(0usize, |total, image| {
            let pixels = rune_theme_codenomad::attachment::decoded_size(image)
                .map_or(0, |[w, h]| {
                    (w as usize).saturating_mul(h as usize).saturating_mul(4)
                });
            total.saturating_add(pixels)
        });
        encoded.max(decoded)
    }
    pub(crate) fn evict(&mut self) -> usize {
        let before = self.retained_bytes();
        if before == 0 && self.shown.is_empty() && self.requested.is_empty() {
            return 0;
        }
        self.suspend();
        self.scope = None;
        self.shown = Rc::default();
        self.requested.clear();
        self.budget = MAX_FILE_BYTES;
        self.ready = 0;
        self.cache = ImageCache::new(self.wake.clone());
        before
    }
    pub fn sync(
        &mut self,
        identity: Option<(u64, u64)>,
        visible: bool,
        base: &str,
        text: &str,
    ) -> bool {
        let switched = self.scope != identity;
        if switched {
            self.suspend();
            self.scope = identity;
            self.shown = Rc::default();
            self.budget = MAX_FILE_BYTES;
            self.requested.clear();
            self.ready = 0;
        }
        if !visible {
            self.suspend();
        }
        let launch = visible && !self.visible;
        self.visible = visible;
        while let Ok((generation, source, bytes)) = self.results.try_recv() {
            if generation == self.generation && visible {
                self.requested.insert(source.clone());
                if let Some(bytes) = bytes {
                    self.budget = self.budget.saturating_sub(bytes.len());
                    Rc::make_mut(&mut self.shown).insert(source, self.cache.load(bytes));
                }
            }
        }
        let ready = self.shown.values().filter(|image| image.is_ready()).count();
        let changed = std::mem::replace(&mut self.ready, ready) != ready;
        if launch && self.budget > 0 {
            self.load(base, text);
        }
        switched || changed
    }
    fn load(&mut self, base: &str, text: &str) {
        let mut seen = self.requested.clone();
        let sources: Vec<_> = rune_theme_codenomad::document_reader::markdown_image_sources(text)
            .into_iter()
            .filter(|source| {
                #[cfg(test)]
                if !source.starts_with(base) {
                    return false;
                }
                images::supported(base, source) && seen.insert(source.clone())
            })
            .take(MAX_IMAGES.saturating_sub(self.requested.len()))
            .collect();
        if sources.is_empty() {
            return;
        }
        let (cancel, cancelled) = bounded(1);
        self.cancel = Some(cancel);
        let (send, wake, base, generation, mut budget) = (
            self.send.clone(),
            self.wake.clone(),
            base.to_owned(),
            self.generation,
            self.budget,
        );
        platform::spawn(async move {
            let Ok(client) = images::Images::new() else {
                return;
            };
            for source in sources {
                let Some(bytes) =
                    cancellable(&cancelled, client.read(&base, &source, budget)).await
                else {
                    return;
                };
                let bytes = bytes.ok();
                if let Some(bytes) = &bytes {
                    budget -= bytes.len();
                }
                if cancellable(&cancelled, send.send((generation, source, bytes)))
                    .await
                    .is_none()
                {
                    return;
                }
                wake();
                if budget == 0 {
                    break;
                }
            }
        });
    }
}
