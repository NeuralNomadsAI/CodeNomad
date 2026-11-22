use crate::{Phase, State, init, launcher, poll, setup, view};
use rune::{Env, Runtime, edit::TextEdit};
use serde_json::json;
use std::{path::PathBuf, time::{Duration, Instant}};

fn tap(rt: &mut Runtime<State>, key: &str) {
    let (x,y) = rt.find(key).unwrap_or_else(|| panic!("Missing {key}"));
    rt.pointer_down(x,y);
    rt.pointer_up(x,y);
    rt.frame(0.016);
}

fn until(rt: &mut Runtime<State>, limit: Duration, label: &str, done: impl Fn(&State)->bool) {
    let end = Instant::now() + limit;
    while !done(&rt.state) {
        assert!(Instant::now() < end, "Timeout: {label}");
        rt.frame(0.016);
        std::thread::sleep(Duration::from_millis(4));
    }
}

pub fn run() {
    let mut state = init();
    setup(&mut state, std::sync::Arc::new(||{}));
    let dpi = std::env::var("RUNE_SERVO_PROBE_DPI").ok().and_then(|v|v.parse().ok()).unwrap_or(1.0);
    let mut rt = Runtime::new(state, view, (1150.0, 1050.0), Env::new(true,dpi));
    rt.poll = Some(poll);
    let minute = Duration::from_secs(60);
    until(&mut rt, minute, "server connection", |s|s.launcher.as_ref().is_some_and(|l|l.connection.is_some()));
    let folder = std::env::var("RUNE_TEST_FOLDER").expect("test folder");
    rt.state.launcher.as_mut().unwrap().folder = TextEdit::new(folder);
    rt.frame(0.016);
    tap(&mut rt,"open-folder");
    until(&mut rt, minute, "project", |s|s.launcher.as_ref().is_some_and(|l|l.project.is_some()));
    rt.state.launcher.as_mut().unwrap().title = TextEdit::new("Servo preview trial");
    rt.frame(0.016);
    tap(&mut rt,"create-session");
    until(&mut rt, minute, "session", |s|s.phase == Phase::Ready && s.preview.owner_for_trial().is_some());
    let (workspace, session) = rt.state.preview.owner_for_trial().unwrap();
    let backend = rt.state.launcher.as_ref().unwrap().connection.as_ref().unwrap().clone();
    let sidecar = std::env::var("RUNE_SERVO_SIDECAR_PORT").ok().and_then(|v|v.parse::<u16>().ok())
        .and_then(|port| crate::platform::block_on(async {
            let reply = backend.client.post(format!("{}api/sidecars",backend.base))
                .json(&json!({"name":"Servo trial","port":port,"insecure":true})).send().await.ok()?;
            let status = reply.status();
            let body: serde_json::Value = reply.json().await.ok()?;
            Some(json!({"status":status.as_u16(),"body":body}))
        }));
    println!("SERVO_TRIAL {}", json!({"workspace":workspace,"session":session,"server":backend.base,"sidecar":sidecar}));
    let flag: PathBuf = std::env::var_os("RUNE_SERVO_PROBE_FINISH").expect("completion marker").into();
    let deadline = Instant::now() + Duration::from_secs(220);
    let mut frame_us = Vec::new();
    while !flag.exists() && Instant::now() < deadline {
        let start = Instant::now();
        rt.frame(0.016);
        frame_us.push(start.elapsed().as_micros() as u64);
        std::thread::sleep(Duration::from_millis(4));
    }
    frame_us.sort_unstable();
    println!("SERVO_METRICS {}",json!({"dpi":dpi, "runtime_frame_us_p95":frame_us.get(frame_us.len()*95/100),
        "guest":crate::preview::test_metrics::take(),"messages":rt.state.messages.len()}));
    rt.state.preview.close();
    drop(rt);
    crate::platform::finish();
}
