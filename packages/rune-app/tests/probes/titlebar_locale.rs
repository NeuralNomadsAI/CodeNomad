use crate::{
    State,
    platform::titlebar::{sync_locale, view},
};
use rune::Cx;
use rune_theme_codenomad::shell;

#[test]
fn confirmed_language_updates_native_labels_without_recreating_state() {
    let state = crate::init();
    shell::native_locale("en");
    let fixture = |state: &State, cx: &mut Cx<State>| {
        use rune_theme_codenomad::layout::Layout;
        let locale = state.native_locale.get().unwrap_or("en");
        crate::strings::with_locale(locale, || {
            rune_theme_codenomad::layout::render(cx, |cx| view(state, cx)).locale_direction(locale)
        })
    };
    let mut rt = rune::Runtime::new(state, fixture, (1000.0, 600.0), rune::Env::new(false, 1.0));
    let mut insets = rune::ChromeInsets::default();
    insets.trailing = 138.0;
    insets.height = 36.0;
    rt.set_chrome_insets(insets);
    rt.update(|state, tx| {
        assert!(sync_locale(state, "he"));
        tx.instant();
    });
    rt.frame(0.02);
    let minimize = rune::Label::Minimize;
    assert_eq!(
        rune::labels::label(minimize),
        rune_theme_codenomad::catalogue::message("he", "window.controls.minimize").unwrap()
    );
    let he_menu = rt.find("window.menu.file").unwrap();
    (insets.leading, insets.trailing) = (insets.trailing, insets.leading);
    rt.set_chrome_insets(insets);
    rt.update(|state, tx| {
        assert!(!sync_locale(state, "he"));
        assert!(sync_locale(state, "en"));
        tx.instant();
    });
    rt.frame(0.02);
    let en_menu = rt.find("window.menu.file").unwrap();
    assert!(
        he_menu.0 > 500.0 && en_menu.0 < 500.0,
        "{he_menu:?} {en_menu:?}"
    );
    assert_eq!(
        rune::labels::label(minimize),
        rune_theme_codenomad::catalogue::message("en", "window.controls.minimize").unwrap()
    );
}
