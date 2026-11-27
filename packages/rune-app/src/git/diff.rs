use crate::components::diff::{DiffMode, DiffState, FileDiff, parse};
use codenomad_client::git::Diff;
use rune_theme_codenomad::git_diff::{Image, ImageCache};
use std::borrow::Cow;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Hidden {
    Whitespace,
    Invisible,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct DiffPreferences {
    pub split: bool,
    pub full: bool,
    pub wrap: bool,
}

impl Default for DiffPreferences {
    fn default() -> Self {
        Self {
            split: false,
            full: false,
            wrap: true,
        }
    }
}

const MAX_DIFF_LINES: usize = 50_000;
const MAX_LINE_BYTES: usize = 64 * 1024;

fn fits(text: &str) -> bool {
    let mut lines = text.split_terminator('\n');
    lines
        .by_ref()
        .take(MAX_DIFF_LINES)
        .all(|line| line.len() <= MAX_LINE_BYTES)
        && lines.next().is_none()
}

fn model(text: &str) -> Cow<'_, str> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    if text.contains('\r') {
        Cow::Owned(text.replace("\r\n", "\n").replace('\r', "\n"))
    } else {
        Cow::Borrowed(text)
    }
}

fn trim(line: &str) -> &str {
    line.trim_matches([' ', '\t'])
}

fn classify(before: &str, after: &str, old: &str, new: &str) -> Option<Hidden> {
    if before == after {
        None
    } else if old == new {
        Some(Hidden::Invisible)
    } else if !old.is_empty()
        && !new.is_empty()
        && old.split('\n').count() == new.split('\n').count()
        && old
            .split('\n')
            .zip(new.split('\n'))
            .all(|(a, b)| trim(a) == trim(b))
    {
        Some(Hidden::Whitespace)
    } else {
        None
    }
}

fn trimmed(model: &str) -> String {
    // A final line of blanks stays a line, even if it contains no newline.
    // Normalize every other line to the same convention for Myers comparisons.
    let mut result = String::with_capacity(model.len());
    for line in model.split_inclusive('\n') {
        let text = line.strip_suffix('\n').unwrap_or(line);
        result.push_str(trim(text));
        if line.ends_with('\n') {
            result.push('\n');
        } else if trim(text).is_empty() {
            result.push(' ');
        }
    }
    result
}

fn text_diff(
    path: &str,
    before: &str,
    after: &str,
    hide: bool,
    full: bool,
) -> (FileDiff, Option<Hidden>) {
    let (old, new) = (model(before), model(after));
    let notice = classify(before, after, &old, &new);
    let context = if full {
        old.split('\n').count().max(new.split('\n').count()) as u32
    } else {
        3
    };
    let mut file = FileDiff::from_texts_with_context(path, &old, &new, context);
    if hide && !old.is_empty() && !new.is_empty() {
        let (a, b) = (trimmed(&old), trimmed(&new));
        if a != old || b != new {
            let canonical = FileDiff::from_texts_with_context(path, &a, &b, context);
            file.hunks = canonical.hunks;
            let olds: Vec<_> = old.lines().collect();
            let news: Vec<_> = new.lines().collect();
            for line in file.hunks.iter_mut().flat_map(|h| &mut h.lines) {
                let text = line
                    .new
                    .and_then(|n| news.get((n - 1) as usize))
                    .or_else(|| line.old.and_then(|n| olds.get((n - 1) as usize)));
                if let Some(text) = text {
                    let offset = text.len() - text.trim_start_matches([' ', '\t']).len();
                    line.changes.retain_mut(|range| {
                        range.start += offset;
                        range.end += offset;
                        range.end <= text.len()
                    });
                    line.text = (*text).into();
                }
            }
        }
    }
    // The Kit builds no rows for equal texts, including ignored whitespace. A
    // context-only hunk keeps the actual modified-side text readable/selectable.
    if file.hunks.is_empty() && !new.is_empty() {
        let n = new.lines().count();
        let mut patch = format!("--- a/context\n+++ b/context\n@@ -1,{n} +1,{n} @@\n");
        for line in new.lines() {
            patch.push(' ');
            patch.push_str(line);
            patch.push('\n');
        }
        if !new.ends_with('\n') {
            patch.push_str("\\ No newline at end of file\n");
        }
        if let Some(context) = parse(&patch).pop() {
            file.hunks = context.hunks;
        }
    }
    (file, notice)
}

pub(super) struct Reader {
    pub state: DiffState,
    pub content: Option<Diff>,
    pub notice: Option<Hidden>,
    pub full: bool,
    pub images: [Option<Image>; 2],
    decoded: [bool; 2],
}

impl Default for Reader {
    fn default() -> Self {
        let mut state = DiffState::new(Vec::new());
        state.set_wrap(true);
        Self {
            state,
            content: None,
            notice: None,
            full: false,
            images: [None, None],
            decoded: [false; 2],
        }
    }
}

