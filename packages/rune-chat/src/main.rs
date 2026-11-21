#![forbid(unsafe_code)]
mod backend;
mod catalog;
mod content;
mod history;
mod launcher;
mod launcher_probe;
mod launcher_strings;
mod launcher_view;
mod probes;
mod real_history_probe;
mod recovery;
mod recovery_probe;
mod stream;
mod strings;
mod surfaces;
mod tool_strings;
mod transcript;
mod transport;
mod wire;
use rune::edit::TextEdit;
use rune::tok::type_;
use rune::{AppSpec, Cx, El, GrowthSpec, ScrollSpec, Tx, col, row, text, text_input};
use std::sync::mpsc::{self, Receiver, SyncSender};
use transport::{Command, Event};

pub const CODE: &str = "fn main() {\n    println!(\"Rune · Code Nomad\");\n}";
#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub body: String,
    pub parts: Vec<content::Part>,
}
struct State {
    expanded_tools: std::collections::HashSet<String>,
    launcher: Option<launcher::Launcher>,
    launcher_visible: bool,
    chat_title: String,
    messages: Vec<Message>,
    draft: TextEdit,
    incoming: Option<Receiver<Event>>,
    commands: Option<SyncSender<Command>>,
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
    let scoped = ["RUNE_BACKEND", "RUNE_WORKSPACE", "RUNE_SESSION"]
        .iter()
        .all(|key| std::env::var_os(key).is_some());
    if !scoped && !local_stress() {
        s.launcher = Some(launcher::Launcher::new(wake));
        s.launcher_visible = true;
        return;
    }
    let (out, incoming) = mpsc::sync_channel(64);
    let (commands, input) = mpsc::sync_channel(1);
    s.incoming = Some(incoming);
    s.commands = Some(commands);
    std::thread::spawn(move || transport::run(out, input, wake));
}
fn local_stress() -> bool {
    std::env::args()
        .collect::<Vec<_>>()
        .windows(2)
        .any(|args| args[0] == "--scene" && args[1] == "synthetic")
}
fn send(s: &mut State, _: &mut Tx) {
    if s.phase != Phase::Ready || s.draft.text.trim().is_empty() {
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
fn poll(s: &mut State, _: f64, tx: &mut Tx) -> bool {
    let mut changed = launcher::poll(s, tx);
    for _ in 0..64 {
        let Some(event) = s.incoming.as_ref().and_then(|r| r.try_recv().ok()) else {
            break;
        };
        match event {
            Event::Sync(page) => {
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
            Event::Reconnecting => s.phase = Phase::Reconnecting,
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
            Event::Failed => s.phase = Phase::Failed,
        }
        s.revision += 1;
        changed = true;
    }
    if changed {
        tx.instant();
    }
    changed
}
fn view(s: &State, _: &mut Cx<State>) -> El {
    if s.launcher_visible {
        return launcher_view::view(s);
    }
    let t = surfaces::get();
    let rows = col()
        .key("rows")
        .w_full()
        .growth(GrowthSpec::default())
        .virtual_rows(
            s.messages.len(),
            110.0,
            |s: &State, i| s.messages[i].id.clone().into(),
            |s: &State, i| transcript::message(s, i),
        )
        .virtual_rows_version(s.revision);
    let status = match s.phase {
        Phase::Loading => "loading",
        Phase::Ready => "ready",
        Phase::Streaming => "streaming",
        Phase::Failed => "failed",
        Phase::Reconnecting => "reconnecting",
    };
    col()
        .w_full()
        .h_full()
        .fill(t.canvas)
        .color(t.text)
        .child(
            row()
                .w_full()
                .padding(14.0)
                .gap(20.0)
                .child(text(strings::t("title")).font(type_::TITLE))
                .child(if s.launcher.is_some() {
                    launcher_view::button(
                        "sessions-back",
                        strings::t("sessions"),
                        !matches!(s.phase, Phase::Ready | Phase::Failed)
                            || !s.draft.text.is_empty(),
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
                        .on_press(|s: &mut State| {
                            let command = if s.history_error && s.phase != Phase::Failed {
                                Command::Older
                            } else {
                                Command::Retry
                            };
                            if s.commands
                                .as_ref()
                                .is_some_and(|c| c.try_send(command).is_ok())
                            {
                                if s.history_error && s.phase != Phase::Failed {
                                    s.paging = true;
                                } else {
                                    s.phase = Phase::Reconnecting;
                                }
                                s.history_error = false;
                            }
                        })
                } else {
                    rune::el()
                })
                .child(
                    text(strings::t("latest"))
                        .key("latest")
                        .role("button")
                        .focusable(true)
                        .on_press_tx(|_: &mut State, tx| tx.scroll_to_bottom_instant("history")),
                ),
        )
        .child(if s.chat_title.is_empty() {
            rune::el()
        } else {
            text(&s.chat_title).key("chat-title").padding(14.0)
        })
        .child(
            col()
                .key("history")
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .scroll(ScrollSpec { stick_bottom: true })
                .child(rows),
        )
        .child(
            col()
                .w_full()
                .padding(14.0)
                .gap(10.0)
                .child(
                    rune::auto_grow(
                        text_input(&s.draft, type_::BODY)
                            .key("composer")
                            .label(strings::t("prompt"))
                            .w_full()
                            .padding(10.0)
                            .fill(t.field)
                            .placeholder(strings::t("prompt"), t.text.alpha(0.5))
                            .on_edit(|s: &mut State| &mut s.draft)
                            .on_submit(send),
                        3,
                        8,
                    )
                    .min_h(76.0)
                    .fill(t.field),
                )
                .child(
                    text(strings::t("send"))
                        .key("send")
                        .role("button")
                        .focusable(true)
                        .padding(10.0)
                        .fill(t.control)
                        .disabled(s.phase != Phase::Ready)
                        .on_press_tx(send),
                ),
        )
}
fn main() {
    if std::env::args().any(|arg| arg == "--probe-launcher") {
        launcher_probe::run();
        return;
    }
    if std::env::args().any(|arg| arg == "--probe-real-history") {
        real_history_probe::run();
        return;
    }
    if std::env::args().any(|arg| arg == "--probe-fresh") {
        probes::fresh();
        return;
    }
    if std::env::args().any(|arg| arg == "--probe-recovery") {
        recovery_probe::run();
        return;
    }
    if std::env::args().any(|arg| arg == "--probe-contract") {
        probes::contract();
        return;
    }
    rune::run(AppSpec {
        families: ("Inter", "ui-monospace"),
        setup: Some(setup),
        poll: Some(poll),
        scenes: &[("synthetic", |s| {
            s.messages = transport::synthetic();
            s.phase = Phase::Ready;
        })],
        ..AppSpec::new(
            if std::env::var_os("RUNE_LIVE_TITLE").is_some() {
                "Code Nomad · Rune · OpenCode V2"
            } else {
                "Code Nomad · Rune"
            },
            (960.0, 760.0),
            init,
            view,
        )
    });
}

#[cfg(test)]
mod content_tests;
#[cfg(test)]
mod history_tests;
#[cfg(test)]
mod tests;
