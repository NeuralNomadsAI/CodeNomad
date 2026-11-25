use super::*;
use crate::{files::test_http, workspace::RightPanelTab};
use serde_json::json;

const ORDER: &str = "Z9o1qhx0QOJajoRR0hwuPNcxx5rwfCUjOU-J6kgtbPE";
const HEADER: &str = r#"{"root":{"version":1,"id":"alpha","projectID":"fixture-project","projectCanonical":"/repo","title":"Owned mission","excerpt":"Owned mission objective 🦀","template":"custom","status":"active","coordinatorSessionId":"ses_fixture","revision":3,"createdAt":1,"updatedAt":3,"historyTruncated":false,"bodies":{}},"collections":{"actors":{"characters":2,"digest":"XukXOxtWTmGv0jWaiXwYC16oOHWpGihTffQgKq1LOqc","total":0,"array":true},"history":{"characters":2,"digest":"XukXOxtWTmGv0jWaiXwYC16oOHWpGihTffQgKq1LOqc","total":0,"array":true},"reports":{"characters":2,"digest":"XukXOxtWTmGv0jWaiXwYC16oOHWpGihTffQgKq1LOqc","total":0,"array":true}},"tasks":{"page":{"order":"Z9o1qhx0QOJajoRR0hwuPNcxx5rwfCUjOU-J6kgtbPE","offset":0,"end":1,"total":1,"reports":0,"counts":{"ready":1}},"pins":[],"reportPins":[],"version":"Z9o1qhx0QOJajoRR0hwuPNcxx5rwfCUjOU-J6kgtbPE"}}"#;
const TASKS: &str = r#"{"taskPage":{"order":"Z9o1qhx0QOJajoRR0hwuPNcxx5rwfCUjOU-J6kgtbPE","offset":0,"end":1,"total":1,"reports":0,"counts":{"ready":1}},"tasks":[{"id":"task-one","key":"task-one","title":"Owned task","role":"specialist","status":"ready","blockedBy":[],"order":0,"createdAt":1,"updatedAt":3,"dependents":0,"reportCount":0,"outstandingExecution":false}],"reports":[]}"#;
const RECEIPT: &str = r#"{"receiptID":"evt-actor","sessionID":"ses_fixture","acknowledgementState":"known","nativeAcknowledgement":{"missionID":"alpha","operationID":"op-fixture","sessionID":"ses_fixture","action":"pause","disposition":"interrupt-observed","interrupt":{"interrupted":true},"cancellations":[],"descendants":{"observed":2,"interrupted":1,"cancelled":0,"unconfirmed":1,"complete":false,"sessions":["ses-child-quiet","ses-child-pending"]}}}"#;

fn detail_page(source: &str, text: &str, digest: &str) -> serde_json::Value {
    let mut page = json!({
        "available":true,"version":1,"source":source,"projectID":"fixture-project","missionID":"alpha","revision":3,
        "discardedEvents":0,"controlUnavailable":false,"notificationUnavailable":false,"cleanupUnavailable":false,
        "page":{"digest":digest,"total":1,"pieces":[{"index":0,"offset":0,"characters":text.encode_utf16().count(),"text":text}]}
    });
    if source == "mission" {
        page["header"] = json!(true);
    }
    page
}

#[test]
fn project_observer_qualifies_changes_without_a_conversation_id() {
    crate::platform::block_on(async {
        let http = test_http::Http::new().await;
        let (notify, signal) = bounded(8);
        let wake: rune::Waker = std::sync::Arc::new(move || {
            let _ = notify.try_send(());
        });
        let (watch, worker) = codenomad_client::settings::PreferencesWatch::task(
            http.backend.clone(),
            Some("project-b"),
            wake,
        );
        crate::platform::spawn(worker);
        let stream = http.accept().await;
        assert!(stream.header.starts_with("GET /api/events?"));
        let body = ["project-a", "project-b"].map(|id| format!("data: {}\n\n", json!({
            "type":"instance.event","instanceId":id,
            "event":{"type":"rpc.codenomad.missions.changed","data":{"missionID":"alpha","revision":4}}
        }))).concat();
        stream.send(&format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()), body.as_bytes()).await;
        let events = test_http::wait(async {
            loop {
                signal.recv().await.unwrap();
                let (_, events) = watch.take_missions();
                if !events.is_empty() {
                    break events;
                }
            }
        })
        .await;
        assert_eq!(
            events,
            vec![
                codenomad_client::transport::WorkspaceEvent::MissionChanged {
                    workspace_id: "project-b".into(),
                    mission_id: "alpha".into(),
                    revision: 4,
                }
            ]
        );
        let stopped = watch.stop();
        assert!(test_http::wait(stopped.recv()).await.is_err());
    });
}

