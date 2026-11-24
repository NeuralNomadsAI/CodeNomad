use super::*;

#[test]
#[cfg(not(target_arch = "wasm32"))]
fn session_new_resolves_authoritative_directory_and_honors_placement_hold() {
    use crate::files::test_http::Http as Fixture;
    crate::platform::block_on(async {
        let http = Fixture::new().await;
        let mut s = workspace_state(1);
        let project = Project {
            id: "proj-1".into(),
            path: "/repo".into(),
        };
        let l = s.screen.launcher_mut().unwrap();
        l.connection = Some(http.backend.clone());
        l.project = Some(project.clone());
        workspace::opened(&mut s, &project);
        let bound = Backend {
            workspace: "proj-1".into(),
            session: "s-linked".into(),
            ..http.backend.clone()
        };
        workspace::bound(&mut s, &bound);
        crate::git::connected_placed(&mut s, &bound, "wt-a");
        let hold = crate::git::PlacementHold {
            members: std::collections::HashSet::from(["s-linked".into()]),
            answered: true,
        };
        crate::git::hold_placement(&mut s, hold.clone());
        let mut rt = project_runtime(s);

        // Unconfirmed worktree move hold blocks session-new.
        send_key(&mut rt, Key::Command('n'), primary_mods(true));
        assert!(!rt.state.screen.launcher().unwrap().pending);

        // Once released, Ready session-new queries the active session's authoritative directory
        // so an in-flight move from wt-a to /repo-moved creates in /repo-moved.
        crate::git::release_placement(&mut rt.state, &bound.base, &hold);
        assert!(matches!(
            crate::git::session_directory(&rt.state),
            crate::git::SessionDirectory::ResolveSession(ref id) if id == "s-linked"
        ));
        send_key(&mut rt, Key::Command('n'), primary_mods(true));
        assert!(rt.state.screen.launcher().unwrap().pending);

        let mut saw_lookup = false;
        let mut saw_create = false;
        let mut saw_bind = false;
        let mut worktree_reads = 0usize;
        while !(saw_lookup && saw_create && saw_bind && worktree_reads >= 2) {
            let req = http.accept().await;
            if req
                .header
                .starts_with("GET /workspaces/proj-1/instance/api/session/s-linked ")
            {
                saw_lookup = true;
                req.reply(
                    200,
                    json!({"data":{"id":"s-linked","title":"","listWorktreeSlug":"wt-b","location":{"directory":"/repo-moved"}}}),
                )
                .await;
            } else if req.header.starts_with(
                "POST /workspaces/proj-1/instance/api/session?directory=%2Frepo-moved ",
            ) {
                assert!(saw_lookup && worktree_reads >= 1);
                assert_eq!(req.body["location"]["directory"], json!("/repo-moved"));
                saw_create = true;
                req.reply(
                    200,
                    json!({"data":{"id":"new-linked","title":"","location":{"directory":"/repo-moved"}}}),
                )
                .await;
            } else if req
                .header
                .starts_with("GET /workspaces/proj-1/instance/api/session/new-linked ")
            {
                saw_bind = true;
                req.reply(
                    200,
                    json!({"data":{"id":"new-linked","title":"","listWorktreeSlug":"wt-b","location":{"directory":"/repo-moved"}}}),
                )
                .await;
            } else if req
                .header
                .starts_with("GET /api/workspaces/proj-1/worktrees ")
            {
                worktree_reads += 1;
                req.reply(
                    200,
                    json!({"worktrees":[
                        {"slug":"root","directory":"/repo","isRoot":true,"nestedFolderMissing":false},
                        {"slug":"wt-b","directory":"/repo-alias","serviceDirectory":"/repo-moved","isRoot":false,"nestedFolderMissing":false}
                    ]}),
                )
                .await;
            } else {
                req.reply(404, json!({})).await;
            }
        }
        for _ in 0..300 {
            let mut done = false;
            rt.update(|s, tx| done = crate::launcher::poll(s, tx));
            if done {
                break;
            }
            crate::platform::sleep(std::time::Duration::from_millis(10)).await;
        }
        settle(&mut rt);
        assert_eq!(workspace::active_session(&rt.state), Some("new-linked"));
    });
}

