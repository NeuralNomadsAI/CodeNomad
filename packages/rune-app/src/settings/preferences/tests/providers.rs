use super::*;
use crate::settings::{provider_changed, provider_stopped, providers::Target, view};
use std::{cell::Cell, rc::Rc, sync::Arc};

#[test]
fn providers_refresh_the_captured_location_and_revoke_a_stopped_project() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let listener = Arc::new(listener);
        let backend = prefs.backend.as_mut().unwrap();
        backend.workspace = "captured".into();
        backend.session = "session".into();
        let root = crate::init();
        let shared = root.settings.shared.clone();
        prefs.window_wake = Some(Arc::new(|| {}));
        *shared.borrow_mut() = prefs;
        let target = Target::capture(&root).unwrap();
        shared.borrow_mut().provider_target = Some(target);
        let window = view::Window::new(shared, Rc::new(Cell::new(false)));
        let mut rt = rune::Runtime::new(
            window,
            view::view,
            (1100.0, 760.0),
            rune::Env::new(false, 1.0),
        );
        let click = |rt: &mut rune::Runtime<view::Window>, key| {
            let (x, y) = rt.find(key).unwrap();
            rt.pointer_down(x, y);
            rt.pointer_up(x, y);
            rt.frame(0.02);
        };
        let tick = |rt: &mut rune::Runtime<view::Window>| {
            rt.update(|s, tx| {
                view::spec().poll.unwrap()(s, 0.0, tx);
            });
            rt.frame(0.02);
        };
        rt.frame(0.0);
        click(&mut rt, "settings-providers");
        tick(&mut rt);
        let first = request(&listener).await;
        let (meta, session) = if first.first.starts_with("GET /api/meta ") {
            (first, request(&listener).await)
        } else {
            (request(&listener).await, first)
        };
        assert!(meta.first.starts_with("GET /api/meta "));
        meta.reply(200, json!({"capabilities":[]})).await;
        reply_snapshot(&listener, session, "First account").await;
        wait_until(|| {
            tick(&mut rt);
            rt.accessibility_json()
                .to_string()
                .contains("First account")
        })
        .await;
        click(&mut rt, "trigger");
        click(&mut rt, "settings-general");
        click(&mut rt, "settings-providers");
        tick(&mut rt);
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
        click(&mut rt, "trigger");
        tick(&mut rt);
        read_snapshot(&listener, "First account").await;
        wait_until(|| {
            tick(&mut rt);
            rt.accessibility_json()
                .to_string()
                .contains("First account")
        })
        .await;

        provider_changed(&root, "another");
        tick(&mut rt);
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
        provider_changed(&root, "captured");
        tick(&mut rt);
        provider_changed(&root, "captured");
        provider_changed(&root, "captured");
        read_snapshot(&listener, "Obsolete account").await;
        let (out, ready) = bounded(1);
        let pending_listener = listener.clone();
        platform::spawn(async move {
            out.send(request(&pending_listener).await).await.unwrap();
        });
        let mut second = None;
        wait_until(|| {
            tick(&mut rt);
            second = ready.try_recv().ok();
            second.is_some()
        })
        .await;
        let second = second.unwrap();
        assert!(
            !rt.accessibility_json()
                .to_string()
                .contains("Obsolete account")
        );
        reply_snapshot(&listener, second, "New account").await;
        wait_until(|| {
            tick(&mut rt);
            rt.accessibility_json().to_string().contains("New account")
        })
        .await;
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
        provider_changed(&root, "captured");
        tick(&mut rt);
        let late = request(&listener).await;
        crate::settings::connection_event(&root, &crate::transport::Event::ConnectionLost);
        tick(&mut rt);
        let tree = rt.accessibility_json().to_string();
        assert!(!tree.contains("New account") && !tree.contains("Obsolete account"));
        drop(late);
        provider_stopped(&root, "captured");
        crate::settings::connection_event(&root, &crate::transport::Event::AgentHint(true));
        tick(&mut rt);
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
}

async fn read_snapshot(listener: &TcpListener, account: &str) {
    let session = request(listener).await;
    reply_snapshot(listener, session, account).await;
}

async fn reply_snapshot(listener: &TcpListener, session: Request, account: &str) {
    assert!(
        session
            .first
            .starts_with("GET /workspaces/captured/instance/api/session/session ")
    );
    session
        .reply(
            200,
            json!({"data":{"id":"session","location":{"directory":"C:/fixture-linked"}}}),
        )
        .await;
    let mut endpoints = Vec::new();
    for _ in 0..4 {
        let query = request(listener).await;
        let url = query.first.split_whitespace().nth(1).unwrap();
        let (endpoint, parameters) = url.split_once('?').unwrap();
        assert_eq!(parameters, "location%5Bdirectory%5D=C%3A%2Ffixture-linked");
        endpoints.push(endpoint.to_owned());
        let data = if endpoint.ends_with("/integration") {
            json!([{"id":"example","name":"Example","connections":[{"type":"credential","label":account}]}])
        } else if endpoint.ends_with("/websearch/provider") {
            json!([])
        } else if endpoint.ends_with("/model") {
            json!([{"id":"model","providerID":"example"}])
        } else {
            assert!(endpoint.ends_with("/provider"));
            json!([{"id":"example","name":"Example"}])
        };
        query
            .reply(
                200,
                json!({"location":{"directory":"C:/fixture-linked"},"data":data}),
            )
            .await;
    }
    endpoints.sort();
    endpoints.dedup();
    assert_eq!(endpoints.len(), 4);
}
