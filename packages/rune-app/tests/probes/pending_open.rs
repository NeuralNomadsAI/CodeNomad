use super::window_restore::{tap, wait, wait_control};
use crate::{State, backend::Backend, init, platform, poll, view, workspace};
use rune::{Env, Runtime};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

fn window() -> Runtime<State> {
    let mut state = init();
    crate::setup(&mut state, std::sync::Arc::new(|| {}));
    let mut rt = Runtime::new(state, view, (1100.0, 1200.0), Env::new(true, 1.0));
    rt.poll = Some(poll);
    rt.frame(0.0);
    tap(&mut rt, "connect");
    wait(&mut rt, "connected", |s| {
        workspace::input_ready(s)
            && s.screen
                .launcher()
                .is_some_and(|l| l.connection.is_some() && !l.pending)
    });
    wait_control(&mut rt, "browse");
    tap(&mut rt, "browse");
    rt.resolve_file_dialog(Some(std::env::var("RUNE_TEST_FOLDER").unwrap().into()))
        .unwrap();
    rt.frame(1.0 / 60.0);
    rt
}
pub fn run() {
    assert!(
        std::env::var("CODENOMAD_PROFILE")
            .unwrap()
            .starts_with("trial-")
    );
    let gate = PathBuf::from(std::env::var("RUNE_TEST_PENDING_GATE").unwrap());
    let case = std::env::var("RUNE_TEST_PENDING_CASE").unwrap();
    if case == "capacity" {
        capacity();
        return;
    }
    let mut old = window();
    wait(&mut old, "held creation", |_| gate.exists());
    let openings = old.state.screen.launcher().unwrap().openings.clone();
    assert_eq!(openings.pending().len(), 1);
    let state_file = PathBuf::from(std::env::var("RUNE_STATE_DIR").unwrap()).join("state.json");
    let backup = std::fs::read(&state_file).ok();
    if case == "quota" {
        let _ = std::fs::remove_file(&state_file);
        std::fs::create_dir(&state_file).unwrap();
    }
    old.update(workspace::finish);
    if case == "quota" {
        assert!(workspace::status(&old.state).is_some());
    }
    drop(old);
    if case == "quota" {
        std::fs::remove_dir(&state_file).unwrap();
        if let Some(bytes) = backup {
            std::fs::write(&state_file, bytes).unwrap();
        }
    }
    let mut next = window();
    wait(&mut next, "successor adoption", |s| {
        s.screen
            .launcher()
            .is_some_and(|l| !l.pending && l.project.is_some())
    });
    let successor = next
        .state
        .screen
        .launcher()
        .unwrap()
        .project
        .as_ref()
        .unwrap()
        .id
        .clone();
    println!(
        "{}",
        serde_json::json!({"type":"pending-open-stage","stage":"successor-adopted","case":case})
    );
    let released = gate.with_extension("released");
    wait(&mut next, "late response released", |_| released.exists());
    let backend = platform::block_on(Backend::connect(
        &std::env::var("RUNE_BACKEND").unwrap(),
        &std::env::var("RUNE_PASSWORD").unwrap(),
    ))
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let projects = platform::block_on(backend.projects()).unwrap();
        if projects.len() == 1 && projects[0].id == successor {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "old claim must preserve successor and leave no owned record"
        );
        next.frame(1.0 / 60.0);
        std::thread::sleep(Duration::from_millis(10));
    }
    // Let the old future observe its delayed receipt and re-qualify cleanup.
    for _ in 0..100 {
        next.frame(1.0 / 60.0);
        std::thread::sleep(Duration::from_millis(5));
    }
    let projects = platform::block_on(backend.projects()).unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].id, successor);
    next.update(workspace::finish);
    drop(next);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !platform::block_on(backend.projects()).unwrap().is_empty() {
        assert!(
            Instant::now() < deadline,
            "all owned records must be released"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    println!(
        "{}",
        serde_json::json!({"type":"pending-open-proof","case":case,"recordsRemaining":0,"successorProtected":true,"latePublicationRejected":true,"unresolvedClaimsRetained":openings.pending().len(),"nativeWindow":false})
    );
    platform::finish();
}

fn capacity() {
    platform::block_on(async {
        let backend = Backend::connect(
            &std::env::var("RUNE_BACKEND").unwrap(),
            &std::env::var("RUNE_PASSWORD").unwrap(),
        )
        .await
        .unwrap();
        let owner = workspace::opening::Openings::default();
        let folder = std::env::var("RUNE_TEST_FOLDER").unwrap();
        let missing = PathBuf::from(&folder).join("missing-fixture-folder");
        assert!(!missing.exists());
        for _ in 0..32 {
            let error = owner
                .begin(backend.clone(), "tab-0")
                .unwrap()
                .create(missing.to_str().unwrap())
                .await
                .err()
                .expect("missing folder refused");
            assert!(error.is::<codenomad_client::catalog::CreationRefused>());
            assert!(
                owner.pending().is_empty(),
                "terminal refusal releases admission"
            );
        }
        assert!(backend.projects().await.unwrap().is_empty());
        let opening = owner
            .begin(backend.clone(), "tab-0")
            .unwrap()
            .create(&folder)
            .await
            .unwrap();
        let id = opening.project.id.clone();
        opening.adopt().unwrap();
        assert_eq!(backend.projects().await.unwrap().len(), 1);
        backend.release_project(&id).await.unwrap();
        assert!(backend.projects().await.unwrap().is_empty());
        println!(
            "{}",
            serde_json::json!({"type":"pending-open-proof","case":"capacity","definitiveRefusals":32,"successfulOpenAfterRefusals":true,"recordsRemaining":0,"nativeWindow":false})
        );
    });
    platform::finish();
}
