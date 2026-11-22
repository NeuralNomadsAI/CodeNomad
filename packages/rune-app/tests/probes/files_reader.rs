use super::files_state::{settle, stage, wait};
use crate::{State, platform};
use codenomad_client::bounded;
use rune::Runtime;
use serde_json::{Value, json};

pub(super) fn snapshot(s: &State) -> Value {
    let reader = &s.files.as_ref().unwrap().reader;
    let target = reader.target().unwrap();
    let preview = reader.preview().unwrap();
    assert!(reader.error().is_none());
    assert_eq!(target.path, preview.path);
    assert_eq!(target.session, "ses_existing");
    assert!(preview.version.as_ref().is_some_and(|v| !v.is_empty()));
    json!({"path":target.path,"directory":target.directory,"session":target.session,
        "workspace":preview.workspace_id,"version":preview.version,
        "text":String::from_utf8(preview.bytes.clone()).unwrap()})
}
pub(super) fn content(rt: &mut Runtime<State>, text: &str) -> Value {
    wait(rt, "reader bytes through real preview API", |s| {
        s.files.as_ref().is_some_and(|f| {
            !f.reader.busy()
                && f.reader
                    .preview()
                    .is_some_and(|p| p.bytes == text.as_bytes())
        })
    });
    snapshot(&rt.state)
}
pub(super) fn open(rt: &mut Runtime<State>) -> Vec<Value> {
    rt.state
        .files
        .as_mut()
        .unwrap()
        .open("src/initial.ts".into());
    let initial = content(rt, "initial");
    stage(rt, "reader-visible");
    let modified = content(rt, "Reader visible · été 🦀\nsecond version");
    assert_ne!(initial["version"], modified["version"]);
    vec![initial, modified]
}
pub(super) fn fences(rt: &mut Runtime<State>) -> Value {
    let reads = rt.state.reads.clone();
    let (_cancel, alive) = bounded(1);
    let slot = platform::block_on(reads.preview(&alive)).unwrap();
    rt.state
        .files
        .as_mut()
        .unwrap()
        .open("src/initial.ts".into());
    rt.frame(1.0 / 60.0);
    assert!(rt.state.files.as_ref().unwrap().reader.busy());
    rt.state.files.as_mut().unwrap().close_reader();
    assert!(rt.state.files.as_ref().unwrap().reader.target().is_none());
    rt.state
        .files
        .as_mut()
        .unwrap()
        .open("src/initial.ts".into());
    rt.frame(1.0 / 60.0);
    assert!(rt.state.files.as_ref().unwrap().reader.busy());
    rt.state.files.as_mut().unwrap().open("initial.txt".into());
    rt.frame(1.0 / 60.0);
    drop(slot);
    let replacement = content(rt, "initial");
    assert_eq!(replacement["path"], "initial.txt");
    settle(rt);
    assert_eq!(snapshot(&rt.state), replacement);
    rt.state.files.as_mut().unwrap().close_reader();
    settle(rt);
    let reader = &rt.state.files.as_ref().unwrap().reader;
    assert!(reader.target().is_none() && reader.preview().is_none() && !reader.busy());
    replacement
}
