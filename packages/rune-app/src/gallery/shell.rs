use crate::{
    Message, Phase, Screen, State,
    catalog::{Project, Session},
    launcher::Launcher,
};

pub fn fixture(s: &mut State) {
    let mut launcher = Launcher::fixture();
    launcher.project = Some(Project {
        id: "header-windows".into(),
        path: "/repo".into(),
        temporary: false,
    });
    launcher.sessions = vec![Session {
        id: "session".into(),
        title: "Fixture conversation".into(),
    }];
    s.screen = Screen::Chat {
        launcher: Some(Box::new(launcher)),
    };
    s.chat_title = "Fixture conversation".into();
    s.phase = Phase::Ready;
    s.messages = vec![
        Message {
            usage: None,
            id: "hello".into(),
            role: "user".into(),
            body: "Fixture message".into(),
            parts: vec![],
            completed: true,
        }
        .into(),
    ];
}

#[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
pub fn run() {
    let mut spec = rune_theme_codenomad::layout::app_spec(
        crate::strings::t("window.title.main"),
        || {
            let mut state = crate::init();
            fixture(&mut state);
            state
        },
        crate::view,
    );
    spec.on_key = Some(crate::shell::keys);
    crate::platform::titlebar::run(spec, |_, _| {});
}
