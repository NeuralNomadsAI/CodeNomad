use crate::{kit, layout::dark};
pub use rune::image::{Image, ImageCache};
use rune::{El, Tx, Waker};
pub use rune_kit::diff::{
    DiffLabel, DiffMode, DiffOptions, DiffState, FileDiff, FileStatus, LineKind, LineRange,
    LineRef, Side, parse,
};
pub use rune_kit::syntax::highlight;
use std::rc::Rc;

pub type LineAction<S> = Rc<dyn Fn(&mut S, LineRange, &mut Tx)>;
pub type CommentFilter = Rc<dyn Fn(usize, LineRef) -> bool>;
pub type LabelResolver = Rc<dyn Fn(DiffLabel<'_>) -> Option<String>>;

pub struct ViewOptions<S> {
    pub comment: Option<LineAction<S>>,
    pub comment_filter: Option<CommentFilter>,
    pub labels: Option<LabelResolver>,
    pub scroll_bar: bool,
}

impl<S> Default for ViewOptions<S> {
    fn default() -> Self {
        Self {
            comment: None,
            comment_filter: None,
            labels: None,
            scroll_bar: false,
        }
    }
}

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
    options: ViewOptions<S>,
) -> El {
    let mut view = rune_kit::diff::DiffView::new(get, get_mut)
        .key(key)
        .scroll_bar(options.scroll_bar);
    if let Some(comment) = options.comment {
        view = view.on_comment(move |s, lines, tx| comment(s, lines, tx));
    }
    if let Some(filter) = options.comment_filter {
        view = view.comment_filter(move |file, at| filter(file, at));
    }
    if let Some(labels) = options.labels {
        view = view.labels(move |label| labels(label));
    }
    view.build(state, kit(dark()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Env, Runtime};

    fn find_by_name<'a>(tree: &'a serde_json::Value, name: &str) -> Option<&'a serde_json::Value> {
        if tree["name"].as_str() == Some(name) {
            return Some(tree);
        }
        tree["children"]
            .as_array()?
            .iter()
            .find_map(|child| find_by_name(child, name))
    }

    #[test]
    fn diff_view_applies_localized_labels_and_scroll_bar() {
        let mut deleted = FileDiff::between(Some("old.rs".into()), None, "old\n", "");
        deleted.status = FileStatus::Deleted;
        let state = DiffState::new(vec![
            FileDiff::from_texts("src/lib.rs", "let a = 1;\n", "let a = 2;\n"),
            deleted,
        ]);
        let mut rt = Runtime::new(
            state,
            |state, _| {
                let labels: LabelResolver = Rc::new(|label| match label {
                    DiffLabel::List => Some("Diff Git".into()),
                    DiffLabel::ExpandFile => Some("Développer".into()),
                    DiffLabel::CollapseFile => Some("Réduire".into()),
                    DiffLabel::CommentLine => Some("Ajouter au prompt".into()),
                    DiffLabel::FileStatus(FileStatus::Deleted) => Some("Supprimé".into()),
                    _ => None,
                });
                view(
                    state,
                    "localized-diff".into(),
                    |s| s,
                    |s| s,
                    ViewOptions {
                        labels: Some(labels),
                        scroll_bar: true,
                        ..ViewOptions::default()
                    },
                )
            },
            (800.0, 500.0),
            Env::new(false, 1.0),
        );
        rt.frame(0.0);
        let a11y = rt.accessibility_json();
        assert!(find_by_name(&a11y, "Diff Git").is_some(), "{a11y}");
        assert!(find_by_name(&a11y, "Réduire").is_some(), "{a11y}");
        assert!(
            rt.elements()
                .iter()
                .any(|el| el.text.as_deref() == Some("Supprimé")),
            "expected localized Deleted status badge"
        );
        rt.update(|state, _| state.set_collapsed(0, true));
        rt.frame(0.0);
        let a11y = rt.accessibility_json();
        assert!(find_by_name(&a11y, "Développer").is_some(), "{a11y}");
    }

    #[test]
    fn comment_filter_restricts_hover_comment_button_to_new_side() {
        struct Host {
            diff: DiffState,
            commented: Vec<LineRange>,
        }
        let mut diff = DiffState::new(vec![FileDiff::from_texts(
            "a.rs",
            "removed_line\n",
            "added_line\n",
        )]);
        diff.set_mode(DiffMode::Unified);
        let mut rt = Runtime::new(
            Host {
                diff,
                commented: Vec::new(),
            },
            |host, _| {
                view(
                    host,
                    "filtered-diff".into(),
                    |h: &Host| &h.diff,
                    |h: &mut Host| &mut h.diff,
                    ViewOptions {
                        comment: Some(Rc::new(|h: &mut Host, range, _| h.commented.push(range))),
                        comment_filter: Some(Rc::new(|_, at| at.side == Side::New)),
                        labels: Some(Rc::new(|label| match label {
                            DiffLabel::CommentLine => Some("Add to prompt".into()),
                            _ => None,
                        })),
                        scroll_bar: true,
                    },
                )
            },
            (800.0, 400.0),
            Env::new(false, 1.0),
        );
        rt.frame(0.0);
        let a11y = rt.accessibility_json();
        fn count_named(tree: &serde_json::Value, name: &str) -> usize {
            let own = usize::from(tree["name"].as_str() == Some(name));
            own + tree["children"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|c| count_named(c, name))
                .sum::<usize>()
        }
        // Only the added (Side::New) line exposes the comment button; the removed (Side::Old) line does not.
        assert_eq!(count_named(&a11y, "Add to prompt"), 1, "{a11y}");
    }
}
