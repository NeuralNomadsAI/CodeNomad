use crate::backend::Backend;
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

struct Reply {
    request: String,
    body: Option<Value>,
    status: u16,
    response: Vec<u8>,
}
fn reply(request: &str, body: Option<Value>, status: u16, response: Value) -> Reply {
    Reply {
        request: request.into(),
        body,
        status,
        response: serde_json::to_vec(&response).unwrap(),
    }
}
struct Server {
    address: String,
    stop: mpsc::Sender<()>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn start(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let (stop, stopped) = mpsc::channel();
        let worker = thread::spawn(move || {
            let mut withheld = vec![];
            for reply in replies {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut socket = loop {
                    if stopped.try_recv().is_ok() {
                        return;
                    }
                    assert!(
                        Instant::now() < deadline,
                        "missing catalogue request {}",
                        reply.request
                    );
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2))
                        }
                        Err(error) => panic!("fixture accept: {error}"),
                    }
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = vec![];
                while !bytes.ends_with(b"\r\n\r\n") {
                    assert!(bytes.len() < 16384);
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    bytes.push(byte[0]);
                }
                let headers = String::from_utf8(bytes).unwrap();
                assert_eq!(
                    headers.lines().next().unwrap(),
                    format!("{} HTTP/1.1", reply.request)
                );
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.split_once(':')
                            .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                            .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                assert!(length <= 16384);
                let mut body = vec![0; length];
                socket.read_exact(&mut body).unwrap();
                assert_eq!(
                    (!body.is_empty()).then(|| serde_json::from_slice::<Value>(&body).unwrap()),
                    reply.body
                );
                if reply.status == 0 {
                    withheld.push(socket);
                    continue;
                }
                let response = if reply.status == 204 {
                    &[][..]
                } else {
                    &reply.response
                };
                let header = format!(
                    "HTTP/1.1 {} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    reply.status,
                    response.len()
                );
                if socket.write_all(header.as_bytes()).is_ok() {
                    let _ = socket.write_all(response);
                }
            }
        });
        Self {
            address,
            stop,
            worker: Some(worker),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}
fn run(test: impl std::future::Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(test)
}
fn project(id: &str, claim: &str) -> Value {
    json!({"id":id,"location":{"directory":"/trial"},"requestId":claim})
}

#[test]
fn creation_is_an_independent_claimed_occurrence_and_cleanup_targets_its_owner() {
    run(async {
        let one = "11223344-5566-7788-99aa-bbccddeeff00";
        let two = "11223344-5566-7788-99aa-bbccddeeff01";
        let server = Server::start(vec![
            reply(
                "POST /api/workspaces",
                Some(json!({"path":"/trial","requestId":"first"})),
                201,
                project(one, "first"),
            ),
            reply(
                "POST /api/workspaces",
                Some(json!({"path":"/trial","requestId":"second"})),
                201,
                project(two, "second"),
            ),
            reply(
                "POST /api/workspaces/creation/cancel",
                Some(json!({"requestId":"first"})),
                204,
                Value::Null,
            ),
            reply(
                &format!("POST /api/workspaces/{two}/creation/release"),
                Some(json!({"requestId":"second"})),
                204,
                Value::Null,
            ),
            reply(
                &format!("DELETE /api/workspaces/{two}"),
                None,
                204,
                Value::Null,
            ),
        ]);
        let backend = Backend::connect(&server.address, "").await.unwrap();
        let first = backend.create_project("/trial", " first ").await.unwrap();
        let second = backend.create_project("/trial", "second").await.unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(first.path, second.path);
        backend.cancel_project_creation(" first ").await.unwrap();
        backend
            .release_project_creation(&second.id, "second")
            .await
            .unwrap();
        backend.release_project(&second.id).await.unwrap();
    });
}