impl Reader {
    pub fn retained_bytes(&self) -> usize {
        let content = match &self.content {
            Some(Diff::Text { before, after }) => {
                before.len().saturating_add(after.len()).saturating_mul(2)
            }
            Some(Diff::Image {
                mime,
                before,
                after,
            }) => mime
                .len()
                .saturating_add(before.as_ref().map_or(0, Vec::len))
                .saturating_add(after.as_ref().map_or(0, Vec::len)),
            Some(Diff::Binary) | None => 0,
        };
        let images = self.images.iter().flatten().fold(0usize, |total, image| {
            let decoded = rune_theme_codenomad::attachment::decoded_size(image)
                .map_or(0, |[w, h]| {
                    (w as usize).saturating_mul(h as usize).saturating_mul(4)
                });
            total.saturating_add(decoded)
        });
        content.saturating_add(images)
    }

    pub fn clear(&mut self) {
        self.content = None;
        self.notice = None;
        self.state.set_files(Vec::new());
        self.images = [None, None];
        self.decoded = [false; 2];
    }

    pub fn replace(
        &mut self,
        content: Diff,
        path: &str,
        hide: bool,
        cache: &ImageCache,
    ) -> Result<bool, ()> {
        if self.content.as_ref() == Some(&content) {
            return Ok(false);
        }
        if let Diff::Text { before, after } = &content
            && (!fits(&model(before)) || !fits(&model(after)))
        {
            return Err(());
        }
        self.images = match &content {
            Diff::Image { before, after, .. } => [before, after].map(|side| {
                side.as_ref()
                    .map(|bytes| cache.load(std::sync::Arc::<[u8]>::from(&bytes[..])))
            }),
            _ => [None, None],
        };
        self.decoded = [false; 2];
        self.content = Some(content);
        self.rebuild(path, hide);
        Ok(true)
    }

    pub fn poll_images(&mut self) -> bool {
        let ready = self
            .images
            .each_ref()
            .map(|image| image.as_ref().is_some_and(|image| image.is_ready()));
        std::mem::replace(&mut self.decoded, ready) != ready
    }

    pub fn rebuild(&mut self, path: &str, hide: bool) {
        let selection = self.state.selection();
        let (files, notice) = match &self.content {
            Some(Diff::Text { before, after }) => {
                let (file, notice) = text_diff(path, before, after, hide, self.full);
                (vec![file], notice)
            }
            _ => (Vec::new(), None),
        };
        let selection = selection.filter(|selection| {
            files.first().is_some_and(|file| {
                [selection.start, selection.end].into_iter().all(|line| {
                    file.text(line.side).is_some_and(|source| {
                        source
                            .lines()
                            .nth(line.line.saturating_sub(1) as usize)
                            .is_some()
                    })
                })
            })
        });
        self.notice = notice;
        self.state.set_files(files);
        self.state.set_selection(selection);
    }

