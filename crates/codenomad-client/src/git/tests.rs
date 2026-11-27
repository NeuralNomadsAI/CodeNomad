use super::*;
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    time::Duration,
};

#[test]
fn owned_routes_pin_history_and_submit_each_mutation_once() {
    let sha = "1".repeat(40);
    let entries = [
        (
            "GET /api/workspaces/w/worktrees?fresh=true".to_owned(),
            200,
            json!({"isGitRepo":true,
            "worktrees":[{"slug":"root","directory":"D:/repo"},{"slug":"link % #","directory":"D:/link","serviceDirectory":"/mnt/d/link"}]}),
        ),
        (
            "GET /api/workspaces/w/worktrees/link%20%25%20%23/git-status?hideWhitespace=1".into(),
            200,
            json!([{"path":"a + b.rs","stagedStatus":"added","stagedAdditions":3,"stagedDeletions":0,
                "unstagedStatus":"modified","unstagedAdditions":2,"unstagedDeletions":1,"unstagedWhitespaceOnly":true}]),
        ),
        (
            format!(
                "GET /api/workspaces/w/worktrees/link%20%25%20%23/git-history?offset=50&head={sha}"
            ),
            200,
            json!({"head":sha,"commits":[],"hasMore":false}),
        ),
        (
            format!(
                "GET /api/workspaces/w/worktrees/link%20%25%20%23/git-history/{sha}?path=a+%2B+b.rs"
            ),
            200,
            json!({"path":"a + b.rs","before":"","after":"fn main() {}\n","isBinary":false}),
        ),
        (
            "POST /api/workspaces/w/worktrees/link%20%25%20%23/git-stage".into(),
            200,
            json!({"ok":true}),
        ),
        (
            "POST /api/workspaces/w/worktrees/link%20%25%20%23/git-unstage".into(),
            200,
            json!({"ok":true}),
        ),
        (
            "POST /api/workspaces/w/worktrees/link%20%25%20%23/git-commit".into(),
            200,
            json!({"ok":true}),
        ),
        (
            "POST /api/workspaces/w/git-init".into(),
            501,
            json!({"code":"git_init_unsupported"}),
        ),
        (
            "GET /workspaces/w/instance/api/location?location%5Bdirectory%5D=D%3A%2Frepo".into(),
            200,
            json!({"directory":"D:/repo","project":{"id":"global"}}),
        ),
        (
            "GET /workspaces/w/instance/api/session?directory=D%3A%2Frepo&limit=200".into(),
            200,
            json!({"data":[],"cursor":{}}),
        ),
        (
            "POST /api/workspaces/w/sessions/child/worktree".into(),
            200,
            json!({"rootSessionId":"root-session","sessionIds":["root-session","child"],"worktreeSlug":"link % #"}),
        ),
    ];
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        for (route, status, response) in entries {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = BufReader::new(&mut socket);
            let mut line = String::new();
            request.read_line(&mut line).unwrap();
            assert_eq!(line.split(" HTTP/").next(), Some(route.as_str()));
            let mut length = 0;
            loop {
                line.clear();
                assert_ne!(request.read_line(&mut line).unwrap(), 0);
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
            }
            if route.starts_with("POST") {
                let mut body = vec![0; length];
                request.read_exact(&mut body).unwrap();
                let value: Value = serde_json::from_slice(&body).unwrap();
                let expected = if route.ends_with("git-init") {
                    json!({"directory":"D:/repo"})
                } else if route.ends_with("git-commit") {
                    json!({"message":"message"})
                } else if route.ends_with("/worktree") {
                    json!({"worktreeSlug":"link % #"})
                } else {
                    json!({"paths":["a + b.rs"]})
                };
                assert_eq!(value, expected);
            }
            let response = response.to_string();
            write!(socket, "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
        }
    });
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut backend = Backend::connect(&base, "").await.unwrap();
            backend.workspace = "w".into();
            let inventory = backend.git_worktrees(true).await.unwrap();
            assert_eq!(inventory.repository, Repository::Git);
            let root = &inventory.trees[0];
            let tree = &inventory.trees[1];
            let inventory = backend.git_status(tree, true).await.unwrap();
            assert!(inventory[0].whitespace_only && inventory[0].staged.is_some());
            assert!(
                backend
                    .git_history(&tree.slug, Some((&sha, 50)))
                    .await
                    .unwrap()
                    .commits
                    .is_empty()
            );
            assert!(matches!(
                backend
                    .git_commit_diff(tree, &sha, "a + b.rs")
                    .await
                    .unwrap(),
                Diff::Text { .. }
            ));
            let paths = ["a + b.rs".into()];
            backend
                .git_move_paths(tree, Section::Unstaged, &paths)
                .await
                .unwrap();
            backend
                .git_move_paths(tree, Section::Staged, &paths)
                .await
                .unwrap();
            backend.git_commit(&tree.slug, " message\n").await.unwrap();
            let err = backend.git_init("D:/repo").await.unwrap_err();
            assert_eq!(
                err.downcast_ref::<Refusal>().unwrap().code.as_deref(),
                Some("git_init_unsupported")
            );
            assert!(
                backend
                    .git_local_diff(tree, Section::Unstaged, " a + b.rs", None)
                    .await
                    .is_err()
            );
            assert!(backend.git_commit_diff(tree, "HEAD", "a").await.is_err());
            assert!(
                backend
                    .git_init_sessions(root)
                    .await
                    .unwrap()
                    .rows
                    .is_empty()
            );
            assert!(backend.place_session(&tree.slug).await.is_err());
            backend.session = "child".into();
            assert_eq!(
                backend.place_session(&tree.slug).await.unwrap(),
                ["root-session", "child"]
            );
        });
    server.join().unwrap();
}

