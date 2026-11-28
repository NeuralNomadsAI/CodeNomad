#[cfg(target_arch = "wasm32")]
use crate::platform;
use crate::{State, chat, composer, settings, shell};
use rune::{Cx, El};
use rune_theme_codenomad::layout;
#[cfg(target_arch = "wasm32")]
use rune_theme_codenomad::layout::Layout;

pub(crate) fn view(s: &State, cx: &mut Cx<State>) -> El {
    settings::render(s, cx, |cx| {
        #[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
        if s.git.scene {
            return crate::probes::git_scene::view(s);
        }
        let base = shell::view(s, cx, chat::view::chat_view);
        let mut layer = Vec::new();
        if !s.screen.is_launcher() {
            composer::view::overlays(s, &mut layer);
        }
        layer.extend(crate::workspace::mission_confirmation(s));
        shell::notifications::app_layers(s, &mut layer);
        layer.extend(shell::command_palette::overlay(s));
        layer.extend(shell::tab_rename::overlay(s));
        layer.extend(shell::temporary::overlay(s));
        layer.extend(shell::blank_cleanup::overlay(s));
        #[cfg(not(target_arch = "wasm32"))]
        layer.extend(chat::authentication::dialog(s));
        let body = layout::with_overlays(base, layer);
        // Android draws the window under its system bars and keyboard.
        #[cfg(target_os = "android")]
        let body = layout::safe_area(cx, body);
        #[cfg(target_arch = "wasm32")]
        {
            rune::col()
                .full_width()
                .full_height()
                .children(platform::pairing::required(s).then(|| platform::pairing::view(s)))
                .child(body.remaining())
        }
        #[cfg(not(target_arch = "wasm32"))]
        body
    })
    .on_window_focus(shell::notifications::focus_changed)
    .on_layout_tx(|s, bounds @ [_, _, w, h], tx| {
        let changed = chat::ToolDiffPreferences::layout(s, w)
            | crate::timeline::preview_window_layout(s, [w, h])
            | shell::notifications::measure_notices(s, bounds, tx)
            | shell::command_palette::measure(s, bounds, tx)
            | shell::tab_rename::measure(s, bounds, tx)
            | shell::temporary::measure(s, bounds, tx)
            | shell::blank_cleanup::measure(s, bounds, tx);
        if !changed {
            tx.live_only();
        }
    })
}
