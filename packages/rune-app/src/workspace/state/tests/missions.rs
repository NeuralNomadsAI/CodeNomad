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
fn reconnect_event_abandons_preparing_briefing_without_posting() {
    crate::platform::block_on(async {
        let http = test_http::Http::new().await;
        let backend = http.backend.clone();
        let identity = tokio::spawn(async move { backend.attest_server().await });
        let meta = http.accept().await;
        meta.reply(200, json!({"apiContract":1,"serverId":"fixture-server"}))
            .await;
        assert_eq!(
            test_http::wait(identity).await.unwrap().unwrap(),
            "fixture-server"
        );
        let mut s = init();
        crate::gallery::shell::fixture(&mut s);
        let mut ui = Ui::new();
        ui.ready = true;
        s.workspace = Some(ui);
        let launcher = s.screen.launcher_mut().unwrap();
        launcher.connection = Some(http.backend.clone());
        launcher.server_id = Some("fixture-server".into());
        let project = launcher.project.clone().unwrap();
        let workspace_id = project.id.clone();
        opened(&mut s, &project);
        let mut proj_backend = http.backend.clone();
        proj_backend.workspace.clone_from(&workspace_id);
        let panel = crate::missions::Panel::new(
            proj_backend.clone(),
            None,
            s.reads.clone(),
            s.wake.clone(),
        );
        {
            let ui = s.workspace.as_mut().unwrap();
            if let Tab::Workspace(saved) = &mut ui.entries[0].saved {
                saved.view.right_panel = RightPanelTab::Missions;
            }
            ui.entries[0].missions = Some(panel);
        }
        let mut rt =
            rune::Runtime::new(s, crate::view, (1400.0, 880.0), rune::Env::new(false, 1.0));
        for _ in 0..4 {
            rt.frame(1.0 / 60.0);
        }
        assert!(rt.state.shell.visible(1), "right panel laid out");

        let header: codenomad_client::missions::MapHeader = serde_json::from_str(HEADER).unwrap();
        let key = crate::missions::BriefingKey::new(&proj_backend, &header).unwrap();

        // 1. MissionsReconnected for the active project abandons Preparing even with an admitted GET buffered.
        let (out1, cancelled1) = rt
            .state
            .workspace
            .as_mut()
            .unwrap()
            .mission_briefing
            .fixture_preparing(&key, "req-reconn-1", "tab-0", proj_backend.clone(), &header);
        out1.try_send(codenomad_client::missions::BriefingAdmissionOutcome::Admitted)
            .unwrap();
        let reconnected =
            codenomad_client::transport::WorkspaceEvent::MissionsReconnected { workspace_id };
        rt.update(|s, _| mission_event(s, Some(&reconnected)));
        assert!(
            cancelled1.is_closed(),
            "MissionsReconnected must immediately cancel Preparing before reconcile can POST"
        );
        assert_eq!(
            rt.state
                .workspace
                .as_ref()
                .unwrap()
                .mission_briefing
                .visible_phase(&key, &header),
            Some(&crate::missions::BriefingPhase::Error)
        );

        // 2. Shared/chat SSE reconnect (mission_event None) also abandons Preparing immediately.
        let (out2, cancelled2) = rt
            .state
            .workspace
            .as_mut()
            .unwrap()
            .mission_briefing
            .fixture_preparing(&key, "req-reconn-2", "tab-0", proj_backend, &header);
        out2.try_send(codenomad_client::missions::BriefingAdmissionOutcome::Admitted)
            .unwrap();
        rt.update(|s, _| mission_event(s, None));
        assert!(
            cancelled2.is_closed(),
            "SSE reconnect must immediately cancel Preparing before reconcile can POST"
        );
        assert_eq!(
            rt.state
                .workspace
                .as_ref()
                .unwrap()
                .mission_briefing
                .visible_phase(&key, &header),
            Some(&crate::missions::BriefingPhase::Error)
        );
    });
}
