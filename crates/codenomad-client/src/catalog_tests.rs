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
fn stats_reads_the_service_contract_on_the_captured_backend() {
    use crate::settings::stats::{self, DAY};
    run(async {
        let to = 1_800_000_000_000;
        let mut snapshot = json!({
            "scope": "service", "owner":"channel", "connection":"live", "identity":"root",
            "stats": {
                "range": {"from":to - 7*DAY, "to":to},
                "sessions":2, "subagents":1, "prompts":3, "steps":4, "cost":0.0025,
                "tokens":{"input":12345,"output":9,"reasoning":1,"cache":{"read":5,"write":2}},
                "activeDays":1, "streak":1, "activity":[], "models":[]
            }
        });
        let url = "/api/workspaces/project/service-usage";
        let fresh = format!(
            "GET {url}?timezone=Europe%2FParis&from={}&to={to}&restorePeriod=true",
            to - 30 * DAY
        );
        let server = Server::start(vec![
            reply(
                "GET /api/meta",
                None,
                200,
                json!({"apiContract":1,"serverId":"fixture","capabilities":["service-usage"]}),
            ),
            reply(
                &format!("GET {url}/owner"),
                None,
                200,
                json!({"owner":"channel","connection":"live"}),
            ),
            reply(
                &format!("GET {url}/cache?timezone=Europe%2FParis&days=7"),
                None,
                200,
                json!({"days":7,"owner":"channel","connection":"live","identity":"root","snapshot":snapshot}),
            ),
            reply(&fresh, None, 200, snapshot.clone()),
            {
                snapshot["stats"]["range"]["to"] = json!(to + 1);
                reply(&fresh, None, 200, snapshot)
            },
            reply(
                "GET /api/meta",
                None,
                200,
                json!({"apiContract":1,"serverId":"fixture","capabilities":[]}),
            ),
        ]);
        let backend = Backend::unauthenticated(&server.address).unwrap();
        backend.attest_server().await.unwrap();
        assert!(backend.client.supports_service_usage());
        assert_eq!(
            stats::owner(&backend, "project")
                .await
                .unwrap()
                .connection
                .as_deref(),
            Some("live")
        );
        let cached = stats::cached(&backend, "project", "Europe/Paris", Some(7))
            .await
            .unwrap();
        assert_eq!(cached.snapshot.unwrap().stats.tokens.input, 12345);
        let read = || stats::fresh(&backend, "project", "Europe/Paris", 30, to, true);
        assert_eq!(read().await.unwrap().days(), 7);
        assert!(read().await.is_err());
        backend.attest_server().await.unwrap();
        assert!(!backend.client.supports_service_usage());
    });
}

