#![forbid(unsafe_code)]
mod agent;
pub(crate) use agent::{form_view as agent_form_view, forms as agent_forms, view as agent_view};
pub(crate) use codenomad_client::{agent_api, backend, catalog, content, history};
mod chat;
pub(crate) use chat::{actions as transcript_state, transcript, transport};
mod components;
mod composer;
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
use rune::{AppSpec, Cx, El, Tx};
use rune_theme_codenomad::layout::{self, Layout};
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
    attachments: chat::attachments::Reader,
    #[cfg(target_arch = "wasm32")]
    pairing: platform::pairing::Recovery,
    transcript_display: transcript_state::Display,
    tool_diff_preferences: chat::ToolDiffPreferences,
    screen: Screen,
    settings: settings::Host,
    #[cfg(not(target_arch = "wasm32"))]
    direct_authentication: chat::authentication::Recovery,
    input_scope: std::rc::Rc<()>,
    rejected_edit: TextEdit,
    workspace: Option<workspace::Ui>,
    shell: shell::Panels,
    chat_title: String,
    messages: Vec<history::Row>,
    draft: TextEdit,
    composer: composer::Owner,
    incoming: Option<Receiver<Event>>,
    commands: Option<Sender<Command>>,
    phase: Phase,
    revision: u64,
    can_older: bool,
    paging: bool,
    history_error: bool,
    history_detached: bool,
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
        attachments: Default::default(),
        #[cfg(target_arch = "wasm32")]
        pairing: Default::default(),
        transcript_display: Default::default(),
        tool_diff_preferences: Default::default(),
        screen: Screen::Chat { launcher: None },
        settings: Default::default(),
        #[cfg(not(target_arch = "wasm32"))]
        direct_authentication: Default::default(),
        input_scope: std::rc::Rc::new(()),
        rejected_edit: TextEdit::new(""),
        workspace: None,
        shell: Default::default(),
        chat_title: String::new(),
        messages: vec![],
        draft: TextEdit::new(""),
        composer: Default::default(),
        incoming: None,
        commands: None,
        phase: Phase::Loading,
        revision: 0,
        can_older: false,
        paging: false,
        history_error: false,
        history_detached: false,
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
    composer::send(s, tx, false);
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
    if s.composer.pending() {
        // A terminal failure can be delivered ahead of the last transport receipt.
        poll_chat(s, 64);
        if s.composer.pending() {
            return;
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    if chat::authentication::retry(s) {
        return;
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
            if let Some(backend) = settings::bound_backend(s) {
                transport::start_bound(s, backend);
            } else {
                transport::start(s, false);
            }
        }
    } else if s
        .commands
        .as_ref()
        .is_some_and(|c| c.try_send(Command::Retry).is_ok())
    {
        s.phase = Phase::Reconnecting;
    }
}
fn latest(s: &mut State, tx: &mut Tx) {
    if s.history_detached {
        if s.commands
            .as_ref()
            .is_some_and(|c| c.try_send(Command::Latest).is_ok())
        {
            s.phase = Phase::Reconnecting;
            s.can_older = false;
        }
        return;
    }
    tx.scroll_to_bottom_instant("history");
}
fn poll(s: &mut State, now: f64, tx: &mut Tx) -> bool {
    let chat = poll_chat(s, 64);
    let mut changed = chat | transcript_state::Display::poll(s, chat, now, tx);
    changed |= platform::titlebar::poll(s);
    changed |= launcher::poll(s, tx);
    changed |= s.composer.picker.poll(&s.reads, &s.wake);
    changed |= chat::attachments::poll(s, tx);
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
    #[cfg(not(target_arch = "wasm32"))]
    {
        changed |= chat::authentication::poll(s);
    }
    changed |= s.files.as_mut().is_some_and(|files| files.poll(now));
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
                s.attachments.bind(backend.clone());
                s.composer.picker.bind(backend.clone());
                git::connected(s, &backend);
                settings::connected(s, &backend);
                workspace::restore_files_mode(s);
                if s.agent.is_none() {
                    s.agent = Some(agent::Ui::new(agent::start(backend, s.wake.clone())));
                }
            }
            Event::AgentHint(catalog) => {
                if catalog {
                    s.composer.picker.reconnect_commands(&s.reads, &s.wake);
                    s.composer.picker.mentions_changed(&s.reads, &s.wake);
                }
                if catalog && let Some(files) = &mut s.files {
                    files.online(true);
                }
                if let Some(a) = s.agent.as_mut() {
                    if catalog {
                        a.online = true;
                    }
                    a.refresh(catalog)
                }
            }
            Event::Workspace(codenomad_client::transport::WorkspaceEvent::CommandsChanged) => {
                s.composer.picker.commands_changed(&s.reads, &s.wake);
            }
            Event::Workspace(codenomad_client::transport::WorkspaceEvent::MentionsChanged) => {
                s.composer.picker.mentions_changed(&s.reads, &s.wake);
            }
            Event::Workspace(
                codenomad_client::transport::WorkspaceEvent::ComposerCataloguesChanged,
            ) => {
                s.composer.picker.commands_changed(&s.reads, &s.wake);
                s.composer.picker.mentions_changed(&s.reads, &s.wake);
            }
            Event::Workspace(event) => {
                git::event(s, &event);
                if let Some(files) = &mut s.files {
                    files.event(event);
                }
            }
            Event::Preferences(owner) => settings::invalidate(s, owner),
            Event::Sync(page) => {
                s.composer
                    .picker
                    .set_attachments_supported(page.user_file_references);
                git::online(s, true);
                if let Some(files) = &mut s.files {
                    files.online(true);
                }
                if let Some(a) = s.agent.as_mut() {
                    if !a.online {
                        a.online = true;
                        s.composer.picker.refresh_commands(&s.reads, &s.wake);
                        a.refresh(false);
                    }
                }
                s.messages = page.rows;
                s.history_detached = false;
                composer::reconcile(s);
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
                if !page.rows.is_empty() {
                    s.attachments.cancel();
                    s.history_detached = page.newer.is_some();
                    s.messages = page.rows;
                }
                s.can_older = page.older.is_some();
                s.history_error = false;
                s.paging = false;
            }
            Event::Reconnecting | Event::ConnectionLost => {
                s.composer.picker.set_attachments_supported(false);
                #[cfg(target_arch = "wasm32")]
                if matches!(event, Event::ConnectionLost) && !platform::pairing::required(s) {
                    platform::pairing::observe(s);
                }
                git::online(s, false);
                if let Some(files) = &mut s.files {
                    files.online(false);
                }
                if !s.history_detached {
                    s.phase = Phase::Reconnecting;
                }
                s.attachments.cancel();
                if let Some(a) = s.agent.as_mut() {
                    a.online = false;
                }
            }
            Event::PagingFailed => {
                s.paging = false;
                s.history_error = true;
            }
            Event::HistoryInvalidated => {
                s.composer.picker.set_attachments_supported(false);
                s.attachments.cancel();
                s.messages.clear();
                s.history_detached = false;
                s.can_older = false;
                s.paging = false;
                s.phase = Phase::Reconnecting;
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
                    s.messages.push(m.into());
                }
            }
            Event::PromptAcknowledged { attempted, outcome } => {
                composer::acknowledge(s, &attempted, outcome);
                if s.workspace.is_some() && std::mem::take(&mut s.composer.restored) {
                    workspace::capture(s);
                }
            }
            Event::Text(id, event) => {
                if let Some(m) = s.messages.iter_mut().find(|m| m.id == id) {
                    match content::apply_text(std::sync::Arc::make_mut(m), &event) {
                        Ok(content::TextFit::Repair) | Err(_) => s.history_error = true,
                        _ => {}
                    }
                }
            }
            Event::Done => s.phase = Phase::Ready,
            Event::AuthenticationRequired(_) | Event::Failed => {
                s.composer.picker.set_attachments_supported(false);
                #[cfg(target_arch = "wasm32")]
                if matches!(&event, Event::Failed) && !platform::pairing::required(s) {
                    platform::pairing::observe(s);
                }
                if let Event::AuthenticationRequired(expired) = event {
                    if !settings::authentication_required(s, &expired)
                        && s.screen.launcher().is_none()
                    {
                        continue;
                    }
                    s.commands = None;
                    composer::reject_pending(s);
                    #[cfg(not(target_arch = "wasm32"))]
                    chat::authentication::expired(s, expired);
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
    if (s.composer.pending() || s.phase == Phase::Reconnecting)
        && s.incoming
            .as_ref()
            .is_some_and(|receiver| receiver.is_closed() && receiver.is_empty())
    {
        composer::reject_pending(s);
        s.phase = Phase::Failed;
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
        let base = shell::view(s, cx, chat_view);
        let mut layer = Vec::new();
        if !s.screen.is_launcher() {
            composer::view::overlays(s, &mut layer);
        }
        let body = layout::with_overlays(base, layer);
        #[cfg(target_arch = "wasm32")]
        if platform::pairing::required(s) {
            return rune::col()
                .full_width()
                .full_height()
                .child(platform::pairing::view(s))
                .child(body.remaining());
        }
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(dialog) = chat::authentication::dialog(s) {
            return rune::col()
                .full_width()
                .full_height()
                .child(body)
                .child(dialog);
        }
        body
    })
    .on_layout_tx(chat::ToolDiffPreferences::layout)
}
fn chat_view(s: &State, cx: &mut Cx<State>) -> El {
    let expanded = interruption_expanded(s);
    rune_theme_codenomad::interruption::session_surface(expanded)
        .child(shell::reader(s, || {
            rune_theme_codenomad::interruption::history(expanded)
                .drawn_rect_into(&s.tool_diff_preferences.history_bounds)
                .on_layout_tx(chat::ToolDiffPreferences::history_layout)
                .child(transcript::rows(s))
        }))
        .child(agent_view::view(s, cx))
        .children(chat::attachments::error(s))
        .child(composer::view::view(s))
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
