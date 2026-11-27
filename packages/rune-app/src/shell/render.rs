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
        #[cfg(not(target_arch = "wasm32"))]
        layer.extend(chat::authentication::dialog(s));
        let body = layout::with_overlays(base, layer);
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
    .on_hover_change(|s: &mut State, _inside, tx| {
        s.transcript_display.reading_mut().end_wheel_gesture();
        tx.live_only();
    })
    .on_layout_tx(|s, bounds @ [_, _, w, h], tx| {
        let changed = chat::ToolDiffPreferences::layout(s, w)
            | crate::timeline::preview_window_layout(s, [w, h])
            | shell::notifications::measure_notices(s, bounds, tx);
        if !changed {
            tx.live_only();
        }
    })
}
