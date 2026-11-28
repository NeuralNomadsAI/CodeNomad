use super::*;
use serde_json::json;

#[test]
fn stats_reconnect_adopts_the_other_windows_saved_period_and_totals_together() {
    for cache_first in [true, false] {
        let mut a = pending();
        let a_proof = proof("owner", Some("root"), "old");
        a.days = Some(7);
        a.snapshot = Some(snapshot(7, a_proof));
        let b_proof = proof("owner", Some("root"), "new");
        let cache = Reply::Cache(Some(Cached {
            days: 90,
            snapshot: Some(snapshot(90, b_proof.clone())),
            proof: b_proof,
        }));
        if cache_first {
            a.receive(cache, 1.0);
            assert_eq!(a.days, Some(90));
            assert_eq!(a.snapshot.as_ref().unwrap().days(), 90);
            a.receive(Reply::Fresh(None), 2.0);
        } else {
            a.receive(Reply::Fresh(None), 1.0);
            assert_eq!(a.days, Some(7));
            assert_eq!(a.snapshot.as_ref().unwrap().days(), 7);
            a.receive(cache, 2.0);
        }
        assert!(a.failed);
        assert_eq!(a.days, Some(90));
        assert_eq!(a.snapshot.as_ref().unwrap().days(), 90);
        assert_eq!(
            a.snapshot.as_ref().unwrap().proof.connection.as_deref(),
            Some("new")
        );
    }
}

fn proof(owner: &str, identity: Option<&str>, connection: &str) -> Proof {
    Proof {
        owner: Some(owner.into()),
        identity: identity.map(str::to_owned),
        connection: Some(connection.into()),
    }
}

fn snapshot(days: u32, proof: Proof) -> Snapshot {
    let mut value: Snapshot = serde_json::from_value(json!({
        "scope": "service",
        "stats": {
            "range": {"from": 1, "to": 1 + stats::DAY * u64::from(days)},
            "sessions": 2, "subagents": 1, "prompts": 2, "steps": 3,
            "tokens": {"input": 12345, "output": 8, "reasoning": 4, "cache": {"read": 1, "write": 2}},
            "cost": 0.0025, "activeDays": 1, "streak": 1, "models": [], "activity": []
        }
    })).unwrap();
    value.proof = proof;
    value
}

fn pending() -> Dashboard {
    let (cancel, _) = bounded(1);
    let (_, replies) = bounded(3);
    Dashboard {
        busy: true,
        flight: Some(Flight {
            cancel,
            replies,
            observed: 0,
            fresh: false,
            rejected: false,
            proof: Proof::default(),
        }),
        ..Dashboard::default()
    }
}

#[test]
fn stats_fresh_wins_and_only_same_connection_can_enrich_identity() {
    let mut d = pending();
    d.receive(
        Reply::Fresh(Some(snapshot(90, proof("same", None, "live")))),
        8.0,
    );
    for (connection, expected) in [("old", None), ("live", Some("root"))] {
        let proof = proof("same", Some("root"), connection);
        d.receive(
            Reply::Cache(Some(Cached {
                days: 7,
                snapshot: Some(snapshot(7, proof.clone())),
                proof,
            })),
            9.0,
        );
        assert_eq!(d.days, Some(90));
        assert_eq!(d.snapshot.as_ref().unwrap().days(), 90);
        assert_eq!(
            d.snapshot.as_ref().unwrap().proof.identity.as_deref(),
            expected
        );
    }
}

#[test]
fn stats_reconnect_retires_unidentified_values_and_rejects_conflicting_fresh() {
    let mut d = pending();
    d.snapshot = Some(snapshot(30, proof("owner", None, "stopped")));
    d.receive(Reply::Owner(Some(proof("owner", None, "live"))), 1.0);
    assert!(d.snapshot.is_none());
    d.receive(
        Reply::Fresh(Some(snapshot(
            30,
            proof("foreign", Some("elsewhere"), "other"),
        ))),
        2.0,
    );
    d.receive(
        Reply::Cache(Some(Cached {
            days: 30,
            proof: proof("owner", Some("root"), "live"),
            snapshot: Some(snapshot(30, proof("owner", Some("root"), "live"))),
        })),
        3.0,
    );
    assert!(d.failed && d.stale && !d.busy && d.snapshot.is_none());
}

#[test]
fn stats_owner_error_preserves_cache_and_activity_coalesces_after_settlement() {
    let mut d = pending();
    let proof = proof("owner", Some("root"), "live");
    d.receive(
        Reply::Cache(Some(Cached {
            days: 7,
            snapshot: Some(snapshot(7, proof.clone())),
            proof,
        })),
        2.0,
    );
    d.invalidate(3.0);
    d.invalidate(4.0);
    d.receive(Reply::Fresh(None), 5.0);
    assert_eq!(d.days, Some(7));
    assert_eq!(d.due, Some(10.0));
    assert!(d.failed && d.stale && d.snapshot.is_some());
    d.select(365);
    assert_eq!(d.days, Some(365));
    assert_eq!(d.due, Some(0.0));
    assert!(d.flight.is_none() && d.snapshot.is_none());
}

#[test]
fn stats_view_renders_metrics_and_error_alert_in_both_themes() {
    for dark in [false, true] {
        let mut dashboard = Dashboard::default();
        dashboard.scope = Some(("owner".into(), "ws-1".into()));
        dashboard.days = Some(30);
        dashboard.failed = true;
        dashboard.snapshot = Some(snapshot(30, proof("owner", Some("root"), "live")));
        let mut rt = rune::Runtime::new(
            (dark, dashboard),
            |(dark, stats), cx| {
                rune_theme_codenomad::settings::render(cx, *dark, None, |cx| {
                    crate::strings::with_locale("en", || {
                        let mut layers = Vec::new();
                        let body = view::view(cx, stats, &mut layers, |s| Some(&mut s.1));
                        rune_theme_codenomad::layout::with_overlays(body, layers)
                    })
                })
            },
            (840.0, 760.0),
            rune::Env::new(dark, 1.0),
        );
        rt.frame(0.02);
        let tree = rt.accessibility_json().to_string();
        assert!(tree.contains("\"role\":\"alert\""), "dark={dark}");
        assert!(tree.contains("\"role\":\"table\""), "dark={dark}");
        assert!(rt.find("stats-refresh").is_some(), "dark={dark}");
    }
}
