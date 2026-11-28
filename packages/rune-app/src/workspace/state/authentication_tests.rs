use super::*;
use crate::{Phase, transport::Event};

#[test]
fn inactive_prompt_rejection_is_saved_before_closing_its_tab() {
    let mut state = crate::init();
    let mut launcher = crate::launcher::Launcher::fixture();
    let mut backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    backend.session = "first".into();
    launcher.connection = Some(backend.clone());
    state.screen = crate::Screen::Chat {
        launcher: Some(Box::new(launcher)),
    };
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries[0].saved = Tab::Workspace(Workspace {
        backend_id: None,
        server_id: None,
        folder: "/fixture".into(),
        project_name: None,
        temporary: false,
        occurrence: 0,
        workspace_id: None,
        active_session_id: Some("first".into()),
        drafts: Default::default(),
        attachment_drafts: Default::default(),
        attachment_parts: Default::default(),
        view: Default::default(),
    });
    ui.entries[0].binding = Some(backend.clone());
    ui.entries.push(entry("tab-1".into(), Tab::Blank));
    let (out, incoming) = codenomad_client::bounded(2);
    state.incoming = Some(incoming);
    let (commands, sent) = codenomad_client::bounded(1);
    state.commands = Some(commands);
    state.draft = TextEdit::new("preserve this");
    state.phase = Phase::Streaming;
    state.workspace = Some(ui);
    let mut runtime = rune::Runtime::new(
        state,
        crate::view,
        (1000.0, 800.0),
        rune::Env::new(false, 1.0),
    );
    runtime.update(|s, tx| {
        crate::composer::send(s, tx, false);
        select(s, "tab-1", tx);
    });
    let Ok(crate::transport::Command::Prompt(prompt)) = sent.try_recv() else {
        panic!("expected the sent prompt");
    };
    out.try_send(Event::PromptAcknowledged {
        attempted: prompt.id.unwrap(),
        outcome: crate::transport::PromptOutcome::Rejected,
    })
    .unwrap();
    out.try_send(Event::authentication_required(backend))
        .unwrap();
    runtime.update(|s, tx| {
        poll(s, 0.0, tx);
        close(s, "tab-0", tx);
        let ui = s.workspace.as_ref().unwrap();
        assert_eq!(ui.active_key(), "tab-1");
        assert_eq!(
            ui.closed[0].drafts.get("first").map(String::as_str),
            Some("preserve this")
        );
    });
}
