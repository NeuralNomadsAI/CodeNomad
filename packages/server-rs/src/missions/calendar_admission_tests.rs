//! Admission of event sources, followed conversations, explicit coordinators
//! and the independent task mode (`validate_config`).
use super::*;

fn user_config(launch: Value) -> Value {
    let selection = json!({"agent":"build","model":{"providerID":"fixture","id":"fixture"}});
    json!({"title":"Admission","objective":"Admit","template":"custom","taskMode":"native",
        "profiles":{"coordinator":selection,"roles":{"specialist":selection}},"watchedConversationIDs":[],"launch":launch})
}
fn admit(v: Value, creating: bool) -> Result<Value, Value> {
    let mut v = v;
    validate_config(&mut v, "/owned", &json!({"profileID":"profile"}), creating).map(|()| v).map_err(|e| e.1.0)
}

#[test]
fn event_sources_followed_conversations_coordinators_and_independent_mode_are_admitted() {
    let cron = json!({"kind":"cron","expression":"0 9 * * *","zone":"UTC"});
    let conditions = [
        json!({"kind":"schedule-success","missionID":"msn_source"}),
        json!({"kind":"mission-completed","missionID":"msn_source"}),
        json!({"kind":"branch-commits","directory":"/elsewhere","ref":"refs/heads/main"}),
        json!({"kind":"conversation-message","conversationID":"ses_source"}),
        json!({"kind":"files-changed","paths":["b.txt","a.txt"]}),
        json!({"kind":"github-notification"}),
        json!({"kind":"github-security-alert","repository":"owner/name"}),
        json!({"kind":"github-pull-request","repository":"owner/name","author":"someone"}),
        json!({"kind":"github-issue","repository":"owner/name"}),
        json!({"kind":"repository-activity","provider":"gitea","host":"forge.example","repository":"owner/name","event":"issue-created"}),
    ];
    for c in conditions {
        for launch in [json!({"when":[c.clone()]}), json!({"when":[cron.clone(), c.clone()]}),
            json!({"timing":{"kind":"every","intervalMs":900000},"condition":c.clone(),"ends":{"maxLaunches":null,"afterMs":null,"at":null}})] {
            let admitted = admit(user_config(launch.clone()), true).unwrap_or_else(|e| panic!("{launch}: {e}"));
            assert_eq!(admitted["roots"], json!([{"mode":"directory-only","directory":"/owned"}]));
        }
    }
    let mut config = user_config(json!({"when":[cron.clone()]}));
    config["watchedConversationIDs"] = json!(["ses_followed"]);
    config["coordinatorSessionID"] = json!("ses_coordinator");
    config["taskMode"] = json!("independent");
    let admitted = admit(config, true).unwrap();
    assert_eq!(admitted["coordinatorSessionID"], "ses_coordinator");
    assert_eq!(admitted["taskMode"], "independent");
    // A files-changed condition is stored in the reference normal form.
    let sorted = admit(user_config(json!({"when":[{"kind":"files-changed","paths":["b","a"]}]})), false).unwrap();
    assert_eq!(sorted["launch"]["when"][0]["paths"], json!(["a", "b"]));
}

#[test]
fn schedule_configurations_keep_the_reference_request_and_configuration_refusals() {
    let request = json!({"error":"Invalid Mission schedule request","code":"schedule-input-invalid"});
    let configuration = json!({"error":"Invalid Mission schedule configuration","code":"schedule-input-invalid"});
    let cron = json!({"kind":"cron","expression":"0 9 * * *","zone":"UTC"});
    // Field rules: the body schema.
    let mut carrier = user_config(json!({"when":[cron.clone()]}));
    carrier["coordinatorSessionID"] = json!("ses_cn_schedule_carrier");
    assert_eq!(admit(carrier, true).unwrap_err(), request);
    let mut duplicate = user_config(json!({"when":[cron.clone()]}));
    duplicate["watchedConversationIDs"] = json!(["ses_a", "ses_a"]);
    assert_eq!(admit(duplicate, false).unwrap_err(), request);
    assert_eq!(admit(user_config(json!({"when":[{"kind":"branch-commits","directory":"/owned","ref":"main"}]})), true).unwrap_err(), request);
    assert_eq!(admit(user_config(json!({"when":[{"kind":"files-changed","paths":["../up"]}]})), true).unwrap_err(), request);
    assert_eq!(admit(user_config(json!({"when":[]})), true).unwrap_err(), request, "Create requires a calendar");
    let mut author = user_config(json!({"when":[cron.clone()]}));
    author["coordinatorSelectionAuthor"] = json!({"coordinatorSessionID":"ses_author"});
    assert_eq!(admit(author, true).unwrap_err(), request, "server-owned field");
    // Object refinement: the whole schema.
    for source in [json!({"watched":true}), json!({"watched":false})] {
        let mut c = user_config(if source["watched"] == true { json!({"when":[cron.clone()]}) }
            else { json!({"when":[cron.clone(), {"kind":"conversation-message","conversationID":"ses_coordinator"}]}) });
        c["coordinatorSessionID"] = json!("ses_coordinator");
        if source["watched"] == true {
            c["watchedConversationIDs"] = json!(["ses_coordinator"]);
        }
        assert_eq!(admit(c, true).unwrap_err(), configuration, "coordinator is a source");
    }
    let mut once = user_config(json!({"when":[]}));
    once["coordinatorSessionID"] = json!("ses_coordinator");
    assert_eq!(admit(once, false).unwrap_err(), configuration, "one-time configure keeps no coordinator");
    let mut partial = user_config(json!({"when":[cron]}));
    partial["profiles"]["roles"]["specialist"] = json!({"agent":"build"});
    assert_eq!(admit(partial, true).unwrap_err(), configuration);
}
