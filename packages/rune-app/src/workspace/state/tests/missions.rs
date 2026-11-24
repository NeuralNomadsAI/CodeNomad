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
        test_http::wait(signal.recv()).await.unwrap();
        tick(&mut rt);
        assert!(rt.find("right-panel-tab-2").is_some());
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
        for _ in 0..2 {
            test_http::wait(signal.recv()).await.unwrap();
        }
        tick(&mut rt);
        assert!(rt.accessibility_json().to_string().contains("Alpha 🦀"));
        assert!(
            rt.accessibility_json()
                .to_string()
                .contains(crate::strings::t("missions.cleanup.documentPending"))
        );
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
        test_http::wait(signal.recv()).await.unwrap();
        tick(&mut rt);
        let tree = rt.accessibility_json().to_string();
        assert!(tree.contains("Owned mission objective 🦀") && tree.contains("Owned task"));
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
        test_http::wait(signal.recv()).await.unwrap();
        tick(&mut rt);
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

        // 2. Direct delete A clearing selection in phase 1 revokes cleanup retry B's GET-only
        // settlement in phase 2 of the SAME poll_missions cycle.
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
            !ui.entries[0]
                .missions
                .as_ref()
                .unwrap()
                .has_settled_cleanup_for_test("del-b"),
            "B's read-only GET settlement must not publish after A's delete cleared selection in the same poll"
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
