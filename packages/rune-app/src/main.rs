#![forbid(unsafe_code)]
mod agent;
pub(crate) use agent::{form_view as agent_form_view, forms as agent_forms, view as agent_view};
pub(crate) use codenomad_client::{agent_api, backend, catalog, content, history};
mod chat;
pub(crate) use chat::{actions as transcript_state, transcript, transport};
use chat::{connection::retry_connection, events::poll_chat};
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
mod missions;
pub(crate) use launcher::view as launcher_view;
mod platform;
#[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
#[path = "../tests/probes/mod.rs"]
mod probes;
mod screen;
mod settings;
mod shell;
use shell::render::view;
mod strings;
mod timeline;
use screen::Screen;
mod workspace;
#[cfg(test)]
use codenomad_client::bounded;
use codenomad_client::{Receiver, Sender};
use rune::edit::TextEdit;
use rune::{AppSpec, Tx};
use rune_theme_codenomad::layout;
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
    rail_excerpts: timeline::ExcerptCache,
    saved_outlines: workspace::outlines::Cache,
    rail_filter_revision: u64,
    window_size: [f32; 2],
    tool_diff_preferences: chat::ToolDiffPreferences,
    screen: Screen,
    settings: settings::Host,
    notifications: shell::notifications::Host,
    wake_lock: platform::wake_lock::Controller,
    #[cfg(not(target_arch = "wasm32"))]
    launch: platform::launch::Host,
    #[cfg(not(target_arch = "wasm32"))]
    direct_authentication: chat::authentication::Recovery,
    input_scope: std::rc::Rc<()>,
    #[cfg(target_arch = "wasm32")]
    web_composer_input_epoch: u64,
    rejected_edit: TextEdit,
    workspace: Option<workspace::Ui>,
    shell: shell::Panels,
    command_palette: shell::command_palette::Palette,
    tab_rename: shell::tab_rename::Rename,
    temporary: shell::temporary::Host,
    blank_cleanup: shell::blank_cleanup::Host,
    workspace_open: shell::workspace_open::Host,
    status_permissions: shell::status_permissions::Permissions,
    status_services: shell::status_services::Services,
    status_usage: shell::status_usage::Panel,
    chat_title: String,
    messages: Vec<history::Row>,
    draft: TextEdit,
    composer: composer::Owner,
    prompt_history: composer::recall::History,
    command_receipts: composer::command_receipts::CommandReceipts,
    incoming: Option<Receiver<Event>>,
    conversation_client_id: Option<String>,
    conversation_stream_connected: bool,
    reader: Option<chat::reader::Reader>,
    commands: Option<Sender<Command>>,
    phase: Phase,
    revision: u64,
    can_older: bool,
    paging: bool,
    history_error: bool,
    history_detached: bool,
    stream_offline: bool,
}
#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Loading,
    Ready,
    Streaming,
    Failed,
    Reconnecting,
    StreamDisconnected {
        running: bool,
    },
    #[cfg(target_arch = "wasm32")]
    WorkspaceMissing,
    #[cfg(target_arch = "wasm32")]
    RestoreFailed,
}
impl Phase {
    fn reconnecting(&self) -> bool {
        matches!(self, Self::Reconnecting | Self::StreamDisconnected { .. })
    }

