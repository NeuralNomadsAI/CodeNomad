use super::{
    document::{Content, content},
    reader::Reader,
};

pub struct Presentation {
    pub source: bool,
    pub wrap: bool,
    pub image: Option<rune::Image>,
    cache: rune::ImageCache,
    receipt: u64,
    ready: bool,
}
impl Presentation {
    pub fn new(wake: rune::Waker) -> Self {
        Self {
            source: false,
            wrap: false,
            image: None,
            cache: rune::ImageCache::new(wake),
            receipt: 0,
            ready: false,
        }
    }
    pub fn reset(&mut self) {
        self.source = false;
        self.image = None;
        self.receipt = 0;
        self.ready = false;
    }
    pub fn sync(&mut self, reader: &Reader) -> bool {
        let (receipt, success) = reader.receipt();
        let ready = self.image.as_ref().is_some_and(rune::Image::is_ready);
        let changed = std::mem::replace(&mut self.ready, ready) != ready;
        if receipt == self.receipt || !success {
            return changed;
        }
        self.receipt = receipt;
        self.image = reader
            .target()
            .zip(reader.preview())
            .and_then(|(target, preview)| {
                matches!(content(&target.path, &preview.bytes), Content::Image(_))
                    .then(|| self.cache.load(preview.bytes.clone()))
            });
        true
    }
}
