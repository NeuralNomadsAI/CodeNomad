use super::Preferences;
#[cfg(target_arch = "wasm32")]
use super::{web, web_contrast};
use crate::{State, strings};
use rune::{Cx, El};

pub(crate) fn render(s: &State, cx: &mut Cx<State>, view: impl FnOnce(&mut Cx<State>) -> El) -> El {
    #[cfg(target_arch = "wasm32")]
    s.settings.web.commit_palette(
        &s.settings.shared,
        cx.system_dark(),
        !crate::platform::pairing::required(s),
    );
    let prefs = s.settings.shared.borrow();
    if awaiting_appearance(s, &prefs) {
        return rune::el().key("preferences-bootstrap");
    }
    #[cfg(target_arch = "wasm32")]
    let more = s
        .settings
        .contrast
        .as_ref()
        .is_some_and(web_contrast::Watch::more);
    #[cfg(not(target_arch = "wasm32"))]
    let more = cx.system_increased_contrast();
    #[cfg(target_arch = "wasm32")]
    let include_preview = s.settings.web.shown() && !crate::platform::pairing::required(s);
    #[cfg(not(target_arch = "wasm32"))]
    let include_preview = false;
    render_with(cx, &prefs, more, include_preview, |cx| {
        let body = view(cx);
        #[cfg(target_arch = "wasm32")]
        {
            use rune_theme_codenomad::layout::Layout;
            // Opening or closing a modal must keep the shell at the same Rune path.
            rune::col()
                .full_width()
                .full_height()
                .child(body)
                .children(web::view(s, &prefs, more, cx))
        }
        #[cfg(not(target_arch = "wasm32"))]
        body
    })
}

pub(super) fn awaiting_appearance(s: &State, prefs: &Preferences) -> bool {
    prefs.awaiting_appearance()
        || prefs.backend.is_none()
            && (s
                .screen
                .launcher()
                .is_some_and(|launcher| launcher.pending && !launcher.authentication_required)
                || s.screen.launcher().is_none()
                    && s.incoming.is_some()
                    && s.phase == crate::Phase::Loading)
}

pub(super) fn render_with<S>(
    cx: &mut Cx<S>,
    prefs: &Preferences,
    system_more: bool,
    include_preview: bool,
    view: impl FnOnce(&mut Cx<S>) -> El,
) -> El {
    let dark = prefs.dark(cx.system_dark());
    let locale = prefs.locale().unwrap_or_else(strings::locale);
    use rune_theme_codenomad::layout::Layout;
    let more = effective_contrast(prefs.contrast(), system_more);
    let palette = prefs.resolved_palette(dark, more, include_preview);
    rune_theme_codenomad::settings::render(cx, dark, palette, |cx| {
        strings::with_locale(locale, || view(cx).locale_direction(locale))
    })
}

pub(super) fn effective_contrast(preference: &str, system: bool) -> bool {
    preference == "on" || preference == "auto" && system
}

pub(crate) fn app_locale(s: &State) -> &'static str {
    s.settings
        .shared
        .borrow()
        .locale()
        .unwrap_or_else(strings::locale)
}
