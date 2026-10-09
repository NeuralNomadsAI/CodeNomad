//! Text of the one-time profile question, shared word for word with Electron's
//! `profile-selection-dialog.ts`. Native menus are English-only and the question appears before
//! any profile (and so any saved UI locale) is opened, so it is not localized.
use crate::profile_transition::Candidate;
use std::time::SystemTime;

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct SelectionDialogContent {
    pub(crate) title: String,
    pub(crate) message: String,
    pub(crate) detail: String,
    /// One button per candidate (most recently used first), then Quit when a third button is free.
    pub(crate) buttons: Vec<String>,
}

/// Proleptic Gregorian UTC date, matching JavaScript's `toISOString().slice(0, 10)`.
fn iso_date(time: SystemTime) -> String {
    let days = time
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| (duration.as_secs() / 86_400) as i64)
        .unwrap_or(0);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

pub(crate) fn selection_dialog_content(candidates: &[Candidate]) -> SelectionDialogContent {
    let mut detail = candidates
        .iter()
        .map(|candidate| {
            format!(
                "• {}: last used {}",
                candidate.name,
                iso_date(candidate.last_used)
            )
        })
        .collect::<Vec<_>>();
    detail.push(String::new());
    detail.push("Your choice is remembered and updates will not change it. Nothing is moved or deleted: the other profiles stay on disk and remain available with CODENOMAD_PROFILE=<name>. OpenCode sessions are shared by every profile.".to_string());
    let mut buttons = candidates
        .iter()
        .map(|candidate| format!("Use {}", candidate.name))
        .collect::<Vec<_>>();
    if candidates.len() < 3 {
        buttons.push("Quit".to_string());
    }
    SelectionDialogContent {
        title: "Choose CodeNomad data".to_string(),
        message: "CodeNomad found saved windows in more than one data profile. Which one should this installation use?".to_string(),
        detail: detail.join("\n"),
        buttons,
    }
}

/// Maps the clicked button label to the chosen profile key; dismissal or Quit returns `None`.
pub(crate) fn selected_profile_key(
    candidates: &[Candidate],
    content: &SelectionDialogContent,
    clicked: Option<&str>,
) -> Option<String> {
    let index = content
        .buttons
        .iter()
        .position(|label| Some(label.as_str()) == clicked)?;
    candidates.get(index).map(|candidate| candidate.key.clone())
}

/// Shows the native question synchronously, before the Tauri builder or any profile path exists.
pub(crate) fn ask(candidates: &[Candidate]) -> Option<String> {
    let content = selection_dialog_content(candidates);
    let [first, second, third] =
        [0, 1, 2].map(|index| content.buttons.get(index).cloned().unwrap_or_default());
    let result = rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Info)
        .set_title(&content.title)
        .set_description(format!("{}\n\n{}", content.message, content.detail))
        .set_buttons(rfd::MessageButtons::YesNoCancelCustom(first, second, third))
        .show();
    let clicked = match &result {
        rfd::MessageDialogResult::Custom(label) => Some(label.as_str()),
        _ => None,
    };
    selected_profile_key(candidates, &content, clicked)
}

/// Reports a startup failure (such as an invalid explicit profile) before exiting.
pub(crate) fn show_startup_error(message: &str) {
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("CodeNomad cannot start")
        .set_description(message)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn candidate(key: &str, name: &str, days: u64) -> Candidate {
        Candidate {
            key: key.into(),
            name: name.into(),
            last_used: SystemTime::UNIX_EPOCH + Duration::from_secs(days * 86_400 + 3_600),
        }
    }

    #[test]
    fn dialog_text_matches_electron_and_maps_buttons() {
        // 2026-10-01 is day 20727 since the epoch; 2026-09-01 is day 20697.
        let candidates = vec![
            candidate("dev-v2", "dev-v2", 20_727),
            candidate("stable", "default", 20_697),
        ];
        let content = selection_dialog_content(&candidates);
        assert_eq!(content.buttons, vec!["Use dev-v2", "Use default", "Quit"]);
        assert!(content.detail.contains("• dev-v2: last used 2026-10-01"));
        assert!(content.detail.contains("• default: last used 2026-09-01"));
        assert_eq!(
            selected_profile_key(&candidates, &content, Some("Use default")).as_deref(),
            Some("stable")
        );
        assert_eq!(
            selected_profile_key(&candidates, &content, Some("Quit")),
            None
        );
        assert_eq!(selected_profile_key(&candidates, &content, None), None);
        let three = vec![
            candidate("dev", "dev", 1),
            candidate("dev-v2", "dev-v2", 1),
            candidate("stable", "default", 1),
        ];
        assert_eq!(selection_dialog_content(&three).buttons.len(), 3);
        assert_eq!(iso_date(SystemTime::UNIX_EPOCH), "1970-01-01");
        assert_eq!(
            iso_date(SystemTime::UNIX_EPOCH + Duration::from_secs(951_782_400)),
            "2000-02-29"
        );
    }
}