#[test]
fn mounted_missions_reads_the_active_occurrence_only_while_visible() {
    crate::platform::block_on(async {
        let http = test_http::Http::new().await;
        let backend = http.backend.clone();
        let identity = tokio::spawn(async move { backend.attest_server().await });
        let meta = http.accept().await;
        assert!(meta.header.starts_with("GET /api/meta "));
        meta.reply(200, json!({"apiContract":1,"serverId":"fixture-server"}))
            .await;
        assert_eq!(
            test_http::wait(identity).await.unwrap().unwrap(),
            "fixture-server"
        );
        let (wake, signal) = bounded(8);
        let mut s = init();
        crate::gallery::shell::fixture(&mut s);
        s.wake = std::sync::Arc::new(move || {
            let _ = wake.try_send(());
        });
        let mut ui = Ui::new();
        ui.ready = true;
        s.workspace = Some(ui);
        let launcher = s.screen.launcher_mut().unwrap();
        launcher.connection = Some(http.backend.clone());
        launcher.server_id = Some("fixture-server".into());
        let project = launcher.project.clone().unwrap();
        opened(&mut s, &project);
        let mut rt =
            rune::Runtime::new(s, crate::view, (1400.0, 880.0), rune::Env::new(false, 1.0));

        fn tick(rt: &mut rune::Runtime<State>) {
            rt.update(|s, tx| {
                let mut ui = s.workspace.take().unwrap();
                panel_state::poll_missions(&mut ui, s, tx);
                s.workspace = Some(ui);
                tx.instant();
            });
            for _ in 0..8 {
                rt.frame(1.0 / 60.0);
            }
        }
        async fn until(
            rt: &mut rune::Runtime<State>,
            signal: &codenomad_client::Receiver<()>,
            ready: impl Fn(&rune::Runtime<State>) -> bool,
        ) {
            test_http::wait(async {
                tick(rt);
                while !ready(rt) {
                    signal.recv().await.unwrap();
                    tick(rt);
                }
            })
            .await;
        }
        fn click(rt: &mut rune::Runtime<State>, key: &str) {
            let (x, y) = rt.find(key).unwrap_or_else(|| panic!("{key}"));
            rt.pointer_down(x, y);
            rt.pointer_up(x, y);
            rt.frame(1.0 / 60.0);
            tick(rt);
        }

        for _ in 0..8 {
            rt.frame(1.0 / 60.0);
        }
        assert!(rt.state.shell.visible(1), "right panel laid out");
        tick(&mut rt);
        let meta = http.accept().await;
        assert!(meta.header.starts_with("GET /api/meta "));
        meta.reply(503, json!({})).await;
        let meta = http.accept().await;
        assert!(meta.header.starts_with("GET /api/meta "));
        meta.reply(200, json!({"capabilities":["missions"]})).await;
        until(&mut rt, &signal, |rt| {
            rt.find("right-panel-tab-2").is_some()
        })
        .await;
        assert!(rt.find("missions-panel").is_none());
        http.quiet().await;

        click(&mut rt, "right-panel-tab-2");
        assert_eq!(right_panel_tab(&rt.state), RightPanelTab::Missions);
        for _ in 0..2 {
            let req = http.accept().await;
            assert!(
                req.header
                    .starts_with("POST /api/workspaces/header-windows/missions/panel-page ")
            );
            let source = req.body["source"].as_str().unwrap();
            let text = r#"{"id":"alpha","title":"Alpha 🦀","objective":"Fixture","status":"active","coordinatorSessionId":"ses_fixture","actorCount":1,"updatedAt":1,"revision":1}"#;
            let (order, pieces) = if source == "summaries" {
                assert_eq!(req.body["initial"], true);
                (
                    "pQZDmPIGPngSQdn6a5560UWeBbykj_5zv2m5P6NiqW4",
                    vec![
                        json!({"index":0,"offset":0,"characters":text.encode_utf16().count(),"text":text}),
                    ],
                )
            } else {
                assert_eq!(source, "cleanups");
                let text = r#"{"missionID":"pending","deletionID":"pending-delete","requestID":"request-pending","expectedRevision":4,"deleteManagedSessions":true,"objective":"Only document cleanup","removed":0,"retained":0,"pending":0,"reasons":[],"createdAt":1.2,"documentPending":true}"#;
                (
                    "avT82Y_MBECsXLRw2uK9T35u7Z3kBrjXEox3HpLTKRQ",
                    vec![json!({"index":0,"offset":0,"characters":text.len(),"text":text})],
                )
            };
            let total = pieces.len();
            let mut page = json!({"available":true,"version":1,"source":source,"projectID":"fixture-project",
                "discardedEvents":0,"controlUnavailable":false,"notificationUnavailable":false,"cleanupUnavailable":false,
                "window":{"order":order,"offset":0,"end":total,"total":total},
                "page":{"digest":order,"total":total,"pieces":pieces}});
            if source == "summaries" {
                page["finishHighWater"] = 0.into();
            }
            req.reply(200, page).await;
        }
        until(&mut rt, &signal, |rt| {
            let tree = rt.accessibility_json().to_string();
            tree.contains("Alpha 🦀")
                && tree.contains(crate::strings::t("missions.cleanup.documentPending"))
        })
        .await;
        click(&mut rt, "mission-row-alpha");
        let header = http.accept().await;
        assert_eq!(
            header.body,
            json!({"source":"mission","missionID":"alpha","header":true})
        );
        let header_text = format!(
            "{}{}",
            HEADER.strip_suffix('}').unwrap(),
            r#","control":{"id":"op-fixture","requestID":"pause-request","action":"pause","expectedRevision":2,"completedRevision":3,"pending":0,"receipts":1,"unconfirmedReceipts":0,"partialDescendants":1}}"#
        );
        header
            .reply(
                200,
                detail_page(
                    "mission",
                    &header_text,
                    "sroHj1qVqLjPp9aSmuG0e5eUKhRU1N7fV1TWCHtG2ZA",
                ),
            )
            .await;
        let tasks = http.accept().await;
        assert_eq!(
            tasks.body,
            json!({"source":"tasks","task":{"missionID":"alpha","offset":0,"order":ORDER}})
        );
        assert!(
            !rt.accessibility_json()
                .to_string()
                .contains("Owned mission objective")
        );
        tasks
            .reply(
                200,
                detail_page(
                    "tasks",
                    TASKS,
                    "L2wfoi8OxmyX4OB8WULLBV48Yr4h1vfWr_f87GB8ek4",
                ),
            )
            .await;
        until(&mut rt, &signal, |rt| {
            let tree = rt.accessibility_json().to_string();
            tree.contains("Owned mission objective 🦀") && tree.contains("Owned task")
        })
        .await;
        let activity = http.accept().await;
        assert_eq!(
            activity.body,
            json!({"source":"activity","missionID":"alpha","actorOffset":0})
        );
        activity
            .reply(
                503,
                json!({"available":false,"reason":"plugin-unavailable","missions":[]}),
            )
            .await;
        test_http::wait(signal.recv()).await.unwrap();
        tick(&mut rt);
        click(&mut rt, "control.receipts");
        let receipts = http.accept().await;
        assert_eq!(
            receipts.body,
            json!({"source":"mission","missionID":"alpha","field":"control","part":"receipts","window":{"offset":0}})
        );
        let digest = "rP23EDXdvL_epC0d9GiNxzXO5BekTQKgEj_v548s3pA";
        let mut page = detail_page("mission", RECEIPT, digest);
        page.as_object_mut().unwrap().remove("header");
        page["field"] = json!("control");
        page["part"] = json!("receipts");
        page["window"] = json!({"order":digest,"offset":0,"end":1,"total":1});
        receipts.reply(200, page).await;
        until(&mut rt, &signal, |rt| {
            rt.find("receipt-evt-actor").is_some()
        })
        .await;
        let has_descendant = |rt: &rune::Runtime<State>| {
            rt.accessibility_json()
                .to_string()
                .contains("ses-child-pending")
        };
        assert!(!has_descendant(&rt));
        click(&mut rt, "receipt-evt-actor");
        assert!(has_descendant(&rt));
        click(&mut rt, "receipt-evt-actor");
        assert!(!has_descendant(&rt));
        let ui = rt.state.workspace.as_ref().unwrap();
        assert!(
            matches!(&ui.entries[ui.active].saved,Tab::Workspace(w) if w.view.selected_mission.as_deref()==Some("alpha"))
        );
        // A cached stream from another project cannot substitute for B's observer.
        let (conversation_a, incoming) = bounded(1);
        rt.update(move |s, _| {
            let active = Cache::take(s);
            s.incoming = Some(incoming);
            let mut other = entry("tab-a".into(), Tab::Blank);
            other.cache = Some(Cache::take(s));
            active.apply(s);
            s.workspace.as_mut().unwrap().entries.push(other);
            assert!(has_conversation_stream(s));
            assert_eq!(mission_observation_project(s), Some("header-windows"));
        });

        let changed = codenomad_client::transport::WorkspaceEvent::MissionChanged {
            workspace_id: "header-windows".into(),
            mission_id: "alpha".into(),
            revision: 4,
        };
        rt.update(|s, _| mission_event(s, Some(&changed)));
        tick(&mut rt);
        let mut detail = false;
        for _ in 0..4 {
            let req = http.accept().await;
            detail |= req.body == json!({"source":"mission","missionID":"alpha","header":true});
            req.reply(
                503,
                json!({"available":false,"reason":"plugin-unavailable","missions":[]}),
            )
            .await;
        }
        assert!(detail, "Journal changes reread the selected header");
        tick(&mut rt);
        rt.update(|s, _| {
            s.workspace.as_mut().unwrap().clock = 2.0;
            mission_event(s, None);
        });
        tick(&mut rt);
        let mut detail = false;
        for _ in 0..4 {
            let req = http.accept().await;
            detail |= req.body["source"] == "mission";
            req.reply(
                503,
                json!({"available":false,"reason":"plugin-unavailable","missions":[]}),
            )
            .await;
        }
        assert!(detail, "Reconnection rereads the selected header");
        tick(&mut rt);
        click(&mut rt, "right-panel-tab-0");
        assert!(rt.find("missions-panel").is_none());
        assert!(mission_observation_project(&rt.state).is_none());
        rt.update(|s, _| {
            mission_event(s, Some(&changed));
            mission_event(s, None);
        });
        tick(&mut rt);
        http.quiet().await;
        click(&mut rt, "right-panel-tab-2");
        let summaries = http.accept().await;
        let cleanups = http.accept().await;
        assert!(rt.find("missions-panel").is_some());
        rt.update(|s, tx| {
            assert!(crate::settings::conversation_authentication(
                s,
                codenomad_client::transport::Authentication {
                    backend: http.backend.clone(),
                    confirmed: true,
                },
            ));
            tx.instant();
        });
        tick(&mut rt);
        assert!(
            rt.state.shell.visible(1),
            "the dock geometry still claims space"
        );
        assert!(rt.find("missions-panel").is_none());
        assert!(rt.find("server-password").is_some());
        summaries.disconnected().await;
        cleanups.disconnected().await;
        http.quiet().await;
        assert_eq!(right_panel_tab(&rt.state), RightPanelTab::Missions);
        drop(conversation_a);
    });
}

