use super::{
    document::{Content, Format, content},
    reader::Reader,
};
use std::{cell::Cell, collections::BTreeSet, rc::Rc};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Binary,
    Image,
    Text(Format),
}

pub struct Presentation {
    pub source: bool,
    pub rendered_scroll: Rc<Cell<f32>>,
    pub unwrapped_blocks: BTreeSet<usize>,
    code_revision: u64,
    pub image: Option<rune::Image>,
    pub kind: Option<Kind>,
    cache: rune::ImageCache,
    receipt: u64,
    ready: bool,
}
impl Presentation {
    pub fn new(wake: rune::Waker) -> Self {
        Self {
            source: false,
            rendered_scroll: Rc::default(),
            unwrapped_blocks: BTreeSet::new(),
            code_revision: 0,
            image: None,
            kind: None,
            cache: rune::ImageCache::new(wake),
            receipt: 0,
            ready: false,
        }
    }
    pub fn reset(&mut self) {
        self.source = false;
        self.rendered_scroll = Rc::default();
        self.unwrapped_blocks.clear();
        self.code_revision = 0;
        self.image = None;
        self.kind = None;
        self.receipt = 0;
        self.ready = false;
    }
    pub(crate) fn retained_bytes(&self) -> usize {
        self.image
            .as_ref()
            .and_then(rune_theme_codenomad::attachment::decoded_size)
            .map_or(0, |[w, h]| {
                (w as usize).saturating_mul(h as usize).saturating_mul(4)
            })
    }
    pub(crate) fn evict_image(&mut self, wake: rune::Waker) -> usize {
        let before = self.retained_bytes();
        if before == 0 && self.image.is_none() {
            return 0;
        }
        self.image = None;
        self.receipt = 0;
        self.ready = false;
        self.cache = rune::ImageCache::new(wake);
        before
    }
    pub fn sync(&mut self, reader: &Reader, revision: u64) -> bool {
        if reader.target().is_none() {
            let changed = self.kind.is_some();
            self.reset();
            return changed;
        }
        if self.code_revision != revision {
            self.code_revision = revision;
            self.unwrapped_blocks.clear();
        }
        let (receipt, success) = reader.receipt();
        let ready = self.image.as_ref().is_some_and(rune::Image::is_ready);
        let changed = std::mem::replace(&mut self.ready, ready) != ready;
        if receipt == self.receipt || !success {
            return changed;
        }
        self.receipt = receipt;
        self.kind = reader
            .target()
            .zip(reader.preview())
            .map(
                |(target, preview)| match content(&target.path, &preview.bytes) {
                    Content::Image(_)
                        if codenomad_client::files::images::can_decode(&preview.bytes) =>
                    {
                        Kind::Image
                    }
                    Content::Image(_) => Kind::Binary,
                    Content::Text { format, .. } => Kind::Text(format),
                    Content::Binary => Kind::Binary,
                },
            );
        self.image = reader
            .preview()
            .filter(|_| self.kind == Some(Kind::Image))
            .map(|preview| self.cache.load(preview.bytes.clone()));
        true
    }
}
