//! Offscreen fixture frame; the popup remains the public shared component.
use crate::{kit, layout, tokens};
use rune::{El, Icon};
use rune_kit::{Button, ButtonVariant};

static MORE: Icon = Icon {
    name: "lucide-ellipsis",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></g>"#,
};
pub fn trigger(highlighted: bool) -> El {
    let t = tokens(layout::dark());
    Button::new("")
        .variant(ButtonVariant::Ghost)
        .label_with(move |_, _| {
            rune::icon(&MORE, t.metric("fileRowActionGlyph", "width").px()).color(t.color(
                if highlighted {
                    "text-primary"
                } else {
                    "text-muted"
                },
            ))
        })
        .build(&kit(layout::dark()))
        .size(
            t.metric("fileRowAction", "minWidth").px(),
            t.metric("fileRowAction", "minHeight").px(),
        )
        .padding(t.metric("fileRowAction", "paddingLeft").px())
        .radius(t.metric("actionMenu", "borderRadius").px())
        .fill(rune::Color::TRANSPARENT)
        .hover(rune::Color::TRANSPARENT)
        .press(rune::Color::TRANSPARENT)
        .opacity(if highlighted {
            1.0
        } else {
            t.metric("fileRowAction", "opacity").px()
        })
}
pub fn surface(trigger: El, layers: Vec<El>) -> El {
    rune_kit::root(
        rune::col()
            .w_full()
            .h_full()
            .fill(tokens(layout::dark()).color("surface-canvas"))
            .child(trigger.absolute(296.0, 24.0)),
        layers,
    )
}
pub fn dialog(button: El) -> El {
    rune::col()
        .absolute(150.0, 150.0)
        .padding(tokens(layout::dark()).space(crate::Space::Md).px())
        .fill(tokens(layout::dark()).color("surface-overlay"))
        .child(button)
}
