use super::*;
use crate::{files::test_http, workspace::RightPanelTab};
use serde_json::json;

#[test]
fn mounted_missions_reads_the_active_occurrence_only_while_visible() {
    crate::platform::block_on(async {
        let http = test_http::Http::new().await;
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
                panel_state::poll_missions(&mut ui, s);
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
        let ui = rt.state.workspace.as_ref().unwrap();
        assert!(
            matches!(&ui.entries[ui.active].saved,Tab::Workspace(w) if w.view.selected_mission.as_deref()==Some("alpha"))
        );

        click(&mut rt, "right-panel-tab-0");
        assert!(rt.find("missions-panel").is_none());
        http.quiet().await;
        click(&mut rt, "right-panel-tab-2");
        let summaries = http.accept().await;
        let cleanups = http.accept().await;
        assert!(rt.find("missions-panel").is_some());
        rt.update(|s, tx| {
            assert!(crate::settings::authentication_required(s, &http.backend));
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
    });
}
