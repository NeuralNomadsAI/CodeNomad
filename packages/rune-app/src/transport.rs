//! Commands and display events for the native prototype.
#[cfg(not(target_arch = "wasm32"))]
pub use crate::native_transport::run;
#[cfg(test)]
pub use crate::wire::decode_event;
use crate::{CODE, Message};
pub use codenomad_client::transport::{Command, Event, publish, run_backend};
use codenomad_client::{Receiver, Sender};
use std::time::Duration;
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
pub async fn run_async(out: Sender<Event>, input: Receiver<Command>, wake: rune::Waker) {
    if crate::platform::setting("RUNE_BACKEND").is_some() && !crate::local_stress() {
        let result = match crate::backend::environment().await {
            Ok(backend) => run_backend(backend, out.clone(), input, wake.clone()).await,
            Err(error) => Err(error),
        };
        if result.is_err() {
            eprintln!("Rune backend unavailable");
            publish(&out, &wake, Event::Failed).await;
        }
        return;
    }
    publish(&out, &wake, Event::History(synthetic())).await;
    let mut turn = 0;
    while let Ok(command) = input.recv().await {
        if matches!(command, Command::Close) {
            return;
        }
        let Command::Send(_) = command else {
            publish(&out, &wake, Event::PagingFailed).await;
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
        )
        .await;
        for chunk in CODE.chars().collect::<Vec<_>>().chunks(3) {
            crate::platform::sleep(Duration::from_millis(35)).await;
            if !publish(
                &out,
                &wake,
                Event::Delta(id.clone(), chunk.iter().collect()),
            )
            .await
            {
                return;
            }
        }
        publish(&out, &wake, Event::Done).await;
    }
}