#[test]
fn meta_requires_bounded_opaque_identity_and_the_consumed_api_contract() {
    run(async {
        let id = "🦀".repeat(256);
        let cases = [
            (
                json!({"serverId":id,"apiContract":1,"serverVersion":"future-unrestricted"}),
                true,
            ),
            (
                json!({"serverId":"opaque-installation","apiContract":1}),
                true,
            ),
            (
                json!({"serverId":"opaque-installation","apiContract":2}),
                false,
            ),
            (json!({"serverId":123,"apiContract":1}), false),
            (json!({"serverId":" \t ","apiContract":1}), false),
            (json!({"serverId":"id\nsecret","apiContract":1}), false),
            (json!({"serverId":"🦀".repeat(257),"apiContract":1}), false),
            (json!({"serverId":"id"}), false),
        ];
        let server = Server::start(
            cases
                .iter()
                .map(|(value, _)| reply("GET /api/meta", None, 200, value.clone()))
                .collect(),
        );
        let backend = Backend::connect(&server.address, "").await.unwrap();
        for (value, accepted) in cases {
            let result = backend.server_id().await;
            assert_eq!(result.is_ok(), accepted);
            if accepted {
                assert_eq!(result.unwrap(), value["serverId"].as_str().unwrap());
            }
        }
        let server = Server::start(vec![Reply {
            request: "GET /api/meta".into(),
            body: None,
            status: 200,
            response: vec![b' '; 2 * 1024 * 1024 + 1],
        }]);
        let backend = Backend::connect(&server.address, "").await.unwrap();
        assert!(backend.server_id().await.is_err());
    });
}

#[test]
fn mismatched_creation_receipts_and_unsuccessful_cleanup_are_errors() {
    run(async {
        let server = Server::start(vec![
            reply(
                "POST /api/workspaces",
                Some(json!({"path":"/trial","requestId":"mine"})),
                201,
                project("workspace", "other"),
            ),
            reply(
                "POST /api/workspaces/creation/cancel",
                Some(json!({"requestId":"mine"})),
                200,
                json!({"ok":true}),
            ),
            reply(
                "POST /api/workspaces/workspace/creation/release",
                Some(json!({"requestId":"mine"})),
                404,
                Value::Null,
            ),
            reply("DELETE /api/workspaces/workspace", None, 503, Value::Null),
        ]);
        let backend = Backend::connect(&server.address, "").await.unwrap();
        assert!(backend.create_project("/trial", "mine").await.is_err());
        assert!(backend.cancel_project_creation("mine").await.is_err());
        assert!(
            backend
                .release_project_creation("workspace", "mine")
                .await
                .is_err()
        );
        assert!(backend.release_project("workspace").await.is_err());
    });
}

#[test]
fn invalid_mutation_inputs_are_rejected_before_dispatch() {
    run(async {
        let backend = Backend::connect("http://127.0.0.1:9", "").await.unwrap();
        for request in [String::new(), " \t ".into(), "🦀".repeat(65)] {
            assert_eq!(
                backend
                    .create_project("/trial", &request)
                    .await
                    .unwrap_err()
                    .to_string(),
                "invalid workspace creation request"
            );
            assert_eq!(
                backend
                    .cancel_project_creation(&request)
                    .await
                    .unwrap_err()
                    .to_string(),
                "invalid workspace creation request"
            );
            assert_eq!(
                backend
                    .release_project_creation("workspace", &request)
                    .await
                    .unwrap_err()
                    .to_string(),
                "invalid workspace creation request"
            );
        }
        assert_eq!(
            backend
                .create_project("relative", "mine")
                .await
                .unwrap_err()
                .to_string(),
            "workspace creation refused before publication"
        );
        for id in ["", "../other", "workspace?discard=true"] {
            assert_eq!(
                backend.release_project(id).await.unwrap_err().to_string(),
                "invalid workspace id"
            );
            assert_eq!(
                backend
                    .release_project_creation(id, "mine")
                    .await
                    .unwrap_err()
                    .to_string(),
                "invalid workspace id"
            );
        }
    });
}

#[test]
fn only_known_prepublication_rejections_are_definitive() {
    run(async {
        for (status, text, definitive) in [
            (400, "Workspace directory is not authorized", true),
            (400, "Workspace creation request mine was cancelled", false),
            (400, "Workspace directory is being removed", true),
            (
                400,
                "Too many workspace creations are already in progress",
                true,
            ),
            (
                400,
                "Workspace creation request mine is already in use",
                false,
            ),
            (400, "Workspace creation request other was cancelled", false),
            (400, "HTTP 400 invalid folder", false),
            (
                400,
                "{\"error\":\"Workspace directory is not authorized\"}",
                false,
            ),
            (500, "Workspace directory is not authorized", false),
        ] {
            let server = Server::start(vec![Reply {
                request: "POST /api/workspaces".into(),
                body: Some(json!({"path":"/trial","requestId":"mine"})),
                status,
                response: text.as_bytes().to_vec(),
            }]);
            let backend = Backend::connect(&server.address, "").await.unwrap();
            let error = backend.create_project("/trial", "mine").await.unwrap_err();
            assert_eq!(
                error.is::<crate::catalog::CreationRefused>(),
                definitive,
                "{status}: {text}"
            );
        }
        let server = Server::start(vec![Reply {
            request: "POST /api/workspaces".into(),
            body: Some(json!({"path":"/trial","requestId":"mine"})),
            status: 400,
            response: vec![b'x'; 513],
        }]);
        let backend = Backend::connect(&server.address, "").await.unwrap();
        assert!(
            !backend
                .create_project("/trial", "mine")
                .await
                .unwrap_err()
                .is::<crate::catalog::CreationRefused>()
        );
    });
}