#[test]
fn parked_tab_disconnect_marks_own_missions_panel_offline_and_hidden_deletions_forget_cached_rows()
{
    crate::platform::block_on(async {
        let http = test_http::Http::new().await;
        let backend = http.backend.clone();
        let attest = std::thread::spawn(move || {
            crate::platform::block_on(async {
                let meta = http.accept().await;
                meta.reply(200, json!({"apiContract": 1, "serverId": "server"}))
                    .await;
                http
            })
        });
        backend.attest_server().await.unwrap();
        let http = attest.join().unwrap();
        let wake: codenomad_client::Wake = std::sync::Arc::new(|| {});
        let mut s = crate::init();
        crate::settings::fixture_mission_delete_sessions(&s, true);
        let mut active_entry = entry("tab-active".into(), Tab::Workspace(workspace("alpha", "")));
        active_entry.binding = Some(backend.clone());
        active_entry.project = Some(codenomad_client::catalog::Project {
            id: backend.workspace.clone(),
            path: "/fixture".into(),
        });
        let mut active_panel = crate::missions::Panel::new(
            backend.clone(),
            Some("project".into()),
            Default::default(),
            wake.clone(),
        );
        active_panel.seed_summary_for_test("msn-del");
        active_entry.missions = Some(active_panel);

        let mut parked_entry = entry("tab-parked".into(), Tab::Blank);
        let parked_panel = crate::missions::Panel::new(
            backend.clone(),
            Some("project".into()),
            Default::default(),
            wake.clone(),
        );
        parked_entry.missions = Some(parked_panel);
        let (tx_parked, rx_parked) = bounded(4);
        let active_cache = Cache::take(&mut s);
        s.incoming = Some(rx_parked);
        parked_entry.cache = Some(Cache::take(&mut s));
        active_cache.apply(&mut s);

        let mut ui = Ui::new();
        ui.entries = vec![active_entry, parked_entry];
        ui.active = 0;
        // Send ConnectionLost on the parked tab's stream.
        tx_parked
            .send(codenomad_client::transport::Event::ConnectionLost)
            .await
            .unwrap();
        let mut tx = rune::Tx::default();
        assert!(super::super::observation::poll_cached(
            &mut s, &mut ui, None, &mut tx
        ));
        // Active tab's delete preference and online state stay untouched, while the parked tab's
        // own Missions panel records offline.
        assert_eq!(crate::settings::mission_delete_sessions(&s), Some(true));
        assert!(ui.entries[0].missions.as_ref().unwrap().online());
        assert!(!ui.entries[1].missions.as_ref().unwrap().online());
        drop(tx_parked);

        // Even while Missions is hidden (Tab::Blank / right panel closed), a confirmed deletion
        // removes the deleted mission from cached summaries and clears its selection.
        ui.mission_lifecycle.start_delete_for_test(
            "tab-active",
            &http.backend,
            "project",
            "msn-del",
            7,
            wake,
        );
        let del = http.accept().await;
        del.reply(200, json!({"deleted": true})).await;
        let mut settled = false;
        for _ in 0..100 {
            if super::super::panel_state::poll_missions(&mut ui, &s, &mut tx)
                && ui.entries[0]
                    .missions
                    .as_ref()
                    .is_some_and(|p| !p.has_summary_for_test("msn-del"))
            {
                settled = true;
                break;
            }
            crate::platform::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            settled,
            "confirmed deletion must forget cached summaries even when Missions panel is hidden"
        );
        assert!(ui.entries[0].missions.as_ref().unwrap().selected.is_none());
    });
}

