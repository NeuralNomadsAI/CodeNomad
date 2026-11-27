use super::{Display, document};
use crate::{
    Message, State, screen,
    settings::{self, TranscriptRow},
    strings::t,
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole,
    layout::{self, Layout},
};

// Same context key as history-4. Its rail attaches to this card, not its body.
pub(super) fn view(s: &State, message: &Message) -> Option<El> {
    let mut row = col().key(message.id.clone()).full_width();
    let key = format!("context-{}", message.id);
    let system = message.role == "system";
    let heading = match message.role.as_str() {
        "system" => t("messageBlock.system.label"),
        "compaction" => t("messageTimeline.segment.compaction.label"),
        _ => return None,
    };
    let mode = settings::transcript_mode(s, TranscriptRow::System);
    if !super::super::anchors::context_visible(s, &message.role) {
        return Some(row);
    }
    let search = s
        .transcript_display
        .search_highlight
        .as_ref()
        .filter(|hit| hit.message == message.id);
    let expanded =
        !system || search.is_some() || s.transcript_display.expanded(&key, mode == "expanded");
    let toggle = key.clone();
    let title = if system {
        layout::button(
            heading,
            false,
            screen::action(&s.input_scope, move |s| {
                Display::set_expanded(s, &toggle, !expanded);
            }),
        )
        .key(format!("toggle-{key}"))
        .expanded(expanded)
    } else {
        text(heading).text_role(TextRole::Label)
    };
    let card = col()
        .key(key.clone())
        .full_width()
        .pad(Space::Sm)
        .inset_surface()
        .child(title)
        .children((expanded && !message.body.is_empty()).then(|| {
            let content = format!("{key}-content");
            if system {
                document::window(
                    s,
                    content,
                    &[&message.body],
                    document::PROSE_LIMIT,
                    |shown, _| {
                        crate::chat::reading::inner_scroller(
                            rune_theme_codenomad::markdown::tool_pane(
                                rune_theme_codenomad::timeline::search::ink(
                                    rune_theme_codenomad::markdown::code(
                                        shown, "text", false, true,
                                    ),
                                    shown,
                                    search.map(|hit| {
                                        hit.query(Some((codenomad_client::search::Kind::Text, 0)))
                                    }),
                                ),
                                true,
                            ),
                            false,
                        )
                    },
                )
            } else {
                document::prose(s, &message.id, content, &message.body, false)
            }
        }));
    let marker = crate::timeline::demanded(s)
        .then(|| {
            super::super::anchors::blocks(message, 0, false)
                .into_iter()
                .next()
        })
        .flatten()
        .map(|block| block.marker);
    let card = super::super::reading::passage(
        s,
        card,
        &message.id,
        key,
        system.then_some(TranscriptRow::System),
        marker,
    );
    row = row.pad(Space::Lg).child(card);
    Some(row)
}
