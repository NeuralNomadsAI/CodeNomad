//! Shared diff for the Git reader and edits shown in the transcript.
use rune_theme_codenomad::catalogue;
pub(crate) use rune_theme_codenomad::git_diff::{
    CommentFilter, DiffLabel, DiffMode, DiffOptions, DiffState, FileDiff, FileStatus,
    LabelResolver, LineRange, LineRef, Side, ViewOptions, parse, view,
};
use std::rc::Rc;

pub(crate) fn labels(locale: &'static str, list_key: &'static str) -> LabelResolver {
    Rc::new(move |label: DiffLabel<'_>| match label {
        DiffLabel::List => catalogue::message(locale, list_key).map(str::to_owned),
        DiffLabel::CommentLine => {
            catalogue::message(locale, "instanceShell.gitChanges.actions.insertContext")
                .map(str::to_owned)
        }
        DiffLabel::ExpandFile => {
            catalogue::message(locale, "sessionList.expand.expandTitle").map(str::to_owned)
        }
        DiffLabel::CollapseFile => {
            catalogue::message(locale, "sessionList.expand.collapseTitle").map(str::to_owned)
        }
        DiffLabel::BinaryFile => {
            catalogue::message(locale, "instanceShell.gitChanges.binaryViewer").map(str::to_owned)
        }
        DiffLabel::FileStatus(FileStatus::Deleted) => {
            catalogue::message(locale, "instanceShell.gitChanges.deleted").map(str::to_owned)
        }
        DiffLabel::ShowHiddenLines(count) => Some(catalogue::format(
            locale,
            "instanceShell.gitChanges.hiddenRows.show",
            &[("count", &count.to_string())],
        )),
        _ => None,
    })
}