#[test]
fn parked_tab_clears_saved_selection_on_tombstone_and_replacement_panel_inherits_offline() {
    crate::platform::block_on(async {
        let http = test_http::Http::new().await;
        let backend = http.backend.clone();
        let attest = std::thread::spawn(move || {
            crate::platform::block_on(async {
                let meta = http.accept().await;
                meta.reply(200, json!({"apiContract": 1, "serverId": "server"}))
                    .await;
                http
            })
        });
        backend.attest_server().await.unwrap();
        let http = attest.join().unwrap();
        let wake: codenomad_client::Wake = std::sync::Arc::new(|| {});
        let s = crate::init();
        let mut active_entry = entry("tab-active".into(), Tab::Workspace(workspace("alpha", "")));
        active_entry.binding = Some(backend.clone());
        active_entry.project = Some(codenomad_client::catalog::Project {
            id: backend.workspace.clone(),
            path: "/fixture".into(),
        });
        let mut parked_saved = workspace("alpha", "");
        parked_saved.view.selected_mission = Some("msn-tomb".into());
        let mut parked_entry = entry("tab-parked".into(), Tab::Workspace(parked_saved));
        let mut parked_panel = crate::missions::Panel::new(
            backend.clone(),
            Some("project".into()),
            Default::default(),
            wake.clone(),
        );
        parked_panel.seed_summary_for_test("msn-tomb");
        parked_entry.missions = Some(parked_panel);

        let mut ui = Ui::new();
        ui.entries = vec![active_entry, parked_entry];
        ui.active = 0;

        // 1. Replacement panel created while the preference stream is offline starts offline.
        crate::settings::set_stream_online(&s, false);
        let mut tx = rune::Tx::default();
        super::super::panel_state::poll_missions(&mut ui, &s, &mut tx);
        assert!(
            !ui.entries[0].missions.as_ref().unwrap().online(),
            "replacement panel created while stream is offline must start offline"
        );

        // 2. A 503 cleanup-pending reconciled as a tombstone (no live mission card) clears
        // both the parked panel's live selection and its persisted saved.view.selected_mission.
        ui.mission_lifecycle.start_delete_for_test(
            "tab-active",
            &http.backend,
            "project",
            "msn-tomb",
            7,
            wake,
        );
        let del = http.accept().await;
        let request_id = del.body["requestId"].as_str().unwrap().to_owned();
        del.reply(503, json!({"code": "cleanup-pending"})).await;
        let rec = http.accept().await;
        rec.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "cleanups": [{
                    "missionID": "msn-tomb", "deletionID": "del-tomb", "requestID": request_id,
                    "expectedRevision": 7, "deleteManagedSessions": false,
                    "objective": "Tomb", "createdAt": 1, "removed": 0, "retained": 0,
                    "pending": 1, "reasons": [], "documentPending": false
                }]
            }),
        )
        .await;
        let mut cleared = false;
        for _ in 0..100 {
            super::super::panel_state::poll_missions(&mut ui, &s, &mut tx);
            if matches!(
                &ui.entries[1].saved,
                Tab::Workspace(saved) if saved.view.selected_mission.is_none()
            ) {
                cleared = true;
                break;
            }
            crate::platform::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            cleared,
            "tombstoned mission must clear saved.view.selected_mission on parked tabs"
        );
        assert!(ui.entries[1].missions.as_ref().unwrap().selected.is_none());

        // 3. A confirmed direct deletion adopts its authoritative settled cleanup receipt on
        // hidden and parked panels so reopening does not show the stale pending row.
        let pending_cleanup: codenomad_client::missions::Cleanup = serde_json::from_value(json!({
            "missionID": "msn-bg", "deletionID": "del-bg", "requestID": "req-bg",
            "expectedRevision": 4, "deleteManagedSessions": true,
            "objective": "Background", "createdAt": 1, "removed": 0, "retained": 0,
            "pending": 1, "reasons": [], "documentPending": false
        }))
        .unwrap();
        ui.entries[1]
            .missions
            .as_mut()
            .unwrap()
            .accept_cleanups_for_test(vec![pending_cleanup]);
        assert!(
            !ui.entries[1]
                .missions
                .as_ref()
                .unwrap()
                .has_settled_cleanup_for_test("del-bg")
        );
        ui.mission_lifecycle.start_delete_for_test(
            "tab-active",
            &http.backend,
            "project",
            "msn-bg",
            4,
            std::sync::Arc::new(|| {}),
        );
        let del_bg = http.accept().await;
        let bg_req_id = del_bg.body["requestId"].as_str().unwrap().to_owned();
        del_bg
            .reply(
                200,
                json!({
                    "deleted": true,
                    "cleanup": {
                        "missionID": "msn-bg", "deletionID": "del-bg", "requestID": bg_req_id,
                        "expectedRevision": 4, "deleteManagedSessions": false,
                        "objective": "Background", "createdAt": 1, "removed": 1, "retained": 0,
                        "pending": 0, "reasons": [], "documentPending": false
                    }
                }),
            )
            .await;
        let mut adopted = false;
        for _ in 0..100 {
            super::super::panel_state::poll_missions(&mut ui, &s, &mut tx);
            if ui.entries[1]
                .missions
                .as_ref()
                .is_some_and(|p| p.has_settled_cleanup_for_test("del-bg"))
            {
                adopted = true;
                break;
            }
            crate::platform::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            adopted,
            "confirmed direct deletion must adopt authoritative settled cleanup receipt on parked panels"
        );
    });
}