#[test]
fn binding_returns_the_validated_native_session_without_a_list_or_second_read() {
    run(async {
        let server = Server::start(vec![
            reply(
                "GET /workspaces/workspace/instance/api/session/off-page",
                None,
                200,
                json!({"data":{"id":"off-page","title":"Session page 2","location":{"directory":"/trial"}}}),
            ),
            reply(
                "GET /workspaces/workspace/instance/api/session/legacy",
                None,
                200,
                json!({"data":{"id":"legacy","title":"Legacy","location":{"directory":"/trial"}}}),
            ),
            reply(
                "GET /workspaces/workspace/instance/api/session/foreign",
                None,
                200,
                json!({"data":{"id":"foreign","title":"Other folder","location":{"directory":"/other"}}}),
            ),
            reply(
                "GET /workspaces/workspace/instance/api/session/expected",
                None,
                200,
                json!({"data":{"id":"different","title":"Other session","location":{"directory":"/trial"}}}),
            ),
        ]);
        let backend = Backend::connect(&server.address, "").await.unwrap();
        let project = crate::catalog::Project {
            id: "workspace".into(),
            path: "/trial".into(),
        };
        let (bound, session) = backend
            .bind_session(&project, "off-page", false)
            .await
            .unwrap();
        assert_eq!(bound.session, "off-page");
        assert_eq!(session.id, "off-page");
        assert_eq!(session.title, "Session page 2");
        assert_eq!(
            backend
                .bind(&project, "legacy", true)
                .await
                .unwrap()
                .session,
            "legacy"
        );
        assert!(
            backend
                .bind_session(&project, "foreign", false)
                .await
                .is_err()
        );
        assert!(
            backend
                .bind_session(&project, "expected", false)
                .await
                .is_err()
        );
    });
}

#[test]
fn server_search_follows_scoped_worktree_cursors_and_binds_the_exact_match() {
    run(async {
        let inventory = json!({"worktrees":[
            {"directory":"/trial"},
            {"directory":"/alias", "serviceDirectory":"/linked"},
            {"directory":"/missing","nestedFolderMissing":true}
        ]});
        let session = json!({"id":"later","title":"Off page","location":{"directory":"/linked"}});
        let server = Server::start(vec![
            reply(
                "GET /api/workspaces/workspace/worktrees",
                None,
                200,
                inventory.clone(),
            ),
            reply(
                "GET /workspaces/workspace/instance/api/session?directory=%2Ftrial&limit=200&search=Off+page",
                None,
                200,
                json!({"data":[],"cursor":{}}),
            ),
            reply(
                "GET /workspaces/workspace/instance/api/session?directory=%2Flinked&limit=200&search=Off+page",
                None,
                200,
                json!({"data":[],"cursor":{"next":"private-scope"}}),
            ),
            reply(
                "GET /workspaces/workspace/instance/api/session?directory=%2Flinked&cursor=private-scope",
                None,
                200,
                json!({"data":[session.clone()],"cursor":{}}),
            ),
            reply(
                "GET /workspaces/workspace/instance/api/session/later",
                None,
                200,
                json!({"data":session}),
            ),
            reply(
                "GET /api/workspaces/workspace/worktrees",
                None,
                200,
                inventory,
            ),
        ]);
        let backend = Backend::connect(&server.address, "").await.unwrap();
        let project = crate::catalog::Project {
            id: "workspace".into(),
            path: "/trial".into(),
        };
        let results = backend.search_sessions(&project, "Off page").await.unwrap();
        assert_eq!(results.len(), 1);
        let found = &results[0];
        assert_eq!(found.id, "later");
        let (bound, info) = backend
            .bind_at(&project, &found.id, None, false)
            .await
            .unwrap();
        assert_eq!(bound.session, info.id);
    });
}

