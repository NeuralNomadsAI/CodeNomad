use super::*;
use crate::missions::codec::digest;

const ORDER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn observation() -> Value {
    json!({
        "context":{"id":"mission","projectID":"project","revision":9,"status":"active",
            "coordinatorSessionId":"coordinator","actors":[{"sessionId":"actor","title":"Léa 🦀",
                "location":{"directory":"/fixture"},"reportOwed":true,"callOpen":false}],
            "actorPage":{"order":ORDER,"offset":0,"end":1,"total":1},
            "discardedEvents":0,"controlUnavailable":false,"notificationUnavailable":false,"cleanupUnavailable":false},
        "coverage":"partial",
        "requests":{"state":"partial","items":[{"kind":"form","actorSessionId":"actor",
            "request":{"id":"form","sessionID":"child","title":"Question","fields":[]}}]},
        "activity":{"actors":[{"sessionId":"actor","state":"running"}],
            "family":{"state":"partial","members":[{"sessionId":"child","parentSessionId":"actor","actorSessionId":"actor","kind":"ordinary"}]}}
    })
}

fn read(row: Value, phase: &str) -> Result<Activity> {
    let mut backend = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
    backend.workspace = "workspace".into();
    let mut read = backend
        .mission_activity("project", "mission", 0, None)
        .unwrap();
    let row = row.to_string();
    let page = json!({"available":true,"version":1,"projectID":"project","source":"activity",
        "missionID":"mission","revision":9,"phase":phase,"observedAt":30,
        "discardedEvents":0,"controlUnavailable":false,"notificationUnavailable":false,"cleanupUnavailable":false,
        "page":{"digest":digest(std::slice::from_ref(&row)),"total":1,"pieces":[
            {"index":0,"offset":0,"characters":row.encode_utf16().count(),"text":row}]}});
    read.accept(page)?
        .ok_or_else(|| "missing observation".into())
}

#[test]
fn positive_partial_request_is_owned_and_distinct_from_execution() {
    let page = read(observation(), "observed").unwrap();
    assert_eq!(page.coverage, Coverage::Partial);
    assert_eq!(page.requests, Coverage::Partial);
    assert_eq!(page.actors[0].title, "Léa 🦀");
    assert_eq!(page.actors[0].state, ActorState::Running);
    assert_eq!(page.actors[0].request, Some(ActorState::Form));
    assert!(read(observation(), "context").is_err());
    let mut other = observation();
    other["requests"]["items"][0]["request"]["sessionID"] = json!("unowned");
    assert!(read(other, "observed").is_err());
}