#[test]
fn parked_tab_preserves_active_retry_error_and_reauth_carries_document_pending_and_same_poll_delete_fences_retry()
 {
    crate::platform::block_on(async {
        let http = test_http::Http::new().await;
        let backend = http.backend.clone();
        let attest = std::thread::spawn(move || {
            crate::platform::block_on(async {
                let meta = http.accept().await;
                meta.reply(200, json!({"apiContract": 1, "serverId": "server"}))
                    .await;
                http
            })
        });
        backend.attest_server().await.unwrap();
        let http = attest.join().unwrap();
        let wake: codenomad_client::Wake = std::sync::Arc::new(|| {});
        let s = crate::init();

        let mut active_saved = workspace("alpha", "");
        active_saved.view.right_panel = RightPanelTab::Missions;
        active_saved.view.selected_mission = Some("msn-a".into());
        let mut active_entry = entry("tab-active".into(), Tab::Workspace(active_saved));
        active_entry.binding = Some(backend.clone());
        active_entry.project = Some(codenomad_client::catalog::Project {
            id: backend.workspace.clone(),
            path: "/fixture".into(),
        });
        let active_panel = crate::missions::Panel::new(
            backend.clone(),
            Some("project".into()),
            Default::default(),
            wake.clone(),
        );
        let pending_b_json = json!({
            "missionID": "msn-b", "deletionID": "del-b", "requestID": "req-b",
            "expectedRevision": 2, "deleteManagedSessions": false,
            "objective": "Pending B", "createdAt": 1, "removed": 0, "retained": 0,
            "pending": 1, "reasons": [], "documentPending": false
        });
        let pending_b: codenomad_client::missions::Cleanup =
            serde_json::from_value(pending_b_json.clone()).unwrap();
        let doc_only: codenomad_client::missions::Cleanup = serde_json::from_value(json!({
            "missionID": "msn-doc", "deletionID": "del-doc", "requestID": "req-doc",
            "expectedRevision": 3, "deleteManagedSessions": false,
            "objective": "Doc only", "createdAt": 1, "removed": 0, "retained": 0,
            "pending": 0, "reasons": [], "documentPending": true
        }))
        .unwrap();
        active_entry.missions = Some(active_panel);

        // Parked tab on the same workspace with an EMPTY cleanup cache.
        let mut parked_entry = entry("tab-parked".into(), Tab::Workspace(workspace("alpha", "")));
        let parked_panel = crate::missions::Panel::new(
            backend.clone(),
            Some("project".into()),
            Default::default(),
            wake.clone(),
        );
        parked_entry.missions = Some(parked_panel);

        let mut ui = Ui::new();
        ui.entries = vec![active_entry, parked_entry];
        ui.active = 0;
        let sc = ui.entries[0]
            .missions
            .as_ref()
            .unwrap()
            .cleanup_scope()
            .unwrap();
        // Force active panel visible/supported without dispatching probe HTTP.
        let mut tx = rune::Tx::default();
        ui.entries[0].missions.as_mut().unwrap().show(true);
        let empty_digest = "XukXOxtWTmGv0jWaiXwYC16oOHWpGihTffQgKq1LOqc";
        let empty_panel_page = |req: &test_http::Request| {
            let source = req.body["source"]
                .as_str()
                .unwrap_or("summaries")
                .to_owned();
            let mut page = json!({
                "available": true, "version": 1, "source": source, "projectID": "project",
                "discardedEvents": 0, "controlUnavailable": false,
                "notificationUnavailable": false, "cleanupUnavailable": false,
                "window": {"order": empty_digest, "offset": 0, "end": 0, "total": 0},
                "page": {"digest": empty_digest, "total": 0, "pieces": []}
            });
            if source == "summaries" {
                page["finishHighWater"] = json!(0);
            }
            page
        };
        for _ in 0..2 {
            let req = http.accept().await;
            let page = empty_panel_page(&req);
            req.reply(200, page).await;
        }
        for _ in 0..50 {
            ui.entries[0].missions.as_mut().unwrap().poll();
            crate::platform::sleep(std::time::Duration::from_millis(5)).await;
        }
        // Seed cleanup rows after initial empty show refresh (no mission selected yet so step 1
        // refresh dispatches only summaries + cleanups).
        assert!(
            ui.entries[0]
                .missions
                .as_mut()
                .unwrap()
                .accept_cleanups_for_test(vec![pending_b.clone(), doc_only.clone()])
        );

        // 1. Parked tab with empty cache must NOT erase active tab's 409 cleanup retry error.
        ui.entries[0].missions.as_mut().unwrap().retry_cleanup(
            &mut ui.mission_lifecycle,
            &sc,
            pending_b.clone(),
        );
        let pre = http.accept().await;
        pre.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "cleanups": [pending_b_json.clone()]
            }),
        )
        .await;
        let del = http.accept().await;
        del.reply(409, json!({"code": "request-conflict"})).await;
        let after = http.accept().await;
        after
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                    "cleanups": [pending_b_json.clone()]
                }),
            )
            .await;
        let mut saw_error = false;
        for _ in 0..100 {
            let deletes = ui.mission_lifecycle.poll_deletes();
            let finished = ui.mission_lifecycle.poll_after_deletes();
            if deletes.changed() || finished.changed() {
                ui.entries[0].missions.as_mut().unwrap().settle_controls(
                    "tab-active",
                    &mut ui.mission_lifecycle,
                    &finished,
                );
                ui.entries[1]
                    .missions
                    .as_mut()
                    .unwrap()
                    .apply_background_deletions(&mut ui.mission_lifecycle, &finished);
                saw_error = true;
                break;
            }
            crate::platform::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(saw_error);
        assert_eq!(
            ui.mission_lifecycle.cleanup_error_for_test(&sc),
            Some("missions.cleanup.error.requestConflict"),
            "empty parked tab must not erase the active tab's cleanup retry error"
        );
        // Drain the two panel-page refresh requests triggered by settle_controls above.
        for _ in 0..2 {
            let req = http.accept().await;
            assert!(
                req.header.contains("/missions/panel-page"),
                "expected panel-page refresh, got: {}",
                req.header
            );
            let page = empty_panel_page(&req);
            req.reply(200, page).await;
        }
        for _ in 0..50 {
            ui.entries[0].missions.as_mut().unwrap().poll();
            crate::platform::sleep(std::time::Duration::from_millis(5)).await;
        }
        ui.entries[0]
            .missions
            .as_mut()
            .unwrap()
            .seed_summary_for_test("msn-a");
        assert!(
            ui.entries[0]
                .missions
                .as_mut()
                .unwrap()
                .accept_cleanups_for_test(vec![pending_b.clone(), doc_only.clone()])
        );

        // 2. Direct delete A clearing selection in phase 1 leaves unrelated cleanup retry B's
        // GET-only settlement live in phase 2 of the SAME poll_missions cycle.
        ui.mission_lifecycle.start_delete_for_test(
            "tab-active",
            &http.backend,
            "project",
            "msn-a",
            7,
            wake.clone(),
        );
        ui.entries[0].missions.as_mut().unwrap().retry_cleanup(
            &mut ui.mission_lifecycle,
            &sc,
            pending_b.clone(),
        );
        let mut del_a = None;
        let mut get_b = None;
        while del_a.is_none() || get_b.is_none() {
            let req = http.accept().await;
            if req.header.starts_with("DELETE ") && del_a.is_none() {
                del_a = Some(req);
            } else if req.header.starts_with("GET ") && get_b.is_none() {
                get_b = Some(req);
            } else if req.header.contains("/missions/panel-page") {
                let page = empty_panel_page(&req);
                req.reply(200, page).await;
            } else {
                panic!("unexpected request in step 2: {}", req.header);
            }
        }
        // Complete both before polling: A succeeds, B returns a GET-only settled receipt.
        del_a.unwrap().reply(200, json!({"deleted": true})).await;
        let mut settled_b = pending_b_json;
        settled_b["pending"] = json!(0);
        settled_b["removed"] = json!(1);
        get_b
            .unwrap()
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 3,
                    "cleanups": [settled_b]
                }),
            )
            .await;
        // Wait for both HTTP responses to land in their channels, then run phase 1 + phase 2.
        crate::platform::sleep(std::time::Duration::from_millis(80)).await;
        let deletes = ui.mission_lifecycle.poll_deletes();
        assert!(deletes.changed());
        ui.entries[0].missions.as_mut().unwrap().settle_controls(
            "tab-active",
            &mut ui.mission_lifecycle,
            &deletes,
        );
        assert!(ui.entries[0].missions.as_ref().unwrap().selected.is_none());
        let after_del = ui.mission_lifecycle.poll_after_deletes();
        ui.entries[0].missions.as_mut().unwrap().settle_controls(
            "tab-active",
            &mut ui.mission_lifecycle,
            &after_del,
        );
        assert!(
            ui.entries[0]
                .missions
                .as_ref()
                .unwrap()
                .has_settled_cleanup_for_test("del-b"),
            "unrelated cleanup row B must still settle even after mission A's deletion clears selection in the same poll"
        );

        // 3. Same-workspace reauthentication carries passively learned documentPending: true.
        let mut renewed_backend =
            crate::backend::Backend::unauthenticated(&http.backend.base).unwrap();
        renewed_backend.workspace = http.backend.workspace.clone();
        let attest2 = {
            let b = renewed_backend.clone();
            tokio::spawn(async move { b.attest_server().await })
        };
        loop {
            let req = http.accept().await;
            if req.header.contains("/api/meta") {
                req.reply(200, json!({"apiContract": 1, "serverId": "server"}))
                    .await;
                break;
            }
            if req.header.contains("/missions/panel-page") {
                let page = empty_panel_page(&req);
                let _ = req.try_reply(200, page).await;
            } else {
                panic!("unexpected request in step 3: {}", req.header);
            }
        }
        test_http::wait(attest2).await.unwrap().unwrap();
        ui.entries[0].binding = Some(renewed_backend);
        super::super::panel_state::poll_missions(&mut ui, &s, &mut tx);
        let mut doc_omitted = doc_only;
        doc_omitted.document_pending = None;
        assert!(
            ui.entries[0]
                .missions
                .as_mut()
                .unwrap()
                .accept_cleanups_for_test(vec![doc_omitted])
        );
        assert!(
            !ui.entries[0]
                .missions
                .as_ref()
                .unwrap()
                .has_settled_cleanup_for_test("del-doc"),
            "passively learned documentPending: true must survive same-workspace reauthentication"
        );
    });
}

