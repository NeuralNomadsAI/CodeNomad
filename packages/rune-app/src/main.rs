#![forbid(unsafe_code)]
mod agent;
pub(crate) use agent::{form_view as agent_form_view, forms as agent_forms, view as agent_view};
pub(crate) use codenomad_client::{agent_api, backend, catalog, content, history};
mod chat;
pub(crate) use chat::{actions as transcript_state, transcript, transport};
mod components;
mod files;
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
mod strings;
use screen::Screen;
mod workspace;
use codenomad_client::{Receiver, Sender, bounded};
use rune::edit::TextEdit;
use rune::{AppSpec, Cx, El, Tx, col, text};
use rune_theme_codenomad::{
    Space, TextRole,
    layout::{self, Layout, input},
};
use transport::{Command, Event};

#[cfg(any(test, feature = "test-support"))]
pub const CODE: &str = "fn main() {\n    println!(\"Rune · Code Nomad\");\n}";
pub use codenomad_client::Message;
struct State {
    wake: codenomad_client::Wake,
    agent: Option<agent::Ui>,
    files: Option<files::Ui>,
    documents: files::document::store::Store,
    reads: platform::reads::Reads,
    expanded_tools: std::collections::HashSet<String>,
    screen: Screen,
    input_scope: std::rc::Rc<()>,
    rejected_edit: TextEdit,
    workspace: Option<workspace::Ui>,
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
}
fn init() -> State {
    State {
        wake: std::sync::Arc::new(|| {}),
        agent: None,
        files: None,
        documents: Default::default(),
        reads: Default::default(),
        expanded_tools: Default::default(),
        screen: Screen::Chat { launcher: None },
        input_scope: std::rc::Rc::new(()),
        rejected_edit: TextEdit::new(""),
        workspace: None,
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
    let (out, incoming) = bounded(64);
    let (commands, input) = bounded(1);
    s.incoming = Some(incoming);
    s.commands = Some(commands);
    platform::spawn(transport::run_async(out, input, wake));
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
fn retry(s: &mut State) {
    let older = s.history_error && s.phase != Phase::Failed;
    let command = if older {
        Command::Older
    } else {
        Command::Retry
    };
    if s.commands
        .as_ref()
        .is_some_and(|c| c.try_send(command).is_ok())
    {
        if older {
            s.paging = true;
        } else {
            s.phase = Phase::Reconnecting;
        }
        s.history_error = false;
    }
}
fn latest(_: &mut State, tx: &mut Tx) {
    tx.scroll_to_bottom_instant("history");
}
fn poll(s: &mut State, now: f64, tx: &mut Tx) -> bool {
    let mut changed = launcher::poll(s, tx);
    changed |= poll_chat(s, 64);
    changed |= workspace::poll(s, now, tx);
    changed |= s.files.as_mut().is_some_and(|files| files.poll(now));
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
                s.agent = Some(agent::Ui::new(agent::start(backend, s.wake.clone())));
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
                if let Some(files) = &mut s.files {
                    files.event(event);
                }
            }
            Event::Sync(page) => {
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
            Event::Reconnecting => {
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
            Event::Failed => {
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
    layout::render(cx, |cx| {
        let scope = s.input_scope.clone();
        let mut body = match &s.screen {
            Screen::Launcher(_) => launcher_view::view(s),
            Screen::Chat { .. } => chat_view(s, cx),
        };
        if s.workspace.is_none() {
            return body;
        }
        let tabs = workspace::strip(s, cx);
        if let Some(ui) = &s.workspace {
            body = body.key(format!("tab-body-{}", ui.active_key()));
        }
        col()
            .full_width()
            .full_height()
            .reading_surface()
            .child(tabs)
            .child(if let Some(error) = workspace::status(s) {
                layout::action_row()
                    .pad(Space::Sm)
                    .child(text(strings::t(error)).role("alert"))
                    .child(launcher_view::button_tx(
                        "workspace-retry",
                        strings::t("sessionList.loadError.retry"),
                        false,
                        crate::screen::action_tx(&scope, workspace::retry),
                    ))
            } else {
                rune::el()
            })
            .child(body.remaining())
    })
    .locale_direction(strings::locale())
}
fn chat_view(s: &State, cx: &mut Cx<State>) -> El {
    let scope = s.input_scope.clone();
    let locale = strings::locale();
    let rows = layout::transcript_rows(
        s.messages.len(),
        |s: &State, i| s.messages[i].id.clone().into(),
        move |s: &State, i| strings::with_locale(locale, || transcript::message(s, i)),
    )
    .key("rows")
    .virtual_rows_version(s.revision);
    let status = match s.phase {
        Phase::Loading => "rune.loading",
        Phase::Ready => "rune.ready",
        Phase::Streaming => "rune.streaming",
        Phase::Failed => "rune.failed",
        Phase::Reconnecting => "rune.reconnecting",
    };
    let expanded = s
        .agent
        .as_ref()
        .is_some_and(|a| a.picker || !a.ids().is_empty());
    rune_theme_codenomad::interruption::session_surface(expanded)
        .child(
            rune_theme_codenomad::layout::action_row()
                .full_width()
                .key("session-header")
                .pad(Space::Md)
                .separate(Space::Lg)
                .child(
                    text(strings::t("window.title.main"))
                        .key("app-title")
                        .text_role(TextRole::Title),
                )
                .child(if s.screen.launcher().is_some() {
                    launcher_view::button(
                        "sessions-back",
                        strings::t("sessionList.header.title"),
                        !matches!(s.phase, Phase::Ready | Phase::Failed)
                            || (!s.draft.text.is_empty() && s.workspace.is_none())
                            || agent::navigation_blocked(s),
                        crate::screen::action(&scope, launcher::back),
                    )
                } else {
                    rune::el()
                })
                .child(text(strings::t(status)))
                .child(files::view::toggle(s))
                .child(
                    text(strings::t(if s.paging {
                        "rune.loading"
                    } else {
                        "rune.older"
                    }))
                    .key("older")
                    .role("button")
                    .focusable(true)
                    .disabled(!s.can_older || s.paging || s.phase == Phase::Reconnecting)
                    .on_press_tx(crate::screen::action_tx(&scope, request_older)),
                )
                .child(if s.phase == Phase::Failed || s.history_error {
                    text(strings::t("sessionList.loadError.retry"))
                        .key("retry")
                        .role("button")
                        .focusable(true)
                        .on_press(crate::screen::action(&scope, retry))
                } else {
                    rune::el()
                })
                .child(
                    text(strings::t("rune.latest"))
                        .key("latest")
                        .role("button")
                        .focusable(true)
                        .on_press_tx(crate::screen::action_tx(&scope, latest)),
                ),
        )
        .child(if s.chat_title.is_empty() {
            rune::el()
        } else {
            text(&s.chat_title).key("chat-title").pad(Space::Md)
        })
        .child(
            files::view::body(
                s,
                rune_theme_codenomad::interruption::history(expanded).child(rows),
            )
            .remaining(),
        )
        .child(agent_view::view(s, cx))
        .child(
            col()
                .key("session-composer")
                .role("group")
                .label(strings::t("rune.prompt"))
                .full_width()
                .pad(Space::Md)
                .separate(Space::Sm)
                .child(
                    layout::composer(
                        input(&s.draft)
                            .key("composer")
                            .label(strings::t("rune.prompt"))
                            .full_width()
                            .pad(Space::Sm)
                            .field_surface()
                            .hint(strings::t("rune.prompt"))
                            .content_direction()
                            .on_edit(screen::edit(&scope, screen::Editor::Composer))
                            .on_input_change(crate::screen::action_tx(
                                &scope,
                                workspace::draft_changed,
                            ))
                            .on_submit(crate::screen::action_tx(&scope, send)),
                    )
                    .field_surface(),
                )
                .child(launcher_view::button_tx(
                    "send",
                    strings::t("promptInput.overlay.send"),
                    s.phase != Phase::Ready || s.agent.as_ref().is_some_and(|a| a.blocked()),
                    crate::screen::action_tx(&scope, send),
                )),
        )
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
    run_app();
}
#[cfg(target_arch = "wasm32")]
fn main() {
    run_app();
}
fn run_app() {
    layout::run(
        AppSpec {
            setup: Some(setup),
            poll: Some(poll),
            #[cfg(feature = "test-support")]
            scenes: &[("synthetic", |s| {
                s.messages = transport::synthetic();
                s.phase = Phase::Ready;
            })],
            ..layout::app_spec(strings::t("window.title.main"), init, view)
        },
        workspace::finish,
    );
    platform::finish();
}
