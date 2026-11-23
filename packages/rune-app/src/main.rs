#![forbid(unsafe_code)]
mod agent;
pub(crate) use agent::{form_view as agent_form_view, forms as agent_forms, view as agent_view};
pub(crate) use codenomad_client::{agent_api, backend, catalog, content, history};
mod chat;
pub(crate) use chat::{actions as transcript_state, transcript, transport};
mod components;
mod files;
mod git;
pub(crate) use components::window_close_button as window_control;
#[cfg(any(test, feature = "test-support"))]
mod gallery;
#[cfg(not(target_arch = "wasm32"))]
pub(crate) use platform::host;
mod launcher;
pub(crate) use launcher::view as launcher_view;
mod platform;
#[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
#[path = "../tests/probes/mod.rs"]
mod probes;
mod screen;
mod settings;
mod shell;
mod strings;
use screen::Screen;
mod workspace;
#[cfg(test)]
use codenomad_client::bounded;
use codenomad_client::{Receiver, Sender};
use rune::edit::TextEdit;
use rune::{AppSpec, Cx, El, Tx, col};
use rune_theme_codenomad::{
    Space,
    layout::{self, Layout, input},
};
use transport::{Command, Event};

#[cfg(any(test, feature = "test-support"))]
pub const CODE: &str = "fn main() {\n    println!(\"Rune · Code Nomad\");\n}";
pub use codenomad_client::Message;
struct State {
    #[cfg(target_os = "windows")]
    native_locale: std::cell::Cell<Option<&'static str>>,
    #[cfg(target_os = "windows")]
    native_locale_repaint: std::cell::Cell<bool>,
    wake: codenomad_client::Wake,
    agent: Option<agent::Ui>,
    files: Option<files::Ui>,
    git: git::Binding,
    documents: files::document::store::Store,
    reads: platform::reads::Reads,
    #[cfg(target_arch = "wasm32")]
    pairing: platform::pairing::Recovery,
    transcript_display: transcript_state::Display,
    tool_diff_preferences: chat::ToolDiffPreferences,
    screen: Screen,
    settings: settings::Host,
    input_scope: std::rc::Rc<()>,
    rejected_edit: TextEdit,
    workspace: Option<workspace::Ui>,
    shell: shell::Panels,
    chat_title: String,
    messages: Vec<Message>,
    draft: TextEdit,
    incoming: Option<Receiver<Event>>,
    commands: Option<Sender<Command>>,
    phase: Phase,
    revision: u64,
    can_older: bool,
    paging: bool,
    history_error: bool,
}
#[derive(PartialEq)]
enum Phase {
    Loading,
    Ready,
    Streaming,
    Failed,
    Reconnecting,
    #[cfg(target_arch = "wasm32")]
    WorkspaceMissing,
    #[cfg(target_arch = "wasm32")]
    RestoreFailed,
}
fn init() -> State {
    State {
        #[cfg(target_os = "windows")]
        native_locale: std::cell::Cell::new(None),
        #[cfg(target_os = "windows")]
        native_locale_repaint: std::cell::Cell::new(false),
        wake: std::sync::Arc::new(|| {}),
        agent: None,
        files: None,
        git: Default::default(),
        documents: Default::default(),
        reads: Default::default(),
        #[cfg(target_arch = "wasm32")]
        pairing: Default::default(),
        transcript_display: Default::default(),
        tool_diff_preferences: Default::default(),
        screen: Screen::Chat { launcher: None },
        settings: Default::default(),
        input_scope: std::rc::Rc::new(()),
        rejected_edit: TextEdit::new(""),
        workspace: None,
        shell: Default::default(),
        chat_title: String::new(),
        messages: vec![],
        draft: TextEdit::new(""),
        incoming: None,
        commands: None,
        phase: Phase::Loading,
        revision: 0,
        can_older: false,
        paging: false,
        history_error: false,
    }
}
fn setup(s: &mut State, wake: rune::Waker) {
    s.wake = wake.clone();
    #[cfg(feature = "test-support")]
    if platform::scene_is("transcript") {
        return;
    }
    #[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
    if s.git.scene {
        return;
    }
    let scoped = ["RUNE_BACKEND", "RUNE_WORKSPACE", "RUNE_SESSION"]
        .iter()
        .all(|key| platform::setting(key).is_some());
    if !scoped && !local_stress() {
        s.screen = Screen::Launcher(launcher::Launcher::new(wake));
        s.workspace = Some(workspace::Ui::new());
        s.renew_scope();
        workspace::connected(s);
        return;
    }
    transport::start(s, true);
}
fn local_stress() -> bool {
    #[cfg(feature = "test-support")]
    {
        platform::synthetic_scene()
    }
    #[cfg(not(feature = "test-support"))]
    {
        false
    }
}

