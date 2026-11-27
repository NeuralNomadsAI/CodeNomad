use crate::State;
use rune::{KeyEvent, Tx};

#[derive(Clone, Copy)]
pub(super) enum Action {
    Send,
    Alternate,
    Newline,
    ExitShell,
    PreviousUser,
    NextUser,
    PreviousPrompt,
    NextPrompt,
    Clear,
}

impl Action {
    pub(super) fn id(self) -> &'static str {
        match self {
            Self::Send => "prompt-send",
            Self::Alternate => "prompt-alternate-send",
            Self::Newline => "prompt-newline",
            Self::ExitShell => "prompt-exit-shell",
            Self::PreviousUser => "user-message-prev",
            Self::NextUser => "user-message-next",
            Self::PreviousPrompt => "prompt-history-prev",
            Self::NextPrompt => "prompt-history-next",
            Self::Clear => "clear-input",
        }
    }

    pub(super) fn label(self, s: &State) -> Option<String> {
        let label = crate::settings::shortcut_label(s, self.id());
        (!label.is_empty()).then_some(label)
    }

    pub(super) fn matches(self, s: &State, event: &KeyEvent, tx: &Tx) -> bool {
        crate::settings::matches_shortcut(s, self.id(), event, tx)
    }
}
