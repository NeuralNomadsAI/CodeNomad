use super::delivery::*;
use super::projection::*;
use super::*;
use crate::missions::activity::ojson;

#[test]
fn admission_preserves_full_target_map_and_project_damage_without_other_missions() {
    let target = json!({"id":"msn_target","tasks":[{"brief":"full"}],"actors":[]});
    let snapshot = json!({"projectID":"project","version":1,"generatedAt":10,"controlUnavailable":true,
        "cleanupUnavailable":true,"notificationUnavailable":false,"missions":[{"id":"msn_other"},target],
        "cleanups":[{"missionID":"msn_target"},{"missionID":"msn_other"}]});
    assert_eq!(
        admission_projection(&snapshot, &json!("msn_target")),
        json!({
            "available":true,"version":1,"projectID":"project","generatedAt":10,"controlUnavailable":true,
            "cleanupUnavailable":true,"mission":target,"cleanups":[{"missionID":"msn_target"}]
        })
    );
    assert!(admission_projection(&snapshot, &json!("msn_missing")).get("mission").is_none());
}

#[tokio::test]
async fn stream_large_bytes_holds_budget_until_drain_and_releases_on_stall_timeout() {
    use futures_util::StreamExt;
    let budget = Arc::new(tokio::sync::Semaphore::new(4));
    let permit = budget.clone().try_acquire_many_owned(3).unwrap();
    let payload = vec![b'x'; 256 * 1024 + 17];
    let response = stream_large_bytes(payload.clone(), permit, Duration::from_secs(5), Duration::from_secs(30));
    assert_eq!(budget.available_permits(), 1);
    let mut stream = response.into_body().into_data_stream();
    let first = stream.next().await.unwrap().unwrap();
    assert_eq!(first.len(), LARGE_RESPONSE_CHUNK);
    let mut collected = first.to_vec();
    while let Some(chunk) = stream.next().await {
        collected.extend_from_slice(&chunk.unwrap());
    }
    assert_eq!(collected, payload);
    tokio::task::yield_now().await;
    assert_eq!(budget.available_permits(), 4, "budget must release once body finishes");
    // Chunks are copied into independent 64 KiB allocations, so holding `first` does not
    // retain the full backing buffer.
    assert_eq!(first.len(), LARGE_RESPONSE_CHUNK);

    // Stalled client: channel holds 2 chunks (128 KiB); chunk 3 blocks and times out cleanly.
    let stall_permit = budget.clone().try_acquire_many_owned(3).unwrap();
    let stalled = stream_large_bytes(
        vec![b'y'; 256 * 1024],
        stall_permit,
        Duration::from_millis(40),
        Duration::from_secs(5),
    );
    assert_eq!(budget.available_permits(), 1);
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(budget.available_permits(), 4, "budget must release after stall timeout");
    drop(stalled);

    // Slow-trickling client: total deadline fires even when individual chunks arrive within chunk_timeout.
    let trickle_permit = budget.clone().try_acquire_many_owned(3).unwrap();
    let trickled = stream_large_bytes(
        vec![b'z'; 512 * 1024],
        trickle_permit,
        Duration::from_secs(5),
        Duration::from_millis(60),
    );
    assert_eq!(budget.available_permits(), 1);
    let mut slow_stream = trickled.into_body().into_data_stream();
    let _ = slow_stream.next().await;
    tokio::time::sleep(Duration::from_millis(110)).await;
    while let Some(item) = slow_stream.next().await {
        if item.is_err() {
            break;
        }
    }
    tokio::task::yield_now().await;
    assert_eq!(budget.available_permits(), 4, "budget must release after total deadline");
}

#[test]
fn project_snapshot_bytes_streams_target_and_compacts_preserving_wire_key_order() {
    let raw_mode = r#"{"kind":"independent","reason":"lifetime","explanation":"Needs isolated root"}"#;
    let snapshot = format!(
        r#"{{"output":{{"version":1,"projectID":"prj_1","generatedAt":10,"controlUnavailable":true,"missions":[{{"id":"msn_other","projectID":"prj_1","projectCanonical":"/repo","tasks":[{{"brief":"huge other"}}]}},{{"version":1,"id":"msn_target","projectID":"prj_1","projectCanonical":"/repo","objective":"Obj","template":"custom","status":"active","runState":"running","coordinatorSessionId":"ses_coord","revision":1,"actors":[],"tasks":[{{"id":"tsk_1","key":"k1","title":"T1","brief":"B1","role":"specialist","blockedBy":[],"status":"ready","executionMode":{raw_mode},"createdAt":1,"updatedAt":1}}],"reports":[],"frontier":[],"claims":[],"createdAt":1,"updatedAt":1,"history":[],"historyTruncated":false}}],"cleanups":[{{"missionID":"msn_other"}},{{"missionID":"msn_target","deletionId":"del_1"}}]}}}}"#
    );
    let full_bytes = project_snapshot_bytes(snapshot.as_bytes(), "msn_target", "prj_1", "/repo", false).unwrap();
    let full: Value = serde_json::from_slice(&full_bytes).unwrap();
    assert_eq!(full["mission"]["objective"], "Obj");
    assert_eq!(full["cleanups"].as_array().unwrap().len(), 1);
    assert_eq!(full["controlUnavailable"], true);

    let compact_bytes = project_snapshot_bytes(snapshot.as_bytes(), "msn_target", "prj_1", "/repo", true).unwrap();
    let compact: Value = serde_json::from_slice(&compact_bytes).unwrap();
    assert!(compact["mission"].get("objective").is_none());
    assert_eq!(
        compact["mission"]["tasks"][0]["bodies"]["executionMode"]["digest"],
        ojson::content_digest(raw_mode)
    );

    // Escaped Windows paths with backslashes and quotes must decode cleanly.
    let win_path = r#"C:\repo\quoted"dir"#;
    let win_path_json = serde_json::to_string(win_path).unwrap();
    let win_snapshot = format!(
        r#"{{"output":{{"version":1,"projectID":"prj_1","generatedAt":10,"missions":[{{"id":"msn_other","projectID":"prj_1","projectCanonical":{win_path_json}}},{{"version":1,"id":"msn_target","projectID":"prj_1","projectCanonical":{win_path_json},"objective":"Win","template":"custom","status":"active","runState":"running","coordinatorSessionId":"ses_coord","revision":1,"actors":[],"tasks":[],"reports":[],"frontier":[],"claims":[],"createdAt":1,"updatedAt":1,"history":[],"historyTruncated":false}}],"cleanups":[]}}}}"#
    );
    let win_bytes = project_snapshot_bytes(win_snapshot.as_bytes(), "msn_target", "prj_1", win_path, false).unwrap();
    let win_val: Value = serde_json::from_slice(&win_bytes).unwrap();
    assert_eq!(win_val["mission"]["objective"], "Win");
}

