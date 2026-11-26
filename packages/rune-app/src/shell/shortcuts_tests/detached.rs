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
            temporary: false,
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
        while !(saw_lookup && saw_create && saw_bind) {
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
                assert!(saw_lookup);
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
            let mut workspaces_count = 0usize;
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
                } else if header.starts_with("GET /api/workspaces ") {
                    workspaces_count += 1;
                    if workspaces_count == 2 {
                        let _ = stream
                            .write_all(
                                b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            )
                            .await;
                        let _ = stream.shutdown().await;
                    } else {
                        let body =
                            b"[{\"id\":\"header-windows\",\"location\":{\"directory\":\"/repo\"}}]";
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(resp.as_bytes()).await;
                        let _ = stream.write_all(body).await;
                        let _ = stream.shutdown().await;
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

        // Close active session so Files and Git run in detached mode; consume the handoff refresh first,
        // then move tab 0 to a cached background tab before verifying real SSE offline -> reconnect invalidation.
        send_key(&mut rt, Key::Command('w'), primary_mods(true));
        assert!(rt.state.screen.is_launcher());
        let handoff = rt.state.files.as_mut().unwrap().tree.take_refresh();
        assert!(!handoff.is_empty());
        for read in handoff {
            assert!(
                rt.state
                    .files
                    .as_mut()
                    .unwrap()
                    .tree
                    .complete(read, Ok(vec![]), Ok)
            );
        }
        assert!(
            rt.state
                .files
                .as_mut()
                .unwrap()
                .tree
                .take_refresh()
                .is_empty()
        );
        rt.state.screen.launcher_mut().unwrap().pending = false;
        send_key(&mut rt, Key::Command(']'), primary_mods(false));
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 1);

        // Attach the real SSE CatalogueWatch now and step through gen=1 (online), gen=2 (offline), gen=3 (reconnected).
        let (watch, task) = codenomad_client::stream::CatalogueWatch::new(
            root_backend.clone(),
            rt.state.wake.clone(),
        );
        crate::platform::spawn(task);
        let launcher = rt.state.screen.launcher_mut().unwrap();
        launcher.connection = Some(root_backend);
        launcher.catalogue_watch = Some(watch);

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
        for _ in 0..300 {
            rt.update(|s, tx| {
                let _ = crate::launcher::poll(s, tx);
            });
            if rt
                .state
                .screen
                .launcher()
                .is_some_and(crate::launcher::Launcher::workspace_stream_online)
            {
                break;
            }
            crate::platform::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            rt.state
                .screen
                .launcher()
                .is_some_and(crate::launcher::Launcher::workspace_stream_online)
        );
        // Consume the gen=1 connection revalidation on tab 0 before disconnecting.
        send_key(&mut rt, Key::Command('['), primary_mods(false));
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
        let gen1_reads = rt.state.files.as_mut().unwrap().tree.take_refresh();
        assert!(!gen1_reads.is_empty());
        for read in gen1_reads {
            assert!(
                rt.state
                    .files
                    .as_mut()
                    .unwrap()
                    .tree
                    .complete(read, Ok(vec![]), Ok)
            );
        }
        assert!(
            rt.state
                .files
                .as_mut()
                .unwrap()
                .tree
                .take_refresh()
                .is_empty()
        );
        send_key(&mut rt, Key::Command(']'), primary_mods(false));
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 1);

        let _ = drop_first_tx.send(());
        wait_gen(&mut rt, 2).await;
        // Verify tab 0 actually transitioned offline on gen=2 before reconnecting.
        send_key(&mut rt, Key::Command('['), primary_mods(false));
        assert_eq!(crate::git::fixture_online(&rt.state), Some(false));
        send_key(&mut rt, Key::Command(']'), primary_mods(false));
        let _ = allow_second_tx.send(());
        wait_gen(&mut rt, 3).await;
        for _ in 0..300 {
            rt.update(|s, tx| {
                let _ = crate::launcher::poll(s, tx);
            });
            if rt
                .state
                .screen
                .launcher()
                .is_some_and(crate::launcher::Launcher::workspace_stream_online)
            {
                break;
            }
            crate::platform::sleep(std::time::Duration::from_millis(10)).await;
        }
        rt.state.screen.launcher_mut().unwrap().pending = false;

        // Switch back to tab 0: real SSE reconnect reconciled workspace existence, invalidated detached Files and restored Git online.
        send_key(&mut rt, Key::Command('['), primary_mods(false));
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
        assert_eq!(crate::git::fixture_online(&rt.state), Some(true));
        let files = rt.state.files.as_mut().unwrap();
        files.show(true);
        files.activate(true);
        assert!(!files.tree.take_refresh().is_empty());

        // Reconciling with opened_after omits a newly opened workspace from Stopped,
        // whereas any pre-existing detached workspace (including one closed during reconcile) stops when absent from live.
        let empty = std::collections::HashSet::new();
        let no_opened = std::collections::HashSet::new();
        let opened_after: std::collections::HashSet<String> = ["header-windows".into()].into();
        assert!(crate::workspace::reconcile_detached_online(
            &mut rt.state,
            &opened_after,
            Some(&empty),
        ));
        assert!(!rt.state.files.as_ref().unwrap().stopped);
        assert!(crate::workspace::reconcile_detached_online(
            &mut rt.state,
            &no_opened,
            Some(&empty),
        ));
        assert!(rt.state.files.as_ref().unwrap().stopped);

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

        // Enlarged attachment preview modal blocks tab switching.
        rt.state.transcript_display.pictures.fixture_preview(true);
        send_key(&mut rt, Key::Command('2'), primary_mods(false));
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
        rt.state.transcript_display.pictures.fixture_preview(false);

        // Remapping new-instance to Ctrl+F opens search when session-search is still active (matching Solid),
        // hides Ctrl+F from close-instance tooltip while shadowed by session-search,
        // and runs new-instance once session-search is remapped to Ctrl+G or disabled.
        let tabs_before = rt.state.workspace.as_ref().unwrap().tab_count();
        settings::fixture_shortcuts(
            &rt.state,
            json!({
                "new-instance": [{"key": "f", "mod": true}],
                "close-instance": [{"key": "f", "mod": true}]
            }),
        );
        rt.update(|s, _| s.revision += 1);
        settle(&mut rt);
        assert!(!help_of(&rt, "c-tab-0").contains('('));
        send_key(&mut rt, Key::Command('f'), primary_mods(false));
        assert_eq!(
            rt.state.workspace.as_ref().unwrap().tab_count(),
            tabs_before
        );
        send_key(&mut rt, Key::Escape, Mods::default());

        settings::fixture_shortcuts(
            &rt.state,
            json!({
                "new-instance": [{"key": "f", "mod": true}],
                "session-search": [{"key": "g", "mod": true}]
            }),
        );
        send_key(&mut rt, Key::Command('f'), primary_mods(false));
        assert_eq!(
            rt.state.workspace.as_ref().unwrap().tab_count(),
            tabs_before + 1
        );
        send_key(&mut rt, Key::Command('1'), primary_mods(false));
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);

        settings::fixture_shortcuts(
            &rt.state,
            json!({"new-instance": [{"key": "f", "mod": true}], "session-search": []}),
        );
        send_key(&mut rt, Key::Command('f'), primary_mods(false));
        assert_eq!(
            rt.state.workspace.as_ref().unwrap().tab_count(),
            tabs_before + 2
        );
        send_key(&mut rt, Key::Command('1'), primary_mods(false));
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);

        // Pending message edit also blocks tab switching via global shortcuts.
        rt.state.transcript_display.messages.fixture_set_pending();
        send_key(&mut rt, Key::Command('2'), primary_mods(false));
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
        rt.state.transcript_display.messages = Default::default();

        // Remapping session-search to a bare letter does not swallow typing while the search input
        // is focused, but keeps priority over new-instance when focus moves outside the input.
        settings::fixture_shortcuts(
            &rt.state,
            json!({"session-search": [{"key": "s"}], "new-instance": [{"key": "s"}]}),
        );
        let tabs_before_search = rt.state.workspace.as_ref().unwrap().tab_count();
        rt.update(|s, tx| {
            let open_ev = KeyEvent {
                key: Key::Text("s".into()),
                mods: Mods::default(),
            };
            assert!(crate::timeline::search::open_key(s, &open_ev, tx));
            assert!(
                !crate::timeline::search::open_key(s, &open_ev, tx),
                "bare text key must not be swallowed while the search query is focused"
            );
            crate::timeline::search::fixture_blur(s);
        });
        send_key(&mut rt, Key::Text("s".into()), Mods::default());
        assert_eq!(
            rt.state.workspace.as_ref().unwrap().tab_count(),
            tabs_before_search
        );
        rt.update(|s, _| {
            crate::timeline::search::close(s);
        });
        settings::fixture_shortcuts(&rt.state, json!({}));

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
        crate::git::connected_placed(&mut rt.state, &bound, "wt-a");
        crate::git::fixture_commit_draft(&mut rt.state, Some("wip commit"));
        rt.state.composer.device.choosing = true;
        rt.update(|s, tx| {
            assert!(
                !crate::launcher::close_session(s, tx),
                "close-session must refuse while composer device attachment work is active"
            );
        });
        rt.state.composer.device.choosing = false;
        rt.update(|s, tx| {
            assert!(crate::launcher::close_session(s, tx));
        });
        assert_eq!(
            crate::git::fixture_commit_draft(&mut rt.state, None).as_deref(),
            Some("wip commit")
        );
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
        // Passive file change schedules a wake deadline even when idle in detached mode.
        rt.state.files.as_mut().unwrap().event(
            codenomad_client::transport::WorkspaceEvent::FilesChanged {
                workspace_id: bound.workspace.clone(),
                changes: vec![codenomad_client::transport::DirectoryChange {
                    directory: "/repo".into(),
                    path: "src/new.rs".into(),
                }],
            },
        );
        rt.update(|s, tx| {
            crate::files::poll(s, 1.0, tx);
            assert!(
                s.files.as_ref().unwrap().next_wake().is_some(),
                "detached passive file change must keep a wake deadline"
            );
        });
        // Re-authentication on the same server identity preserves detached Files tree state.
        let attest_old = tokio::spawn({
            let backend = bound.clone();
            async move { backend.attest_server().await.unwrap() }
        });
        http.accept()
            .await
            .reply(200, json!({"apiContract": 1, "serverId": "srv-1"}))
            .await;
        assert_eq!(attest_old.await.unwrap(), "srv-1");
        let mut renewed = Backend::unauthenticated(&http.backend.base).unwrap();
        renewed.workspace = bound.workspace.clone();
        let attest_new = tokio::spawn({
            let backend = renewed.clone();
            async move { backend.attest_server().await.unwrap() }
        });
        http.accept()
            .await
            .reply(200, json!({"apiContract": 1, "serverId": "srv-1"}))
            .await;
        assert_eq!(attest_new.await.unwrap(), "srv-1");
        assert!(!bound.client.same_connection(&renewed.client));
        crate::files::bind(&mut rt.state, &renewed);
        assert!(rt.state.files.as_ref().unwrap().tree.expanded("src"));
        assert_eq!(
            rt.state.files.as_ref().unwrap().tree.selected(),
            Some("src")
        );
        // Rebinding a root conversation from detached mode preserves an active commit draft in the browsed worktree.
        crate::git::connected_placed(&mut rt.state, &bound, "root");
        assert_eq!(
            crate::git::fixture_commit_draft(&mut rt.state, None).as_deref(),
            Some("wip commit")
        );
        crate::files::bind(&mut rt.state, &bound);
        assert!(rt.state.files.as_ref().unwrap().tree.expanded("src"));
        assert_eq!(
            rt.state.files.as_ref().unwrap().tree.selected(),
            Some("src")
        );
        // Rebinding a detached Files panel to a live conversation resets online state so
        // the conversation SSE's online(true) revalidates the tree without losing mid-handoff edits.
        rt.state.files.as_mut().unwrap().show(true);
        let _ = rt.state.files.as_mut().unwrap().tree.take_refresh();
        rt.state.files.as_mut().unwrap().online(true);
        assert!(
            !rt.state
                .files
                .as_mut()
                .unwrap()
                .tree
                .take_refresh()
                .is_empty(),
            "conversation stream online(true) must revalidate a rebound detached Files tree"
        );

        // project_opened during a catalogue SSE outage keeps detached Files/Git offline.
        let (watch, _watch_task) = codenomad_client::stream::CatalogueWatch::new(
            http.backend.clone(),
            std::sync::Arc::new(|| {}),
        );
        if let Some(l) = rt.state.screen.launcher_mut() {
            l.connection = Some(http.backend.clone());
            l.catalogue_watch = Some(watch);
            l.workspace_stream_generation = 2;
        }
        rt.state.git.owner = None;
        crate::git::project_opened(&mut rt.state);
        assert_eq!(crate::git::fixture_online(&rt.state), Some(false));
        if let Some(l) = rt.state.screen.launcher_mut() {
            l.catalogue_watch = None;
            l.workspace_stream_generation = 1;
        }

        // WorkspaceEvent::Stopped reaches active Files/Git even while a conversation stream is open.
        let (_stop_tx, stop_rx) = codenomad_client::bounded(1);
        rt.state.incoming = Some(stop_rx);
        assert!(crate::workspace::deliver_detached_events(
            &mut rt.state,
            &[codenomad_client::transport::WorkspaceEvent::Stopped {
                workspace_id: bound.workspace.clone(),
                deleted: false,
                temporary_retained: false,
            }],
        ));
        assert!(rt.state.files.as_ref().unwrap().stopped);
        rt.state.incoming = None;

        // Creating an untitled session whose directory matches the project root under different casing/slashes
        // omits ?directory= and sends the project's canonical root path in the body.
        let canonical_project = Project {
            id: "proj-win".into(),
            path: r"D:\Repo".into(),
            temporary: false,
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

        // Proxy-attested alias worktree slug succeeds in session_directory and bind_created_session
        // without requiring the alias string to match the inventory path verbatim.
        let alias_project = Project {
            id: "proj-alias".into(),
            path: "/repo".into(),
            temporary: false,
        };
        let dir_task = tokio::spawn({
            let backend = http.backend.clone();
            let project = alias_project.clone();
            async move {
                backend
                    .session_directory(&project, "s-alias")
                    .await
                    .unwrap()
            }
        });
        let req = http.accept().await;
        assert!(
            req.header
                .starts_with("GET /workspaces/proj-alias/instance/api/session/s-alias ")
        );
        req.reply(
            200,
            json!({
                "data": {
                    "id": "s-alias",
                    "title": "",
                    "location": {"directory": "/alias-wt"},
                    "listWorktreeSlug": "wt-a"
                }
            }),
        )
        .await;
        assert_eq!(dir_task.await.unwrap(), "/alias-wt");
        let bind_task = tokio::spawn({
            let backend = http.backend.clone();
            let project = alias_project.clone();
            async move {
                backend
                    .bind_created_session(&project, "s-new", "/alias-wt")
                    .await
                    .unwrap()
            }
        });
        let req = http.accept().await;
        assert!(
            req.header
                .starts_with("GET /workspaces/proj-alias/instance/api/session/s-new ")
        );
        req.reply(
            200,
            json!({
                "data": {
                    "id": "s-new",
                    "title": "",
                    "location": {"directory": "/alias-wt"},
                    "listWorktreeSlug": "wt-a"
                }
            }),
        )
        .await;
        let (_, _, slug) = bind_task.await.unwrap();
        assert_eq!(slug, "wt-a");

        // Refused session-next while launcher is pending does not supersede an active navigation ticket.
        settings::fixture_shortcuts(&rt.state, json!({}));
        let ticket = rt.state.notifications.navigation_ticket();
        if let Some(l) = rt.state.screen.launcher_mut() {
            l.pending = true;
        }
        send_key(&mut rt, Key::Command(']'), primary_mods(true));
        assert_eq!(rt.state.notifications.navigation_ticket(), ticket);
        if let Some(l) = rt.state.screen.launcher_mut() {
            l.pending = false;
        }

        // Closed conversation stream must not be treated as detached by set_detached_online.
        rt.state.show_chat();
        let (closed_tx, closed_rx) = codenomad_client::bounded(1);
        drop(closed_tx);
        rt.state.incoming = Some(closed_rx);
        crate::git::connected_placed(&mut rt.state, &bound, "root");
        crate::git::online(&mut rt.state, false);
        assert!(!crate::workspace::set_detached_online(&mut rt.state, true));
        assert_eq!(crate::git::fixture_online(&rt.state), Some(false));
        rt.state.incoming = None;

        // Remapped session-search to PageUp does not open search while composer has focus.
        settings::fixture_shortcuts(&rt.state, json!({"session-search": [{"key": "PageUp"}]}));
        rt.update(|_, tx| {
            tx.focus("composer", true);
        });
        settle(&mut rt);
        send_key(&mut rt, Key::PageUp, Mods::default());
        assert!(!crate::timeline::search::is_open(&rt.state));

        // Remapped session-search to F8 is blocked while the composer picker overlay is open.
        settings::fixture_shortcuts(&rt.state, json!({"session-search": [{"key": "F8"}]}));
        rt.state.draft = TextEdit::new("@");
        rt.state
            .composer
            .picker
            .changed(&rt.state.draft, &rt.state.reads, &rt.state.wake);
        assert!(rt.state.composer.picker.open());
        send_key(&mut rt, Key::Function(8), Mods::default());
        assert!(!crate::timeline::search::is_open(&rt.state));
        rt.state.composer.picker.reset();
        rt.state.draft = TextEdit::new("");

        // Conversation header search toggle tooltip reflects confirmed session-search override,
        // and key repeat does not reopen session-search.
        rt.update(|_, tx| tx.instant());
        settle(&mut rt);
        let search_help = rt
            .elements()
            .into_iter()
            .find(|el| el.key.as_deref() == Some("history-search-toggle"))
            .and_then(|el| el.help)
            .unwrap_or_default();
        assert!(
            search_help.contains("F8"),
            "expected F8 shortcut in search tooltip: {search_help:?}"
        );
        rt.repeat_key(KeyEvent {
            key: Key::Function(8),
            mods: Mods::default(),
        });
        settle(&mut rt);
        assert!(!crate::timeline::search::is_open(&rt.state));

        // Repeat of a shadowed session-search shortcut is consumed and does not fall through to instance-next.
        settings::fixture_shortcuts(
            &rt.state,
            json!({"instance-next": [{"key": "f", "mod": true}]}),
        );
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
        rt.repeat_key(KeyEvent {
            key: Key::Command('f'),
            mods: primary_mods(false),
        });
        settle(&mut rt);
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
        assert!(!crate::timeline::search::is_open(&rt.state));

        // Opening search then closing the session closes search so Escape does not hit an invisible search overlay.
        crate::workspace::bound(&mut rt.state, &bound);
        // Trimmed sidebar filter matches sessions even with leading/trailing spaces.
        if let Some(l) = rt.state.screen.launcher_mut() {
            l.sessions = vec![
                Session {
                    id: "s1".into(),
                    title: "Alpha".into(),
                },
                Session {
                    id: "s2".into(),
                    title: "Beta".into(),
                },
            ];
            l.show_search = true;
            l.search = TextEdit::new(" Alpha ");
            assert_eq!(
                crate::shell::sidebar::visible_session_ids(l),
                vec!["s1".to_string()]
            );
            l.show_search = false;
            l.search = TextEdit::new("");
        }
        send_key(&mut rt, Key::Command('f'), primary_mods(false));
        assert!(crate::timeline::search::is_open(&rt.state));
        settings::fixture_shortcuts(&rt.state, json!({}));
        send_key(&mut rt, Key::Command('w'), primary_mods(true));
        assert!(rt.state.screen.is_launcher());
        assert!(!crate::timeline::search::is_open(&rt.state));
        rt.update(|s, tx| {
            let esc = KeyEvent {
                key: Key::Escape,
                mods: Mods::default(),
            };
            assert!(!crate::timeline::search::close_key(s, &esc, tx));
        });
    });
}
