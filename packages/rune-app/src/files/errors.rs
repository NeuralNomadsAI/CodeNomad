use super::document::store::Error as SaveError;
use crate::strings::t;
use codenomad_client::{
    files::{FileError, ListingTooLarge, WriteConflict},
    history::Error,
};

pub(super) fn format_listing_error(path: &str, root_name: &str, error: &Error) -> String {
    if error.is::<ListingTooLarge>() {
        return t("filesPanel.listingTooLarge")
            .replace("{path}", if path == "." { root_name } else { path });
    }
    t(file_error_key(error).unwrap_or("directoryBrowser.load.errorFallback")).into()
}

pub(super) fn format_preview_error(error: &Error) -> String {
    if error.is::<ListingTooLarge>() {
        return t("toolCall.output.tooLarge").into();
    }
    t(file_error_key(error).unwrap_or("filesPanel.error.previewUnavailable")).into()
}

pub(super) fn format_save_error(error: &SaveError) -> String {
    match error {
        SaveError::Conflict(WriteConflict::WorktreeDeleting) => {
            t("filesPanel.gitInit.deleting").into()
        }
        SaveError::Conflict(WriteConflict::ChangedOnDisk) => t("filesPanel.draftConflict").into(),
        SaveError::Conflict(WriteConflict::Other) => {
            t("instanceShell.rightPanel.toast.saveError").into()
        }
        SaveError::TooLarge => t("filesPanel.error.saveTooLarge").into(),
        SaveError::ReadOnly => t("filesPanel.readOnly").into(),
        SaveError::AccessDenied => t("filesPanel.error.accessDenied").into(),
        SaveError::Unauthorized => t("messageItem.errors.authenticationFallback").into(),
        SaveError::NotFound => t("filesPanel.error.notFound").into(),
        SaveError::WorkspaceUnavailable => t("remoteRestore.compatible").into(),
        SaveError::Read | SaveError::MissingVersion | SaveError::Uncertain => {
            t("instanceShell.rightPanel.toast.saveError").into()
        }
    }
}

