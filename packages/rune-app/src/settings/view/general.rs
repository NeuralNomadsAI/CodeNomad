use super::*;

pub(super) fn view(
    s: &Window,
    prefs: &Preferences,
    system_dark: bool,
    system_more: bool,
    layers: &mut Vec<El>,
) -> El {
    col()
        .full_width()
        .child(s.general.view(
            &s.shared,
            system_dark,
            system_more,
            layers,
            |s: &mut Window| &mut s.general,
        ))
        .child(super::super::memory::view(
            prefs,
            s.memory_help_failed,
            |s: &mut Window, desired| {
                super::super::memory::action(&mut s.shared.borrow_mut(), desired)
            },
            |s: &mut Window, failed| s.memory_help_failed = failed,
            |s: &mut Window, edit| s.memory_editor.open(edit),
            |s: &mut Window, action| {
                super::super::memory::review_action(&mut s.shared.borrow_mut(), action);
            },
        ))
        .child(
            s.behavior
                .view(&s.shared, true, layers, |s: &mut Window| &mut s.behavior),
        )
}