#[test]
#[cfg(not(target_arch = "wasm32"))]
fn detached_files_and_git_invalidate_after_stream_reconnect() {
    crate::platform::block_on(async {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        async fn read_http_head(stream: &mut tokio::net::TcpStream) -> String {
            let mut bytes = Vec::with_capacity(512);
            let mut chunk = [0u8; 512];
            while !bytes.windows(4).any(|w| w == b"\r\n\r\n") && bytes.len() < 8192 {
                let n = stream.read(&mut chunk).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..n]);
            }
            String::from_utf8_lossy(&bytes).into_owned()
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}/", listener.local_addr().unwrap());
        let (drop_first_tx, drop_first_rx) = tokio::sync::oneshot::channel::<()>();
        let (allow_second_tx, allow_second_rx) = tokio::sync::oneshot::channel::<()>();
        let (drop_second_tx, drop_second_rx) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let mut drop_first = Some(drop_first_rx);
            let mut allow_second = Some(allow_second_rx);
            let mut drop_second = Some(drop_second_rx);
            let mut sse_count = 0usize;
            while let Ok((mut stream, _)) = listener.accept().await {
                let header = read_http_head(&mut stream).await;
                if header.starts_with("GET /api/events") {
                    sse_count += 1;
                    if sse_count == 1 {
                        let _ = stream
                            .write_all(
                                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: {\"type\":\"server.connected\"}\n\n",
                            )
                            .await;
                        let _ = stream.flush().await;
                        if let Some(rx) = drop_first.take() {
                            tokio::spawn(async move {
                                let _ = rx.await;
                                let _ = stream.shutdown().await;
                            });
                        }
                    } else if sse_count == 2 {
                        if let Some(rx) = allow_second.take() {
                            let _ = rx.await;
                        }
                        let _ = stream
                            .write_all(
                                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: {\"type\":\"server.connected\"}\n\n",
                            )
                            .await;
                        let _ = stream.flush().await;
                        if let Some(rx) = drop_second.take() {
                            tokio::spawn(async move {
                                let _ = rx.await;
                                let _ = stream.shutdown().await;
                            });
                        }
                    } else {
                        let _ = stream
                            .write_all(
                                b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            )
                            .await;
                        let _ = stream.flush().await;
                    }
                } else {
                    let body = b"{\"data\":[]}";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                    let _ = stream.write_all(body).await;
                    let _ = stream.shutdown().await;
                }
            }
        });

        let mut s = workspace_state(2);
        let root_backend = Backend::unauthenticated(&address).unwrap();
        let backend = Backend {
            workspace: "header-windows".into(),
            session: "session".into(),
            ..root_backend.clone()
        };
        if let Some(l) = s.screen.launcher_mut() {
            l.connection = Some(root_backend.clone());
        }
        workspace::bound(&mut s, &backend);
        crate::files::bind(&mut s, &backend);
        let files = s.files.as_mut().unwrap();
        files.online(true);
        files.activate(true);
        files.show(true);
        let initial = files.tree.take_refresh();
        assert_eq!(initial.len(), 1);
        for read in initial {
            assert!(files.tree.complete(read, Ok(vec![]), Ok));
        }
        assert!(files.tree.take_refresh().is_empty());
        crate::git::connected(&mut s, &backend);
        let mut rt = project_runtime(s);

        // Close active session so Files and Git run in detached mode, then move it to a cached background tab.
        send_key(&mut rt, Key::Command('w'), primary_mods(true));
        assert!(rt.state.screen.is_launcher());
        rt.state.screen.launcher_mut().unwrap().pending = false;
        send_key(&mut rt, Key::Command(']'), primary_mods(false));
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 1);

        // Attach the real SSE CatalogueWatch now and step through gen=1 (online), gen=2 (offline), gen=3 (reconnected).
        let (watch, task) =
            codenomad_client::stream::CatalogueWatch::new(root_backend, rt.state.wake.clone());
        crate::platform::spawn(task);
        rt.state.screen.launcher_mut().unwrap().catalogue_watch = Some(watch);

        async fn wait_gen(rt: &mut Runtime<State>, target: u64) {
            for _ in 0..300 {
                rt.update(|s, tx| {
                    let _ = crate::launcher::poll(s, tx);
                });
                if rt
                    .state
                    .screen
                    .launcher()
                    .is_some_and(|l| l.workspace_stream_generation == target)
                {
                    return;
                }
                crate::platform::sleep(std::time::Duration::from_millis(10)).await;
            }
            panic!("timed out waiting for workspace_stream_generation == {target}");
        }

        wait_gen(&mut rt, 1).await;
        let _ = drop_first_tx.send(());
        wait_gen(&mut rt, 2).await;
        let _ = allow_second_tx.send(());
        wait_gen(&mut rt, 3).await;
        rt.state.screen.launcher_mut().unwrap().pending = false;

        // Switch back to tab 0: real SSE reconnect through launcher::poll invalidated detached Files and restored Git online.
        send_key(&mut rt, Key::Command('['), primary_mods(false));
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
        assert_eq!(crate::git::fixture_online(&rt.state), Some(true));
        let files = rt.state.files.as_mut().unwrap();
        files.show(true);
        files.activate(true);
        assert!(!files.tree.take_refresh().is_empty());

        // Subsequent 401 on the detached SSE observer surfaces authentication_required on the launcher.
        let _ = drop_second_tx.send(());
        for _ in 0..300 {
            rt.update(|s, tx| {
                let _ = crate::launcher::poll(s, tx);
            });
            if rt
                .state
                .screen
                .launcher()
                .is_some_and(|l| l.authentication_required)
            {
                break;
            }
            crate::platform::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            rt.state
                .screen
                .launcher()
                .is_some_and(|l| l.authentication_required)
        );
        server.abort();
    });
}

