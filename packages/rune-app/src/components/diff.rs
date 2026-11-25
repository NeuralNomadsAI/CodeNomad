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
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_labels_resolve_real_french_catalogue_entries() {
        let resolve = labels("fr", "gitPanel.diff");
        assert_eq!(
            resolve(DiffLabel::List).as_deref(),
            catalogue::message("fr", "gitPanel.diff")
        );
        assert_eq!(
            resolve(DiffLabel::ExpandFile).as_deref(),
            catalogue::message("fr", "sessionList.expand.expandTitle")
        );
        assert_eq!(
            resolve(DiffLabel::CollapseFile).as_deref(),
            catalogue::message("fr", "sessionList.expand.collapseTitle")
        );
        assert_eq!(
            resolve(DiffLabel::CommentLine).as_deref(),
            catalogue::message("fr", "instanceShell.gitChanges.actions.insertContext")
        );
        assert_eq!(
            resolve(DiffLabel::BinaryFile).as_deref(),
            catalogue::message("fr", "instanceShell.gitChanges.binaryViewer")
        );
        assert_eq!(
            resolve(DiffLabel::FileStatus(FileStatus::Deleted)).as_deref(),
            catalogue::message("fr", "instanceShell.gitChanges.deleted")
        );
        assert_eq!(resolve(DiffLabel::ShowHiddenLines(5)), None);
    }
}
