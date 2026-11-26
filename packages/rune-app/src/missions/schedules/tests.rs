use super::{
    Cap, ScheduleConfirmation, ScheduleGesture as G, ScheduleHoldKey as Key,
    ScheduleHoldPhase as P, ScheduleHolds, confirmation,
};
use crate::{files::test_http::Http, missions::Panel, platform::reads::Reads, strings::t};
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
fn row_root(id: &str, title: &str, state: &str, rev: u64, control: &str, root: &str) -> Value {
    let (acts, nat) = if state == "running" {
        (r#"["pause","stop","run-now","delete"]"#, "active")
    } else {
        (r#"["resume","stop","run-now","delete"]"#, "paused")
    };
    js(&format!(
        r#"{{"id":"{id}","kind":"schedule","revision":{rev},"state":"{state}","firstPlayedAt":1700000000000,"oneShotAt":null,"launchedCount":2,"successfulCount":1,"checks":{{"count":4,"since":1700000000000}},"configuration":{{"title":"{title}","objective":"Run nightly audit","notes":"Server routes","roots":[{{"mode":"directory-only","directory":"{root}"}}],"launch":{{"when":[{{"kind":"cron","expression":"0 9 * * *","zone":"UTC"}},{{"kind":"files-changed","paths":["src/main.rs"]}}]}}}},"observation":{{"state":"known","nativeStatus":"{nat}","nextDueAt":1700003600000,"kind":"check"}},"availableActions":{acts},"pendingPassage":{{"coordinatorSessionID":"ses_pending_1"}},"history":[{{"id":"psg_hist_1","coordinatorSessionID":"ses_hist_1","dueAt":1700000000000,"outcome":"completed"}}],"control":{control},"scheduleActivation":{{"state":"ready"}}}}"#
    ))
}
fn row(id: &str, title: &str, state: &str, rev: u64, control: &str) -> Value {
    row_root(id, title, state, rev, control, "/owned")
}
fn list(rows: Vec<Value>, next: Option<&str>) -> Value {
    json!({ "version": 1, "projectID": "proj_1", "schedules": rows, "next": next })
}
fn rdoc(doc: Value) -> Value {
    json!({ "pending": false, "document": doc })
}
fn cap_body(enabled: bool) -> Value {
    json!({"api":{"available":true},"enabled":enabled,"activation":{"available":enabled,"targets":[]}})
}

struct H {
    http: Http,
    panel: Panel,
    holds: ScheduleHolds,
    auth_expired: Vec<Backend>,
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
        )
        .with_owner_scope("/owned".into());
        Self {
            http,
            panel,
            holds: Default::default(),
            auth_expired: Vec::new(),
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
            let mut exp = self.panel.drain_auth_expired();
            let av = self.panel.active_schedule_view("occ-1");
            let (_, evs) = self.holds.poll(av.as_ref(), &exp);
            exp.extend(self.holds.drain_auth_expired());
            self.panel.commit_schedule_pre(&mut self.holds, true, &exp);
            self.panel.apply_schedule_hold_events(&evs);
            self.auth_expired.extend(exp);
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
    async fn drain_one(&mut self) {
        for _ in 0..40 {
            if self.panel.poll_schedules(&mut self.holds) {
                return;
            }
            let _ =
                tokio::time::timeout(std::time::Duration::from_millis(25), self.done.recv()).await;
        }
        panic!("poll_schedules did not advance");
    }
    async fn reply_lc(&self, rows: Vec<Value>, enabled: bool) {
        self.reply_lc_body(rows, cap_body(enabled)).await;
    }
    async fn reply_lc_body(&self, rows: Vec<Value>, cap: Value) {
        for _ in 0..2 {
            let req = self.http.accept().await;
            let b = if req.header.contains("/capabilities") {
                cap.clone()
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
        h.pump(|p, _| {
            p.schedules.is_fresh("msn_s2") && p.schedules.capability == Some(Cap::Available)
        })
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
        let dkey = h.key("msn_s2");
        assert!(h.act(G::Confirm(true)));
        h.pump(|_, hs| hs.get(&dkey).is_some()).await;
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
        assert!(
            h.holds
                .has_unresolved_control_for_workspace(&h.panel.backend)
        );
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
        assert_eq!(h.auth_expired.len(), 1);
        h.auth_expired.clear();
        assert!(
            h.holds
                .has_unresolved_control_for_workspace(&h.panel.backend)
        );

        let mut foreign_ws = h.panel.backend.clone();
        foreign_ws.workspace = "other_ws".into();
        let mut wrong_ctx = h.panel.schedule_ctx();
        wrong_ctx.backend = &foreign_ws;
        assert!(!h.holds.reconcile(&pkey, wrong_ctx));
        h.holds.retire_workspace(&foreign_ws);
        assert!(h.holds.get(&pkey).is_some());

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
        assert!(
            !h.holds
                .has_unresolved_control_for_workspace(&h.panel.backend)
        );
        h.reply_lc(
            vec![row("msn_s1", "Alpha nightly", "paused", 8, "null")],
            true,
        )
        .await;
        h.pump(|_, hs| hs.get(&pkey).is_none()).await;
    });
}

#[test]
fn guards_auth_cancel_pre_races_confirmation_generation_roots_and_refusal() {
    crate::platform::block_on(async {
        let mut h = H::new().await;
        let (s, c) = h.panel.schedule_parts();
        s.show(true);
        s.refresh(c);
        let r1 = h.http.accept().await;
        r1.reply(401, js(r#"{"error":"unauthorized"}"#)).await;
        let _ = tokio::time::timeout(std::time::Duration::from_millis(100), h.done.recv()).await;
        h.panel.schedules.suspend();
        assert_eq!(h.panel.drain_auth_expired().len(), 1);

        let foreign = row_root("msn_other", "Foreign root", "running", 2, "null", "/other");
        let s1 = row("msn_s1", "Alpha nightly", "running", 7, "null");
        let (s, c) = h.panel.schedule_parts();
        s.show(true);
        s.refresh(c);
        h.http
            .accept()
            .await
            .reply(200, list(vec![foreign.clone(), s1.clone()], None))
            .await;
        h.pump(|p, _| !p.schedules.loading() && p.schedules.rows.len() == 2)
            .await;

        assert!(h.act(G::Select("msn_other".into())));
        h.reply_lc(vec![foreign, s1.clone()], true).await;
        h.pump(|p, _| {
            !p.schedules.loading()
                && p.schedules.is_fresh("msn_other")
                && p.schedules.capability == Some(Cap::Available)
        })
        .await;
        assert!(!h.act(G::Action(A::Pause)));
        h.http.quiet().await;

        let refused_cap = json!({
            "api":{"available":true},
            "enabled":true,
            "activation":{"available":false,"code":"schedule-activation-refused","refusal":{"reason":"masked"}}
        });
        assert!(h.act(G::Select("msn_s1".into())));
        let paused = row("msn_s1", "Alpha nightly", "paused", 7, "null");
        h.reply_lc_body(vec![paused.clone()], refused_cap).await;
        h.pump(|p, _| {
            !p.schedules.loading()
                && p.schedules.is_fresh("msn_s1")
                && p.schedules.capability == Some(Cap::Refused)
        })
        .await;
        assert!(!h.act(G::Action(A::Resume)));
        assert!(!h.act(G::Action(A::RunNow)));
        h.http.quiet().await;

        let (s, c) = h.panel.schedule_parts();
        s.refresh(c);
        h.reply_lc(vec![s1.clone()], true).await;
        h.pump(|p, _| {
            !p.schedules.loading()
                && p.schedules.is_fresh("msn_s1")
                && p.schedules.capability == Some(Cap::Available)
        })
        .await;

        assert!(h.act(G::Action(A::Pause)));
        h.http.accept().await.reply(200, rdoc(s1.clone())).await;
        for _ in 0..40 {
            if h.panel.poll_schedules(&mut h.holds) {
                break;
            }
            let _ = tokio::time::timeout(std::time::Duration::from_millis(25), h.done.recv()).await;
        }
        let exp = vec![h.panel.backend.clone()];
        assert!(h.panel.commit_schedule_pre(&mut h.holds, true, &exp));
        assert!(h.holds.get(&h.key("msn_s1")).is_none());
        h.http.quiet().await;

        assert!(h.act(G::Action(A::Delete)));
        h.http.accept().await.reply(200, rdoc(s1.clone())).await;
        for _ in 0..40 {
            if h.panel.poll_schedules(&mut h.holds) {
                break;
            }
            let _ = tokio::time::timeout(std::time::Duration::from_millis(25), h.done.recv()).await;
        }
        assert!(h.panel.commit_schedule_pre(&mut h.holds, false, &[]));
        assert!(h.holds.confirmation.is_none());
        h.http.quiet().await;

        assert!(h.act(G::Action(A::Delete)));
        h.http.accept().await.reply(200, rdoc(s1.clone())).await;
        h.pump(|_, hs| hs.confirmation.is_some()).await;
        assert!(
            h.panel
                .schedule_confirmation_valid(&h.holds, h.holds.confirmation.as_ref().unwrap())
        );
        h.panel.invalidate_schedules(1.0);
        assert!(
            !h.panel
                .schedule_confirmation_valid(&h.holds, h.holds.confirmation.as_ref().unwrap())
        );
        assert!(h.act(G::Confirm(true)));
        assert!(h.holds.confirmation.is_none());
        h.http.quiet().await;

        let (s, c) = h.panel.schedule_parts();
        s.refresh(c);
        h.reply_lc(vec![s1.clone()], true).await;
        h.pump(|p, _| !p.schedules.loading() && p.schedules.is_fresh("msn_s1"))
            .await;
        assert!(h.act(G::Action(A::Pause)));
        h.http.accept().await.reply(200, rdoc(s1)).await;
        let pkey = h.key("msn_s1");
        h.pump(|_, hs| hs.get(&pkey).is_some()).await;
        let _post = h.http.accept().await;
        h.holds.retire_workspace(&h.panel.backend);
        assert!(h.holds.get(&pkey).is_none());
    });
}

#[test]
fn r2_activation_proof_confirm_401_stale_invalidation_and_page_step_down() {
    crate::platform::block_on(async {
        let mut h = H::new().await;
        let mut unact = row("msn_new", "Fresh schedule", "paused", 1, "null");
        unact["firstPlayedAt"] = Value::Null;
        unact["availableActions"] = js(r#"["play","delete"]"#);
        unact["scheduleActivation"] = Value::Null;
        let s1 = row("msn_s1", "Alpha nightly", "paused", 7, "null");
        let s2 = row("msn_s2", "Beta weekly", "running", 3, "null");

        // R2 #6: adaptive page limit step-down (8 -> 4 -> 2 -> 1) on Retry after 503 RPC overflow
        let (s, c) = h.panel.schedule_parts();
        s.show(true);
        s.refresh(c);
        let r8 = h.http.accept().await;
        assert!(r8.header.contains("limit=8"));
        r8.reply(503, js(r#"{"error":"too-large"}"#)).await;
        h.pump(|p, _| !p.schedules.loading() && p.schedules.error)
            .await;
        h.http.quiet().await;
        assert!(h.act(G::RetryList));
        let r4 = h.http.accept().await;
        assert!(r4.header.contains("limit=4"));
        r4.reply(503, js(r#"{"error":"too-large"}"#)).await;
        h.pump(|p, _| !p.schedules.loading() && p.schedules.error)
            .await;
        assert!(h.act(G::RetryList));
        let r2 = h.http.accept().await;
        assert!(r2.header.contains("limit=2"));
        r2.reply(200, list(vec![unact.clone(), s1.clone()], Some("msn_s1")))
            .await;
        h.pump(|p, _| !p.schedules.loading() && !p.schedules.error && p.schedules.rows.len() == 2)
            .await;

        assert!(h.act(G::More));
        let rm2 = h.http.accept().await;
        assert!(rm2.header.contains("limit=2") && rm2.header.contains("after=msn_s1"));
        rm2.reply(503, js(r#"{"error":"too-large"}"#)).await;
        h.pump(|p, _| !p.schedules.loading() && p.schedules.error)
            .await;
        assert!(h.act(G::RetryList));
        let rm1 = h.http.accept().await;
        assert!(rm1.header.contains("limit=1") && rm1.header.contains("after=msn_s1"));
        rm1.reply(200, list(vec![s2.clone()], None)).await;
        h.pump(|p, _| {
            !p.schedules.loading() && p.schedules.next.is_none() && p.schedules.rows.len() == 3
        })
        .await;

        // R2 #2: Play without scheduleActivation.state == "ready" is blocked even with Cap::Available
        assert!(h.act(G::Select("msn_new".into())));
        h.reply_lc(vec![unact.clone(), s1.clone()], true).await;
        h.pump(|p, _| {
            !p.schedules.loading()
                && p.schedules.is_fresh("msn_new")
                && p.schedules.capability == Some(Cap::Available)
        })
        .await;
        assert!(!h.act(G::Action(A::Play)));
        h.http.quiet().await;

        // R2 #2 (pre-check race): Resume where fresh GET lost scheduleActivation refuses POST
        assert!(h.act(G::Select("msn_s1".into())));
        h.reply_lc(vec![s1.clone()], true).await;
        h.pump(|p, _| {
            !p.schedules.loading()
                && p.schedules.is_fresh("msn_s1")
                && p.schedules.capability == Some(Cap::Available)
        })
        .await;
        assert!(h.act(G::Action(A::Resume)));
        let mut lost_act = s1.clone();
        lost_act["scheduleActivation"] = Value::Null;
        h.http.accept().await.reply(200, rdoc(lost_act)).await;
        h.http.accept().await.reply(200, cap_body(true)).await;
        h.pump(|p, _| {
            p.schedules.feedback_for("msn_s1") == Some("missions.scheduling.capability.missing")
        })
        .await;
        assert!(h.holds.get(&h.key("msn_s1")).is_none());
        h.http.quiet().await;

        // R2 #4: Confirming Delete parks in pending_pre and respects same-tick 401 barrier
        assert!(h.act(G::Action(A::Delete)));
        h.http.accept().await.reply(200, rdoc(s1.clone())).await;
        h.pump(|_, hs| hs.confirmation.is_some()).await;
        assert!(h.act(G::Confirm(true)));
        assert!(h.holds.confirmation.is_none());
        h.http.quiet().await;
        let exp = vec![h.panel.backend.clone()];
        assert!(h.panel.commit_schedule_pre(&mut h.holds, true, &exp));
        assert!(h.holds.get(&h.key("msn_s1")).is_none());
        h.http.quiet().await;

        // R2 #5: Stale list response from before SSE invalidate() cannot re-mark rows fresh
        let (s, c) = h.panel.schedule_parts();
        s.refresh(c);
        let mut stale_list = None;
        for _ in 0..2 {
            let req = h.http.accept().await;
            if req.header.contains("/capabilities") {
                req.reply(200, cap_body(true)).await;
            } else {
                stale_list = Some(req);
            }
        }
        h.drain_one().await;
        h.panel.invalidate_schedules(1.0);
        assert!(!h.panel.schedules.is_fresh("msn_s1"));
        stale_list
            .unwrap()
            .reply(200, list(vec![s1.clone()], None))
            .await;
        h.drain_one().await;
        assert!(!h.panel.schedules.is_fresh("msn_s1"));
        let fresh_req = h.http.accept().await;
        fresh_req.reply(200, list(vec![s1], None)).await;
        h.pump(|p, _| !p.schedules.loading() && p.schedules.is_fresh("msn_s1"))
            .await;
    });
}

#[test]
fn capability_missing_blocks_calendar_launch_and_view_renders_controls() {
    let mut b = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
    b.workspace = "owned".into();
    let mut panel = Panel::new(b, Some("proj_1".into()), Reads::default(), Arc::new(|| {}))
        .with_owner_scope("/owned".into());
    let doc =
        UnifiedSchedule::from_value(&row("msn_ui", "Nightly build", "paused", 5, "null")).unwrap();
    let foreign = UnifiedSchedule::from_value(&row_root(
        "msn_foreign",
        "Foreign",
        "paused",
        1,
        "null",
        "/other",
    ))
    .unwrap();
    let legacy = UnifiedSchedule::from_value(&js(
        r#"{"id":"msn_leg","kind":"schedule","revision":2,"state":"paused","firstPlayedAt":null,"launchedCount":0,"successfulCount":0,"configuration":{"title":"Legacy watch","objective":"Watch commits","roots":[{"mode":"directory-only","directory":"/owned"}],"launch":{"timing":{"kind":"every","intervalMs":300000},"condition":{"kind":"branch-commits","ref":"refs/heads/main"},"ends":{"at":1700099900000,"afterMs":600000}}},"observation":{"state":"known","nativeStatus":"paused"},"availableActions":["resume","delete"]}"#,
    ))
    .unwrap();
    panel.schedules.show(true);
    panel.schedules.rows.push(doc.clone());
    panel.schedules.rows.push(legacy.clone());
    panel.schedules.fresh.insert("msn_ui".into());
    panel.schedules.fresh.insert("msn_foreign".into());
    panel.schedules.selected = Some("msn_ui".into());
    panel.schedules.capability = Some(Cap::Missing);
    assert!(
        !panel
            .schedules
            .capable(&doc, A::Resume, false, true, Some("/owned"))
    );
    assert!(
        !panel
            .schedules
            .capable(&doc, A::RunNow, false, true, Some("/owned"))
    );
    panel.schedules.capability = Some(Cap::Refused);
    assert!(
        !panel
            .schedules
            .capable(&doc, A::Resume, false, true, Some("/owned"))
    );
    assert!(
        panel
            .schedules
            .capable(&doc, A::Delete, false, true, Some("/owned"))
    );
    panel.schedules.capability = Some(Cap::Available);
    assert!(
        panel
            .schedules
            .capable(&doc, A::Resume, false, true, Some("/owned"))
    );
    assert!(
        !panel
            .schedules
            .capable(&foreign, A::Resume, false, true, Some("/owned"))
    );
    assert!(!panel.schedules.capable(&doc, A::Resume, false, true, None));

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
        s.0.schedules.capability = Some(Cap::Refused);
        let _ =
            s.0.schedule_gesture("occ-1", &mut s.1, G::ToggleInstructions);
    });
    rt.frame(0.01);
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("Nightly build")
            && tree.contains("Run nightly audit")
            && tree.contains(t("missions.scheduleList.activationRefused"))
    );
    rt.update(|s, _| {
        s.0.schedules.selected = Some("msn_leg".into());
        s.0.schedules.capability = Some(Cap::Available);
    });
    rt.frame(0.02);
    let legacy_tree = rt.accessibility_json().to_string();
    let end_after = rune_theme_codenomad::catalogue::format(
        crate::strings::locale(),
        "missions.scheduleList.endAfter",
        &[("minutes", "10")],
    );
    assert!(
        legacy_tree.contains(t("missions.scheduling.connector.if"))
            && legacy_tree.contains(&end_after)
    );
    rt.update(|s, _| {
        s.0.schedules.selected = Some("msn_ui".into());
        let key = Key::new(&s.0.backend, "proj_1", &s.0.owner_scope, "msn_ui");
        s.1.confirmation = Some(ScheduleConfirmation {
            occurrence: "occ-1".into(),
            key,
            action: A::RunNow,
            expected_revision: 5,
            generation: 0,
            title: "Nightly build".into(),
        });
    });
    rt.frame(0.03);
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("Nightly build")
    );
}