#[test]
#[cfg(not(target_arch = "wasm32"))]
fn message_actions_guards_unsupported_multi_overrides_and_shadowed_tooltips() {
    use crate::files::test_http::Http as Fixture;
    crate::platform::block_on(async {
        let http = Fixture::new().await;
        let mut s = workspace_state(2);
        let bound = Backend {
            workspace: "header-windows".into(),
            session: "session".into(),
            ..http.backend.clone()
        };
        workspace::bound(&mut s, &bound);
        let mut rt = project_runtime(s);
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);

        // Open transcript message action menu blocks tab switching.
        rt.state
            .transcript_display
            .messages
            .fixture_open_menu(Some("m-1"));
        send_key(&mut rt, Key::Command('2'), primary_mods(false));
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
        rt.state.transcript_display.messages.fixture_open_menu(None);

        // Open prune confirmation modal blocks both tab switching and close-session.
        let preview_task = tokio::spawn({
            let bound = bound.clone();
            async move { bound.preview_message_prune("m-1").await.unwrap() }
        });
        let req = http.accept().await;
        assert!(
            req.header
                .starts_with("POST /api/workspaces/header-windows/session-pruning/preview ")
        );
        req.reply(
            200,
            json!({
                "status": "preview",
                "liveMutation": true,
                "revision": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                "parts": [{"index": 0, "type": "tool"}]
            }),
        )
        .await;
        let preview = preview_task.await.unwrap();
        let scope = rt.state.input_scope.clone();
        rt.state
            .transcript_display
            .messages
            .fixture_confirmation(&scope, Some(preview));
        send_key(&mut rt, Key::Command('2'), primary_mods(false));
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
        send_key(&mut rt, Key::Command('w'), primary_mods(true));
        assert!(!rt.state.screen.is_launcher());
        rt.state
            .transcript_display
            .messages
            .fixture_confirmation(&scope, None);

        // History search scope dropdown blocks global shortcuts.
        crate::timeline::search::fixture_scope_open(&mut rt.state, Some(bound.clone()), true);
        send_key(&mut rt, Key::Command(']'), primary_mods(false));
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
        crate::timeline::search::fixture_scope_open(&mut rt.state, None, false);

        // Multi-binding override with one unsupported key keeps the valid alternative instead of reverting to default.
        settings::fixture_shortcuts(
            &rt.state,
            json!({"instance-next": [{"key": "f8"}, {"key": "AudioVolumeUp"}]}),
        );
        send_key(&mut rt, Key::Command(']'), primary_mods(false));
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
        send_key(&mut rt, Key::Function(8), Mods::default());
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 1);

        // Return to the bound project tab; Solid's " " Space override is accepted instead of reverting to default.
        send_key(&mut rt, Key::Command('1'), primary_mods(false));
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
        settings::fixture_shortcuts(
            &rt.state,
            json!({"instance-next": [{"key": " ", "mod": true}]}),
        );
        assert!(
            settings::with_shortcut_label(&rt.state, "Next", "instance-next").contains("Space")
        );
        send_key(&mut rt, Key::Command(']'), primary_mods(false));
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
        send_key(&mut rt, Key::Command(' '), primary_mods(false));
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 1);

        // Return to the bound project tab and verify session-new / new-instance shadowing hides overridden tooltips.
        send_key(&mut rt, Key::Command('1'), primary_mods(false));
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
        settings::fixture_shortcuts(
            &rt.state,
            json!({
                "session-new": [{"key": "n", "mod": true}],
                "new-instance": [{"key": "f8"}],
                "close-instance": [{"key": "f8"}]
            }),
        );
        rt.update(|s, _| s.revision += 1);
        settle(&mut rt);
        let help_of = |rt: &Runtime<State>, key: &str| {
            rt.elements()
                .into_iter()
                .find(|el| el.key.as_deref() == Some(key))
                .and_then(|el| el.help)
                .unwrap()
        };
        assert!(
            !help_of(&rt, "c-tab-0").contains('('),
            "unexpected shadowed close hint: {}",
            help_of(&rt, "c-tab-0")
        );
        settings::fixture_shortcuts(
            &rt.state,
            json!({"session-new": [{"key": "n", "mod": true}]}),
        );
        rt.update(|s, _| s.revision += 1);
        settle(&mut rt);
        let new_help = help_of(&rt, "project-tabs-new");
        assert!(
            !new_help.contains('('),
            "unexpected shadowed hint: {new_help}"
        );

        // Control-character overrides are invalid and revert to default instead of disabling the shortcut.
        settings::fixture_shortcuts(&rt.state, json!({"close-instance": [{"key": "\u{001b}"}]}));
        assert!(
            settings::with_shortcut_label(&rt.state, "Close", "close-instance").contains('('),
            "control char override must revert to default"
        );

        // Remapping new-instance to Ctrl+F while disabling session-search runs new-instance instead of opening search.
        settings::fixture_shortcuts(
            &rt.state,
            json!({"new-instance": [{"key": "f", "mod": true}], "session-search": []}),
        );
        let tabs_before = rt.state.workspace.as_ref().unwrap().tab_count();
        send_key(&mut rt, Key::Command('f'), primary_mods(false));
        assert_eq!(
            rt.state.workspace.as_ref().unwrap().tab_count(),
            tabs_before + 1
        );
        send_key(&mut rt, Key::Command('1'), primary_mods(false));
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);

        // Closing and rebinding a session in the same project preserves the Files tree expanded folders
        // and revalidates the tree across the conversation-to-detached handoff.
        let mut files = crate::files::Ui::new(
            bound.clone(),
            "/repo".into(),
            rt.state.reads.clone(),
            rt.state.wake.clone(),
        );
        files.host_width = Some(1200.0);
        files.show(true);
        files.activate(true);
        files.online(true);
        let _ = files.tree.take_refresh();
        files.tree.select("src".into());
        files.tree.toggle("src");
        let _ = files.tree.take_refresh();
        assert!(files.tree.expanded("src"));
        assert_eq!(files.tree.selected(), Some("src"));
        rt.state.files = Some(files);
        rt.update(|s, tx| {
            assert!(crate::launcher::close_session(s, tx));
        });
        assert!(rt.state.files.as_ref().unwrap().tree.expanded("src"));
        assert_eq!(
            rt.state.files.as_ref().unwrap().tree.selected(),
            Some("src")
        );
        assert!(
            !rt.state
                .files
                .as_mut()
                .unwrap()
                .tree
                .take_refresh()
                .is_empty(),
            "close-session handoff must revalidate Files tree"
        );
        crate::files::bind(&mut rt.state, &bound);
        assert!(rt.state.files.as_ref().unwrap().tree.expanded("src"));
        assert_eq!(
            rt.state.files.as_ref().unwrap().tree.selected(),
            Some("src")
        );

        // Creating an untitled session whose directory matches the project root under different casing/slashes
        // omits ?directory= and sends the project's canonical root path in the body.
        let canonical_project = Project {
            id: "proj-win".into(),
            path: r"D:\Repo".into(),
        };
        let create_task = tokio::spawn({
            let backend = http.backend.clone();
            let project = canonical_project.clone();
            async move {
                backend
                    .create_untitled_session(&project, "d:/repo")
                    .await
                    .unwrap()
            }
        });
        let req = http.accept().await;
        assert!(
            req.header
                .starts_with("POST /workspaces/proj-win/instance/api/session "),
            "unexpected query on root match: {}",
            req.header
        );
        assert_eq!(
            req.body["location"]["directory"],
            json!(r"D:\Repo"),
            "expected canonical root path in body: {}",
            req.body
        );
        req.reply(
            200,
            json!({"data":{"id":"s-root","title":"","location":{"directory":r"D:\Repo"}}}),
        )
        .await;
        assert_eq!(create_task.await.unwrap().id, "s-root");
    });
}
