use super::{
    ScheduleConfirmation, ScheduleGesture as G, ScheduleHoldKey as Key, ScheduleHoldPhase as P,
    ScheduleHolds, confirmation,
};
use crate::{files::test_http::Http, missions::Panel, platform::reads::Reads};
use codenomad_client::{
    Receiver, Wake,
    backend::Backend,
    bounded,
    missions::{ScheduleAction as A, UnifiedSchedule},
};
use serde_json::{Value, json};
use std::sync::Arc;

fn js(s: &str) -> Value {
    serde_json::from_str(s).unwrap()
}
fn row(id: &str, title: &str, state: &str, rev: u64, control: &str) -> Value {
    let (acts, nat) = if state == "running" {
        (r#"["pause","stop","run-now","delete"]"#, "active")
    } else {
        (r#"["resume","stop","run-now","delete"]"#, "paused")
    };
    js(&format!(
        r#"{{"id":"{id}","kind":"schedule","revision":{rev},"state":"{state}","firstPlayedAt":1700000000000,"launchedCount":2,"successfulCount":1,"checks":{{"count":4,"since":1700000000000}},"configuration":{{"title":"{title}","objective":"Run nightly audit","notes":"Server routes","launch":{{"when":[{{"kind":"cron","expression":"0 9 * * *","zone":"UTC"}},{{"kind":"files-changed","paths":["src/main.rs"]}}]}}}},"observation":{{"state":"known","nativeStatus":"{nat}","nextDueAt":1700003600000,"kind":"check"}},"availableActions":{acts},"pendingPassage":{{"coordinatorSessionID":"ses_pending_1"}},"history":[{{"id":"psg_hist_1","coordinatorSessionID":"ses_hist_1","dueAt":1700000000000,"outcome":"completed"}}],"control":{control}}}"#
    ))
}
fn list(rows: Vec<Value>, next: Option<&str>) -> Value {
    json!({ "version": 1, "projectID": "proj_1", "schedules": rows, "next": next })
}
fn rdoc(doc: Value) -> Value {
    json!({ "pending": false, "document": doc })
}

struct H {
    http: Http,
    panel: Panel,
    holds: ScheduleHolds,
    done: Receiver<()>,
}
impl H {
    async fn new() -> Self {
        let http = Http::new().await;
        let (tx, done) = bounded(16);
        let wake: Wake = Arc::new(move || {
            let _ = tx.try_send(());
        });
        let panel = Panel::new(
            http.backend.clone(),
            Some("proj_1".into()),
            Reads::default(),
            wake,
        );
        Self {
            http,
            panel,
            holds: Default::default(),
            done,
        }
    }
    fn key(&self, id: &str) -> Key {
        Key::new(&self.panel.backend, "proj_1", &self.panel.owner_scope, id)
    }
    fn act(&mut self, g: G) -> bool {
        self.panel.schedule_gesture("occ-1", &mut self.holds, g)
    }
    async fn pump(&mut self, pred: impl Fn(&Panel, &ScheduleHolds) -> bool) {
        for _ in 0..40 {
            self.panel.poll_schedules(&mut self.holds);
            let av = self.panel.active_schedule_view("occ-1");
            let (_, evs) = self.holds.poll(av.as_ref(), &[]);
            self.panel.apply_schedule_hold_events(&evs);
            if pred(&self.panel, &self.holds) {
                return;
            }
            let _ =
                tokio::time::timeout(std::time::Duration::from_millis(25), self.done.recv()).await;
        }
        assert!(
            pred(&self.panel, &self.holds),
            "predicate did not become true"
        );
    }
    async fn reply_lc(&self, rows: Vec<Value>, enabled: bool) {
        for _ in 0..2 {
            let req = self.http.accept().await;
            let b = if req.header.contains("/capabilities") {
                json!({"api":{"available":true},"enabled":enabled})
            } else {
                list(rows.clone(), None)
            };
            req.reply(200, b).await;
        }
    }
}

#[test]
fn pagination_delete_and_uncertain_hold_reconciliation() {
    crate::platform::block_on(async {
        let mut h = H::new().await;
        let (s, c) = h.panel.schedule_parts();
        s.show(true);
        s.refresh(c);
        let r1 = h.http.accept().await;
        assert!(
            r1.header
                .starts_with("GET /api/workspaces/owned/missions/scheduled?limit=8")
        );
        let mut one = row("msn_one", "One time", "paused", 1, "null");
        one["kind"] = Value::String("one-time".into());
        let s1 = row("msn_s1", "Alpha nightly", "running", 7, "null");
        r1.reply(200, list(vec![one, s1.clone()], Some("msn_s1")))
            .await;
        h.pump(|p, _| !p.schedules.loading() && p.schedules.rows.len() == 2)
            .await;
        assert_eq!(
            h.panel
                .schedules
                .visible_rows(&h.holds, h.panel.schedule_ctx())
                .len(),
            1
        );

        assert!(h.act(G::More));
        let r2 = h.http.accept().await;
        assert!(r2.header.contains("after=msn_s1"));
        let s2 = row("msn_s2", "Beta weekly", "paused", 4, "null");
        r2.reply(200, list(vec![s2.clone()], None)).await;
        h.pump(|p, _| !p.schedules.loading() && p.schedules.next.is_none())
            .await;

        assert!(h.act(G::Select("msn_s2".into())));
        h.reply_lc(vec![s1.clone(), s2.clone()], true).await;
        h.pump(|p, _| p.schedules.is_fresh("msn_s2") && p.schedules.capability == Some(true))
            .await;
        assert!(
            h.panel
                .owns_schedule_conversation_target(&h.holds, "ses_pending_1")
                && h.panel
                    .owns_schedule_conversation_target(&h.holds, "ses_hist_1")
                && !h
                    .panel
                    .owns_schedule_conversation_target(&h.holds, "ses_foreign")
        );

        assert!(h.act(G::Action(A::Delete)));
        h.http.accept().await.reply(200, rdoc(s2.clone())).await;
        h.pump(|_, hs| hs.confirmation.is_some()).await;
        assert!(h.act(G::Confirm(false)));
        h.http.quiet().await;

        assert!(h.act(G::Action(A::Delete)));
        h.http.accept().await.reply(200, rdoc(s2)).await;
        h.pump(|_, hs| hs.confirmation.is_some()).await;
        assert!(h.act(G::Confirm(true)));
        let del = h.http.accept().await;
        assert!(
            del.header
                .starts_with("POST /api/workspaces/owned/missions/msn_s2/schedule")
                && del.body["deleteManagedSessions"].as_bool() == Some(false)
        );
        let drid = del.body["requestID"].as_str().unwrap();
        let tomb = js(&format!(
            r#"{{"pending":false,"document":null,"deleted":true,"deletionReceipt":{{"id":"msn_s2","requestID":"{drid}","expectedRevision":4,"deleteManagedSessions":false}}}}"#
        ));
        del.reply(200, tomb).await;
        let dkey = h.key("msn_s2");
        h.pump(|p, hs| p.schedules.selected.is_none() && hs.get(&dkey).is_none())
            .await;
        h.http
            .accept()
            .await
            .reply(200, list(vec![s1.clone()], None))
            .await;
        h.pump(|p, _| !p.schedules.loading()).await;

        assert!(h.act(G::Select("msn_s1".into())));
        h.reply_lc(vec![s1.clone()], true).await;
        h.pump(|p, _| p.schedules.is_fresh("msn_s1")).await;
        let pkey = h.key("msn_s1");
        assert!(h.act(G::Action(A::Pause)));
        h.http.accept().await.reply(200, rdoc(s1.clone())).await;
        h.pump(|_, hs| hs.get(&pkey).is_some()).await;
        let post = h.http.accept().await;
        let rid = post.body["requestID"].as_str().unwrap().to_owned();
        let pend = js(&format!(
            r#"{{"code":"schedule-pending","pending":true,"document":{{"id":"msn_s1","control":{{"requestID":"{rid}","expectedRevision":7,"action":"pause","pending":true}}}}}}"#
        ));
        post.reply(503, pend).await;
        h.pump(|_, hs| {
            hs.get(&pkey)
                .is_some_and(|(ph, chk)| chk && matches!(ph, P::Control(_, true)))
        })
        .await;
        let g1 = h.http.accept().await;
        assert!(g1.header.contains(&format!("requestID={rid}")));
        g1.reply(401, js(r#"{"error":"unauthorized"}"#)).await;
        h.pump(|_, hs| {
            hs.get(&pkey)
                .is_some_and(|(ph, chk)| !chk && matches!(ph, P::Control(_, true)))
        })
        .await;
        assert_eq!(h.holds.drain_auth_expired().len(), 1);

        h.panel.schedules.suspend();
        h.http.quiet().await;
        let (s, c) = h.panel.schedule_parts();
        s.show(true);
        s.refresh(c);
        h.reply_lc(vec![s1], true).await;
        h.pump(|p, _| !p.schedules.loading()).await;
        h.http.quiet().await;

        assert!(h.act(G::Reconcile));
        let rec = h.http.accept().await;
        assert!(rec.header.contains(&format!("requestID={rid}")));
        let ctrl = format!(
            r#"{{"requestID":"{rid}","expectedRevision":7,"action":"pause","pending":false}}"#
        );
        rec.reply(
            200,
            rdoc(row("msn_s1", "Alpha nightly", "paused", 8, &ctrl)),
        )
        .await;
        h.pump(|_, hs| hs.get(&pkey).is_some_and(|(ph, _)| ph.is_publication()))
            .await;
        h.reply_lc(
            vec![row("msn_s1", "Alpha nightly", "paused", 8, "null")],
            true,
        )
        .await;
        h.pump(|_, hs| hs.get(&pkey).is_none()).await;
    });
}

#[test]
fn capability_missing_blocks_calendar_launch_and_view_renders_controls() {
    let mut b = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
    b.workspace = "owned".into();
    let mut panel = Panel::new(b, Some("proj_1".into()), Reads::default(), Arc::new(|| {}));
    let doc =
        UnifiedSchedule::from_value(&row("msn_ui", "Nightly build", "paused", 5, "null")).unwrap();
    panel.schedules.rows.push(doc.clone());
    panel.schedules.selected = Some("msn_ui".into());
    panel.schedules.capability = Some(false);
    assert!(!panel.schedules.capable(&doc, A::Resume, false, true));
    assert!(!panel.schedules.capable(&doc, A::RunNow, false, true));
    panel.schedules.capability = Some(true);

    let mut rt = rune::Runtime::new(
        (
            panel,
            ScheduleHolds::default(),
            crate::missions::EditorHolds::default(),
            rune::edit::TextEdit::new(""),
        ),
        |s, cx| {
            rune_theme_codenomad::layout::render(cx, |_| {
                let act = |s: &mut (
                    Panel,
                    ScheduleHolds,
                    crate::missions::EditorHolds,
                    rune::edit::TextEdit,
                ),
                           g,
                           tx: &mut rune::Tx| {
                    let _ = s.0.schedule_gesture("occ-1", &mut s.1, g);
                    tx.instant();
                };
                let base = crate::missions::panel_body(
                    &s.0,
                    &s.2,
                    &s.1,
                    |s| (Some(&mut s.0), &mut s.3),
                    rune::el(),
                    None,
                    |_, _| {},
                    |_, _, _| {},
                    act,
                );
                match confirmation(&s.1, act) {
                    Some(m) => rune::col().child(base).child(m),
                    None => base,
                }
            })
        },
        (420.0, 900.0),
        rune::Env::new(false, 1.0),
    );
    rt.frame(0.0);
    for key in [
        "mission-schedule-row-msn_ui",
        "mission-schedule-detail",
        "mission-schedule-primary",
        "mission-schedule-stop",
        "mission-schedule-run-now",
        "mission-schedule-delete",
        "mission-schedule-open-conversation",
        "mission-schedule-run-open-psg_hist_1",
    ] {
        assert!(rt.find(key).is_some(), "missing {key}");
    }
    rt.update(|s, _| {
        let _ =
            s.0.schedule_gesture("occ-1", &mut s.1, G::ToggleInstructions);
    });
    rt.frame(0.01);
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("Nightly build") && tree.contains("Run nightly audit"));
    rt.update(|s, _| {
        let key = Key::new(&s.0.backend, "proj_1", &s.0.owner_scope, "msn_ui");
        s.1.confirmation = Some(ScheduleConfirmation {
            occurrence: "occ-1".into(),
            key,
            action: A::RunNow,
            expected_revision: 5,
            title: "Nightly build".into(),
        });
    });
    rt.frame(0.02);
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("Nightly build")
    );
}