#[test]
fn workspace_absence_requires_a_successful_inventory_and_uses_occurrence_identity() {
    run(async {
        let server = Server::start(vec![
            reply(
                "GET /api/workspaces",
                None,
                401,
                json!({"pairingRequired":true}),
            ),
            reply(
                "GET /api/workspaces",
                None,
                200,
                json!([project("old", "fixture")]),
            ),
            reply(
                "GET /api/workspaces",
                None,
                200,
                json!([project("another", "fixture")]),
            ),
        ]);
        let backend = Backend::connect(&server.address, "").await.unwrap();
        assert!(backend.workspace_missing("old").await.is_err());
        assert!(!backend.workspace_missing("old").await.unwrap());
        assert!(backend.workspace_missing("old").await.unwrap());
    });
}

#[test]
fn only_confirmed_absence_or_departure_retires_a_session_visit() {
    run(async {
        let server = Server::start(vec![
            reply(
                "GET /workspaces/workspace/instance/api/session/missing",
                None,
                404,
                json!({"_tag":"SessionNotFoundError","sessionID":"missing"}),
            ),
            reply(
                "GET /workspaces/workspace/instance/api/session/other",
                None,
                404,
                json!({"_tag":"SessionNotFoundError","sessionID":"missing"}),
            ),
            reply(
                "GET /workspaces/workspace/instance/api/session/unready",
                None,
                503,
                json!({"_tag":"SessionNotFoundError","sessionID":"unready"}),
            ),
            reply(
                "GET /workspaces/workspace/instance/api/session/moved",
                None,
                403,
                json!({"reason":"session_located_elsewhere"}),
            ),
            reply(
                "GET /workspaces/workspace/instance/api/session/forbidden",
                None,
                403,
                json!({"error":"Session does not belong to workspace"}),
            ),
        ]);
        let backend = Backend::connect(&server.address, "").await.unwrap();
        let project = crate::catalog::Project {
            id: "workspace".into(),
            path: "/trial".into(),
        };
        for (id, missing) in [
            ("missing", true),
            ("other", false),
            ("unready", false),
            ("moved", true),
            ("forbidden", false),
        ] {
            assert_eq!(
                backend
                    .bind_session(&project, id, false)
                    .await
                    .unwrap_err()
                    .is::<crate::catalog::SessionMissing>(),
                missing
            );
        }
    });
}

#[test]
fn malformed_catalogue_data_is_not_a_terminal_session_page() {
    run(async {
        let route = "GET /workspaces/workspace/instance/api/session?directory=%2Ftrial&limit=200";
        let server = Server::start(vec![
            reply(route, None, 200, json!({"data":[], "cursor":[]})),
            reply(
                route,
                None,
                200,
                json!({"data":[{"id":"ses_a","location":{"directory":"/trial"},"parentID":false}]}),
            ),
            reply(route, None, 200, json!({"data":[], "cursor":{}})),
        ]);
        let backend = Backend::connect(&server.address, "").await.unwrap();
        let project = crate::catalog::Project {
            id: "workspace".into(),
            path: "/trial".into(),
        };
        assert!(backend.sessions(&project, None).await.is_err());
        assert!(backend.sessions(&project, None).await.is_err());
        assert!(
            backend
                .sessions(&project, None)
                .await
                .unwrap()
                .next
                .is_none()
        );
    });
}

#[test]
fn catalogue_omissions_require_targeted_absence() {
    run(async {
        let server = Server::start(vec![
            reply(
                "GET /workspaces/workspace/instance/api/session/unresponsive",
                None,
                0,
                json!({}),
            ),
            reply(
                "GET /workspaces/workspace/instance/api/session/reordered",
                None,
                200,
                json!({"data":{"id":"reordered","location":{"directory":"/trial"}}}),
            ),
            reply(
                "GET /workspaces/workspace/instance/api/session/unavailable",
                None,
                503,
                json!({}),
            ),
            reply(
                "GET /workspaces/workspace/instance/api/session/deleted",
                None,
                404,
                json!({"_tag":"SessionNotFoundError","sessionID":"deleted"}),
            ),
        ]);
        let backend = Backend::connect(&server.address, "").await.unwrap();
        let project = crate::catalog::Project {
            id: "workspace".into(),
            path: "/trial".into(),
        };
        let ids = ["unresponsive", "reordered", "unavailable", "deleted"].map(str::to_owned);
        let (out, results) = async_channel::bounded(ids.len());
        backend
            .confirm_missing_sessions(&project, ids.into(), out, || {})
            .await;
        assert_eq!(results.try_recv().unwrap().0, "deleted");
        assert!(results.try_recv().is_err());
    });
}
