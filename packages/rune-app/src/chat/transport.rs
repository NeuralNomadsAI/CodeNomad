//! Commands and display events for the native prototype.
#[cfg(any(test, feature = "test-support"))]
use crate::{CODE, Message};
pub use codenomad_client::transport::{
    Command, Event, HistoryEdge, PromptOutcome, publish, run_backend,
};
#[cfg(test)]
pub use codenomad_client::wire::decode_event;
use codenomad_client::{Receiver, Sender, bounded};
#[cfg(feature = "test-support")]
use std::time::Duration;
#[cfg(any(test, feature = "test-support"))]
pub fn synthetic() -> Vec<crate::history::Row> {
    (0..10_000)
        .map(|i| Message {
            usage: None,
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
        .map(Into::into)
        .collect()
}
pub fn start(s: &mut crate::State, bootstrap: bool) {
    s.agent = None;
    launch(s, Startup::Configured { bootstrap }, None);
}

pub(crate) fn start_bound(s: &mut crate::State, backend: crate::backend::Backend) {
    start_bound_at(s, backend, None);
}

pub(crate) fn start_bound_at(
    s: &mut crate::State,
    backend: crate::backend::Backend,
    anchor: Option<String>,
) {
    launch(s, Startup::Bound(backend), anchor);
}
enum Startup {
    Configured { bootstrap: bool },
    Bound(crate::backend::Backend),
}

fn launch(s: &mut crate::State, startup: Startup, anchor: Option<String>) {
    s.status_usage.attach();
    s.status_permissions.attach(match &startup {
        Startup::Bound(backend) => Some(backend),
        Startup::Configured { .. } => None,
    });
    s.status_services.attach(match &startup {
        Startup::Bound(backend) => Some(backend),
        Startup::Configured { .. } => None,
    });
    let (out, incoming) = bounded(64);
    let (commands, input) = bounded(1);
    s.incoming = Some(incoming);
    s.conversation_client_id = match &startup {
        Startup::Bound(backend) => Some(backend.client_id.clone()),
        Startup::Configured { .. } => None,
    };
    s.conversation_stream_connected = false;
    s.commands = Some(commands);
    s.stream_offline = false;
    let reading = match &startup {
        Startup::Bound(_) => {
            let (mut reader, lane) = super::reader::Reader::open();
            if let Some(id) = anchor {
                reader.resume(super::reading::Bookmark::Message { id, offset: 0.0 });
            } else if let Some(previous) = &s.reader {
                let width = s.tool_diff_preferences.history_width();
                let history_bounds = s.tool_diff_preferences.history_bounds.get();
                reader.resume_from(
                    previous,
                    s.transcript_display.reading_mut(),
                    width,
                    history_bounds,
                );
            }
            s.reader = Some(reader);
            Some(lane)
        }
        Startup::Configured { .. } => {
            s.reader = None;
            None
        }
    };
    let wake = s.wake.clone();
    let previous = crate::settings::stop_before_conversation(s);
    crate::platform::spawn(async move {
        if let Some(previous) = previous {
            let _ = previous.recv().await;
        }
        if input.is_closed() {
            return;
        }
        match startup {
            Startup::Configured { bootstrap } => run_configured(out, input, wake, bootstrap).await,
            Startup::Bound(backend) => run_bound(Ok(backend), out, input, wake, reading).await,
        }
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
        match crate::platform::configured_target(bootstrap) {
            Ok(target) => {
                let password = crate::platform::setting("RUNE_PASSWORD").unwrap_or_default();
                let token = bootstrap
                    .then(|| crate::platform::setting("RUNE_BOOTSTRAP_TOKEN"))
                    .flatten();
                authenticate_and_run(target, password, token, out, input, wake).await;
            }
            Err(error) => run_bound(Err(error), out, input, wake, None).await,
        }
        return;
    }
    #[cfg(feature = "test-support")]
    run_synthetic(out, input, wake).await;
    #[cfg(not(feature = "test-support"))]
    publish(&out, &wake, Event::Failed).await;
}

pub(crate) async fn authenticate_and_run(
    mut target: crate::backend::Backend,
    password: String,
    token: Option<String>,
    out: Sender<Event>,
    input: Receiver<Command>,
    wake: rune::Waker,
) {
    let result = target.authenticate(&password, token.as_deref()).await;
    drop((password, token));
    #[cfg(not(target_arch = "wasm32"))]
    if result.is_ok() && target.attest_server().await.is_err() {
        // Keep the admitted cookie for Retry; the startup token was single-use.
        publish(&out, &wake, Event::authentication_required(target)).await;
        return;
    }
    match result {
        Ok(()) => match target.prompt_directory().await {
            Ok(directory) => {
                target.session_directory = Some(directory);
                run_bound(Ok(target), out, input, wake, None).await;
            }
            Err(error) if codenomad_client::http::authentication_expired(&error) => {
                publish(&out, &wake, Event::authentication_required(target)).await;
                drop(out);
                wake();
            }
            Err(error) => run_bound(Err(error), out, input, wake, None).await,
        },
        Err(error) if codenomad_client::http::authentication_expired(&error) => {
            publish(&out, &wake, Event::authentication_required(target)).await;
            drop(out);
            wake();
        }
        Err(error) => run_bound(Err(error), out, input, wake, None).await,
    }
}

async fn run_bound(
    backend: crate::history::Result<crate::backend::Backend>,
    out: Sender<Event>,
    input: Receiver<Command>,
    wake: rune::Waker,
    reading: Option<codenomad_client::recovery::ReadingLane>,
) {
    let result = match (backend, reading) {
        (Ok(backend), Some(reading)) => {
            codenomad_client::transport::run_backend_reading(
                backend,
                out.clone(),
                input,
                wake.clone(),
                reading,
            )
            .await
        }
        (Ok(backend), None) => run_backend(backend, out.clone(), input, wake.clone()).await,
        (Err(error), _) => Err(error),
    };
    if result.is_err() {
        eprintln!("Rune backend unavailable");
        publish(&out, &wake, Event::Failed).await;
    }
    drop(out);
    wake();
}
#[cfg(feature = "test-support")]
async fn run_synthetic(out: Sender<Event>, input: Receiver<Command>, wake: rune::Waker) {
    let mut reject_first = crate::platform::scene_is("synthetic-paste");
    let history = if reject_first {
        Event::Sync(crate::history::Page {
            rows: synthetic(),
            older: None,
            newer: None,
            running: false,
            user_file_references: true,
        })
    } else {
        Event::History(synthetic())
    };
    publish(&out, &wake, history).await;
    let mut turn = 0;
    while let Ok(command) = input.recv().await {
        if matches!(command, Command::Close) {
            return;
        }
        match command {
            Command::Prompt(prompt) => {
                if let Some(attempted) = prompt.id {
                    let reject = std::mem::take(&mut reject_first);
                    if reject {
                        crate::platform::sleep(Duration::from_millis(1500)).await;
                    }
                    publish(
                        &out,
                        &wake,
                        Event::PromptAcknowledged {
                            outcome: if reject {
                                PromptOutcome::Rejected
                            } else {
                                PromptOutcome::Confirmed(attempted.clone())
                            },
                            attempted,
                        },
                    )
                    .await;
                    if reject {
                        continue;
                    }
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
                usage: None,
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