fn file_error_key(error: &Error) -> Option<&'static str> {
    let file_error = error.downcast_ref::<FileError>()?;
    match file_error {
        FileError::NotFound => Some("filesPanel.error.notFound"),
        FileError::WorkspaceUnavailable => Some("remoteRestore.compatible"),
        FileError::AccessDenied => Some("filesPanel.error.accessDenied"),
        FileError::Unauthorized => Some("messageItem.errors.authenticationFallback"),
        FileError::TooLarge => Some("toolCall.output.tooLarge"),
        FileError::Conflict => Some("filesPanel.draftConflict"),
        FileError::Transport => Some("rune.failed"),
        FileError::Unavailable
        | FileError::InvalidRequest
        | FileError::InvalidEncoding
        | FileError::UnexpectedResponse
        | FileError::Server => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_no_raw_error_leak(rendered: &str) {
        let lower = rendered.to_ascii_lowercase();
        for forbidden in [
            "reqwest",
            "error sending request",
            "status code",
            "http status",
            "127.0.0.1",
            "foreign file preview",
            "collation unavailable",
            "fixture failure",
        ] {
            assert!(
                !lower.contains(forbidden),
                "raw error detail `{forbidden}` leaked into `{rendered}`"
            );
        }
    }

    #[test]
    fn maps_every_file_error_and_raw_fallback_to_localized_catalogue_strings() {
        let all_errors: Vec<Error> = vec![
            ListingTooLarge.into(),
            FileError::NotFound.into(),
            FileError::WorkspaceUnavailable.into(),
            FileError::Unavailable.into(),
            FileError::AccessDenied.into(),
            FileError::Unauthorized.into(),
            FileError::TooLarge.into(),
            FileError::Conflict.into(),
            FileError::InvalidRequest.into(),
            FileError::InvalidEncoding.into(),
            FileError::UnexpectedResponse.into(),
            FileError::Transport.into(),
            FileError::Server.into(),
            "error sending request for url (http://127.0.0.1:9999/secret): HTTP status code 500"
                .into(),
            "collation unavailable".into(),
            "foreign file preview".into(),
            "fixture failure".into(),
        ];
        let en_new_keys: [(&str, &str); 4] = crate::strings::with_locale("en", || {
            [
                ("filesPanel.error.notFound", t("filesPanel.error.notFound")),
                (
                    "filesPanel.error.accessDenied",
                    t("filesPanel.error.accessDenied"),
                ),
                (
                    "filesPanel.error.previewUnavailable",
                    t("filesPanel.error.previewUnavailable"),
                ),
                (
                    "filesPanel.error.saveTooLarge",
                    t("filesPanel.error.saveTooLarge"),
                ),
            ]
        });
        for locale in [
            "en", "fr", "de", "es", "he", "ja", "ne", "ru", "tr", "zh-Hans",
        ] {
            crate::strings::with_locale(locale, || {
                if locale != "en" {
                    for (key, en_value) in en_new_keys {
                        assert_ne!(
                            t(key),
                            en_value,
                            "missing translation for {key} in locale {locale}"
                        );
                    }
                }
                for error in &all_errors {
                    let listing = format_listing_error("src", "repo", error);
                    assert!(!listing.is_empty());
                    assert_no_raw_error_leak(&listing);

                    let preview = format_preview_error(error);
                    assert!(!preview.is_empty());
                    assert_no_raw_error_leak(&preview);
                }
                assert_eq!(
                    format_listing_error(".", "repo", &ListingTooLarge.into()),
                    t("filesPanel.listingTooLarge").replace("{path}", "repo")
                );
                assert_eq!(
                    format_preview_error(&FileError::NotFound.into()),
                    t("filesPanel.error.notFound")
                );
                assert_eq!(
                    format_preview_error(&FileError::WorkspaceUnavailable.into()),
                    t("remoteRestore.compatible")
                );
                assert_eq!(
                    format_preview_error(&FileError::Unavailable.into()),
                    t("filesPanel.error.previewUnavailable")
                );
                assert_eq!(
                    format_listing_error("src", "repo", &FileError::Unavailable.into()),
                    t("directoryBrowser.load.errorFallback")
                );
                assert_eq!(
                    format_preview_error(&FileError::AccessDenied.into()),
                    t("filesPanel.error.accessDenied")
                );
                assert_eq!(
                    format_preview_error(&FileError::Unauthorized.into()),
                    t("messageItem.errors.authenticationFallback")
                );
                assert_eq!(
                    format_preview_error(&FileError::TooLarge.into()),
                    t("toolCall.output.tooLarge")
                );
                assert_eq!(
                    format_preview_error(&FileError::Transport.into()),
                    t("rune.failed")
                );
                assert_eq!(
                    format_preview_error(&"reqwest: error sending request".into()),
                    t("filesPanel.error.previewUnavailable")
                );
                assert_eq!(
                    format_listing_error("src", "repo", &"reqwest: error sending request".into()),
                    t("directoryBrowser.load.errorFallback")
                );
                assert_eq!(
                    format_save_error(&SaveError::TooLarge),
                    t("filesPanel.error.saveTooLarge")
                );
                assert_eq!(
                    format_save_error(&SaveError::AccessDenied),
                    t("filesPanel.error.accessDenied")
                );
                assert_eq!(
                    format_save_error(&SaveError::Unauthorized),
                    t("messageItem.errors.authenticationFallback")
                );
                assert_eq!(
                    format_save_error(&SaveError::NotFound),
                    t("filesPanel.error.notFound")
                );
                assert_eq!(
                    format_save_error(&SaveError::WorkspaceUnavailable),
                    t("remoteRestore.compatible")
                );
                assert_eq!(
                    format_save_error(&SaveError::Conflict(WriteConflict::ChangedOnDisk)),
                    t("filesPanel.draftConflict")
                );
                assert_eq!(
                    format_save_error(&SaveError::Conflict(WriteConflict::WorktreeDeleting)),
                    t("filesPanel.gitInit.deleting")
                );
                assert_eq!(
                    format_save_error(&SaveError::Conflict(WriteConflict::Other)),
                    t("instanceShell.rightPanel.toast.saveError")
                );
                assert_eq!(
                    format_save_error(&SaveError::Uncertain),
                    t("instanceShell.rightPanel.toast.saveError")
                );
            });
        }
    }
}
