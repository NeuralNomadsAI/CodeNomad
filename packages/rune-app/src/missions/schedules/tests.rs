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
async fn wait_auth_sink(sink: &super::AuthSink, done: &Receiver<()>) {
    for _ in 0..40 {
        if sink.lock().unwrap().pending.len() == 1 {
            return;
        }
        let _ = tokio::time::timeout(std::time::Duration::from_millis(25), done.recv()).await;
    }
    assert_eq!(
        sink.lock().unwrap().pending.len(),
        1,
        "401 did not reach auth sink"
    );
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
        let holds = ScheduleHolds::default();
        let panel = Panel::new(
            http.backend.clone(),
            Some("proj_1".into()),
            Reads::default(),
            wake,
        )
        .with_owner_scope("/owned".into())
        .with_schedule_auth(holds.auth_sink());
        Self {
            http,
            panel,
            holds,
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
        wait_auth_sink(&h.holds.auth_sink(), &h.done).await;
        h.panel.schedules.suspend();
        let mut exp = h.panel.drain_auth_expired();
        exp.extend(h.holds.drain_auth_expired());
        assert_eq!(exp.len(), 1);

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
        assert!(!h.act(G::RetryList));
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

        // Tranche 2: Play without scheduleActivation.state == "ready" runs /schedule-settings handshake then chains Play
        assert!(h.act(G::Select("msn_new".into())));
        h.reply_lc(vec![unact.clone(), s1.clone()], true).await;
        h.pump(|p, _| {
            !p.schedules.loading()
                && p.schedules.is_fresh("msn_new")
                && p.schedules.capability == Some(Cap::Available)
        })
        .await;
        assert!(h.act(G::Action(A::Play)));
        for _ in 0..2 {
            let req = h.http.accept().await;
            if req.header.contains("/capabilities") {
                req.reply(200, cap_body(true)).await;
            } else {
                req.reply(200, rdoc(unact.clone())).await;
            }
        }
        let k_new = h.key("msn_new");
        let k_s1 = h.key("msn_s1");
        h.pump(|_, hs| {
            matches!(
                hs.get(&k_new),
                Some((
                    P::Activation {
                        action: A::Play,
                        ..
                    },
                    true
                ))
            )
        })
        .await;
        assert!(
            h.holds
                .has_unresolved_control_for_workspace(&h.panel.backend)
        );
        let act_post = h.http.accept().await;
        assert!(
            act_post.header.starts_with("POST ")
                && act_post
                    .header
                    .contains("/missions/msn_new/schedule-settings")
        );
        let act_req_id = act_post.body["requestID"].as_str().unwrap().to_owned();
        assert_eq!(act_post.body["expectedDocumentRevision"], 1);
        act_post
            .reply(
                200,
                json!({
                    "document": {
                        "revision": 2,
                        "scheduleActivation": {
                            "requestID": act_req_id,
                            "expectedRevision": 1,
                            "state": "ready"
                        }
                    }
                }),
            )
            .await;
        // Chains immediately into POST /missions/msn_new/schedule (action: play, expectedRevision: 2)
        h.pump(|_, hs| {
            matches!(
                hs.get(&k_new),
                Some((P::Control(r, false), true)) if r.action == A::Play
            )
        })
        .await;
        let play_post = h.http.accept().await;
        assert!(
            play_post.header.starts_with("POST ")
                && play_post.header.contains("/missions/msn_new/schedule")
        );
        assert_eq!(play_post.body["action"], "play");
        assert_eq!(play_post.body["expectedRevision"], 2);
        let play_rid = play_post.body["requestID"].as_str().unwrap().to_owned();
        let played_doc = row(
            "msn_new",
            "Unactivated",
            "running",
            3,
            &format!(
                r#"{{"requestID":"{play_rid}","expectedRevision":2,"action":"play","pending":false}}"#
            ),
        );
        play_post.reply(200, rdoc(played_doc.clone())).await;
        h.pump(|_, hs| matches!(hs.get(&k_new), Some((P::Publication(3), false))))
            .await;
        h.reply_lc(vec![played_doc, s1.clone()], true).await;
        h.pump(|_, hs| hs.get(&k_new).is_none()).await;

        // Tranche 2: Activation refused with exact notApplied releases hold and surfaces refusal + configFileID
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
        for _ in 0..2 {
            let req = h.http.accept().await;
            if req.header.contains("/capabilities") {
                req.reply(
                    200,
                    json!({"api":{"available":true},"enabled":false,"activation":{"available":true,"targets":[{"scope":"project","path":"/owned/.opencode/opencode.jsonc"}]}}),
                )
                .await;
            } else {
                req.reply(200, rdoc(lost_act.clone())).await;
            }
        }
        h.pump(|_, hs| {
            matches!(
                hs.get(&k_s1),
                Some((
                    P::Activation {
                        action: A::Resume,
                        ..
                    },
                    true
                ))
            )
        })
        .await;
        let ref_post = h.http.accept().await;
        assert!(
            ref_post.header.starts_with("POST ")
                && ref_post
                    .header
                    .contains("/missions/msn_s1/schedule-settings")
        );
        let ref_rid = ref_post.body["requestID"].as_str().unwrap().to_owned();
        ref_post
            .reply(
                403,
                json!({
                    "code": "schedule-activation-refused",
                    "refusal": {
                        "reason": "explicit-off",
                        "provenance": "automations-setting",
                        "layer": "global",
                        "path": "/home/.config/opencode/opencode.jsonc",
                        "openable": true,
                        "configFileID": "opencode-global-config-jsonc"
                    },
                    "notApplied": {"requestID": ref_rid, "expectedRevision": 7}
                }),
            )
            .await;
        h.pump(|p, hs| {
            hs.get(&k_s1).is_none()
                && p.schedules.feedback_for("msn_s1")
                    == Some("missions.scheduleList.activationRefused")
                && p.schedules
                    .refusal
                    .as_ref()
                    .and_then(|r| r.openable_config_id())
                    == Some("opencode-global-config-jsonc")
        })
        .await;
        // Drain refresh triggered by ActivationRefused event
        h.reply_lc(vec![s1.clone()], true).await;
        h.pump(|p, _| !p.schedules.loading() && p.schedules.is_fresh("msn_s1"))
            .await;

        // Tranche 2: Uncertain activation (503) keeps hold and reconciles via GET /schedule-settings (and handles 401)
        let mut need_act = s1.clone();
        need_act["scheduleActivation"] = Value::Null;
        assert!(h.act(G::Action(A::Resume)));
        for _ in 0..2 {
            let req = h.http.accept().await;
            if req.header.contains("/capabilities") {
                req.reply(200, cap_body(true)).await;
            } else {
                req.reply(200, rdoc(need_act.clone())).await;
            }
        }
        h.pump(|_, hs| {
            matches!(
                hs.get(&k_s1),
                Some((
                    P::Activation {
                        action: A::Resume,
                        ..
                    },
                    true
                ))
            )
        })
        .await;
        let unc_post = h.http.accept().await;
        let unc_rid = unc_post.body["requestID"].as_str().unwrap().to_owned();
        unc_post
            .reply(503, json!({"code": "schedule-activation-pending"}))
            .await;
        h.pump(|_, hs| matches!(hs.get(&k_s1), Some((P::Activation { .. }, false))))
            .await;
        h.reply_lc(vec![s1.clone()], true).await;
        h.pump(|p, _| !p.schedules.loading()).await;
        // Reconcile -> 401 preserves hold and routes to auth_expired
        assert!(h.act(G::Reconcile));
        let get_401 = h.http.accept().await;
        assert!(
            get_401.header.starts_with("GET ")
                && get_401
                    .header
                    .contains("/missions/msn_s1/schedule-settings")
        );
        get_401.reply(401, js(r#"{"error":"unauthorized"}"#)).await;
        h.pump(|_, hs| matches!(hs.get(&k_s1), Some((P::Activation { .. }, false))))
            .await;
        assert!(!h.auth_expired.is_empty());
        h.auth_expired.clear();
        // Reconcile -> 200 ready settles activation to Publication(8)
        assert!(h.act(G::Reconcile));
        let get_ok = h.http.accept().await;
        assert!(
            get_ok.header.starts_with("GET ")
                && get_ok.header.contains(&format!("requestID={unc_rid}"))
        );
        get_ok
            .reply(
                200,
                json!({
                    "document": {
                        "revision": 8,
                        "scheduleActivation": {
                            "requestID": unc_rid,
                            "expectedRevision": 7,
                            "state": "ready"
                        }
                    }
                }),
            )
            .await;
        h.pump(|_, hs| matches!(hs.get(&k_s1), Some((P::Publication(8), false))))
            .await;
        let s1_rev8_pub = row("msn_s1", "Alpha nightly", "paused", 8, "null");
        h.reply_lc(vec![s1_rev8_pub.clone()], true).await;
        h.pump(|p, hs| hs.get(&k_s1).is_none() && p.schedules.is_fresh("msn_s1"))
            .await;
        let s1 = s1_rev8_pub;

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
        fresh_req.reply(200, list(vec![s1.clone()], None)).await;
        h.pump(|p, _| !p.schedules.loading() && p.schedules.is_fresh("msn_s1"))
            .await;

        // R4 #2: pre-check returning rev 8 must not overwrite rev 9 already published in rows
        assert!(h.act(G::Action(A::Resume)));
        h.http.accept().await.reply(200, rdoc(s1.clone())).await;
        let cap_req = h.http.accept().await;
        let s1_rev9 =
            UnifiedSchedule::from_value(&row("msn_s1", "Alpha nightly", "paused", 9, "null"))
                .unwrap();
        *h.panel
            .schedules
            .rows
            .iter_mut()
            .find(|r| r.id == "msn_s1")
            .unwrap() = s1_rev9;
        cap_req.reply(200, cap_body(true)).await;
        h.pump(|p, _| p.schedules.feedback_for("msn_s1") == Some("missions.scheduleList.conflict"))
            .await;
        assert_eq!(
            h.panel
                .schedules
                .rows
                .iter()
                .find(|r| r.id == "msn_s1")
                .unwrap()
                .revision,
            9
        );
        assert!(h.holds.get(&h.key("msn_s1")).is_none());
        h.http.quiet().await;

        // R3 #1 / R4 #1: 401 decoded right as panel drops on tab close still reaches window-scoped ScheduleHolds
        h.panel.schedules.clear_selection();
        let (s, c) = h.panel.schedule_parts();
        s.refresh(c);
        let req = h.http.accept().await;
        let mut holds = h.holds;
        let done = h.done;
        let mut panel = h.panel;
        let sink = holds.auth_sink();
        req.reply(401, js(r#"{"error":"unauthorized"}"#)).await;
        wait_auth_sink(&sink, &done).await;
        panel.suspend();
        drop(panel);
        let (changed, _) = holds.poll(None, &[]);
        assert!(changed);
        assert_eq!(holds.drain_auth_expired().len(), 1);
    });
}

#[test]
fn capability_missing_blocks_calendar_launch_and_view_renders_controls() {
    let mut b = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
    b.workspace = "owned".into();
    let mut panel = Panel::new(b, Some("proj_1".into()), Reads::default(), Arc::new(|| {}))
        .with_owner_scope("/owned".into());
    let mut doc_v = row("msn_ui", "Nightly build", "paused", 5, "null");
    doc_v["observation"]["wakeCount"] = json!(9);
    doc_v["technical"] = json!({
        "cleanupPending": false,
        "carriers": [{
            "role": "principal",
            "slot": 0,
            "timeGeneration": 2,
            "sessionID": "ses_carrier_diag_1",
            "scheduleID": "sch_carrier_diag_1",
            "retiring": false,
            "cleanupPending": false
        }]
    });
    let doc = UnifiedSchedule::from_value(&doc_v).unwrap();
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
        "mission-schedule-diagnostics-toggle",
        "mission-schedule-diagnostics-info",
    ] {
        assert!(rt.find(key).is_some(), "missing {key}");
    }
    // Technical diagnostics are collapsed by default (no carrier session IDs visible before expanding).
    assert!(rt.find("mission-schedule-diagnostics").is_none());
    assert!(
        !rt.accessibility_json()
            .to_string()
            .contains("ses_carrier_diag_1")
    );

    rt.update(|s, _| {
        s.0.schedules.capability = Some(Cap::Refused);
        s.0.schedules.refusal = Some(codenomad_client::missions::ActivationRefusal {
            reason: "explicit-off".into(),
            provenance: "automations-setting".into(),
            layer: "global".into(),
            path: Some("/home/.config/opencode/opencode.jsonc".into()),
            openable: true,
            config_file_id: Some("opencode-global-config-jsonc".into()),
        });
        let _ =
            s.0.schedule_gesture("occ-1", &mut s.1, G::ToggleInstructions);
        let _ =
            s.0.schedule_gesture("occ-1", &mut s.1, G::ToggleDiagnostics);
    });
    rt.frame(0.01);
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("Nightly build")
            && tree.contains("Run nightly audit")
            && tree.contains(t("missions.scheduleList.activationRefused"))
            && tree.contains("ses_carrier_diag_1")
            && tree.contains("sch_carrier_diag_1")
    );
    assert!(rt.find("mission-schedule-diagnostics").is_some());
    assert!(rt.find("mission-schedule-open-settings").is_some());
    assert!(rt.find("mission-schedule-refusal-info").is_some());
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

#[test]
fn r1_continuation_epoch_same_tick_401_and_retained_proof_revisions() {
    crate::platform::block_on(async {
        let mut h = H::new().await;
        let mut s_a = row("msn_a", "Schedule A", "paused", 7, "null");
        s_a["availableActions"] = js(r#"["resume","delete"]"#);
        s_a["scheduleActivation"] =
            json!({"requestID": "act_prev_5", "expectedRevision": 5, "state": "ready"});
        let mut s_b = row("msn_b", "Schedule B", "paused", 3, "null");
        s_b["availableActions"] = js(r#"["play","delete"]"#);
        s_b["scheduleActivation"] = Value::Null;

        let (s, c) = h.panel.schedule_parts();
        s.show(true);
        s.refresh(c);
        h.http
            .accept()
            .await
            .reply(200, list(vec![s_a.clone(), s_b.clone()], None))
            .await;
        h.pump(|p, _| !p.schedules.loading() && p.schedules.rows.len() == 2)
            .await;

        // 1. A -> B -> A round-trip while activation is in flight revokes Play continuation
        assert!(h.act(G::Select("msn_b".into())));
        h.reply_lc(vec![s_a.clone(), s_b.clone()], true).await;
        h.pump(|p, _| {
            !p.schedules.loading()
                && p.schedules.is_fresh("msn_b")
                && p.schedules.capability == Some(Cap::Available)
        })
        .await;
        assert!(h.act(G::Action(A::Play)));
        for _ in 0..2 {
            let req = h.http.accept().await;
            if req.header.contains("/capabilities") {
                req.reply(200, cap_body(true)).await;
            } else {
                req.reply(200, rdoc(s_b.clone())).await;
            }
        }
        let kb = h.key("msn_b");
        h.pump(|_, hs| {
            matches!(
                hs.get(&kb),
                Some((
                    P::Activation {
                        action: A::Play,
                        ..
                    },
                    true
                ))
            )
        })
        .await;
        let act_b = h.http.accept().await;
        let rid_b = act_b.body["requestID"].as_str().unwrap().to_owned();
        // Switch B -> A -> B before activation returns
        assert!(h.act(G::Select("msn_a".into())));
        h.reply_lc(vec![s_a.clone(), s_b.clone()], true).await;
        h.pump(|p, _| {
            !p.schedules.loading()
                && p.schedules.is_fresh("msn_a")
                && p.schedules.capability == Some(Cap::Available)
        })
        .await;
        assert!(h.act(G::Select("msn_b".into())));
        h.reply_lc(vec![s_a.clone(), s_b.clone()], true).await;
        h.pump(|p, _| {
            !p.schedules.loading()
                && p.schedules.is_fresh("msn_b")
                && p.schedules.capability == Some(Cap::Available)
        })
        .await;
        act_b
            .reply(
                200,
                json!({"document": {"revision": 4, "scheduleActivation": {"requestID": rid_b, "expectedRevision": 3, "state": "ready"}}}),
            )
            .await;
        // Settles directly to Publication(4) without dispatching POST /missions/msn_b/schedule
        h.pump(|_, hs| matches!(hs.get(&kb), Some((P::Publication(4), false))))
            .await;
        let mut sb_rev4 = row("msn_b", "Schedule B", "paused", 4, "null");
        sb_rev4["availableActions"] = js(r#"["play","delete"]"#);
        sb_rev4["scheduleActivation"] = Value::Null;
        h.reply_lc(vec![s_a.clone(), sb_rev4.clone()], true).await;
        h.pump(|_, hs| hs.get(&kb).is_none()).await;
        h.http.quiet().await;

        // 2. Same-tick 401 in auth_sink blocks activation -> Play continuation
        let s_b2 = sb_rev4;
        assert!(h.act(G::Action(A::Play)));
        for _ in 0..2 {
            let req = h.http.accept().await;
            if req.header.contains("/capabilities") {
                req.reply(200, cap_body(true)).await;
            } else {
                req.reply(200, rdoc(s_b2.clone())).await;
            }
        }
        h.pump(|_, hs| matches!(hs.get(&kb), Some((P::Activation { .. }, true))))
            .await;
        let act_b2 = h.http.accept().await;
        let rid_b2 = act_b2.body["requestID"].as_str().unwrap().to_owned();
        act_b2
            .reply(
                200,
                json!({"document": {"revision": 5, "scheduleActivation": {"requestID": rid_b2, "expectedRevision": 4, "state": "ready"}}}),
            )
            .await;
        // Deposit a same-connection 401 into auth_sink in the exact poll tick that receives Ready
        for _ in 0..40 {
            super::push_auth_sink(&h.holds.auth_sink(), h.panel.backend.clone());
            let av = h.panel.active_schedule_view("occ-1");
            let (_, evs) = h.holds.poll(av.as_ref(), &[]);
            h.panel.apply_schedule_hold_events(&evs);
            if matches!(h.holds.get(&kb), Some((P::Publication(5), false))) {
                break;
            }
            let _ = tokio::time::timeout(std::time::Duration::from_millis(25), h.done.recv()).await;
        }
        assert!(matches!(h.holds.get(&kb), Some((P::Publication(5), false))));
        assert!(!h.holds.drain_auth_expired().is_empty());
        let sb_rev5 = row("msn_b", "Schedule B", "paused", 5, "null");
        h.reply_lc(vec![s_a.clone(), sb_rev5], true).await;
        h.pump(|_, hs| hs.get(&kb).is_none()).await;
        h.http.quiet().await;

        // 3. Retained R5 ready proof on R7 doc: POST sends rev 7, 403 notApplied rev 7 releases,
        //    and uncertain reconcile sends GET expectedDocumentRevision=5
        assert!(h.act(G::Select("msn_a".into())));
        let cap_act = json!({"api":{"available":true},"enabled":false,"activation":{"available":true,"targets":[{"scope":"project","path":"/owned/.opencode/opencode.jsonc"}]}});
        h.reply_lc_body(vec![s_a.clone()], cap_act.clone()).await;
        h.pump(|p, _| {
            !p.schedules.loading()
                && p.schedules.is_fresh("msn_a")
                && p.schedules.capability == Some(Cap::Activatable)
        })
        .await;
        assert!(h.act(G::Action(A::Resume)));
        for _ in 0..2 {
            let req = h.http.accept().await;
            if req.header.contains("/capabilities") {
                req.reply(200, cap_act.clone()).await;
            } else {
                req.reply(200, rdoc(s_a.clone())).await;
            }
        }
        let ka = h.key("msn_a");
        h.pump(|_, hs| {
            matches!(
                hs.get(&ka),
                Some((
                    P::Activation {
                        proof_expected_revision: 5,
                        ..
                    },
                    true
                ))
            )
        })
        .await;
        let act_a = h.http.accept().await;
        assert_eq!(act_a.body["requestID"], "act_prev_5");
        assert_eq!(act_a.body["expectedDocumentRevision"], 7);
        act_a
            .reply(
                403,
                json!({
                    "code": "schedule-activation-refused",
                    "refusal": {"reason": "explicit-off", "layer": "global", "openable": true, "configFileID": "opencode-global-config"},
                    "notApplied": {"requestID": "act_prev_5", "expectedRevision": 7}
                }),
            )
            .await;
        h.pump(|p, hs| {
            hs.get(&ka).is_none()
                && p.schedules.feedback_for("msn_a")
                    == Some("missions.scheduleList.activationRefused")
        })
        .await;
        h.reply_lc_body(vec![s_a.clone()], cap_act.clone()).await;
        h.pump(|p, _| {
            !p.schedules.loading()
                && p.schedules.is_fresh("msn_a")
                && p.schedules.capability == Some(Cap::Activatable)
        })
        .await;

        // Uncertain POST on retained R5 proof -> GET /schedule-settings sends expectedDocumentRevision=5
        assert!(h.act(G::Action(A::Resume)));
        for _ in 0..2 {
            let req = h.http.accept().await;
            if req.header.contains("/capabilities") {
                req.reply(200, cap_act.clone()).await;
            } else {
                req.reply(200, rdoc(s_a.clone())).await;
            }
        }
        h.pump(|_, hs| matches!(hs.get(&ka), Some((P::Activation { .. }, true))))
            .await;
        let act_a2 = h.http.accept().await;
        assert_eq!(act_a2.body["requestID"], "act_prev_5");
        assert_eq!(act_a2.body["expectedDocumentRevision"], 7);
        act_a2
            .reply(503, json!({"code": "schedule-activation-pending"}))
            .await;
        h.pump(|_, hs| matches!(hs.get(&ka), Some((P::Activation { .. }, false))))
            .await;
        h.reply_lc_body(vec![s_a.clone()], cap_act).await;
        h.pump(|p, _| !p.schedules.loading() && p.schedules.capability == Some(Cap::Activatable))
            .await;
        assert!(h.act(G::Reconcile));
        let rec_get = h.http.accept().await;
        assert!(
            rec_get.header.starts_with("GET ")
                && rec_get.header.contains("requestID=act_prev_5")
                && rec_get.header.contains("expectedDocumentRevision=5")
        );
        rec_get
            .reply(
                200,
                json!({"document": {"revision": 7, "scheduleActivation": {"requestID": "act_prev_5", "expectedRevision": 5, "state": "ready"}}}),
            )
            .await;
        h.pump(|_, hs| matches!(hs.get(&ka), Some((P::Publication(7), false))))
            .await;
        h.reply_lc(vec![s_a], true).await;
        h.pump(|_, hs| hs.get(&ka).is_none()).await;

        // 4. Opening the Mission editor while activation is in flight revokes Play continuation
        //    and rebind clears open diagnostics disclosures
        let mut s_c = row("msn_c", "Schedule C", "paused", 2, "null");
        s_c["availableActions"] = js(r#"["play","delete"]"#);
        s_c["scheduleActivation"] = Value::Null;
        assert!(h.act(G::Select("msn_c".into())));
        h.reply_lc(vec![s_c.clone()], true).await;
        h.pump(|p, _| {
            !p.schedules.loading()
                && p.schedules.is_fresh("msn_c")
                && p.schedules.capability == Some(Cap::Available)
        })
        .await;
        assert!(h.act(G::ToggleDiagnostics));
        assert!(h.act(G::ToggleDiagnosticsInfo));
        assert!(h.panel.schedules.diagnostics_open.contains("msn_c"));
        assert!(h.panel.schedules.diagnostics_info_open.contains("msn_c"));
        assert!(h.act(G::Action(A::Play)));
        for _ in 0..2 {
            let req = h.http.accept().await;
            if req.header.contains("/capabilities") {
                req.reply(200, cap_body(true)).await;
            } else {
                req.reply(200, rdoc(s_c.clone())).await;
            }
        }
        let kc = h.key("msn_c");
        h.pump(|_, hs| {
            matches!(
                hs.get(&kc),
                Some((
                    P::Activation {
                        action: A::Play,
                        ..
                    },
                    true
                ))
            )
        })
        .await;
        let act_c = h.http.accept().await;
        let rid_c = act_c.body["requestID"].as_str().unwrap().to_owned();
        let mut editor_holds = crate::missions::EditorHolds::default();
        h.panel.open_create_editor(&mut editor_holds, None);
        assert!(h.panel.active_schedule_view("occ-1").is_none());
        act_c
            .reply(
                200,
                json!({"document": {"revision": 3, "scheduleActivation": {"requestID": rid_c, "expectedRevision": 2, "state": "ready"}}}),
            )
            .await;
        h.pump(|_, hs| matches!(hs.get(&kc), Some((P::Publication(3), false))))
            .await;
        let sc_rev3 = row("msn_c", "Schedule C", "paused", 3, "null");
        let (mut saw_list, mut saw_cap) = (false, false);
        for _ in 0..8 {
            let Ok(req) =
                tokio::time::timeout(std::time::Duration::from_millis(120), h.http.accept()).await
            else {
                if saw_list && saw_cap {
                    break;
                }
                continue;
            };
            assert!(
                !req.header.starts_with("POST "),
                "unexpected POST after editor opened: {}",
                req.header
            );
            if req.header.contains("/capabilities") {
                saw_cap = true;
                req.reply(200, cap_body(true)).await;
            } else if req.header.contains("/scheduled") {
                saw_list = true;
                req.reply(200, list(vec![sc_rev3.clone()], None)).await;
            } else {
                req.reply(200, json!({})).await;
            }
            if saw_list && saw_cap {
                break;
            }
        }
        assert!(saw_list && saw_cap);
        h.pump(|_, hs| hs.get(&kc).is_none()).await;

        h.panel.schedules.rebind();
        assert!(h.panel.schedules.diagnostics_open.is_empty());
        assert!(h.panel.schedules.diagnostics_info_open.is_empty());
        assert!(h.panel.schedules.instructions_open.is_empty());
    });
}

#[test]
fn late_sibling_401_between_collect_and_apply_blocks_activation_play() {
    crate::platform::block_on(async {
        let mut h = H::new().await;
        let mut s_a = row("msn_a", "Schedule A", "paused", 2, "null");
        s_a["availableActions"] = js(r#"["play","delete"]"#);
        s_a["scheduleActivation"] = Value::Null;
        let mut s_b = row("msn_b", "Schedule B", "running", 3, "null");
        s_b["availableActions"] = js(r#"["pause","delete"]"#);

        let (s, c) = h.panel.schedule_parts();
        s.show(true);
        s.refresh(c);
        h.http
            .accept()
            .await
            .reply(200, list(vec![s_a.clone(), s_b.clone()], None))
            .await;
        h.pump(|p, _| !p.schedules.loading() && p.schedules.rows.len() == 2)
            .await;

        // Start a Pause control on msn_b and leave its HTTP request open.
        assert!(h.act(G::Select("msn_b".into())));
        h.reply_lc(vec![s_a.clone(), s_b.clone()], true).await;
        h.pump(|p, _| {
            !p.schedules.loading()
                && p.schedules.is_fresh("msn_b")
                && p.schedules.capability == Some(Cap::Available)
        })
        .await;
        assert!(h.act(G::Action(A::Pause)));
        h.http.accept().await.reply(200, rdoc(s_b.clone())).await;
        let kb = h.key("msn_b");
        h.pump(|_, hs| matches!(hs.get(&kb), Some((P::Control(_, false), true))))
            .await;
        let ctrl_b = h.http.accept().await;

        // Switch to msn_a and start Play activation while msn_b's control is still in flight.
        assert!(h.act(G::Select("msn_a".into())));
        h.reply_lc(vec![s_a.clone(), s_b.clone()], true).await;
        h.pump(|p, _| {
            !p.schedules.loading()
                && p.schedules.is_fresh("msn_a")
                && p.schedules.capability == Some(Cap::Available)
        })
        .await;
        assert!(h.act(G::Action(A::Play)));
        for _ in 0..2 {
            let req = h.http.accept().await;
            if req.header.contains("/capabilities") {
                req.reply(200, cap_body(true)).await;
            } else {
                req.reply(200, rdoc(s_a.clone())).await;
            }
        }
        let ka = h.key("msn_a");
        h.pump(|_, hs| {
            matches!(
                hs.get(&ka),
                Some((
                    P::Activation {
                        action: A::Play,
                        ..
                    },
                    true
                ))
            )
        })
        .await;
        let act_a = h.http.accept().await;
        let rid_a = act_a.body["requestID"].as_str().unwrap().to_owned();

        // Activation replies Ready first and is collected by collect_ready.
        act_a
            .reply(
                200,
                json!({"document": {"revision": 3, "scheduleActivation": {"requestID": rid_a, "expectedRevision": 2, "state": "ready"}}}),
            )
            .await;
        let mut exp = Vec::new();
        let ready = loop {
            let (changed, ready) = h.holds.collect_ready(&mut exp);
            if changed {
                break ready;
            }
            let _ = tokio::time::timeout(std::time::Duration::from_millis(25), h.done.recv()).await;
        };
        assert!(exp.is_empty());

        // Sibling control returns 401 AFTER collect_ready and BEFORE apply_ready.
        assert!(h.holds.auth_sink().lock().unwrap().pending.is_empty());
        ctrl_b.reply(401, json!({"error": "unauthorized"})).await;
        wait_auth_sink(&h.holds.auth_sink(), &h.done).await;

        let av = h.panel.active_schedule_view("occ-1");
        assert!(av.is_some());
        let (_, evs) = h.holds.apply_ready(ready, av.as_ref(), &exp);
        h.panel.apply_schedule_hold_events(&evs);

        // Must settle to Publication(3) without chaining POST /missions/msn_a/schedule.
        assert!(matches!(h.holds.get(&ka), Some((P::Publication(3), false))));
        assert!(!h.holds.drain_auth_expired().is_empty());
        let sa_rev3 = row("msn_a", "Schedule A", "paused", 3, "null");
        h.reply_lc(vec![sa_rev3, s_b.clone()], true).await;
        h.pump(|_, hs| hs.get(&ka).is_none()).await;
        h.http.quiet().await;

        // AuthSink epoch detects same-connection 401s even after pending is drained.
        let sink = h.holds.auth_sink();
        let (_, ep0) = super::take_auth_sink(&sink);
        assert!(!super::has_auth_since(&sink, ep0, &h.panel.backend));
        super::push_auth_sink(&sink, h.panel.backend.clone());
        let (drained, _) = super::take_auth_sink(&sink);
        assert_eq!(drained.len(), 1);
        assert!(super::has_auth_since(&sink, ep0, &h.panel.backend));

        // Retiring a workspace while a control is in flight must still wake and deliver 401 once.
        let h2 = H::new().await;
        let mut holds2 = ScheduleHolds::default();
        let (ctrl_tx, ctrl_rx) = bounded::<()>(4);
        let ctrl_wake: Wake = Arc::new(move || {
            let _ = ctrl_tx.try_send(());
        });
        let doc_b = UnifiedSchedule::from_value(&s_b).unwrap();
        let kb2 = h2.key("msn_b");
        let req_b =
            codenomad_client::missions::ScheduleControlRequest::new(A::Pause, 3, None).unwrap();
        let mut ctx2 = h2.panel.schedule_ctx();
        ctx2.wake = &ctrl_wake;
        assert!(holds2.dispatch_control(kb2.clone(), "occ-1".into(), 0, req_b, doc_b, ctx2));
        let ctrl_ret = h2.http.accept().await;
        assert!(ctrl_rx.try_recv().is_err());
        holds2.retire_workspace(&h2.panel.backend);
        assert!(holds2.get(&kb2).is_none());
        ctrl_ret.reply(401, json!({"error": "unauthorized"})).await;
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(2), ctrl_rx.recv())
                .await
                .is_ok(),
            "401 after hold retirement must still wake UI"
        );
        assert_eq!(holds2.drain_auth_expired().len(), 1);
        assert!(holds2.drain_auth_expired().is_empty());
    });
}

#[test]
fn evicted_offpage_selection_shows_retry_and_clears_error_on_more_and_prunes_disclosures() {
    crate::platform::block_on(async {
        let mut h = H::new().await;
        let s1 = row("msn_1", "Page One", "paused", 1, "null");
        let s2 = row("msn_2", "Page Two", "paused", 1, "null");
        let (s, c) = h.panel.schedule_parts();
        s.show(true);
        s.refresh(c);
        let first = h.http.accept().await;
        first
            .reply(200, list(vec![s1.clone()], Some("msn_1")))
            .await;
        h.pump(|p, _| !p.schedules.loading() && p.schedules.rows.len() == 1)
            .await;

        // Load page 2 via More, select msn_2, and open instructions + diagnostics disclosures.
        assert!(h.act(G::More));
        let second = h.http.accept().await;
        second.reply(200, list(vec![s2.clone()], None)).await;
        h.pump(|p, _| !p.schedules.loading() && p.schedules.rows.len() == 2)
            .await;

        assert!(h.act(G::Select("msn_2".into())));
        let (r1, r2) = (h.http.accept().await, h.http.accept().await);
        for req in [r1, r2] {
            if req.header.contains("/capabilities") {
                req.reply(200, cap_body(true)).await;
            } else {
                req.reply(200, list(vec![s1.clone()], Some("msn_1"))).await;
            }
        }
        h.pump(|p, _| !p.schedules.loading() && p.schedules.capability.is_some())
            .await;
        let pt = h.http.accept().await;
        assert!(pt.header.contains("/missions/msn_2/schedule"));
        pt.reply(200, rdoc(s2.clone())).await;
        h.pump(|p, _| p.schedules.is_fresh("msn_2")).await;

        assert!(h.act(G::ToggleInstructions));
        assert!(h.act(G::ToggleDiagnostics));
        assert!(h.panel.schedules.retained_bytes() > 0);

        // Suspend and evict under M7 pressure: rows + disclosures must drop to 0 bytes.
        h.panel.suspend();
        let evicted = h.panel.evict_inactive_caches();
        assert!(evicted > 0);
        assert_eq!(h.panel.schedules.retained_bytes(), 0);
        assert!(h.panel.schedules.instructions_open.is_empty());
        assert!(h.panel.schedules.diagnostics_open.is_empty());
        assert_eq!(h.panel.schedules.selected.as_deref(), Some("msn_2"));

        // Return to tab: page 1 succeeds, off-page point-read fails with 503.
        let (s, c) = h.panel.schedule_parts();
        s.show(true);
        s.refresh(c);
        let (r1, r2) = (h.http.accept().await, h.http.accept().await);
        for req in [r1, r2] {
            if req.header.contains("/capabilities") {
                req.reply(200, cap_body(true)).await;
            } else {
                req.reply(200, list(vec![s1.clone()], Some("msn_1"))).await;
            }
        }
        h.pump(|p, _| !p.schedules.loading()).await;
        let pt_fail = h.http.accept().await;
        assert!(pt_fail.header.contains("/missions/msn_2/schedule"));
        pt_fail.reply(503, json!({"error": "unavailable"})).await;
        h.pump(|p, _| p.schedules.selection_error == Some(super::list::SelectionError::Failed))
            .await;

        // Detail region must stay visible with error alert and targeted Retry button.
        let mut rt = rune::Runtime::new(
            h,
            |h, _| {
                let Some(el) =
                    super::view::detail_section(&h.panel, &h.holds, |_: &mut H, _, _| {})
                else {
                    panic!("expected detail_section with Retry on point-read 503");
                };
                el
            },
            (480.0, 400.0),
            rune::Env::default(),
        );
        rt.frame(0.0);
        let tree = rt.accessibility_json().to_string();
        assert!(
            tree.contains("\"role\":\"alert\""),
            "expected alert role on failed point-read detail: {tree}"
        );
        assert!(
            rt.elements()
                .iter()
                .any(|n| n.key.as_deref() == Some("mission-schedule-retry-selection")),
            "expected RetrySelection button in detail view"
        );
        let mut h = rt.state;

        // Targeted retry issues a new point-read; failing again keeps selection_error,
        // then loading page 2 via More brings msn_2 back and clears the stale error.
        assert!(h.act(G::RetrySelection));
        let pt_retry = h.http.accept().await;
        assert!(pt_retry.header.contains("/missions/msn_2/schedule"));
        pt_retry.reply(503, json!({"error": "unavailable"})).await;
        h.pump(|p, _| p.schedules.selection_error == Some(super::list::SelectionError::Failed))
            .await;

        assert!(h.act(G::More));
        let more_req = h.http.accept().await;
        more_req.reply(200, list(vec![s2.clone()], None)).await;
        h.pump(|p, _| !p.schedules.loading() && p.schedules.rows.len() == 2)
            .await;
        assert_eq!(h.panel.schedules.selection_error, None);
        assert!(h.panel.schedules.is_fresh("msn_2"));
    });
}
