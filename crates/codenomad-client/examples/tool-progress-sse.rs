//! Runs the same production transport and assertions on native and browser.
use codenomad_client::{
    backend::Backend,
    bounded, runtime,
    transport::{Command, Event, run_backend},
};
use std::{sync::Arc, time::Duration};

async fn check(base: &str) -> Result<(), String> {
    let mut backend = Backend::connect(base, "")
        .await
        .map_err(|e| e.to_string())?;
    backend.workspace = "workspace".into();
    backend.session = "parent".into();
    let child = backend
        .watch_child("child")
        .ok_or("child watch unavailable")?;
    let foreign = backend
        .watch_child("foreign")
        .ok_or("foreign watch unavailable")?;
    let observer = backend.clone();
    let (out, events) = bounded(16);
    let (commands, input) = bounded(1);
    runtime::spawn(async move {
        let _ = run_backend(backend, out, input, Arc::new(|| {})).await;
    });
    let mut seen = 0;
    let result = loop {
        match runtime::recv_timeout(&events, Duration::from_secs(10)).await {
            Some(Event::Tool(_, tool)) if tool.name == "execute" => {
                if let Some(calls) = tool.metadata["toolCalls"].as_array() {
                    if calls.len() != 4
                        || calls
                            .iter()
                            .any(|c| c["tool"] != "write" || c.get("input").is_some())
                        || calls[3]["status"] != if seen == 0 { "running" } else { "completed" }
                    {
                        break Err("unexpected projected progress".into());
                    }
                    seen += 1;
                }
            }
            Some(Event::Sync(page)) if seen == 2 => {
                break if page.rows.iter().any(|row| row.id == "reread-proof") {
                    Ok(())
                } else {
                    Err("oversized frame did not cause an authoritative read".into())
                };
            }
            Some(Event::ConnectionLost | Event::Failed) => break Err("stream disconnected".into()),
            None => break Err(format!("timed out after {seen} progress frames")),
            _ => {}
        }
    };
    result?;
    let _ = child.try_recv();
    let _ = foreign.try_recv();
    let initial = observer
        .child_page("child")
        .await
        .map_err(|e| e.to_string())?
        .ok_or("child not owned")?;
    if !initial.rows.is_empty() {
        return Err("child started before the live watch was verified".into());
    }
    let family = observer.family_usage().await.map_err(|e| e.to_string())?;
    if family.len() != 2
        || family["child"].usage.input != 8
        || family["grandchild"].usage.input != 13
    {
        return Err("expected only the child and grandchild's native usage".into());
    }
    observer
        .client
        .post(format!("{}fixture/child", observer.base))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;
    if runtime::recv_timeout(&child, Duration::from_secs(4))
        .await
        .is_none()
        || !foreign.is_empty()
    {
        return Err("expected only the matching child to wake on its tool event".into());
    }
    let page = observer
        .child_page("child")
        .await
        .map_err(|e| e.to_string())?
        .ok_or("child not owned")?;
    if !page.rows.iter().any(|row| {
        row.id == "child-step" && row.parts.iter().any(|part| {
        matches!(part, codenomad_client::content::Part::Tool(tool) if tool.status == "running")
    })
    }) || observer
        .child_page("foreign")
        .await
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Err("expected the child's current history, not the foreign session".into());
    }
    let (mut step, mut session, mut child_usage) = (false, false, false);
    while !step || !session || !child_usage {
        match runtime::recv_timeout(&events, Duration::from_secs(4)).await {
            Some(Event::StepUsage(id, usage)) if id == "msg" && usage.input == 15 => step = true,
            Some(Event::SessionUsage(usage)) if usage.input == 40 => session = true,
            Some(Event::FamilyUsage(codenomad_client::content::FamilyChange::Usage {
                id,
                usage,
            })) if id == "grandchild" && usage.input == 21 => child_usage = true,
            None => return Err("step or session usage update missing".into()),
            _ => {}
        }
    }
    let _ = commands.send(Command::Close).await;
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    let base = std::env::args().nth(1).expect("fixture URL");
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(check(&base))
        .unwrap();
}

#[cfg(target_arch = "wasm32")]
fn main() {}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub async fn observe(base: String) -> Result<(), wasm_bindgen::JsValue> {
    check(&base)
        .await
        .map_err(|err| wasm_bindgen::JsValue::from_str(&err))
}