    pub fn apply(&mut self, preference: DiffPreferences, path: Option<&str>, hide: bool) -> bool {
        let mode = if preference.split {
            DiffMode::Split
        } else {
            DiffMode::Unified
        };
        let changed = self.state.mode() != mode || self.state.wrap() != preference.wrap;
        self.state.set_mode(mode);
        self.state.set_wrap(preference.wrap);
        if self.full == preference.full {
            return changed;
        }
        self.full = preference.full;
        if let Some(path) = path {
            self.rebuild(path, hide);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune_theme_codenomad::git_diff::{LineKind, LineRef, Side, highlight};

    #[test]
    fn git_image_reader_decodes_both_sides_of_svg_and_avif() {
        use base64::{Engine, engine::general_purpose::STANDARD};
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8"><path fill="#f00" d="M0 0h8v8H0z"/></svg>"##.to_vec();
        let avif = STANDARD.decode(concat!(
            "AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAA",
            "FBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAbAAAAKGlpbmYAAAAAAAEAAAAa",
            "aW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAAIAAAACAAAABBwaXhpAAAAAAMICAgAAAA",
            "MYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAjbWRhdAoFGAi/bAIyEhgAAABQAABAA1Lt5xf080WmIA==",
        )).unwrap();
        for (path, mime, bytes) in [
            ("image.svg", "image/svg+xml", svg),
            ("image.avif", "image/avif", avif),
        ] {
            let mut reader = Reader::default();
            let (wake, event) = std::sync::mpsc::channel();
            let cache =
                rune_theme_codenomad::git_diff::image_cache(std::sync::Arc::new(move || {
                    let _ = wake.send(());
                }));
            reader
                .replace(
                    Diff::Image {
                        mime: mime.into(),
                        before: Some(bytes.clone()),
                        after: Some(bytes),
                    },
                    path,
                    false,
                    &cache,
                )
                .unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while reader
                .images
                .iter()
                .flatten()
                .any(|image| !image.is_ready() && image.error().is_none())
            {
                event
                    .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                    .expect(path);
            }
            for side in &reader.images {
                let side = side.as_ref().expect(path);
                assert!(side.is_ready(), "{path}: {:?}", side.error());
                let mut rt = rune::Runtime::new(
                    side.clone(),
                    |image: &Image, _cx: &mut rune::Cx<Image>| {
                        use rune_theme_codenomad::layout::Layout;
                        rune::col().full_width().child(
                            rune_theme_codenomad::git_diff::image(image)
                                .unwrap()
                                .key("git-image"),
                        )
                    },
                    (600.0, 400.0),
                    rune::Env::new(false, 1.0),
                );
                rt.frame(0.0);
                let (rect, _) = rt.presented("git-image").expect(path);
                assert!(
                    (8.0..=64.0).contains(&rect[2])
                        && (8.0..=64.0).contains(&rect[3])
                        && (rect[2] - rect[3]).abs() <= 1.0,
                    "{path}: unexpected rendered bounds {rect:?}"
                );
            }
        }
    }

    #[test]
    fn refreshed_text_preserves_a_still_valid_selection() {
        let cache = rune_theme_codenomad::git_diff::image_cache(std::sync::Arc::new(|| {}));
        let mut reader = Reader::default();
        let text = |after: &str| Diff::Text {
            before: "a\nold\nz\n".into(),
            after: after.into(),
        };
        reader
            .replace(text("a\nnew\nz\n"), "x.rs", false, &cache)
            .unwrap();
        let range = crate::components::diff::LineRange::line(0, LineRef::new(Side::New, 3));
        reader.state.set_selection(Some(range));
        reader
            .replace(text("a\nedited\nz\n"), "x.rs", false, &cache)
            .unwrap();
        assert_eq!(reader.state.selection(), Some(range));
        reader.replace(text("a\n"), "x.rs", false, &cache).unwrap();
        assert!(reader.state.selection().is_none());
    }

    #[test]
    fn oversized_projection_keeps_reader_clear_without_construction() {
        let mut reader = Reader::default();
        let cache = rune_theme_codenomad::git_diff::image_cache(std::sync::Arc::new(|| {}));
        let before = "line\r\n".repeat(MAX_DIFF_LINES + 1);
        let after = "line\n".repeat(MAX_DIFF_LINES + 1);
        assert!(
            reader
                .replace(Diff::Text { before, after }, "many.txt", true, &cache)
                .is_err()
        );
        assert!(reader.content.is_none());
        assert!(reader.state.files().is_empty());
        assert!(!fits(&"a".repeat(MAX_LINE_BYTES + 1)));
    }

    #[test]
    fn whitespace_diff_keeps_indentation_inner_spaces_and_original_line_numbers() {
        let (old, new) = (
            "\u{feff}\ta\r\n  let foo = 'é';\r    last\t",
            "  a\n\tlet foo  = 'ø';\n  last ",
        );
        let (file, notice) = text_diff("a.rs", old, new, true, false);
        assert_eq!(notice, None);
        assert_eq!(file.additions(), 1);
        assert_eq!(file.deletions(), 1);
        assert_eq!(file.text(Side::New), Some(new));
        assert_eq!(file.language(), Some("rust"));
        assert!(!highlight(file.language(), "let foo = 1;").is_empty());
        let lines = &file.hunks[0].lines;
        let changed = lines
            .iter()
            .find(|line| line.kind == LineKind::Added)
            .unwrap();
        assert_eq!(
            (changed.new, changed.text.as_str()),
            (Some(2), "\tlet foo  = 'ø';")
        );
        assert!(
            changed
                .changes
                .iter()
                .all(|range| changed.text.get(range.clone()).is_some())
        );
    }

    #[test]
    fn hidden_notices_distinguish_eol_blank_edges_and_empty_models() {
        for (before, after, expected) in [
            ("a\r\nb\r", "\u{feff}a\nb\n", Some(Hidden::Invisible)),
            (" a \n", "\ta\t\r\n", Some(Hidden::Whitespace)),
            ("", "\u{feff}", Some(Hidden::Invisible)),
            ("", " \t", None),
            ("a\n", "a", None),
            ("a b\n", "a  b\n", None),
            ("a\n\n", "a\n", None),
        ] {
            assert_eq!(text_diff("x", before, after, true, false).1, expected);
        }
        let (file, _) = text_diff("x", " foo\t", "foo ", true, false);
        assert_eq!((file.additions(), file.deletions()), (0, 0));
        assert_eq!(file.hunks[0].lines[0].text, "foo ");
        assert_eq!(
            text_diff("x", " foo\t", "foo ", false, false).0.additions(),
            1
        );
        let blanks = " ".repeat(200_000);
        assert_eq!(
            text_diff("x", &blanks, "\t", true, false).1,
            Some(Hidden::Whitespace)
        );
    }
}
