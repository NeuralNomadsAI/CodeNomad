#![forbid(unsafe_code)]
mod agent;
mod agent_api;
mod agent_form_view;
mod agent_forms;
#[cfg(not(target_arch = "wasm32"))]
mod agent_live_probe;
#[cfg(not(target_arch = "wasm32"))]
mod agent_probe;
mod agent_view;
mod backend;
mod catalog;
mod content;
mod gallery;
mod history;
#[cfg(not(target_arch = "wasm32"))]
mod host;
mod launcher;
#[cfg(not(target_arch = "wasm32"))]
mod launcher_probe;
mod launcher_view;
#[cfg(not(target_arch = "wasm32"))]
mod native_transport;
#[cfg(not(target_arch = "wasm32"))]
mod owned_startup_probe;
mod platform;
#[cfg(not(target_arch = "wasm32"))]
mod probes;
#[cfg(not(target_arch = "wasm32"))]
mod real_history_probe;
#[cfg(not(target_arch = "wasm32"))]
mod recovery_probe;
mod strings;
mod transcript;
mod transcript_state;
mod transport;
mod window_control;
mod wire;
use codenomad_client::{Receiver, Sender, bounded};
use rune::edit::TextEdit;
use rune::{AppSpec, Cx, El, Tx, col, text};
use rune_theme_codenomad::{
    Space, TextRole,
    layout::{self, Layout, input},
};
use transport::{Command, Event};

pub const CODE: &str = "fn main() {\n    println!(\"Rune · Code Nomad\");\n}";
pub use codenomad_client::Message;
struct State {
    wake: codenomad_client::Wake,
    agent: Option<agent::Ui>,
    expanded_tools: std::collections::HashSet<String>,
    launcher: Option<launcher::Launcher>,
    launcher_visible: bool,
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
        expanded_tools: Default::default(),
        launcher: None,
        launcher_visible: false,
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
        s.launcher = Some(launcher::Launcher::new(wake));
        s.launcher_visible = true;
        return;
    }
    let (out, incoming) = bounded(64);
    let (commands, input) = bounded(1);
    s.incoming = Some(incoming);
    s.commands = Some(commands);
    platform::spawn(transport::run_async(out, input, wake));
}
fn local_stress() -> bool {
    platform::synthetic_scene()
}

