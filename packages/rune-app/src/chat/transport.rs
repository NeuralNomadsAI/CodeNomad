//! Commands and display events for the native prototype.
#[cfg(any(test, feature = "test-support"))]
use crate::{CODE, Message};
pub use codenomad_client::transport::{Command, Event, publish, run_backend};
#[cfg(test)]
pub use codenomad_client::wire::decode_event;
use codenomad_client::{Receiver, Sender, bounded};
#[cfg(feature = "test-support")]
use std::time::Duration;
#[cfg(any(test, feature = "test-support"))]
pub fn synthetic() -> Vec<Message> {
    (0..10_000)
        .map(|i| Message {
            completed: true,
            parts: vec![],
            id: format!("synthetic-{i}"),
            role: if i % 2 == 0 { "user" } else { "assistant" }.into(),
            body: if i == 9999 {
                format!("```rust\n{CODE}\n```")
            } else {
                format!("Synthetic message {i}\nUnicode: été · 日本語 · 🦀")
            },
        })
        .collect()
}
pub fn start(s: &mut crate::State, bootstrap: bool) {
    let (out, incoming) = bounded(64);
    let (commands, input) = bounded(1);
    s.agent = None;
    s.incoming = Some(incoming);
    s.commands = Some(commands);
    let wake = s.wake.clone();
    let previous = crate::settings::stop_before_conversation(s);
    crate::platform::spawn(async move {
        if let Some(previous) = previous {
            let _ = previous.recv().await;
        }
        run_configured(out, input, wake, bootstrap).await;
    });
}

#[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
pub(crate) async fn run_async(out: Sender<Event>, input: Receiver<Command>, wake: rune::Waker) {
    run_configured(out, input, wake, true).await;
}

async fn run_configured(
    out: Sender<Event>,
    input: Receiver<Command>,
    wake: rune::Waker,
    bootstrap: bool,
) {
    if crate::platform::setting("RUNE_BACKEND").is_some() && !crate::local_stress() {
        let result = match crate::platform::configured_backend(bootstrap).await {
            Ok(backend) => run_backend(backend, out.clone(), input, wake.clone()).await,
            Err(error) => Err(error),
        };
        if result.is_err() {
            eprintln!("Rune backend unavailable");
            publish(&out, &wake, Event::Failed).await;
        }
        drop(out);
        wake();
        return;
    }
    #[cfg(feature = "test-support")]
    run_synthetic(out, input, wake).await;
    #[cfg(not(feature = "test-support"))]
    publish(&out, &wake, Event::Failed).await;
}
#[cfg(feature = "test-support")]
async fn run_synthetic(out: Sender<Event>, input: Receiver<Command>, wake: rune::Waker) {
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
                completed: false,
                parts: vec![],
                id: id.clone(),
                role: "assistant".into(),
                body: String::new(),
            }),
        )
        .await;
        publish(
            &out,
            &wake,
            Event::Text(
                id.clone(),
                crate::content::TextEvent::Start { ordinal: Some(0) },
            ),
        )
        .await;
        for chunk in CODE.chars().collect::<Vec<_>>().chunks(3) {
            crate::platform::sleep(Duration::from_millis(35)).await;
            if !publish(
                &out,
                &wake,
                Event::Text(
                    id.clone(),
                    crate::content::TextEvent::Delta {
                        ordinal: Some(0),
                        text: chunk.iter().collect(),
                    },
                ),
            )
            .await
            {
                return;
            }
        }
        publish(
            &out,
            &wake,
            Event::Text(
                id,
                crate::content::TextEvent::End {
                    ordinal: Some(0),
                    text: CODE.into(),
                },
            ),
        )
        .await;
        publish(&out, &wake, Event::Done).await;
    }
}
