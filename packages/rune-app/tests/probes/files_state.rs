use crate::{Phase, State, init, launcher, poll, view, workspace};
use rune::{Env, Runtime, edit::TextEdit};
use serde_json::{Value, json};
use std::{
    io::Write,
    time::{Duration, Instant},
};

fn paths(s: &State) -> Vec<String> {
    s.files
        .as_ref()
        .map(|f| f.rows.iter().map(|r| r.entry.path.clone()).collect())
        .unwrap_or_default()
}
fn contains(s: &State, path: &str) -> bool {
    s.files
        .as_ref()
        .is_some_and(|f| f.rows.iter().any(|r| r.entry.path == path))
}
pub(super) fn wait(rt: &mut Runtime<State>, label: &str, condition: impl Fn(&State) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(25);
    while !condition(&rt.state) {
        assert!(Instant::now() < deadline, "Files state timeout: {label}");
        rt.frame(1.0 / 60.0);
        std::thread::sleep(Duration::from_millis(5));
    }
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
}
pub(super) fn settle(rt: &mut Runtime<State>) {
    for _ in 0..600 {
        rt.frame(1.0 / 60.0);
        std::thread::sleep(Duration::from_millis(5));
    }
}
pub(super) fn stage(rt: &Runtime<State>, stage: &str) {
    println!(
        "{}",
        json!({"type":"files-state-stage","stage":stage,"rows":paths(&rt.state)})
    );
    std::io::stdout().flush().unwrap();
    let mut line = String::new();
    assert!(std::io::stdin().read_line(&mut line).unwrap() > 0);
    let ack: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(ack["stage"], stage);
}
pub fn run() {
    assert!(
        std::env::var("CODENOMAD_PROFILE")
            .unwrap()
            .starts_with("trial-")
    );
    let mut state = init();
    crate::setup(&mut state, std::sync::Arc::new(|| {}));
    let mut rt = Runtime::new(state, view, (1100.0, 1000.0), Env::new(true, 1.0));
    rt.poll = Some(poll);
    rt.frame(0.0);
    rt.update(launcher::connect);
    wait(&mut rt, "connection", |s| {
        s.screen
            .launcher()
            .is_some_and(|l| l.connection.is_some() && !l.pending)
            && workspace::input_ready(s)
    });
    rt.state.screen.launcher_mut().unwrap().folder =
        TextEdit::new(std::env::var("RUNE_TEST_FOLDER").unwrap());
    rt.update(launcher::open);
    wait(&mut rt, "project", |s| {
        s.screen
            .launcher()
            .is_some_and(|l| l.project.is_some() && !l.pending)
    });
    rt.update(|s, tx| launcher::choose(s, "ses_existing".into(), tx));
    wait(&mut rt, "existing session", |s| {
        !s.screen.is_launcher() && s.phase == Phase::Ready && s.files.is_some()
    });
    assert_eq!(rt.state.messages.len(), 2);
    assert_eq!(rt.state.messages[0].body, "Existing project history");
    rt.update(|s, _| workspace::set_files_tab(s, true));
    wait(&mut rt, "root listing", |s| {
        contains(s, "initial.txt") && contains(s, "src")
    });
    assert_eq!(rt.state.files.as_ref().unwrap().rows[0].entry.path, "src");
    rt.state.files.as_mut().unwrap().select("src".into(), true);
    wait(&mut rt, "expanded listing", |s| {
        contains(s, "src/initial.ts")
    });
    let mut reader_versions = super::files_reader::open(&mut rt);
    rt.state
        .files
        .as_mut()
        .unwrap()
        .select("src/initial.ts".into(), false);
    stage(&rt, "create");
    wait(&mut rt, "created files through watches", |s| {
        contains(s, "new.txt") && contains(s, "src/nested.ts")
    });
    stage(&rt, "rename");
    wait(&mut rt, "renamed file through watches", |s| {
        contains(s, "renamed.txt") && !contains(s, "new.txt")
    });
    stage(&rt, "delete");
    wait(&mut rt, "deleted files through watches", |s| {
        !contains(s, "renamed.txt") && !contains(s, "src/nested.ts")
    });
    rt.state.files.as_mut().unwrap().select("src".into(), true);
    stage(&rt, "collapsed");
    settle(&mut rt);
    assert!(!contains(&rt.state, "src/collapsed.ts"));
    assert!(!rt.state.files.as_ref().unwrap().tree.expanded("src"));
    rt.state.files.as_mut().unwrap().select("src".into(), true);
    wait(&mut rt, "reopened stale directory", |s| {
        contains(s, "src/collapsed.ts")
    });
    rt.state
        .files
        .as_mut()
        .unwrap()
        .select("src/initial.ts".into(), false);
    let cached = paths(&rt.state);
    rt.update(|s, _| workspace::set_files_tab(s, false));
    stage(&rt, "hidden");
    settle(&mut rt);
    let hidden = super::files_reader::content(&mut rt, "Reader hidden · 日本語\nthird version");
    assert_ne!(
        reader_versions.last().unwrap()["version"],
        hidden["version"]
    );
    reader_versions.push(hidden.clone());
    assert_eq!(paths(&rt.state), cached);
    assert_eq!(
        rt.state.files.as_ref().unwrap().tree.selected(),
        Some("src/initial.ts")
    );
    rt.update(|s, _| workspace::set_files_tab(s, true));
    wait(&mut rt, "visible demand catches hidden mutation", |s| {
        contains(s, "hidden.txt")
    });
    assert!(rt.state.files.as_ref().unwrap().tree.expanded("src"));
    let tab = rt
        .state
        .workspace
        .as_ref()
        .unwrap()
        .active_key()
        .to_string();
    rt.update(workspace::new_tab);
    assert!(rt.state.files.is_none() && rt.state.screen.is_launcher());
    stage(&rt, "tabbed");
    settle(&mut rt);
    rt.update(|s, tx| workspace::select(s, &tab, tx));
    assert_eq!(super::files_reader::snapshot(&rt.state), hidden);
    assert!(rt.state.files.as_ref().unwrap().panel);
    assert_eq!(
        rt.state.files.as_ref().unwrap().tree.selected(),
        Some("src/initial.ts")
    );
    assert!(rt.state.files.as_ref().unwrap().tree.expanded("src"));
    wait(
        &mut rt,
        "restored occurrence catches inactive mutation",
        |s| contains(s, "tabbed.txt"),
    );
    let resumed = super::files_reader::content(
        &mut rt,
        "Reader resumed · quatrième\nversion after suspension",
    );
    assert_ne!(hidden["version"], resumed["version"]);
    reader_versions.push(resumed);
    let document = (std::env::var("RUNE_TEST_DOCUMENT_STATE").as_deref() == Ok("1"))
        .then(|| super::files_document::run(&mut rt));
    let replacement = super::files_reader::fences(&mut rt);
    assert_eq!(rt.state.messages.len(), 2);
    assert!(rt.state.files.as_ref().unwrap().tree.errors().is_empty());
    let final_rows = paths(&rt.state);
    super::window_restore::finish(rt);
    println!(
        "{}",
        json!({"type":"files-state-proof","headless":true,"interfaceQualified":false,
        "existingSession":"ses_existing","stages":7+5*usize::from(document.is_some()),"rows":final_rows,"recordsRemaining":0,
        "selectionRetained":true,"expansionRetained":true,"hiddenSnapshotRetained":true,
        "readerVersions":reader_versions,"readerReplacement":replacement,"document":document,
        "readerHiddenLive":true,"readerSuspensionRetained":true,
        "readerQueuedCloseAndReplacementFenced":true,"readerClosed":true})
    );
}