#[test]
fn stats_fresh_preserves_257_models_while_the_cache_enforces_its_limit() {
    use crate::settings::stats::{self, DAY};
    run(async {
        let to = 1_800_000_000_000;
        let tokens = json!({"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}});
        let models = (0..257)
            .map(|i| {
                json!({
                    "model":{"providerID":"fixture","id":format!("m-{i}")},
                    "steps":1,"tokens":tokens,"cost":0
                })
            })
            .collect::<Vec<_>>();
        let snapshot = json!({
            "scope":"service","owner":"owner","connection":"live","identity":"root",
            "stats":{"range":{"from":to-7*DAY,"to":to},"sessions":1,"subagents":0,
                "prompts":257,"steps":257,"cost":0,"tokens":tokens,"activeDays":1,"streak":1,
                "activity":[],"models":models}
        });
        let url = "/api/workspaces/project/service-usage";
        let server = Server::start(vec![
            reply(
                &format!("GET {url}/cache?timezone=UTC&days=7"),
                None,
                200,
                json!({"days":7,"owner":"owner","connection":"live","identity":"root","snapshot":snapshot}),
            ),
            reply(
                &format!("GET {url}?timezone=UTC&from={}&to={to}", to - 7 * DAY),
                None,
                200,
                snapshot,
            ),
        ]);
        let backend = Backend::unauthenticated(&server.address).unwrap();
        assert!(
            stats::cached(&backend, "project", "UTC", Some(7))
                .await
                .is_err()
        );
        let fresh = stats::fresh(&backend, "project", "UTC", 7, to, false)
            .await
            .unwrap();
        assert_eq!(fresh.stats.models.len(), 257);
        assert_eq!(fresh.stats.models.last().unwrap().model.id, "m-256");
    });
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
            temporary: false,
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
        let session = json!({"id":"later","title":"Off page","location":{"directory":"/linked"},"listWorktreeSlug":"linked"});
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
        ]);
        let backend = Backend::connect(&server.address, "").await.unwrap();
        let project = crate::catalog::Project {
            id: "workspace".into(),
            path: "/trial".into(),
            temporary: false,
        };
        let results = backend.search_sessions(&project, "Off page").await.unwrap();
        assert_eq!(results.len(), 1);
        let found = &results[0];
        assert_eq!(found.id, "later");
        let (bound, info, slug) = backend
            .bind_session_placed(&project, &found.id, false)
            .await
            .unwrap();
        assert_eq!(bound.session, info.id);
        assert_eq!(slug, "linked");
        assert_eq!(bound.session_directory.as_deref(), Some("/linked"));
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
            temporary: false,
        };
        for (id, missing, deleted) in [
            ("missing", true, true),
            ("other", false, false),
            ("unready", false, false),
            ("moved", true, false),
            ("forbidden", false, false),
        ] {
            let err = backend.bind_session(&project, id, false).await.unwrap_err();
            assert_eq!(err.is::<crate::catalog::SessionMissing>(), missing);
            assert_eq!(
                err.downcast_ref::<crate::catalog::SessionMissing>()
                    .is_some_and(|reason| reason.is_deleted()),
                deleted
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
            temporary: false,
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
            reply(
                "GET /workspaces/workspace/instance/api/session/moved",
                None,
                403,
                json!({"reason":"session_located_elsewhere"}),
            ),
        ]);
        let backend = Backend::connect(&server.address, "").await.unwrap();
        let project = crate::catalog::Project {
            id: "workspace".into(),
            path: "/trial".into(),
            temporary: false,
        };
        let ids = [
            "unresponsive",
            "reordered",
            "unavailable",
            "deleted",
            "moved",
        ]
        .map(str::to_owned);
        let (out, results) = async_channel::bounded(ids.len());
        backend
            .confirm_missing_sessions(&project, ids.into(), out, || {})
            .await;
        let first = results.try_recv().unwrap();
        assert_eq!(first.0, "deleted");
        assert_eq!(first.2, crate::catalog::SessionAbsence::NotFound);
        let second = results.try_recv().unwrap();
        assert_eq!(second.0, "moved");
        assert_eq!(second.2, crate::catalog::SessionAbsence::LocatedElsewhere);
        assert!(results.try_recv().is_err());
    });
}

#[test]
fn a_linked_session_requires_the_owned_proxy_placement() {
    run(async {
        let route = "GET /workspaces/workspace/instance/api/session/linked";
        let server = Server::start(vec![
            reply(
                route,
                None,
                200,
                json!({"data":{"id":"linked","location":{"directory":"/linked"}}}),
            ),
            reply(
                route,
                None,
                200,
                json!({"data":{"id":"linked","location":{"directory":"/linked"},"listWorktreeSlug":"linked-worktree"}}),
            ),
        ]);
        let backend = Backend::connect(&server.address, "").await.unwrap();
        let project = crate::catalog::Project {
            id: "workspace".into(),
            path: "/trial".into(),
            temporary: false,
        };
        assert!(
            backend
                .bind_session(&project, "linked", false)
                .await
                .is_err()
        );
        let (bound, row) = backend
            .bind_session(&project, "linked", false)
            .await
            .unwrap();
        assert_eq!(bound.workspace, "workspace");
        assert_eq!(row.id, "linked");
    });
}