#[tokio::test]
async fn mutation_response_budget_allows_concurrent_mutation_while_large_response_streams() {
    let budget = Arc::new(tokio::sync::Semaphore::new(MUTATION_RESPONSE_BUDGET_UNITS));
    let first = budget.clone().acquire_many_owned(LARGE_RESPONSE_BUDGET_UNITS as u32).await.unwrap();
    // Deliver a >4 MiB mutation response that keeps streaming while still holding its units.
    let payload = vec![b'x'; LARGE_RESPONSE_THRESHOLD + 64 * 1024];
    let _streaming_response = deliver_admitted_json_bytes(payload, first);
    // An unrelated large-capable mutation must still be able to reserve its full 128 MiB cap immediately.
    let second = budget
        .clone()
        .try_acquire_many_owned(LARGE_RESPONSE_BUDGET_UNITS as u32)
        .expect("second mutation must not block behind a streaming large response");
    drop(second);
}

#[tokio::test]
async fn encode_json_bytes_holding_keeps_permit_inside_blocking_task() {
    let sem = Arc::new(tokio::sync::Semaphore::new(1));
    let permit = sem.clone().acquire_owned().await.unwrap();
    assert_eq!(sem.available_permits(), 0);
    let (bytes, returned) = encode_json_bytes_holding(json!({"ok": true}), permit, true, false).await.unwrap();
    assert_eq!(sem.available_permits(), 0, "permit must stay held until caller drops it");
    assert_eq!(bytes, br#"{"ok":true}"#);
    drop(returned);
    assert_eq!(sem.available_permits(), 1);
}

#[tokio::test]
async fn native_read_rpc_holding_detects_missing_method_only_and_rejects_rpc_unavailable() {
    use axum::{Router, routing::post};
    let router = Router::new()
        .route(
            "/api/rpc/codenomad.missions/mission",
            post(|| async {
                (
                    Status::BAD_REQUEST,
                    Json(json!({
                        "_tag": "RpcError",
                        "type": "rpc.method_not_found",
                        "message": "Unknown RPC method: mission"
                    })),
                )
            }),
        )
        .route(
            "/api/rpc/codenomad.missions/unavailable",
            post(|| async {
                (
                    Status::BAD_REQUEST,
                    Json(json!({
                        "_tag": "RpcError",
                        "type": "rpc.unavailable",
                        "message": "Plugin temporarily unavailable"
                    })),
                )
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let endpoint = opencode::Endpoint {
        url: reqwest::Url::parse(&format!("http://{addr}/")).unwrap(),
        password: "secret".into(),
        version: String::new(),
        pid: 0,
    };
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let sem = Arc::new(tokio::sync::Semaphore::new(1));
    let permit = sem.clone().acquire_owned().await.unwrap();
    let res = native_read_rpc_with_client(
        &client,
        &endpoint,
        Method::POST,
        "/api/rpc/codenomad.missions/mission",
        "/fixture",
        Some(json!({"input": {"missionID": "msn_1"}})),
        4096,
        true,
        permit,
    )
    .await;
    match res {
        Err(NativeRpcError::Absent(returned)) => {
            assert_eq!(sem.available_permits(), 0);
            drop(returned);
            assert_eq!(sem.available_permits(), 1);
        }
        _ => panic!("expected NativeRpcError::Absent for rpc.method_not_found"),
    }
    let permit = sem.clone().acquire_owned().await.unwrap();
    let res = native_read_rpc_with_client(
        &client,
        &endpoint,
        Method::POST,
        "/api/rpc/codenomad.missions/unavailable",
        "/fixture",
        Some(json!({"input": {"missionID": "msn_1"}})),
        4096,
        true,
        permit,
    )
    .await;
    assert!(matches!(res, Err(NativeRpcError::Failed)), "rpc.unavailable must not fall back to snapshot");
    assert_eq!(sem.available_permits(), 1);
    server.abort();
}
