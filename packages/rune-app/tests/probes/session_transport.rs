use super::native_transport::run;
use crate::{
    CODE,
    transport::{Command, Event},
};
use std::time::Duration;
fn prompt(text: &str) -> Command {
    Command::Prompt(codenomad_client::prompt::Prompt {
        id: Some(codenomad_client::prompt::message_id().unwrap()),
        text: text.into(),
        ..Default::default()
    })
}
pub fn fresh() {
    let (out, incoming) = std::sync::mpsc::sync_channel(64);
    let (commands, input) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || run(out, input, std::sync::Arc::new(|| {})));
    let mut completed = 0;
    let mut last_rows = vec![];
    let mut sent = false;
    loop {
        match incoming
            .recv_timeout(Duration::from_secs(15))
            .expect("fresh event")
        {
            Event::Sync(page) => {
                if !sent {
                    assert!(page.rows.is_empty());
                    sent = true;
                    commands.send(prompt("Fresh first")).unwrap();
                }
                last_rows = page.rows;
            }
            Event::Done => {
                completed += 1;
                assert_eq!(last_rows.len(), completed * 2);
                assert_eq!(
                    last_rows[completed * 2 - 2].body,
                    if completed == 1 {
                        "Fresh first"
                    } else {
                        "Fresh second"
                    }
                );
                assert!(
                    last_rows[completed * 2 - 1]
                        .body
                        .contains(&format!("tour {completed}"))
                );
                assert!(
                    last_rows
                        .iter()
                        .map(|r| &r.id)
                        .collect::<std::collections::HashSet<_>>()
                        .len()
                        == last_rows.len()
                );
                if completed == 2 {
                    println!(
                        "fresh-session probe: 2 sends, 4 unique authoritative native rows, using projected history"
                    );
                    return;
                }
                commands.send(prompt("Fresh second")).unwrap();
            }
            Event::Failed => panic!("fresh session failed"),
            _ => {}
        }
    }
}
/// Exercises the exact adapter without a window or OS clipboard.
pub fn contract() {
    let (out, incoming) = std::sync::mpsc::sync_channel(64);
    let (commands, input) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || run(out, input, std::sync::Arc::new(|| {})));
    let start = std::time::Instant::now();
    let mut body = String::new();
    let mut chunks = 0;
    let prompts = ["Premier échange été 🦀", "Deuxième échange avec code"];
    let mut completed = 0;
    let mut ids = std::collections::HashSet::new();
    let mut active = String::new();
    let mut previous = String::new();
    loop {
        assert!(
            start.elapsed() < Duration::from_secs(40),
            "contract probe timed out"
        );
        match incoming
            .recv_timeout(Duration::from_secs(10))
            .expect("adapter event")
        {
            Event::Sync(page) if active.is_empty() && completed == 0 => {
                let messages = page.rows;
                assert_eq!(messages.len(), 200);
                assert_eq!(messages.last().unwrap().body, CODE);
                commands.send(prompt(prompts[0])).unwrap();
            }
            Event::Text(id, crate::content::TextEvent::Delta { text: delta, .. }) => {
                assert_eq!(id, active);
                chunks += 1;
                body.push_str(&delta);
            }
            Event::Text(
                _,
                crate::content::TextEvent::Start { .. } | crate::content::TextEvent::End { .. },
            ) => {}
            Event::Done => {
                let expected = format!(
                    "fn main() {{\n    println!({});\n}}",
                    serde_json::to_string(&format!(
                        "Rune · tour {}: {}",
                        completed + 1,
                        prompts[completed]
                    ))
                    .unwrap()
                );
                assert_eq!(body, expected);
                assert_ne!(body, previous);
                assert!(chunks > 1);
                completed += 1;
                println!(
                    "contract probe: turn {completed}, id {active}, {chunks} SSE chunks, distinct Unicode response OK"
                );
                if completed == 2 {
                    return;
                }
                previous = std::mem::take(&mut body);
                chunks = 0;
                commands.send(prompt(prompts[completed])).unwrap();
            }
            Event::AuthenticationRequired(..) | Event::Failed => panic!("adapter failed"),
            Event::Sync(_)
            | Event::ReaderSync { .. }
            | Event::History(_)
            | Event::Older(_)
            | Event::PageOffered { .. }
            | Event::PageFailed(_)
            | Event::Anchor { .. }
            | Event::AnchorFailed(_)
            | Event::Reconnecting
            | Event::HistoryInvalidated
            | Event::SessionDeleted
            | Event::RevertChanged
            | Event::ConnectionLost
            | Event::WorkspaceMissing
            | Event::Connected(_)
            | Event::ProviderUsageWatch(_)
            | Event::AgentHint(_)
            | Event::UpstreamReady
            | Event::AgentControl(_)
            | Event::ObservedRunning { .. }
            | Event::Workspace(_)
            | Event::Preferences(_)
            | Event::Reasoning(..)
            | Event::StepUsage(..)
            | Event::SessionUsage(_)
            | Event::FamilyUsage(_)
            | Event::PromptAcknowledged { .. }
            | Event::Tool(..)
            | Event::Inbox { .. }
            | Event::InboxDelta(_)
            | Event::InboxFailed
            | Event::PagingFailed => {}
            Event::Message(message) => {
                assert!(
                    ids.insert(message.id.clone()),
                    "each turn needs a unique message ID"
                );
                active = message.id;
            }
        }
    }
}
