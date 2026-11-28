use rune::{Cx, El, ScrollSpec, col, row, text};
use rune_theme_codenomad::{
    Space, git_panel,
    layout::{self, Layout},
};

type Drafts = Vec<(String, String)>;

pub(crate) fn show(drafts: Drafts, checkpoint_failed: bool) {
    if drafts.is_empty() && !checkpoint_failed {
        return;
    }
    let spec = rune_theme_codenomad::settings::spec(
        crate::strings::t("filesPanel.viewer"),
        Drafts::new,
        view,
    );
    rune::open_window(rune::WindowSpec::new("file-draft-recovery", spec).state(drafts));
}

fn view(drafts: &Drafts, cx: &mut Cx<Drafts>) -> El {
    use crate::strings::t;
    layout::render(cx, |_| {
        col()
            .full_width()
            .full_height()
            .reading_surface()
            .pad(Space::Lg)
            .separate(Space::Md)
            .child(git_panel::note(
                t(if drafts.is_empty() {
                    "rune.save_error"
                } else {
                    "filesPanel.draftLimit"
                }),
                "alert",
            ))
            .child(
                col()
                    .full_width()
                    .remaining()
                    .scroll(ScrollSpec {
                        stick_bottom: false,
                    })
                    .children(drafts.iter().enumerate().map(|(index, (path, _))| {
                        row()
                            .separate(Space::Sm)
                            .child(text(path).remaining())
                            .child(
                                layout::button_tx(
                                    t("markdown.copy"),
                                    false,
                                    move |drafts: &mut Drafts, tx| {
                                        crate::chat::tools::children::note_clipboard_write();
                                        tx.copy(drafts[index].1.as_str());
                                    },
                                )
                                .label(format!("{}: {path}", t("markdown.copy"))),
                            )
                    })),
            )
    })
    .locale_direction(crate::strings::locale())
}
