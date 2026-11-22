use crate::{Phase, State, init, poll, setup, view};
use rune::{Env, Runtime, edit::TextEdit};
use serde_json::json;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

fn tap(rt: &mut Runtime<State>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("Missing {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.016);
}

fn until(rt: &mut Runtime<State>, limit: Duration, label: &str, done: impl Fn(&State) -> bool) {
    let end = Instant::now() + limit;
    while !done(&rt.state) {
        assert!(
            Instant::now() < end,
            "Timeout: {label}; launcher error: {:?}",
            rt.state.launcher.as_ref().and_then(|l| l.error)
        );
        rt.frame(0.016);
        std::thread::sleep(Duration::from_millis(4));
    }
}

pub fn run() {
    let mut state = init();
    setup(&mut state, std::sync::Arc::new(|| {}));
    let dpi = std::env::var("RUNE_LADYBIRD_PROBE_DPI")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1.0);
    let mut rt = Runtime::new(state, view, (1150.0, 1050.0), Env::new(true, dpi));
    rt.poll = Some(poll);
    let minute = Duration::from_secs(60);
    until(&mut rt, minute, "server connection", |s| {
        s.launcher
            .as_ref()
            .is_some_and(|l| l.connection.is_some() && !l.pending)
            && crate::workspace::input_ready(s)
    });
    let folder = std::env::var("RUNE_TEST_FOLDER").expect("test folder");
    rt.update(|s, _| s.launcher.as_mut().unwrap().folder = TextEdit::new(folder));
    tap(&mut rt, "open-folder");
    until(&mut rt, minute, "project", |s| {
        s.launcher
            .as_ref()
            .is_some_and(|l| l.project.is_some() && !l.pending)
    });
    rt.update(|s, _| s.launcher.as_mut().unwrap().title = TextEdit::new("Ladybird preview trial"));
    tap(&mut rt, "create-session");
    until(&mut rt, minute, "session", |s| {
        s.phase == Phase::Ready && s.preview.owner_for_trial().is_some()
    });
    let (workspace, session) = rt.state.preview.owner_for_trial().unwrap();
    let backend = rt
        .state
        .launcher
        .as_ref()
        .unwrap()
        .connection
        .as_ref()
        .unwrap()
        .clone();
    let sidecar = std::env::var("RUNE_LADYBIRD_SIDECAR_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .and_then(|port| {
            crate::platform::block_on(async {
                let reply = backend
                    .client
                    .post(format!("{}api/sidecars", backend.base))
                    .json(&json!({"name":"Ladybird trial","port":port,"insecure":true}))
                    .send()
                    .await
                    .ok()?;
            let status = reply.status();
            let body: serde_json::Value = reply.json().await.ok()?;
            let id = body["id"].as_str()?;
            let probe = backend.client.get(format!("{}sidecars/{id}/",backend.base)).send().await.ok()?;
            let proxy_status = probe.status().as_u16();
            let reached_service = probe.text().await.ok()?.contains("Ladybird SideCar");
            Some(json!({"status":status.as_u16(),"body":body,"proxyStatus":proxy_status,"reachedService":reached_service}))
            })
        });
    let flag: PathBuf = std::env::var_os("RUNE_LADYBIRD_PROBE_FINISH")
        .expect("completion marker")
        .into();
    let deadline = Instant::now() + Duration::from_secs(220);
    let mut frame_us = Vec::new();
    let mut offscreen = rune_theme_codenomad::preview::OffscreenTrial::new(
        (1150.0 * dpi) as u32,
        (1050.0 * dpi) as u32,
    );
    println!(
        "LADYBIRD_TRIAL {}",
        json!({"workspace":workspace,"session":session,"server":backend.base,"sidecar":sidecar})
    );
    let reload = flag.with_file_name("reload");
    let capture = flag.with_file_name("capture");
    let mut chat_seen = Vec::new();
    let mut resized = false;
    let mut captured = false;
    while !flag.exists() && Instant::now() < deadline {
        if !resized && reload.exists() {
            tap(&mut rt, "ladybird-reload");
            rt.set_viewport((1020.0, 920.0), dpi);
            offscreen.resize((1020.0 * dpi) as u32, (920.0 * dpi) as u32);
            resized = true;
            println!("LADYBIRD_RESIZED");
        }
        let start = Instant::now();
        rt.frame(0.016);
        if chat_seen.len() < 25
            && let Some(body) = rt
                .state
                .messages
                .iter()
                .rev()
                .find(|m| m.role == "assistant" && m.body.contains("LBD0;"))
                .map(|m| &m.body)
        {
            while chat_seen.len() < 25 && body.contains(&format!("LBD{};", chat_seen.len())) {
                chat_seen.push(crate::platform::browser::now_ms());
            }
            if chat_seen.len() == 25 {
                std::fs::write(
                    flag.with_file_name("chat-seen.json"),
                    serde_json::to_vec(&chat_seen).unwrap(),
                )
                .unwrap();
            }
        }
        if crate::preview::test_metrics::paint_pending() {
            offscreen.submit(&mut rt);
            crate::preview::test_metrics::submitted(rt.state.preview.trial_gpu_frame());
        }
        if !captured && capture.exists() {
            offscreen.submit(&mut rt);
            offscreen.save(&flag.with_file_name("rune-composite.png")).expect("Rune GPU readback");
            captured = true;
        }
        frame_us.push(start.elapsed().as_micros() as u64);
        std::thread::sleep(Duration::from_millis(4));
    }
    frame_us.sort_unstable();
    println!(
        "LADYBIRD_METRICS {}",
        json!({"dpi":dpi, "viewport":rt.state.preview.trial_viewport(), "runtime_frame_us_p95":frame_us.get(frame_us.len()*95/100),
        "guest":crate::preview::test_metrics::take(),"messages":rt.state.messages.len()})
    );
    if !captured {
        offscreen.submit(&mut rt);
        offscreen.save(&flag.with_file_name("rune-composite.png")).expect("Rune GPU readback");
    }
    rt.state.preview.close();
    drop(rt);
    crate::platform::finish();
}