#[test]
fn linked_session_page_marks_403_as_location_unavailable() {
    run(async {
        let route = "GET /workspaces/workspace/instance/api/session?directory=%2Flinked&limit=200";
        let server = Server::start(vec![
            reply(route, None, 503, json!({})),
            reply(
                route,
                None,
                403,
                json!({"error":"Location does not belong to workspace"}),
            ),
        ]);
        let backend = Backend::connect(&server.address, "").await.unwrap();
        let project = crate::catalog::Project {
            id: "workspace".into(),
            path: "/trial".into(),
            temporary: false,
        };
        let transient = backend
            .linked_session_page(&project, "/linked", None)
            .await
            .err()
            .unwrap();
        assert!(!transient.is::<crate::catalog::LocationUnavailable>());
        let forbidden = backend
            .linked_session_page(&project, "/linked", None)
            .await
            .err()
            .unwrap();
        assert!(forbidden.is::<crate::catalog::LocationUnavailable>());
    });
}

#[test]
fn create_untitled_session_distinguishes_explicit_4xx_rejection_from_ambiguous_errors() {
    run(async {
        let route = "POST /workspaces/workspace/instance/api/session?directory=%2Flinked";
        let body = Some(json!({"location":{"directory":"/linked"}}));
        let server = Server::start(vec![
            reply(route, body.clone(), 403, json!({"error":"forbidden"})),
            reply(route, body.clone(), 401, json!({"error":"unauthorized"})),
            reply(route, body.clone(), 408, json!({})),
            reply(route, body.clone(), 409, json!({"error":"conflict"})),
            reply(route, body, 503, json!({})),
        ]);
        let backend = Backend::connect(&server.address, "").await.unwrap();
        let project = crate::catalog::Project {
            id: "workspace".into(),
            path: "/trial".into(),
            temporary: false,
        };
        let rejected = backend
            .create_untitled_session(&project, "/linked")
            .await
            .err()
            .unwrap();
        assert!(rejected.is::<crate::catalog::CreateRejected>());
        let unauthorized = backend
            .create_untitled_session(&project, "/linked")
            .await
            .err()
            .unwrap();
        assert!(!unauthorized.is::<crate::catalog::CreateRejected>());
        let timeout = backend
            .create_untitled_session(&project, "/linked")
            .await
            .err()
            .unwrap();
        assert!(!timeout.is::<crate::catalog::CreateRejected>());
        let conflict = backend
            .create_untitled_session(&project, "/linked")
            .await
            .err()
            .unwrap();
        assert!(!conflict.is::<crate::catalog::CreateRejected>());
        let unavailable = backend
            .create_untitled_session(&project, "/linked")
            .await
            .err()
            .unwrap();
        assert!(!unavailable.is::<crate::catalog::CreateRejected>());
    });
}

#[test]
fn attest_server_reprobes_on_voluntary_stream_handoff_but_not_on_transport_drop() {
    run(async {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let (arrived_tx, arrived_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let body =
            br#"{"apiContract":1,"serverId":"fixture","capabilities":["settings-atomic-patches"]}"#;
        let worker = thread::spawn(move || {
            for step in 0..3 {
                let (mut socket, _) = listener.accept().unwrap();
                let mut buf = [0u8; 4096];
                let _ = socket.read(&mut buf);
                if step == 0 || step == 2 {
                    arrived_tx.send(step).unwrap();
                    release_rx.recv().unwrap();
                }
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                socket.write_all(head.as_bytes()).unwrap();
                socket.write_all(body).unwrap();
            }
        });

        let backend = Backend::unauthenticated(&address).unwrap();
        let guard_handoff = backend.client.track_stream("outgoing");
        assert!(guard_handoff.try_mark_open(&backend.client, true));
        let client = backend.client.clone();
        let detach = thread::spawn(move || {
            assert_eq!(arrived_rx.recv().unwrap(), 0);
            guard_handoff.close_and_revoke(&client, true, false);
            release_tx.send(()).unwrap();
            let guard_drop = client.track_stream("dropped");
            assert!(guard_drop.try_mark_open(&client, true));
            assert_eq!(arrived_rx.recv().unwrap(), 2);
            guard_drop.close_and_revoke(&client, true, true);
            release_tx.send(()).unwrap();
        });

        assert_eq!(backend.attest_server().await.unwrap(), "fixture");
        assert!(backend.client.supports_atomic_settings_patches());
        assert!(!backend.client.needs_capability_recheck());
        assert_eq!(
            backend.attest_server().await.unwrap_err().to_string(),
            "Transport changed during server attestation"
        );
        detach.join().unwrap();
        worker.join().unwrap();
    });
}