#[test]
fn same_poll_document_pending_page_blocks_bare_delete_settlement() {
    crate::platform::block_on(async {
        let http = test_http::Http::new().await;
        let backend = http.backend.clone();
        let attest = std::thread::spawn(move || {
            crate::platform::block_on(async {
                let meta = http.accept().await;
                meta.reply(200, json!({"apiContract": 1, "serverId": "server"}))
                    .await;
                http
            })
        });
        backend.attest_server().await.unwrap();
        let http = attest.join().unwrap();
        let wake: codenomad_client::Wake = std::sync::Arc::new(|| {});
        let mut s = crate::init();
        let mut tx = rune::Tx::default();
        crate::gallery::shell::fixture(&mut s);
        if !crate::shell::right_panel_visible(&s) {
            crate::shell::toggle_panel(&mut s, 1, &mut tx);
        }
        assert!(crate::shell::right_panel_visible(&s));

        let mut saved = workspace("alpha", "");
        saved.view.right_panel = RightPanelTab::Missions;
        saved.view.selected_mission = Some("msn-bare".into());
        let mut active_entry = entry("tab-active".into(), Tab::Workspace(saved));
        active_entry.binding = Some(backend.clone());
        active_entry.project = Some(codenomad_client::catalog::Project {
            id: backend.workspace.clone(),
            path: "/fixture".into(),
        });
        let mut panel = crate::missions::Panel::new(
            backend.clone(),
            Some("project".into()),
            Default::default(),
            wake.clone(),
        );
        panel.show(true);
        let empty_digest = "XukXOxtWTmGv0jWaiXwYC16oOHWpGihTffQgKq1LOqc";
        for _ in 0..2 {
            let req = http.accept().await;
            let source = req.body["source"]
                .as_str()
                .unwrap_or("summaries")
                .to_owned();
            let mut page = json!({
                "available": true, "version": 1, "source": source, "projectID": "project",
                "discardedEvents": 0, "controlUnavailable": false,
                "notificationUnavailable": false, "cleanupUnavailable": false,
                "window": {"order": empty_digest, "offset": 0, "end": 0, "total": 0},
                "page": {"digest": empty_digest, "total": 0, "pieces": []}
            });
            if source == "summaries" {
                page["finishHighWater"] = json!(0);
            }
            req.reply(200, page).await;
        }
        for _ in 0..50 {
            panel.poll();
            crate::platform::sleep(std::time::Duration::from_millis(5)).await;
        }
        panel.seed_summary_for_test("msn-bare");
        let sc = panel.cleanup_scope().unwrap();
        active_entry.missions = Some(panel);

        let mut ui = Ui::new();
        ui.entries = vec![active_entry];
        ui.active = 0;

        // Launch DELETE (deleteManagedSessions: false) and hold it.
        ui.mission_lifecycle.start_delete_for_test(
            "tab-active",
            &http.backend,
            "project",
            "msn-bare",
            7,
            wake.clone(),
        );
        let del_req = http.accept().await;
        assert!(del_req.header.starts_with("DELETE "));
        let request_id = del_req.body["requestId"].as_str().unwrap().to_owned();

        // Trigger directory refresh so a cleanups page containing the exact documentPending: true
        // tombstone AND the bare 200 {deleted: true} land before a single poll_missions call.
        ui.entries[0].missions.as_mut().unwrap().refresh_for_test();
        let row_json = json!({
            "missionID": "msn-bare", "deletionID": "del-bare", "requestID": request_id,
            "expectedRevision": 7, "deleteManagedSessions": false,
            "objective": "Bare", "createdAt": 1, "removed": 0, "retained": 0,
            "pending": 0, "reasons": [], "documentPending": true
        });
        let row_text = serde_json::to_string(&row_json).unwrap();
        let row_digest = utf16_array_digest(std::slice::from_ref(&row_text));
        let sum_json = json!({
            "id": "msn-bare", "title": "msn-bare", "objective": "msn-bare",
            "status": "active", "coordinatorSessionId": "ses_c", "actorCount": 1,
            "updatedAt": 1, "revision": 7
        });
        let sum_text = serde_json::to_string(&sum_json).unwrap();
        let sum_digest = utf16_array_digest(std::slice::from_ref(&sum_text));
        for _ in 0..2 {
            let req = http.accept().await;
            let source = req.body["source"].as_str().unwrap();
            if source == "cleanups" {
                req.reply(
                    200,
                    json!({
                        "available": true, "version": 1, "source": "cleanups", "projectID": "project",
                        "discardedEvents": 0, "controlUnavailable": false,
                        "notificationUnavailable": false, "cleanupUnavailable": false,
                        "window": {"order": row_digest, "offset": 0, "end": 1, "total": 1},
                        "page": {"digest": row_digest, "total": 1, "pieces": [
                            {"index": 0, "offset": 0, "characters": row_text.encode_utf16().count(), "text": row_text}
                        ]}
                    }),
                )
                .await;
            } else {
                req.reply(
                    200,
                    json!({
                        "available": true, "version": 1, "source": "summaries", "projectID": "project",
                        "finishHighWater": 0,
                        "discardedEvents": 0, "controlUnavailable": false,
                        "notificationUnavailable": false, "cleanupUnavailable": false,
                        "window": {"order": sum_digest, "offset": 0, "end": 1, "total": 1},
                        "page": {"digest": sum_digest, "total": 1, "pieces": [
                            {"index": 0, "offset": 0, "characters": sum_text.encode_utf16().count(), "text": sum_text}
                        ]}
                    }),
                )
                .await;
            }
        }
        // Reply bare {deleted: true} without cleanup receipt; wait for both to queue, then ONE poll.
        del_req.reply(200, json!({"deleted": true})).await;
        crate::platform::sleep(std::time::Duration::from_millis(80)).await;
        super::super::panel_state::poll_missions(&mut ui, &s, &mut tx);

        assert_eq!(
            ui.entries[0].missions.as_ref().unwrap().selected.as_deref(),
            Some("msn-bare"),
            "bare 200 must not clear selection when same-poll cleanup page reported documentPending: true"
        );
        assert!(
            ui.mission_lifecycle
                .has_delete_intent_for_test(&sc, "msn-bare")
        );
        // Even after a subsequent empty cleanup page, the frozen intent stays reachable.
        assert!(
            ui.entries[0]
                .missions
                .as_mut()
                .unwrap()
                .accept_cleanups_for_test(vec![])
        );
        assert!(
            ui.mission_lifecycle
                .has_delete_intent_for_test(&sc, "msn-bare")
        );
    });
}

