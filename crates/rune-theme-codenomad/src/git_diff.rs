use crate::{kit, layout::dark};
pub use rune::image::{Image, ImageCache};
use rune::{El, Tx, Waker};
pub use rune_kit::diff::{DiffMode, DiffState, FileDiff, LineKind, LineRange, Side, parse};
pub use rune_kit::syntax::highlight;

pub fn image_cache(wake: Waker) -> ImageCache {
    ImageCache::new(wake)
}

pub fn image(image: &Image) -> Option<El> {
    let [width, height] = image.size()?;
    Some(
        rune::el()
            .w_full()
            .max_w(width as f32)
            .aspect_ratio(width as f32 / height.max(1) as f32)
            .pixels_fit(image.pixels(), rune::SurfaceFit::Fit),
    )
}

pub fn view<S: 'static>(
    state: &S,
    key: String,
    get: impl Fn(&S) -> &DiffState + 'static,
    get_mut: impl Fn(&mut S) -> &mut DiffState + 'static,
    comment: impl Fn(&mut S, LineRange, &mut Tx) + 'static,
) -> El {
    rune_kit::diff::DiffView::new(get, get_mut)
        .key(key)
        .on_comment(comment)
        .build(state, kit(dark()))
}
