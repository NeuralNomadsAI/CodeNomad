use super::files_state::{stage, wait};
use crate::{
    State,
    files::document::{editor::Decision, store::Error},
};
use rune::Runtime;
use serde_json::{Value, json};

const DRAFT: &str = "Rune saved · été 🦀\nsecond line";
fn edit(rt: &mut Runtime<State>, value: &str) {
    let files = rt.state.files.as_mut().unwrap();
    let scope = files.document.scope();
    files.document.input(scope).replace_text(value);
    files.document.changed(scope);
}
fn save(rt: &mut Runtime<State>) {
    let files = rt.state.files.as_mut().unwrap();
    files.save_document(files.document.scope());
}
fn confirmation(rt: &mut Runtime<State>, decision: Decision) -> u64 {
    wait(rt, "document confirmation", |s| {
        s.files.as_ref().unwrap().document.confirmation().is_some()
    });
    let prompt = rt
        .state
        .files
        .as_ref()
        .unwrap()
        .document
        .confirmation()
        .unwrap();
    assert_eq!(prompt.decision, decision);
    prompt.id
}
fn confirm(rt: &mut Runtime<State>, id: u64, accepted: bool) {
    rt.state
        .files
        .as_mut()
        .unwrap()
        .confirm_document(id, accepted);
}
pub(super) fn run(rt: &mut Runtime<State>) -> Value {
    wait(rt, "editable preview", |s| {
        !s.files.as_ref().unwrap().document.edit().text.is_empty()
    });
    edit(rt, DRAFT);
    stage(rt, "document-external");
    save(rt);
    let cancel = confirmation(rt, Decision::Overwrite);
    confirm(rt, cancel, false);
    assert!(!rt.state.files.as_ref().unwrap().document.pending());
    assert_eq!(rt.state.files.as_ref().unwrap().document.edit().text, DRAFT);
    stage(rt, "document-cancelled");

    save(rt);
    let stale = confirmation(rt, Decision::Overwrite);
    stage(rt, "document-race");
    confirm(rt, stale, true);
    wait(rt, "write version conflict", |s| {
        s.files.as_ref().unwrap().document.error() == Some(Error::Conflict)
    });
    assert_eq!(rt.state.files.as_ref().unwrap().document.edit().text, DRAFT);
    stage(rt, "document-conflict");

    save(rt);
    let overwrite = confirmation(rt, Decision::Overwrite);
    assert_ne!(stale, overwrite);
    confirm(rt, overwrite, true);
    wait(rt, "saved baseline", |s| {
        let document = &s.files.as_ref().unwrap().document;
        !document.pending() && !document.dirty() && document.error().is_none()
    });
    assert_eq!(rt.state.files.as_ref().unwrap().document.edit().text, DRAFT);
    stage(rt, "document-saved");

    edit(rt, "retained unsaved draft");
    let old_scope = rt.state.files.as_ref().unwrap().document.scope();
    rt.state.files.as_mut().unwrap().close_reader();
    rt.state
        .files
        .as_mut()
        .unwrap()
        .open("src/initial.ts".into());
    wait(rt, "reopened dirty draft", |s| {
        let files = s.files.as_ref().unwrap();
        files.reader.receipt().0 > 0
            && !files.reader.busy()
            && files.document.edit().text == "retained unsaved draft"
    });
    let files = rt.state.files.as_mut().unwrap();
    assert!(files.document.dirty());
    files.document.input(old_scope).replace_text("late event");
    files.document.changed(old_scope);
    assert_eq!(files.document.edit().text, "retained unsaved draft");
    files.refresh_document(files.document.scope());
    let discard = confirmation(rt, Decision::Discard);
    confirm(rt, discard, true);
    wait(rt, "discard reads authoritative content", |s| {
        let document = &s.files.as_ref().unwrap().document;
        !document.dirty() && document.edit().text == DRAFT
    });
    json!({"cancelled":true,"versionConflict":true,"saved":DRAFT,
        "draftRetained":true,"lateEditRejected":true,"discarded":true,
        "interfaceQualified":false})
}