#[test]
fn mission_delete_401_probes_auth_status_shows_signin_and_preserves_frozen_intent() {
    crate::platform::block_on(async {
        let http = test_http::Http::new().await;
        let backend = http.backend.clone();
        let attest = std::thread::spawn(move || {
            crate::platform::block_on(async {
                let meta = http.accept().await;
                meta.reply(200, json!({"apiContract": 1, "serverId": "server"}))
                    .await;
                http
            })
        });
        backend.attest_server().await.unwrap();
        let http = attest.join().unwrap();
        let wake: codenomad_client::Wake = std::sync::Arc::new(|| {});
        let mut s = crate::init();
        let mut tx = rune::Tx::default();
        s.screen = crate::Screen::Chat { launcher: None };
        crate::settings::connected(&mut s, &backend);

        let mut saved = workspace("alpha", "");
        saved.view.right_panel = RightPanelTab::Missions;
        saved.view.selected_mission = Some("msn-401".into());
        let mut active_entry = entry("tab-active".into(), Tab::Workspace(saved));
        active_entry.binding = Some(backend.clone());
        active_entry.project = Some(codenomad_client::catalog::Project {
            id: backend.workspace.clone(),
            path: "/fixture".into(),
        });
        let panel = crate::missions::Panel::new(
            backend.clone(),
            Some("project".into()),
            Default::default(),
            wake.clone(),
        );
        let sc = panel.cleanup_scope().unwrap();
        active_entry.missions = Some(panel);
        let mut ui = Ui::new();
        ui.entries = vec![active_entry];
        ui.active = 0;

        ui.mission_lifecycle.start_delete_for_test(
            "tab-active",
            &http.backend,
            "project",
            "msn-401",
            7,
            wake.clone(),
        );
        let first_del = http.accept().await;
        assert!(first_del.header.starts_with("DELETE "));
        let frozen_request_id = first_del.body["requestId"].as_str().unwrap().to_owned();
        // Return 401 on DELETE and expired login on /api/auth/status.
        first_del.reply(401, json!({"error": "unauthorized"})).await;
        let auth_probe = http.accept().await;
        assert!(
            auth_probe.header.starts_with("GET /api/auth/status "),
            "DELETE 401 must probe /api/auth/status, got: {}",
            auth_probe.header
        );
        auth_probe.reply(200, json!({"authenticated": false})).await;

        s.workspace = Some(ui);
        let mut polled_auth = false;
        for _ in 0..100 {
            if super::super::poll(&mut s, 1.0, &mut tx)
                && crate::chat::authentication::dialog(&s).is_some()
            {
                polled_auth = true;
                break;
            }
            crate::platform::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            polled_auth,
            "401 with expired auth status must initiate reauthentication and show sign-in dialog"
        );
        // No automatic DELETE replay may occur.
        http.quiet().await;

        // Frozen intent survives and explicit Retry reuses the exact requestId/revision/option.
        let ui = s.workspace.as_mut().unwrap();
        assert!(
            ui.mission_lifecycle
                .has_delete_intent_for_test(&sc, "msn-401")
        );
        ui.mission_lifecycle
            .retry_delete_for_test(&sc, "msn-401", http.backend.clone(), wake);
        let pre = http.accept().await;
        assert!(pre.header.starts_with("GET /api/workspaces/"));
        pre.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                "mission": {"id": "msn-401", "projectID": "project", "revision": 7},
                "cleanups": []
            }),
        )
        .await;
        let replay = http.accept().await;
        assert!(replay.header.starts_with("DELETE "));
        assert_eq!(replay.body["requestId"], json!(frozen_request_id));
        assert_eq!(replay.body["expectedRevision"], json!(7));
        assert_eq!(replay.body["deleteManagedSessions"], json!(false));
        replay.reply(200, json!({"deleted": true})).await;
    });
}

#[test]
fn stale_mission_auth_expired_is_ignored_when_window_has_no_bound_backend() {
    let mut s = crate::init();
    let mut tx = rune::Tx::default();
    s.screen = crate::Screen::Chat { launcher: None };
    assert!(crate::settings::bound_backend(&s).is_none());
    let mut ui = Ui::new();
    let stale_backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    ui.mission_auth_expired.push(stale_backend);
    s.workspace = Some(ui);
    super::super::poll(&mut s, 1.0, &mut tx);
    assert!(
        crate::chat::authentication::dialog(&s).is_none(),
        "stale mission 401 must not open sign-in when no backend is bound"
    );
}