fn send(s: &mut State, _: &mut Tx) {
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
            id: format!("rune-user-{}", s.revision),
            role: "user".into(),
            body,
            parts: vec![],
        });
        s.revision += 1;
        s.draft = TextEdit::new("");
        s.phase = Phase::Streaming;
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
fn poll(s: &mut State, _: f64, tx: &mut Tx) -> bool {
    let mut changed = launcher::poll(s, tx);
    changed |= s.agent.as_mut().is_some_and(|a| a.poll());
    for _ in 0..64 {
        let Some(event) = s.incoming.as_ref().and_then(|r| r.try_recv().ok()) else {
            break;
        };
        match event {
            Event::Connected(backend) => {
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
            Event::Sync(page) => {
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
            Event::Delta(id, delta) => {
                if let Some(m) = s.messages.iter_mut().find(|m| m.id == id) {
                    if m.body.len() + delta.len() <= 256 * 1024 {
                        m.body.push_str(&delta);
                    }
                }
            }
            Event::Done => s.phase = Phase::Ready,
            Event::Failed => {
                s.phase = Phase::Failed;
                if let Some(a) = s.agent.as_mut() {
                    a.online = false;
                }
            }
        }
        s.revision += 1;
        changed = true;
    }
    if changed {
        tx.instant();
    }
    changed
}
fn view(s: &State, cx: &mut Cx<State>) -> El {
    layout::render(cx, |cx| {
        if s.launcher_visible {
            return launcher_view::view(s);
        }
        let locale = strings::locale();
        let rows = layout::transcript_rows(
            s.messages.len(),
            |s: &State, i| s.messages[i].id.clone().into(),
            move |s: &State, i| strings::with_locale(locale, || transcript::message(s, i)),
        )
        .key("rows")
        .virtual_rows_version(s.revision);
        let status = match s.phase {
            Phase::Loading => "loading",
            Phase::Ready => "ready",
            Phase::Streaming => "streaming",
            Phase::Failed => "failed",
            Phase::Reconnecting => "reconnecting",
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
                        text(strings::t("title"))
                            .key("app-title")
                            .text_role(TextRole::Title),
                    )
                    .child(if s.launcher.is_some() {
                        launcher_view::button(
                            "sessions-back",
                            strings::t("sessions"),
                            !matches!(s.phase, Phase::Ready | Phase::Failed)
                                || !s.draft.text.is_empty()
                                || agent::navigation_blocked(s),
                        )
                        .on_press(launcher::back)
                    } else {
                        rune::el()
                    })
                    .child(text(strings::t(status)))
                    .child(
                        text(strings::t(if s.paging { "loading" } else { "older" }))
                            .key("older")
                            .role("button")
                            .focusable(true)
                            .disabled(!s.can_older || s.paging || s.phase == Phase::Reconnecting)
                            .on_press_tx(request_older),
                    )
                    .child(if s.phase == Phase::Failed || s.history_error {
                        text(strings::t("retry"))
                            .key("retry")
                            .role("button")
                            .focusable(true)
                            .on_press(retry)
                    } else {
                        rune::el()
                    })
                    .child(
                        text(strings::t("latest"))
                            .key("latest")
                            .role("button")
                            .focusable(true)
                            .on_press_tx(latest),
                    ),
            )
            .child(if s.chat_title.is_empty() {
                rune::el()
            } else {
                text(&s.chat_title).key("chat-title").pad(Space::Md)
            })
            .child(rune_theme_codenomad::interruption::history(expanded).child(rows))
            .child(agent_view::view(s, cx))
            .child(
                col()
                    .key("session-composer")
                    .role("group")
                    .label(strings::t("prompt"))
                    .full_width()
                    .pad(Space::Md)
                    .separate(Space::Sm)
                    .child(
                        layout::composer(
                            input(&s.draft)
                                .key("composer")
                                .label(strings::t("prompt"))
                                .full_width()
                                .pad(Space::Sm)
                                .field_surface()
                                .hint(strings::t("prompt"))
                                .content_direction()
                                .on_edit(|s: &mut State| &mut s.draft)
                                .on_submit(send),
                        )
                        .field_surface(),
                    )
                    .child(
                        launcher_view::button(
                            "send",
                            strings::t("send"),
                            s.phase != Phase::Ready
                                || s.agent.as_ref().is_some_and(|a| a.blocked()),
                        )
                        .on_press_tx(send),
                    ),
            )
    })
    .locale_direction(strings::locale())
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    if platform::has_flag("--probe-owned-startup") {
        owned_startup_probe::run();
        return;
    }
    if platform::has_flag("--gallery-window-close") {
        gallery::run();
        return;
    }
    if platform::has_flag("--probe-real-controls") {
        agent_live_probe::run();
        return;
    }
    if platform::has_flag("--probe-controls") {
        agent_probe::run();
        return;
    }
    if platform::has_flag("--probe-launcher") {
        launcher_probe::run();
        return;
    }
    if platform::has_flag("--probe-real-history") {
        real_history_probe::run();
        return;
    }
    if platform::has_flag("--probe-fresh") {
        probes::fresh();
        return;
    }
    if platform::has_flag("--probe-recovery") {
        recovery_probe::run();
        return;
    }
    if platform::has_flag("--probe-contract") {
        probes::contract();
        return;
    }
    run_app();
}
#[cfg(target_arch = "wasm32")]
fn main() {
    run_app();
}
fn run_app() {
    rune::run(AppSpec {
        setup: Some(setup),
        poll: Some(poll),
        scenes: &[("synthetic", |s| {
            s.messages = transport::synthetic();
            s.phase = Phase::Ready;
        })],
        ..layout::app_spec(strings::t("title"), init, view)
    });
    platform::finish();
}

#[cfg(test)]
mod agent_tests;
#[cfg(test)]
mod content_tests;
#[cfg(test)]
mod rtl_tests;
#[cfg(test)]
mod tests;