fn send(s: &mut State, tx: &mut Tx) {
    if s.phase != Phase::Ready
        || s.screen
            .launcher()
            .is_some_and(launcher::Launcher::blocks_prompt)
        || s.draft.text.trim().is_empty()
        || s.agent.as_ref().is_some_and(|a| a.blocked())
    {
        return;
    }
    let body = s.draft.text.clone();
    if s.commands
        .as_ref()
        .is_some_and(|c| c.try_send(Command::Send(body.clone())).is_ok())
    {
        s.messages.push(Message {
            completed: true,
            id: format!("rune-user-{}", s.revision),
            role: "user".into(),
            body,
            parts: vec![],
        });
        s.revision += 1;
        s.draft = TextEdit::new("");
        s.phase = Phase::Streaming;
        workspace::draft_changed(s, tx);
    }
}
fn request_older(s: &mut State, _: &mut Tx) {
    if s.can_older
        && !s.paging
        && s.commands
            .as_ref()
            .is_some_and(|c| c.try_send(Command::Older).is_ok())
    {
        s.paging = true;
    }
}
fn retry_connection(s: &mut State, tx: &mut Tx) {
    #[cfg(target_arch = "wasm32")]
    {
        if platform::pairing::required(s) {
            platform::pairing::observe(s);
            return;
        }
        if matches!(s.phase, Phase::WorkspaceMissing | Phase::RestoreFailed) {
            launcher::reopen(s);
            return;
        }
        if s.screen.is_launcher() && s.commands.is_none() {
            if s.screen.launcher().is_some_and(|l| l.connection.is_some()) {
                launcher::list(s, false);
            } else {
                launcher::connect(s, tx);
            }
            return;
        }
    }
    if s.screen
        .launcher()
        .is_some_and(|l| l.authentication_required)
    {
        s.show_launcher();
        return;
    }
    if s.incoming.as_ref().is_none_or(Receiver::is_closed)
        || s.commands.as_ref().is_none_or(Sender::is_closed)
    {
        if let Some(id) = workspace::active_session(s).map(str::to_owned) {
            launcher::choose(s, id, tx);
        } else if s.screen.launcher().is_none() && s.incoming.is_some() {
            s.phase = Phase::Reconnecting;
            transport::start(s, false);
        }
    } else if s
        .commands
        .as_ref()
        .is_some_and(|c| c.try_send(Command::Retry).is_ok())
    {
        s.phase = Phase::Reconnecting;
    }
}
fn latest(_: &mut State, tx: &mut Tx) {
    tx.scroll_to_bottom_instant("history");
}
fn poll(s: &mut State, now: f64, tx: &mut Tx) -> bool {
    let chat = poll_chat(s, 64);
    let mut changed = chat | transcript_state::Display::poll(s, chat, now, tx);
    changed |= platform::titlebar::poll(s);
    changed |= launcher::poll(s, tx);
    #[cfg(target_arch = "wasm32")]
    {
        changed |= platform::pairing::poll(s, tx);
    }
    shell::sync(s);
    changed |= workspace::poll(s, now, tx);
    changed |= settings::poll(s);
    #[cfg(target_arch = "wasm32")]
    if s.phase == Phase::WorkspaceMissing && !platform::pairing::required(s) {
        changed |= launcher::reopen(s);
    }
    changed |= files::poll(s, now, tx);
    changed |= git::poll(s, now, tx);
    workspace::capture_files_mode(s);
    if changed {
        tx.instant();
    }
    changed
}
fn poll_chat(s: &mut State, limit: usize) -> bool {
    let mut changed = s.agent.as_mut().is_some_and(|a| a.poll());
    for _ in 0..limit {
        let Some(event) = s.incoming.as_ref().and_then(|r| r.try_recv().ok()) else {
            break;
        };
        match event {
            Event::Connected(backend) => {
                s.renew_scope();
                git::connected(s, &backend);
                settings::connected(s, &backend);
                workspace::restore_files_mode(s);
                if s.agent.is_none() {
                    s.agent = Some(agent::Ui::new(agent::start(backend, s.wake.clone())));
                }
            }
            Event::AgentHint(catalog) => {
                if let Some(a) = s.agent.as_mut() {
                    if catalog {
                        a.online = true;
                    }
                    a.refresh(catalog)
                }
            }
            Event::Workspace(event) => {
                git::event(s, &event);
                if let Some(files) = &mut s.files {
                    files.event(event);
                }
            }
            Event::Preferences(owner) => settings::invalidate(s, owner),
            Event::Sync(page) => {
                git::online(s, true);
                if let Some(files) = &mut s.files {
                    files.online(true);
                }
                if let Some(a) = s.agent.as_mut() {
                    if !a.online {
                        a.online = true;
                        a.refresh(false);
                    }
                }
                s.messages = page.rows;
                s.can_older = page.older.is_some();
                s.paging = false;
                s.history_error = false;
                s.phase = if page.running {
                    Phase::Streaming
                } else {
                    Phase::Ready
                };
            }
            Event::Older(page) => {
                match history::join(&page.rows, &s.messages) {
                    Ok(rows) => {
                        s.messages = rows;
                        s.can_older = page.older.is_some();
                        s.history_error = false;
                    }
                    Err(_) => s.history_error = true,
                }
                s.paging = false;
            }
            Event::Reconnecting | Event::ConnectionLost => {
                #[cfg(target_arch = "wasm32")]
                if matches!(event, Event::ConnectionLost) && !platform::pairing::required(s) {
                    platform::pairing::observe(s);
                }
                git::online(s, false);
                if let Some(files) = &mut s.files {
                    files.online(false);
                }
                s.phase = Phase::Reconnecting;
                if let Some(a) = s.agent.as_mut() {
                    a.online = false;
                }
            }
            Event::PagingFailed => {
                s.paging = false;
                s.history_error = true;
            }
            Event::WorkspaceMissing => {
                #[cfg(target_arch = "wasm32")]
                {
                    s.phase = Phase::WorkspaceMissing;
                }
                #[cfg(not(target_arch = "wasm32"))]
                {
                    s.phase = Phase::Failed;
                }
            }
            Event::History(messages) => {
                s.messages = messages;
                s.phase = Phase::Ready;
            }
            Event::Message(m) => {
                if !s.messages.iter().any(|existing| existing.id == m.id) {
                    s.messages.push(m);
                }
            }
            Event::Text(id, event) => {
                if let Some(m) = s.messages.iter_mut().find(|m| m.id == id) {
                    match content::apply_text(m, &event) {
                        Ok(content::TextFit::Repair) | Err(_) => s.history_error = true,
                        _ => {}
                    }
                }
            }
            Event::Done => s.phase = Phase::Ready,
            Event::AuthenticationRequired(_) | Event::Failed => {
                #[cfg(target_arch = "wasm32")]
                if matches!(&event, Event::Failed) && !platform::pairing::required(s) {
                    platform::pairing::observe(s);
                }
                if let Event::AuthenticationRequired(expired) = event {
                    s.commands = None;
                    settings::authentication_required(s, &expired);
                }
                git::online(s, false);
                if let Some(files) = &mut s.files {
                    files.online(false);
                }
                s.phase = Phase::Failed;
                if let Some(a) = s.agent.as_mut() {
                    a.online = false;
                }
            }
        }
        s.revision += 1;
        changed = true;
    }
    changed
}
fn view(s: &State, cx: &mut Cx<State>) -> El {
    settings::render(s, cx, |cx| {
        #[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
        if s.git.scene {
            return probes::git_scene::view(s);
        }
        let body = shell::view(s, cx, chat_view);
        #[cfg(target_arch = "wasm32")]
        if platform::pairing::required(s) {
            return col()
                .full_width()
                .full_height()
                .child(platform::pairing::view(s))
                .child(body.remaining());
        }
        body
    })
    .on_layout_tx(chat::ToolDiffPreferences::layout)
}
fn chat_view(s: &State, cx: &mut Cx<State>) -> El {
    let expanded = interruption_expanded(s);
    rune_theme_codenomad::interruption::session_surface(expanded)
        .child(shell::reader(s, || {
            chat::reading::history(
                s,
                rune_theme_codenomad::interruption::history(expanded)
                    .drawn_rect_into(&s.tool_diff_preferences.history_bounds)
                    .on_layout_tx(chat::ToolDiffPreferences::history_layout)
                    .child(transcript::rows(s)),
            )
        }))
        .child(agent_view::view(s, cx))
        .child(composer(s))
}

