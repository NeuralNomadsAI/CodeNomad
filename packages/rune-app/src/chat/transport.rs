//! Commands and display events for the native prototype.
#[cfg(any(test, feature = "test-support"))]
use crate::{CODE, Message};
pub use codenomad_client::transport::{Command, Event, PromptOutcome, publish, run_backend};
#[cfg(test)]
pub use codenomad_client::wire::decode_event;
use codenomad_client::{Receiver, Sender};
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
                CODE.into()
            } else {
                format!("Synthetic message {i}\nUnicode: été · 日本語 · 🦀")
            },
        })
        .collect()
}
pub async fn run_async(out: Sender<Event>, input: Receiver<Command>, wake: rune::Waker) {
    if crate::platform::setting("RUNE_BACKEND").is_some() && !crate::local_stress() {
        let result = match crate::platform::configured_backend().await {
            Ok(backend) => run_backend(backend, out.clone(), input, wake.clone()).await,
            Err(error) => Err(error),
        };
        if result.is_err() {
            eprintln!("Rune backend unavailable");
            publish(&out, &wake, Event::Failed).await;
        }
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
        match command {
            Command::Send(_) => {}
            Command::Prompt(prompt) => {
                if let Some(attempted) = prompt.id {
                    publish(
                        &out,
                        &wake,
                        Event::PromptAcknowledged {
                            outcome: PromptOutcome::Confirmed(attempted.clone()),
                            attempted,
                        },
                    )
                    .await;
                }
            }
            _ => {
                publish(&out, &wake, Event::PagingFailed).await;
                continue;
            }
        }
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
