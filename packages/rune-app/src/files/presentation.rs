use super::{
    document::{Content, Format, content},
    reader::Reader,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Binary,
    Image { svg: bool },
    Text(Format),
}

pub struct Presentation {
    pub source: bool,
    pub wrap: bool,
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
            wrap: false,
            image: None,
            kind: None,
            cache: rune::ImageCache::new(wake),
            receipt: 0,
            ready: false,
        }
    }
    pub fn reset(&mut self) {
        self.source = false;
        self.image = None;
        self.kind = None;
        self.receipt = 0;
        self.ready = false;
    }
    pub fn sync(&mut self, reader: &Reader) -> bool {
        if reader.target().is_none() {
            let changed = self.kind.is_some();
            self.reset();
            return changed;
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
                    Content::Image(mime) => Kind::Image {
                        svg: mime == "image/svg+xml",
                    },
                    Content::Text { format, .. } => Kind::Text(format),
                    Content::Binary => Kind::Binary,
                },
            );
        self.image = reader
            .preview()
            .filter(|_| matches!(self.kind, Some(Kind::Image { .. })))
            .map(|preview| self.cache.load(preview.bytes.clone()));
        true
    }
}