fn composer(s: &State) -> El {
    let scope = s.input_scope.clone();
    let field = if interruption_expanded(s) {
        layout::compact_composer
    } else {
        layout::composer
    };
    col()
        .key("session-composer")
        .role("group")
        .label(strings::t("rune.prompt"))
        .full_width()
        .pad(Space::Md)
        .separate(Space::Sm)
        .child(
            field(
                input(&s.draft)
                    .key("composer")
                    .label(strings::t("rune.prompt"))
                    .full_width()
                    .pad(Space::Sm)
                    .field_surface()
                    .hint(strings::t("rune.prompt"))
                    .content_direction()
                    .on_edit(screen::edit(&scope, screen::Editor::Composer))
                    .on_input_change(crate::screen::action_tx(&scope, workspace::draft_changed))
                    .on_submit(crate::screen::action_tx(&scope, send)),
            )
            .field_surface(),
        )
        .child(
            layout::action_row()
                .children(s.can_older.then(|| {
                    rune_theme_codenomad::shell::older_button(
                        strings::t(if s.paging {
                            "rune.loading"
                        } else if s.history_error {
                            "sessionList.loadError.retry"
                        } else {
                            "rune.older"
                        }),
                        s.paging || !matches!(s.phase, Phase::Ready | Phase::Streaming),
                        crate::screen::action_tx(&scope, request_older),
                    )
                }))
                .child(components::button_tx(
                    "latest",
                    strings::t("rune.latest"),
                    false,
                    crate::screen::action_tx(&scope, latest),
                ))
                .child(components::button_tx(
                    "send",
                    strings::t("promptInput.overlay.send"),
                    s.phase != Phase::Ready
                        || s.screen
                            .launcher()
                            .is_some_and(launcher::Launcher::blocks_prompt)
                        || s.agent.as_ref().is_some_and(|a| a.blocked()),
                    crate::screen::action_tx(&scope, send),
                )),
        )
}

