use super::*;

pub(super) fn view(
    s: &Window,
    cx: &Cx<Window>,
    prefs: &Preferences,
    system_dark: bool,
    system_more: bool,
    layers: &mut Vec<El>,
) -> El {
    let workbench_width = cx
        .window_layout_with("palette-workbench", |rect| rect[2])
        .unwrap_or(0.0);
    let actions_width = cx
        .window_layout_with("palette-actions", |rect| rect[2])
        .unwrap_or(0.0);
    col()
        .full_width()
        .child(s.general.view(
            &s.shared,
            system_dark,
            system_more,
            workbench_width,
            actions_width,
            cx.touch_controls(),
            layers,
            |s: &mut Window| &mut s.general,
        ))
        .child(super::super::memory::view(
            prefs,
            &s.memory_help,
            |s: &mut Window, desired| {
                super::super::memory::action(&mut s.shared.borrow_mut(), desired)
            },
            |s: &mut Window| {
                (s.section == Section::General && s.confirm_close.is_none() && !s.closing)
                    .then_some(&mut s.memory_help)
            },
            |s: &mut Window, edit| s.memory_editor.open(edit),
            |s: &mut Window, action| {
                super::super::memory::review_action(&mut s.shared.borrow_mut(), action);
            },
        ))
        .child(super::super::startup_state::view(
            &s.shared,
            s.general.startup_help,
            |s: &mut Window| s.general.startup_help = !s.general.startup_help,
        ))
        .child(
            s.behavior
                .view(&s.shared, true, layers, |s: &mut Window| &mut s.behavior),
        )
}
