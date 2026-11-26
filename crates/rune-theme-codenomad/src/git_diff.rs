use crate::{kit, layout::dark};
pub use rune::image::{Image, ImageCache};
use rune::{El, Tx, Waker};
pub use rune_kit::diff::LineRef;
pub use rune_kit::diff::{DiffMode, DiffState, FileDiff, LineKind, LineRange, Side, parse};
pub use rune_kit::syntax::highlight;
use std::rc::Rc;

pub type LineAction<S> = Rc<dyn Fn(&mut S, LineRange, &mut Tx)>;

pub fn image_cache(wake: Waker) -> ImageCache {
    ImageCache::new(wake)
}

pub fn image(image: &Image) -> Option<El> {
    let [width, _] = image.size()?;
    Some(
        rune::el()
            .w_full()
            .max_w(width as f32)
            .pixels_fit(image.pixels(), rune::SurfaceFit::Fit),
    )
}

pub fn view<S: 'static>(
    state: &S,
    key: String,
    get: impl Fn(&S) -> &DiffState + 'static,
    get_mut: impl Fn(&mut S) -> &mut DiffState + 'static,
    comment: Option<LineAction<S>>,
) -> El {
    let view = rune_kit::diff::DiffView::new(get, get_mut).key(key);
    let view = match comment {
        Some(comment) => view.on_comment(move |s, lines, tx| comment(s, lines, tx)),
        None => view,
    };
    view.build(state, &kit(dark()))
}