fn interruption_expanded(s: &State) -> bool {
    s.agent
        .as_ref()
        .is_some_and(|a| a.picker || !a.ids().is_empty())
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    #[cfg(feature = "test-support")]
    if probes::dispatch() {
        return;
    }
    #[cfg(not(feature = "test-support"))]
    if std::env::args().any(|arg| {
        arg.starts_with("--probe-")
            || arg == "--test-support-info"
            || arg.starts_with("--gallery-")
            || arg == "--scene"
            || arg.starts_with("--scene=")
    }) {
        eprintln!("Qualification commands require the test-support feature");
        std::process::exit(2);
    }
    #[cfg(feature = "test-support")]
    if platform::has_flag("--gallery-action-menu") {
        gallery::action_menu::run();
        return;
    }
    #[cfg(feature = "test-support")]
    if platform::has_flag("--gallery-reader") {
        gallery::reader::run();
        return;
    }
    #[cfg(feature = "test-support")]
    if platform::has_flag("--gallery-window-close") {
        gallery::run();
        return;
    }
    #[cfg(feature = "test-support")]
    if platform::has_flag("--gallery-shell") {
        gallery::shell::run();
        return;
    }
    #[cfg(feature = "test-support")]
    if platform::has_flag("--gallery-preferences") {
        settings::gallery();
        return;
    }
    run_app();
}
#[cfg(target_arch = "wasm32")]
fn main() {
    run_app();
}
fn run_app() {
    platform::titlebar::run(
        AppSpec {
            setup: Some(setup),
            poll: Some(poll),
            on_key: Some(shell::keys),
            #[cfg(feature = "test-support")]
            scenes: &[
                ("synthetic", |s| {
                    s.messages = transport::synthetic();
                    s.phase = Phase::Ready;
                }),
                #[cfg(not(target_arch = "wasm32"))]
                ("transcript", probes::transcript_scene::load),
                #[cfg(not(target_arch = "wasm32"))]
                ("git-changes", probes::git_scene::changes),
                #[cfg(not(target_arch = "wasm32"))]
                ("git-commits", probes::git_scene::commits),
            ],
            ..layout::app_spec(strings::t("window.title.main"), init, view)
        },
        |s, tx| {
            settings::close(s);
            workspace::finish(s, tx);
        },
    );
    platform::finish();
}
