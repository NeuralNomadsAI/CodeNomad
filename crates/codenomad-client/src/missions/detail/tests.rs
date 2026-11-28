use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};

const ORDER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn source(text: String, source: &str, revision: u64) -> [Value; 2] {
    let digest = URL_SAFE_NO_PAD.encode(Sha256::digest(
        format!("[{text}]")
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    ));
    let characters = units(&text);
    let split = text.find('🦀').map_or(1, |start| start + '🦀'.len_utf8());
    let offset = units(&text[..split]);
    let mut first = json!({
        "available":true,"version":1,"projectID":"project","source":source,"missionID":"mission","revision":revision,
        "discardedEvents":0,"controlUnavailable":false,"notificationUnavailable":false,"cleanupUnavailable":false,
        "page":{"digest":digest,"total":1,"pieces":[{"index":0,"offset":0,"characters":characters,"text":&text[..split]}]}
    });
    if source == "mission" {
        first["header"] = json!(true);
    }
    let mut last = first.clone();
    last["page"]["pieces"][0]["offset"] = json!(offset);
    last["page"]["pieces"][0]["text"] = json!(&text[split..]);
    first["page"]["next"] = json!({"digest":digest,"index":0,"offset":offset});
    [first, last]
}

fn backend() -> Backend {
    let mut backend = Backend::unauthenticated("http://127.0.0.1:1").unwrap();
    backend.workspace = "workspace".into();
    backend
}

fn header_row() -> Value {
    let descriptor = json!({"characters":2,"digest":ORDER,"total":0,"array":true});
    json!({
        "root":{"version":1,"id":"mission","projectID":"project","projectCanonical":"/fixture",
            "title":"Fiche 🦀","excerpt":"Objective","template":"custom","status":"active",
            "coordinatorSessionId":"ses_fixture","revision":3,"createdAt":1,"updatedAt":3,
            "historyTruncated":false,"bodies":{}},
        "collections":{"actors":descriptor,"history":descriptor,"reports":descriptor},
        "tasks":{"page":{"order":ORDER,"offset":0,"end":1,"total":1,"reports":0,"counts":{"ready":1}},
            "pins":[],"reportPins":[],"version":ORDER}
    })
}

fn verified<T>(mut read: DetailRead<T>, [first, last]: [Value; 2]) -> Result<T> {
    assert!(read.read.accept(first)?.is_none());
    (read.decode)(read.read.accept(last)?.expect("final slice"))
}

#[test]
fn detail_is_project_mission_and_revision_fenced_before_task_publication() {
    let b = backend();
    let open = || b.mission_header("project", "mission").unwrap();
    let original = source(header_row().to_string(), "mission", 3);
    let header = verified(open(), original.clone()).unwrap();
    assert_eq!(header.root.title.as_deref(), Some("Fiche 🦀"));
    for (key, invalid) in [
        ("projectID", json!("other")),
        ("missionID", json!("other")),
        ("revision", json!(4)),
    ] {
        let mut changed = original.clone();
        changed[1][key] = invalid;
        assert!(verified(open(), changed).is_err(), "{key}");
    }
    let mut changed = original;
    let text = changed[1]["page"]["pieces"][0]["text"].as_str().unwrap();
    changed[1]["page"]["pieces"][0]["text"] =
        json!(format!("{} ", text.strip_suffix('}').unwrap()));
    assert!(verified(open(), changed).is_err());

    let task = json!({"id":"tsk-one","key":"task-one","title":"Task 🦀","role":"specialist","status":"ready",
        "blockedBy":[],"order":0,"createdAt":1,"updatedAt":1,"dependents":0,"reportCount":0,"outstandingExecution":false});
    let window = json!({"taskPage":header_row()["tasks"]["page"],"tasks":[task],"reports":[]});
    let open = || b.mission_task_window("project", &header, 0).unwrap();
    let good = verified(open(), source(window.to_string(), "tasks", 3)).unwrap();
    assert_eq!(good.tasks[0].title, "Task 🦀");
    let skew = verified(open(), source(window.to_string(), "tasks", 4)).unwrap_err();
    assert_eq!(
        skew.downcast_ref::<RevisionChanged>().map(|error| error.0),
        Some(4)
    );
    let mut foreign = window;
    foreign["tasks"][0]["order"] = json!(1);
    assert!(verified(open(), source(foreign.to_string(), "tasks", 3)).is_err());
}

#[test]
fn header_decodes_optional_coordinator_goal_and_task_mode_strictly() {
    let b = backend();
    let open = || b.mission_header("project", "mission").unwrap();

    // Omitted fields remain backward compatible.
    let base = header_row();
    let decoded = verified(open(), source(base.to_string(), "mission", 3)).unwrap();
    assert_eq!(decoded.root.template(), Template::Custom);
    assert_eq!(decoded.root.task_mode(), None);
    assert!(!decoded.root.coordinator_goal());

    // Explicit coordinatorGoal: true and taskMode: independent decode accurately.
    let mut enabled = base.clone();
    enabled["root"]["coordinatorGoal"] = json!(true);
    enabled["root"]["taskMode"] = json!("independent");
    enabled["root"]["template"] = json!("compare");
    let decoded = verified(open(), source(enabled.to_string(), "mission", 3)).unwrap();
    assert_eq!(decoded.root.template(), Template::Compare);
    assert_eq!(decoded.root.task_mode(), Some(TaskMode::Independent));
    assert!(decoded.root.coordinator_goal());

    // Explicit coordinatorGoal: false stays false.
    let mut disabled = base.clone();
    disabled["root"]["coordinatorGoal"] = json!(false);
    let decoded = verified(open(), source(disabled.to_string(), "mission", 3)).unwrap();
    assert!(!decoded.root.coordinator_goal());

    // Invalid non-boolean coordinatorGoal or unknown taskMode is rejected.
    let mut bad_goal = base.clone();
    bad_goal["root"]["coordinatorGoal"] = json!("yes");
    assert!(verified(open(), source(bad_goal.to_string(), "mission", 3)).is_err());

    let mut bad_mode = base;
    bad_mode["root"]["taskMode"] = json!("daily");
    assert!(verified(open(), source(bad_mode.to_string(), "mission", 3)).is_err());
}