#[test]
fn image_sides_are_exact_and_binary_does_not_require_text() {
    assert_eq!(
        diff(
            json!({"path":"a.png","isBinary":true,"image":{"mime":"image/png",
        "before":null,"after":"AQID"}}),
            "a.png"
        )
        .unwrap(),
        Diff::Image {
            mime: "image/png".into(),
            before: None,
            after: Some(vec![1, 2, 3])
        }
    );
    assert!(diff(json!({"path":"foreign","isBinary":true}), "wanted").is_err());
    assert_eq!(
        diff(json!({"path":"blob","isBinary":true}), "blob").unwrap(),
        Diff::Binary
    );
}

#[test]
fn bulk_path_batches_preserve_the_exact_order_and_both_server_bounds() {
    let paths: Vec<_> = (0..280).map(|i| format!("{i}.txt")).collect();
    assert_eq!(
        path_batches(&paths)
            .map(<[String]>::len)
            .collect::<Vec<_>>(),
        [256, 24]
    );
    let paths: Vec<_> = (0..12)
        .map(|i| format!("{i}-{}.txt", "é".repeat(1_000)))
        .collect();
    let batches = path_batches(&paths).collect::<Vec<_>>();
    assert!(
        batches
            .iter()
            .all(|batch| batch.iter().map(String::len).sum::<usize>() <= 16_000)
    );
    assert_eq!(batches.concat(), paths);
}
#[test]
fn a_gateway_timeout_cannot_settle_worktree_placement() {
    let message = Some("Native worktree operation could not be verified".into());
    for status in [408, 500, 502, 503, 504] {
        assert!(
            !Refusal {
                status,
                code: None,
                message: message.clone()
            }
            .placement_answered()
        );
    }
    assert!(
        Refusal {
            status: 409,
            code: None,
            message
        }
        .placement_answered()
    );
}

#[test]
fn client_git_errors_are_typed_and_refusals_preserve_structured_messages() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let entries = [
            (
                200,
                json!({"isGitRepo":true,"worktrees":[{"slug":"root","directory":"D:/repo"}]}),
            ),
            (200, json!({"ok":false})),
            (
                422,
                json!({"error":"  pre-commit hook rejected  ","code":"hook_failed"}),
            ),
            (500, json!({"error":"   "})),
            (
                409,
                json!({"error":"   ","message":"  Repository locked  "}),
            ),
            (200, json!({"padding":"x".repeat(65 * 1024)})),
        ];
        for (status, response) in entries {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = BufReader::new(&mut socket);
            let mut line = String::new();
            let mut length = 0;
            loop {
                line.clear();
                assert_ne!(request.read_line(&mut line).unwrap(), 0);
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
            }
            if length > 0 {
                let mut body = vec![0; length];
                request.read_exact(&mut body).unwrap();
            }
            let body = response.to_string();
            write!(
                socket,
                "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        }
    });

    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut backend = Backend::connect(&base, "").await.unwrap();
            backend.workspace = "w".into();

            let checkout_err = backend
                .workspace_checkout("missing-tree")
                .await
                .unwrap_err();
            assert_eq!(
                checkout_err.downcast_ref::<GitError>(),
                Some(&GitError::CheckoutUnavailable)
            );

            let ack_err = backend.git_commit("root", "hello").await.unwrap_err();
            assert_eq!(
                ack_err.downcast_ref::<GitError>(),
                Some(&GitError::UnconfirmedMutation)
            );

            let refusal_err = backend.git_commit("root", "hello").await.unwrap_err();
            let refusal = refusal_err.downcast_ref::<Refusal>().unwrap();
            assert_eq!(refusal.status, 422);
            assert_eq!(refusal.code.as_deref(), Some("hook_failed"));
            assert_eq!(refusal.message(), Some("pre-commit hook rejected"));

            let blank_err = backend.git_commit("root", "hello").await.unwrap_err();
            let blank = blank_err.downcast_ref::<Refusal>().unwrap();
            assert_eq!(blank.status, 500);
            assert_eq!(blank.message(), None);

            let fallback_err = backend.git_commit("root", "hello").await.unwrap_err();
            let fallback = fallback_err.downcast_ref::<Refusal>().unwrap();
            assert_eq!(fallback.status, 409);
            assert_eq!(fallback.message(), Some("Repository locked"));

            let oversized_err = backend.git_commit("root", "hello").await.unwrap_err();
            assert_eq!(
                oversized_err.downcast_ref::<GitError>(),
                Some(&GitError::OversizedContent)
            );

            let empty_msg = backend.git_commit("root", "   ").await.unwrap_err();
            assert_eq!(
                empty_msg.downcast_ref::<GitError>(),
                Some(&GitError::InvalidRequest)
            );

            let bad_mime = diff(
                json!({"path":"a.bin","image":{"mime":"application/octet-stream"}}),
                "a.bin",
            )
            .unwrap_err();
            assert_eq!(
                bad_mime.downcast_ref::<GitError>(),
                Some(&GitError::UnsupportedImageType)
            );

            let huge = "a".repeat(6 * 1024 * 1024 + 1);
            let huge_err = diff(
                json!({"path":"a.txt","isBinary":false,"before":huge,"after":""}),
                "a.txt",
            )
            .unwrap_err();
            assert_eq!(
                huge_err.downcast_ref::<GitError>(),
                Some(&GitError::OversizedContent)
            );

            let foreign = diff(json!({"path":"other.txt","isBinary":true}), "a.txt").unwrap_err();
            assert_eq!(
                foreign.downcast_ref::<GitError>(),
                Some(&GitError::UnexpectedResponse)
            );
        });
    server.join().unwrap();
}