    fn running(&self) -> bool {
        matches!(
            self,
            Self::Streaming | Self::StreamDisconnected { running: true }
        )
    }
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
        rail_excerpts: Default::default(),
        saved_outlines: Default::default(),
        rail_filter_revision: 0,
        window_size: [0.0; 2],
        tool_diff_preferences: Default::default(),
        screen: Screen::Chat { launcher: None },
        settings: Default::default(),
        notifications: Default::default(),
        wake_lock: Default::default(),
        #[cfg(not(target_arch = "wasm32"))]
        launch: Default::default(),
        #[cfg(not(target_arch = "wasm32"))]
        direct_authentication: Default::default(),
        input_scope: std::rc::Rc::new(()),
        #[cfg(target_arch = "wasm32")]
        web_composer_input_epoch: 0,
        rejected_edit: TextEdit::new(""),
        workspace: None,
        shell: Default::default(),
        command_palette: Default::default(),
        tab_rename: Default::default(),
        temporary: Default::default(),
        blank_cleanup: Default::default(),
        workspace_open: Default::default(),
        status_permissions: Default::default(),
        status_services: Default::default(),
        status_usage: Default::default(),
        chat_title: String::new(),
        messages: vec![],
        draft: TextEdit::new(""),
        composer: Default::default(),
        prompt_history: Default::default(),
        command_receipts: Default::default(),
        incoming: None,
        conversation_client_id: None,
        conversation_stream_connected: false,
        reader: None,
        commands: None,
        phase: Phase::Loading,
        revision: 0,
        can_older: false,
        paging: false,
        history_error: false,
        history_detached: false,
        stream_offline: false,
    }
}
#[cfg(feature = "test-support")]
fn load_loopback_scene(s: &mut State) {
    s.messages.push(
        Message {
            id: "loopback-fixture".into(),
            role: "assistant".into(),
            completed: true,
            parts: vec![],
            usage: None,
            body: chat::LOOPBACK_LINK_SCENE.into(),
        }
        .into(),
    );
    s.phase = Phase::Ready;
}
fn setup(s: &mut State, wake: rune::Waker) {
    #[cfg(target_arch = "wasm32")]
    let wake = shell::notifications::with_background_wake(s, wake);
    s.wake = wake.clone();
    #[cfg(all(feature = "test-support", target_arch = "wasm32"))]
    if platform::scene_is("transcript-images") {
        chat::images_fixture::load(s);
        return;
    }
    #[cfg(feature = "test-support")]
    if platform::scene_is("transcript-loopback") {
        #[cfg(target_arch = "wasm32")]
        load_loopback_scene(s);
        return;
    }
    #[cfg(feature = "test-support")]
    if platform::scene_is("transcript") {
        #[cfg(target_arch = "wasm32")]
        transcript::load_scene(s);
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

#[cfg(any(test, feature = "test-support"))]
fn send(s: &mut State, tx: &mut Tx) {
    composer::send(s, tx, false);
}
fn request_older(s: &mut State, tx: &mut Tx) {
    if chat::reader::older(s) {
        chat::reader::announce_paging(tx);
    }
}
fn latest(s: &mut State, tx: &mut Tx) {
    if s.reader.is_none() && s.history_detached {
        if s.commands
            .as_ref()
            .is_some_and(|c| c.try_send(Command::Latest).is_ok())
        {
            s.phase = Phase::Reconnecting;
            s.can_older = false;
        }
        return;
    }
    chat::reader::latest(s, tx);
}
pub(crate) fn poll(s: &mut State, now: f64, tx: &mut Tx) -> bool {
    strings::with_locale(settings::app_locale(s), || poll_window(s, now, tx))
}

fn poll_window(s: &mut State, now: f64, tx: &mut Tx) -> bool {
    chat::reader::expire_sync_undo(s, tx.clock());
    let gesture = timeline::poll_edge(s, tx);
    let conversation_visible = timeline::conversation_shown(s);
    let defer_reader_sync = conversation_visible && !s.messages.is_empty();
    let chat = !timeline::input_precedes_admission(s, tx)
        && chat::events::poll_chat_for_window(s, 64, defer_reader_sync, tx.clock());
    if std::mem::take(&mut s.composer.announce_send_error) {
        rune_theme_codenomad::layout::announce_alert(tx, strings::t("promptInput.send.errorTitle"));
    }
    if std::mem::take(&mut s.composer.announce_unconfirmed) {
        rune_theme_codenomad::layout::announce_alert(
            tx,
            strings::t("missionsPanel.action.requestUpdateUncertain"),
        );
    }
    shell::notifications::collect(s, workspace::notification_target);
    if s.reader
        .as_ref()
        .is_some_and(chat::reader::Reader::has_deferred_sync)
    {
        tx.wake_after(std::time::Duration::ZERO);
    }
    let wait_manual_probe = conversation_visible && chat::reader::take_manual_probe_wait(s, tx);
    if wait_manual_probe {
        tx.wake_after(std::time::Duration::ZERO);
    }
    let history_width = s.tool_diff_preferences.history_width();
    let wait_rail_layout = !wait_manual_probe
        && conversation_visible
        && s.reader
            .as_ref()
            .is_some_and(chat::reader::Reader::has_pending_scroll)
        && timeline::rail_layout_pending(s, history_width);
    if wait_rail_layout {
        tx.wake_after(std::time::Duration::ZERO);
    }
    let queue_changed = chat::queue::poll(s, tx);
    let flushed_replay = conversation_visible && chat::reading::flush_wheel_replay(s, tx);
    let rearmed_replay =
        conversation_visible && chat::reading::rearm_replay_on_layout_change(s, tx);
    let restored = !wait_manual_probe
        && !wait_rail_layout
        && !flushed_replay
        && !rearmed_replay
        && conversation_visible
        && (!s
            .reader
            .as_ref()
            .is_some_and(chat::reader::Reader::awaits_history_width)
            || history_width > 0.0)
        && chat::reader::renderer_ready(s, tx);
    let mut changed = gesture
        | chat
        | queue_changed
        | flushed_replay
        | rearmed_replay
        | restored
        | transcript_state::Display::poll(s, chat, now, tx);
    changed |= chat::ToolDiffPreferences::sync_focused_agent_control(s, tx.focused());
    changed |= platform::titlebar::poll(s);
    #[cfg(target_arch = "wasm32")]
    {
        changed |= platform::pairing::poll(s, tx);
    }
    changed |= launcher::poll(s, tx);
    changed |= s.composer.picker.poll(&s.reads, &s.wake);
    changed |= composer::recall::poll(s);
    changed |= composer::menu::poll(s, tx);
    changed |= composer::device::poll(s, tx);
    changed |= chat::attachments::poll(s, tx);
    changed |= chat::message_actions::poll(s, tx);
    changed |= shell::poll(s, tx);
    shell::sync(s);
    changed |= workspace::poll(s, now, tx);
    let transcript_revision = s.revision;
    changed |= settings::poll(s, tx) | settings::poll_window_actions(s, tx);
    if s.revision != transcript_revision {
        timeline::filters_changed(s);
    }
    changed |= timeline::search::settle_destination(s, tx);
    #[cfg(target_arch = "wasm32")]
    {
        changed |= settings::poll_stats(s, now, tx);
    }
    changed |= shell::status_permissions::poll(s, tx);
    changed |= shell::status_services::poll(s, now, tx);
    changed |= shell::status_usage::poll(s, now, tx);
    changed |= shell::temporary::poll(s, tx);
    changed |= shell::blank_cleanup::poll(s, tx);
    changed |= shell::workspace_open::poll(s);
    #[cfg(target_arch = "wasm32")]
    if s.phase == Phase::WorkspaceMissing && !platform::pairing::required(s) {
        changed |= launcher::reopen(s);
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        changed |= chat::authentication::poll(s);
    }
    changed |= files::poll(s, now, tx);
    changed |= git::poll(s, now, tx);
    changed |= workspace::poll_file_drafts(s, now, tx);
    changed |= shell::notifications::poll(s, tx);
    changed |= shell::notifications::poll_app_notices(s, now, tx);
    platform::wake_lock::sync(s);
    #[cfg(not(target_arch = "wasm32"))]
    platform::launch::sync(s);
    workspace::capture_files_mode(s);
    if changed {
        workspace::enforce_memory_budget(s);
    }
    timeline::poll_reveal(s, tx, changed);
    if changed {
        tx.instant();
    }
    changed
}
rune::android_main!(main);
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
    if !platform::launch::enter() {
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
            on_key: Some(|s, event, tx| {
                strings::with_locale(settings::app_locale(s), || shell::keys(s, event, tx))
            }),
            #[cfg(feature = "test-support")]
            scenes: &[
                ("synthetic", |s| {
                    s.messages = transport::synthetic();
                    s.phase = Phase::Ready;
                }),
                #[cfg(not(target_arch = "wasm32"))]
                ("transcript", transcript::load_scene),
                #[cfg(not(target_arch = "wasm32"))]
                ("transcript-loopback", load_loopback_scene),
                #[cfg(not(target_arch = "wasm32"))]
                ("git-changes", probes::git_scene::changes),
                #[cfg(not(target_arch = "wasm32"))]
                ("git-commits", probes::git_scene::commits),
            ],
            ..layout::app_spec(strings::t("window.title.main"), init, view)
        },
        |s, tx| {
            #[cfg(not(target_arch = "wasm32"))]
            platform::launch::release(s);
            platform::wake_lock::release(s);
            settings::close(s);
            workspace::finish(s, tx);
        },
    );
    platform::finish();
}
