//! Commands and display events for the native prototype.
#[cfg(test)]
pub use crate::wire::decode_event;
use crate::{CODE, Message, history::Page};
use std::{
    sync::mpsc::{Receiver, SyncSender},
    time::Duration,
};
#[derive(Debug)]
pub enum Command {
    Send(String),
    Older,
    Retry,
    Close,
}
#[derive(Debug)]
pub enum Event {
    History(Vec<Message>),
    Sync(Page),
    Older(Page),
    Message(Message),
    Delta(String, String),
    Done,
    Failed,
    Reconnecting,
    PagingFailed,
}
pub fn synthetic() -> Vec<Message> {
    (0..10_000)
        .map(|i| Message {
            parts: vec![],
            id: format!("synthetic-{i}"),
            role: if i % 2 == 0 { "user" } else { "assistant" }.into(),
            body: if i == 9999 {
                CODE.into()
            } else {
                format!("Synthetic message {i}\nUnicode: été · 日本語 · 🦀")
            },
        })
        .collect()
}
pub fn publish(out: &SyncSender<Event>, wake: &rune::Waker, event: Event) -> bool {
    if out.send(event).is_err() {
        return false;
    }
    wake();
    true
}
pub fn run(out: SyncSender<Event>, input: Receiver<Command>, wake: rune::Waker) {
    if std::env::var_os("RUNE_BACKEND").is_some() && !crate::local_stress() {
        let result = crate::backend::Backend::environment()
            .and_then(|backend| crate::recovery::run(backend, out.clone(), input, wake.clone()));
        if let Err(error) = result {
            eprintln!("Rune backend: {error}");
            publish(&out, &wake, Event::Failed);
        }
        return;
    }
    publish(&out, &wake, Event::History(synthetic()));
    let mut turn = 0;
    while let Ok(command) = input.recv() {
        if matches!(command, Command::Close) {
            return;
        }
        let Command::Send(_) = command else {
            publish(&out, &wake, Event::PagingFailed);
            continue;
        };
        turn += 1;
        let id = format!("assistant-{turn}");
        publish(
            &out,
            &wake,
            Event::Message(Message {
                parts: vec![],
                id: id.clone(),
                role: "assistant".into(),
                body: String::new(),
            }),
        );
        for chunk in CODE.chars().collect::<Vec<_>>().chunks(3) {
            std::thread::sleep(Duration::from_millis(35));
            if !publish(
                &out,
                &wake,
                Event::Delta(id.clone(), chunk.iter().collect()),
            ) {
                return;
            }
        }
        publish(&out, &wake, Event::Done);
    }
}