#[test]
fn cleanup_directory_load_more_401_triggers_reauth_without_replaying_delete() {
    crate::platform::block_on(async {
        let http = test_http::Http::new().await;
        let backend = http.backend.clone();
        let attest = std::thread::spawn(move || {
            crate::platform::block_on(async {
                let meta = http.accept().await;
                meta.reply(200, json!({"apiContract": 1, "serverId": "server"}))
                    .await;
                http
            })
        });
        backend.attest_server().await.unwrap();
        let http = attest.join().unwrap();
        let wake: codenomad_client::Wake = std::sync::Arc::new(|| {});

        let mut s = crate::init();
        let mut tx = rune::Tx::default();
        crate::gallery::shell::fixture(&mut s);
        if !crate::shell::right_panel_visible(&s) {
            crate::shell::toggle_panel(&mut s, 1, &mut tx);
        }
        assert!(crate::shell::right_panel_visible(&s));
        // Bind settings backend on the same server connection so auth expiry opens sign-in.
        if let Some(launcher) = s.screen.launcher_mut() {
            launcher.connection = Some(backend.clone());
        }
        crate::settings::connected(&mut s, &backend);

        let mut saved = workspace("alpha", "");
        saved.view.right_panel = RightPanelTab::Missions;
        let mut active_entry = entry("tab-active".into(), Tab::Workspace(saved));
        active_entry.binding = Some(backend.clone());
        active_entry.project = Some(codenomad_client::catalog::Project {
            id: backend.workspace.clone(),
            path: "/fixture".into(),
        });
        let mut panel = crate::missions::Panel::new(
            backend.clone(),
            Some("project".into()),
            Default::default(),
            wake.clone(),
        );
        panel.probe();
        let meta = http.accept().await;
        assert!(meta.header.starts_with("GET /api/meta "));
        meta.reply(200, json!({"capabilities": ["missions"]})).await;
        for _ in 0..50 {
            if panel.poll() && panel.supported() {
                break;
            }
            crate::platform::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(panel.supported());
        panel.show(true);
        let empty_digest = "XukXOxtWTmGv0jWaiXwYC16oOHWpGihTffQgKq1LOqc";
        let row_texts: Vec<String> = (0..50)
            .map(|i| {
                serde_json::to_string(&json!({
                    "missionID": format!("msn-{i}"), "deletionID": format!("del-{i}"),
                    "requestID": format!("req-{i}"),
                    "expectedRevision": 1, "deleteManagedSessions": false,
                    "objective": "Old", "createdAt": 1, "removed": 0, "retained": 0,
                    "pending": 1, "reasons": [], "documentPending": false
                }))
                .unwrap()
            })
            .collect();
        let row_digest = utf16_array_digest(&row_texts);
        let pieces: Vec<serde_json::Value> = row_texts
            .iter()
            .enumerate()
            .map(|(index, text)| {
                json!({
                    "index": index,
                    "offset": 0,
                    "characters": text.encode_utf16().count(),
                    "text": text
                })
            })
            .collect();
        for _ in 0..2 {
            let req = http.accept().await;
            let source = req.body["source"]
                .as_str()
                .unwrap_or("summaries")
                .to_owned();
            if source == "cleanups" {
                req.reply(
                    200,
                    json!({
                        "available": true, "version": 1, "source": "cleanups", "projectID": "project",
                        "discardedEvents": 0, "controlUnavailable": false,
                        "notificationUnavailable": false, "cleanupUnavailable": false,
                        "window": {"order": row_digest, "offset": 0, "end": 50, "total": 51},
                        "page": {"digest": row_digest, "total": 50, "pieces": pieces}
                    }),
                )
                .await;
            } else {
                req.reply(
                    200,
                    json!({
                        "available": true, "version": 1, "source": "summaries", "projectID": "project",
                        "finishHighWater": 0,
                        "discardedEvents": 0, "controlUnavailable": false,
                        "notificationUnavailable": false, "cleanupUnavailable": false,
                        "window": {"order": empty_digest, "offset": 0, "end": 0, "total": 0},
                        "page": {"digest": empty_digest, "total": 0, "pieces": []}
                    }),
                )
                .await;
            }
        }
        for _ in 0..50 {
            panel.poll();
            crate::platform::sleep(std::time::Duration::from_millis(5)).await;
        }
        let sc = panel.cleanup_scope().unwrap();
        active_entry.missions = Some(panel);
        let mut ui = Ui::new();
        ui.entries = vec![active_entry];
        ui.active = 0;

        // Seed a failed frozen delete intent to verify Load more 401 never replays DELETE.
        ui.mission_lifecycle.start_delete_for_test(
            "tab-active",
            &http.backend,
            "project",
            "msn-frozen",
            7,
            wake.clone(),
        );
        let del = http.accept().await;
        del.reply(503, json!({"code": "cleanup-pending"})).await;
        let rec = http.accept().await;
        rec.reply(503, json!({"error": "unavailable"})).await;
        for _ in 0..50 {
            if ui.mission_lifecycle.poll_deletes().changed() {
                break;
            }
            crate::platform::sleep(std::time::Duration::from_millis(5)).await;
        }

        // Trigger Load more on cleanups and return HTTP 401 + expired /api/auth/status.
        ui.entries[0]
            .missions
            .as_mut()
            .unwrap()
            .load_more_cleanups_for_test();
        let more_req = http.accept().await;
        assert!(more_req.header.contains("/missions/panel-page"));
        more_req.reply(401, json!({"error": "unauthorized"})).await;
        let auth_probe = http.accept().await;
        assert!(auth_probe.header.starts_with("GET /api/auth/status "));
        auth_probe.reply(200, json!({"authenticated": false})).await;

        s.workspace = Some(ui);
        let mut opened_signin = false;
        for _ in 0..100 {
            if super::super::poll(&mut s, 1.0, &mut tx)
                && matches!(s.screen, crate::Screen::Launcher(_))
                && s.screen
                    .launcher()
                    .is_some_and(|launcher| launcher.authentication_required)
            {
                opened_signin = true;
                break;
            }
            crate::platform::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            opened_signin,
            "HTTP 401 on cleanup Load more must trigger reauthentication"
        );
        http.quiet().await;
        assert!(
            s.workspace
                .as_ref()
                .unwrap()
                .mission_lifecycle
                .has_delete_intent_for_test(&sc, "msn-frozen"),
            "frozen delete intent must survive without replaying DELETE"
        );
    });
}

#[test]
fn stale_connection_delete_401_does_not_mask_current_connection_auth_failure() {
    crate::platform::block_on(async {
        let http = test_http::Http::new().await;
        let old_backend = http.backend.clone();
        let attest1 = {
            let b = old_backend.clone();
            tokio::spawn(async move { b.attest_server().await })
        };
        let meta1 = http.accept().await;
        meta1
            .reply(200, json!({"apiContract": 1, "serverId": "server"}))
            .await;
        test_http::wait(attest1).await.unwrap().unwrap();

        let mut new_backend = crate::backend::Backend::unauthenticated(&http.backend.base).unwrap();
        new_backend.workspace = old_backend.workspace.clone();
        let attest2 = {
            let b = new_backend.clone();
            tokio::spawn(async move { b.attest_server().await })
        };
        let meta2 = http.accept().await;
        meta2
            .reply(200, json!({"apiContract": 1, "serverId": "server"}))
            .await;
        test_http::wait(attest2).await.unwrap().unwrap();
        assert!(!old_backend.client.same_connection(&new_backend.client));

        let wake: codenomad_client::Wake = std::sync::Arc::new(|| {});
        let mut s = crate::init();
        let mut tx = rune::Tx::default();
        s.screen = crate::Screen::Chat { launcher: None };
        crate::settings::connected(&mut s, &new_backend);

        let mut saved = workspace("alpha", "");
        saved.view.right_panel = RightPanelTab::Missions;
        let mut active_entry = entry("tab-active".into(), Tab::Workspace(saved));
        active_entry.binding = Some(new_backend.clone());
        active_entry.project = Some(codenomad_client::catalog::Project {
            id: new_backend.workspace.clone(),
            path: "/fixture".into(),
        });
        let panel = crate::missions::Panel::new(
            new_backend.clone(),
            Some("project".into()),
            Default::default(),
            wake.clone(),
        );
        active_entry.missions = Some(panel);
        let mut ui = Ui::new();
        ui.entries = vec![active_entry];
        ui.active = 0;

        // Current connection expires on a delete AND a delayed stale connection ALSO expires in the same poll.
        ui.mission_lifecycle.start_delete_for_test(
            "tab-active",
            &new_backend,
            "project",
            "msn-current",
            7,
            wake.clone(),
        );
        let del_cur = http.accept().await;
        ui.mission_lifecycle.start_delete_for_test(
            "tab-active",
            &old_backend,
            "project",
            "msn-stale",
            7,
            wake,
        );
        let del_old = http.accept().await;

        del_cur.reply(401, json!({"error": "unauthorized"})).await;
        del_old.reply(401, json!({"error": "unauthorized"})).await;
        let p1 = http.accept().await;
        let p2 = http.accept().await;
        p1.reply(200, json!({"authenticated": false})).await;
        p2.reply(200, json!({"authenticated": false})).await;
        crate::platform::sleep(std::time::Duration::from_millis(60)).await;

        s.workspace = Some(ui);
        assert!(
            super::super::poll(&mut s, 1.0, &mut tx)
                && crate::chat::authentication::dialog(&s).is_some(),
            "stale connection 401 in the same poll must not mask the current connection's auth expiry"
        );
    });
}

fn utf16_array_digest(rows: &[String]) -> String {
    use base64::Engine as _;
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let joined = format!("[{}]", rows.join(","));
    let mut data: Vec<u8> = joined.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let bit_len = (data.len() as u64) * 8;
    data.push(0x80);
    while data.len() % 64 != 56 {
        data.push(0);
    }
    data.extend_from_slice(&bit_len.to_be_bytes());
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    for chunk in data.chunks_exact(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (slot, delta) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *slot = slot.wrapping_add(delta);
        }
    }
    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(out)
}
