use super::*;
use serde_json::json;

#[test]
fn received_credentials_revoke_quota_authority_before_a_full_recovery_queue() {
    use futures_lite::{
        StreamExt,
        future::{poll_once, zip},
    };
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
            backend.workspace = "project".into();
            let (out, recovery) = crate::bounded(1);
            let (events, _display) = crate::bounded(4);
            let watch = crate::provider_usage::Watch::default();
            let state = State::observing_preferences(events, Arc::new(|| {}))
                .with_provider_usage(Some(watch.clone()));
            let payload = |kind| {
                json!({
                    "type":"instance.event", "instanceId":"project", "event":{"type":kind}
                })
            };
            let chunk = |kind| format!("data: {}\n\n", payload(kind));
            let (bytes, chunks) = crate::bounded(1);
            let mut routed = std::pin::pin!(native::read_frames(
                &backend,
                1,
                &out,
                &state,
                "stream",
                chunks.map(Ok),
            ));
            bytes
                .send(chunk("provider.updated").into_bytes())
                .await
                .unwrap();
            assert!(poll_once(&mut routed).await.is_none());
            assert!(out.is_full());
            let before = watch.current();
            assert!(before.1);
            bytes
                .send(chunk("credential.switched").into_bytes())
                .await
                .unwrap();
            assert!(poll_once(&mut routed).await.is_none());
            assert_eq!(watch.current(), (before.0 + 1, true, before.2));
            let switched = watch.current();
            bytes.send(chunk("irrelevant").into_bytes()).await.unwrap();
            assert!(poll_once(&mut routed).await.is_none());
            assert!(watch.backpressured());
            assert_eq!(watch.current(), switched);
            drop(bytes);
            assert!(matches!(recovery.try_recv().unwrap(), Input::Opened(1)));
            let drain = async {
                assert!(matches!(
                    recovery.recv().await.unwrap(),
                    Input::Workspace(_, WorkspaceEvent::ProviderUsageRefresh(_))
                ));
                for _ in 0..2 {
                    assert!(matches!(
                        recovery.recv().await.unwrap(),
                        Input::Workspace(_, WorkspaceEvent::ProvidersChanged { .. })
                    ));
                }
            };
            let (result, ()) = tokio::time::timeout(Duration::from_secs(2), zip(routed, drain))
                .await
                .unwrap();
            assert_eq!(result.unwrap_err().to_string(), "event stream ended");
            assert!(!watch.backpressured() && !watch.current().1);
        });
}

#[test]
fn owner_changes_invalidate_the_intended_consumers_without_recovering_history() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let backend = Backend::connect("http://127.0.0.1:9/", "").await.unwrap();
            let (out, recovery) = crate::bounded(4);
            let (send, events) = crate::bounded(4);
            let state = State::observing_preferences(send, Arc::new(|| {}));
            opened(1, &out, &state).await.unwrap();
            assert!(matches!(recovery.try_recv().unwrap(), Input::Opened(1)));
            assert!(matches!(
                events.try_recv().unwrap(),
                crate::transport::Event::Preferences(crate::settings::Owner::Config)
            ));
            assert!(matches!(
                events.try_recv().unwrap(),
                crate::transport::Event::Preferences(crate::settings::Owner::State)
            ));
            let stamp = state.version.load(SeqCst);
            dispatch(
                &backend,
                1,
                &out,
                &state,
                "integration-test",
                "message",
                r#"{"owner":"ui","type":"storage.stateChanged","value":{}}"#,
            )
            .await
            .unwrap();
            assert!(recovery.is_empty() && state.valid(stamp));
            assert!(matches!(
                events.try_recv().unwrap(),
                crate::transport::Event::Preferences(crate::settings::Owner::State)
            ));
            let data = json!({"owner":"ui","type":"storage.configChanged",
                              "value":{"padding":"x".repeat(300 * 1024)}});
            dispatch(
                &backend,
                1,
                &out,
                &state,
                "integration-test",
                "message",
                &data.to_string(),
            )
            .await
            .unwrap();
            assert!(matches!(
                events.try_recv().unwrap(),
                crate::transport::Event::Preferences(crate::settings::Owner::Config)
            ));
            assert!(matches!(
                events.try_recv().unwrap(),
                crate::transport::Event::Workspace(WorkspaceEvent::UiPreferencesChanged)
            ));
            assert!(events.is_empty() && recovery.is_empty() && state.valid(stamp));
        });
}

#[test]
fn a_matching_move_cancels_the_body_before_waiting_for_queue_space() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut backend = Backend::connect("http://127.0.0.1:9/", "").await.unwrap();
            backend.workspace = "project".into();
            backend.session = "session".into();
            let (out, inbox) = crate::bounded(1);
            let (events, _receiver) = crate::bounded(1);
            let state = State::observing_preferences(events, Arc::new(|| {}));
            out.try_send(Input::Opened(1)).ok().unwrap();
            let move_event = json!({"type":"instance.event","instanceId":"project","event":{
                "type":"session.moved","data":{"sessionID":"session"}
            }});
            let payload = move_event.to_string();
            let mut dispatch_move = std::pin::pin!(dispatch(
                &backend, 1, &out, &state, "stream", "message", &payload
            ));
            assert!(
                futures_lite::future::poll_once(&mut dispatch_move)
                    .await
                    .is_none()
            );
            assert!(
                futures_lite::future::poll_once(state.placement_changed())
                    .await
                    .is_some()
            );
            assert!(matches!(inbox.try_recv().unwrap(), Input::Opened(1)));
            dispatch_move.await.unwrap();
            assert!(matches!(inbox.try_recv().unwrap(), Input::Native(1, _, _)));
        });
}
