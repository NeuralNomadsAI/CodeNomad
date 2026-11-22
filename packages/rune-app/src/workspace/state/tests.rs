use super::*;
use crate::{Phase, init};
use codenomad_client::{bounded, http::Http};
use std::collections::BTreeMap;

fn workspace(id: &str, draft: &str) -> Workspace {
    Workspace {
        backend_id: None,
        server_id: None,
        folder: "/fixture".into(),
        occurrence: 0,
        workspace_id: None,
        active_session_id: Some(id.into()),
        drafts: BTreeMap::from([(id.into(), draft.into())]),
    }
}
fn backend(session: &str) -> Backend {
    Backend {
        client: Http::new().unwrap(),
        base: "http://127.0.0.1:9/".into(),
        workspace: "fixture".into(),
        session: session.into(),
        client_id: "fixture".into(),
        fresh_mode: false,
    }
}
fn runtime(s: State) -> rune::Runtime<State> {
    rune::Runtime::new(s, crate::view, (1000.0, 800.0), rune::Env::new(false, 1.0))
}

#[test]
fn waiting_saved_session_keeps_its_draft_until_native_binding() {
    let mut s = init();
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries[0].saved = Tab::Workspace(workspace("native-session", "été\n日本語🦀"));
    s.workspace = Some(ui);
    capture(&mut s);
    let Tab::Workspace(saved) = &s.workspace.as_ref().unwrap().snapshot().tabs[0] else {
        panic!()
    };
    assert_eq!(saved.drafts["native-session"], "été\n日本語🦀");
    assert!(s.commands.is_none());
}

#[test]
fn two_occurrences_keep_their_drafts_when_the_user_selects_another_tab() {
    let mut s = init();
    s.phase = Phase::Ready;
    s.draft = TextEdit::new("Alpha local");
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries[0].saved = Tab::Workspace(workspace("alpha", "Alpha saved"));
    ui.entries[0].binding = Some(backend("alpha"));
    let mut other = init();
    other.phase = Phase::Ready;
    other.draft = TextEdit::new("Beta\n🦀");
    let mut second = entry(
        "tab-1".into(),
        Tab::Workspace(workspace("beta", "Beta\n🦀")),
    );
    second.binding = Some(backend("beta"));
    second.cache = Some(Cache::take(&mut other));
    ui.entries.push(second);
    s.workspace = Some(ui);
    let mut rt = runtime(s);
    rt.frame(0.0);
    rt.update(|s, tx| select(s, "tab-1", tx));
    assert_eq!(rt.state.draft.text, "Beta\n🦀");
    rt.update(|s, tx| select(s, "tab-0", tx));
    assert_eq!(rt.state.draft.text, "Alpha local");
    let snapshot = rt.state.workspace.as_ref().unwrap().snapshot();
    let Tab::Workspace(alpha) = &snapshot.tabs[0] else {
        panic!()
    };
    let Tab::Workspace(beta) = &snapshot.tabs[1] else {
        panic!()
    };
    assert_eq!(alpha.drafts["alpha"], "Alpha local");
    assert_eq!(beta.drafts["beta"], "Beta\n🦀");
}

#[test]
fn hidden_tab_drains_events_without_changing_active_conversation() {
    let mut s = init();
    s.phase = Phase::Ready;
    s.draft = TextEdit::new("Active draft");
    let mut ui = Ui::new();
    ui.ready = true;
    let mut other = init();
    other.phase = Phase::Streaming;
    let (out, incoming) = bounded(64);
    other.incoming = Some(incoming);
    out.try_send(crate::transport::Event::Done).unwrap();
    let mut second = entry("tab-1".into(), Tab::Blank);
    second.cache = Some(Cache::take(&mut other));
    ui.entries.push(second);
    s.workspace = Some(ui);
    let mut rt = runtime(s);
    rt.poll = Some(crate::poll);
    rt.frame(0.0);
    assert!(rt.state.phase == Phase::Ready);
    assert_eq!(rt.state.draft.text, "Active draft");
    let hidden = rt.state.workspace.as_mut().unwrap().entries[1]
        .cache
        .take()
        .unwrap();
    let mut scratch = init();
    hidden.apply(&mut scratch);
    assert!(scratch.phase == Phase::Ready);
    assert!(scratch.incoming.as_ref().unwrap().try_recv().is_err());
}
