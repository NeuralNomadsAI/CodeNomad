use rune::{Cx, El, ScrollSpec, col, row, text};
use rune_theme_codenomad::{
    Space,
    layout::{self, Layout},
};

type Drafts = Vec<(String, String)>;

pub(crate) fn show(drafts: Drafts) {
    if drafts.is_empty() {
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
            .child(text(t("filesPanel.draftLimit")).role("alert"))
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
                                        tx.copy(drafts[index].1.as_str())
                                    },
                                )
                                .label(format!("{}: {path}", t("markdown.copy"))),
                            )
                    })),
            )
    })
    .locale_direction(crate::strings::locale())
}
