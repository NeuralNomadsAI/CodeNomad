use super::*;
use crate::{Phase, init, poll_chat};
use rune::{Env, Runtime};

#[test]
fn recall_hydration_can_follow_only_an_installed_visible_window() {
    let (mut reader, _) = Reader::open();
    assert!(!reader.has_visible_window());
    reader.install(false);
    assert!(reader.has_visible_window());
    reader.stop_content();
    assert!(!reader.has_visible_window());
    reader.resume(Bookmark::Latest);
    assert!(!reader.has_visible_window());
    reader.install(false);
    assert!(reader.has_visible_window());
}

#[test]
fn receipt_updates_the_bookmark_of_a_hidden_optimistic_row() {
    let mut state = init();
    let (mut reader, lane) = Reader::open();
    reader.resume(Bookmark::Message {
        id: "attempt".into(),
        offset: -15.0,
    });
    reader.stop_content();
    state.reader = Some(reader);
    settle_bookmark(&mut state, "attempt", Some("confirmed"));
    assert!(lane.demand.current().target.is_none());
    assert_eq!(
        state.reader.as_ref().unwrap().bookmark,
        Bookmark::Message {
            id: "confirmed".into(),
            offset: -15.0,
        }
    );
    settle_bookmark(&mut state, "confirmed", None);
    assert_eq!(state.reader.as_ref().unwrap().bookmark, Bookmark::Latest);
}

#[test]
fn queued_content_cannot_reopen_admission_after_a_disconnect() {
    let mut state = init();
    let (reader, lane) = Reader::open();
    state.reader = Some(reader);
    let (out, incoming) = bounded(1);
    state.incoming = Some(incoming);
    lane.events
        .try_send((
            0,
            0,
            Event::Sync(crate::history::Page {
                rows: vec![],
                older: None,
                newer: None,
                running: false,
                user_file_references: false,
            }),
        ))
        .unwrap();
    lane.events.try_send((0, 0, Event::Done)).unwrap();
    lane.connection.store(1, SeqCst);
    out.try_send(Event::Reconnecting).unwrap();
    assert!(poll_chat(&mut state, 8));
    assert!(state.phase == Phase::Reconnecting);
    lane.events
        .try_send((
            0,
            1,
            Event::Sync(crate::history::Page {
                rows: vec![],
                older: None,
                newer: None,
                running: false,
                user_file_references: false,
            }),
        ))
        .unwrap();
    assert!(poll_chat(&mut state, 8));
    assert!(state.phase == Phase::Ready);
}

#[test]
fn a_page_queued_before_an_activity_change_cannot_reopen_admission() {
    for previous in [false, true] {
        let mut state = init();
        let (reader, lane) = Reader::open();
        state.reader = Some(reader);
        let (out, incoming) = bounded(2);
        state.incoming = Some(incoming);
        let queue_page = |running, version| {
            lane.events
                .try_send((
                    0,
                    0,
                    Event::ReaderSync {
                        page: crate::history::Page {
                            rows: vec![],
                            older: None,
                            newer: None,
                            running,
                            user_file_references: false,
                        },
                        version,
                    },
                ))
                .unwrap();
        };
        queue_page(previous, 1);
        out.try_send(Event::ObservedRunning {
            running: !previous,
            version: 2,
        })
        .unwrap();
        assert!(poll_chat(&mut state, 8));
        assert!(state.phase == Phase::Streaming);
        assert!(state.reader.as_ref().unwrap().blocks_send());
        out.try_send(Event::ObservedRunning {
            running: false,
            version: 3,
        })
        .unwrap();
        queue_page(false, 3);
        assert!(poll_chat(&mut state, 8));
        assert!(state.phase == Phase::Ready);
        assert!(!state.reader.as_ref().unwrap().blocks_send());
    }
}

#[test]
fn a_disconnect_reissues_an_uninstalled_around_snapshot() {
    let mut state = init();
    let (mut reader, lane) = Reader::open();
    reader.resume(Bookmark::Message {
        id: "saved-anchor".into(),
        offset: -17.0,
    });
    let previous = lane.demand.current();
    state.reader = Some(reader);
    let (out, incoming) = bounded(1);
    state.incoming = Some(incoming);
    lane.events
        .try_send((
            previous.generation,
            0,
            Event::Sync(crate::history::Page {
                rows: vec![],
                older: None,
                newer: Some(serde_json::json!({"kind":"after"})),
                running: false,
                user_file_references: false,
            }),
        ))
        .unwrap();
    lane.connection.store(1, SeqCst);
    out.try_send(Event::Reconnecting).unwrap();
    assert!(poll_chat(&mut state, 8));
    assert!(state.reader.as_ref().unwrap().resume_pending);
    let resumed = lane.demand.current();
    assert_eq!(resumed.target, previous.target);
    assert_ne!(resumed.generation, previous.generation);
}

#[test]
fn terminal_observation_settles_when_suspension_cancels_the_tail_read() {
    let mut state = init();
    let (reader, _lane) = Reader::open();
    state.reader = Some(reader);
    state.phase = Phase::Streaming;
    let (out, incoming) = bounded(1);
    state.incoming = Some(incoming);
    out.try_send(Event::ObservedRunning {
        running: false,
        version: 1,
    })
    .unwrap();
    assert!(poll_chat(&mut state, 8));
    assert!(
        state.phase == Phase::Streaming,
        "visible tail still needs the content read"
    );
    assert!(state.reader.as_ref().unwrap().blocks_send());
    suspend(&mut state);
    assert!(
        state.phase == Phase::Ready,
        "hidden execution status settles without content"
    );
}

#[test]
fn retry_keeps_the_original_anchor_even_without_cached_rows() {
    let mut state = init();
    let (mut reader, lane) = Reader::open();
    let anchor = Bookmark::Message {
        id: "saved-anchor".into(),
        offset: -17.0,
    };
    reader.resume(anchor.clone());
    let previous = lane.demand.current();
    reader.failed();
    state.reader = Some(reader);
    state.phase = Phase::Reconnecting;
    state.history_error = true;
    assert!(!state.can_older && state.messages.is_empty());
    let mut rt = Runtime::new(state, crate::view, (960.0, 760.0), Env::new(false, 1.0));
    rt.frame(0.02);
    let (x, y) = rt
        .find("older")
        .expect("Retry is available without an Older cursor");
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    assert!(!rt.state.history_error);
    assert_eq!(rt.state.reader.as_ref().unwrap().bookmark, anchor);
    assert_eq!(lane.demand.current().target, previous.target);
    assert_ne!(lane.demand.current().generation, previous.generation);
}

#[test]
fn linked_disconnect_during_historical_page_preserves_error_and_retry_direction() {
    use crate::transport::{Command, HistoryEdge};

    for edge in [HistoryEdge::After, HistoryEdge::Oldest] {
        // Order A: Input::Closed invalidates the lane connection before Rune drains PageFailed.
        let mut state = init();
        let (mut reader, lane) = Reader::open();
        reader.install(true);
        state.reader = Some(reader);
        state.phase = Phase::Ready;
        state.history_detached = true;
        state.can_older = true;
        let (cmd_tx, cmd_rx) = bounded(4);
        let (out, incoming) = bounded(4);
        state.commands = Some(cmd_tx);
        state.incoming = Some(incoming);

        assert!(request_page(&mut state, edge));
        let Command::Page(sent_edge, cancelled) = cmd_rx.try_recv().unwrap() else {
            panic!("expected Command::Page");
        };
        assert_eq!(sent_edge, edge);

        lane.events
            .try_send((0, 0, Event::PageFailed(cancelled.clone())))
            .unwrap();
        lane.connection.store(1, SeqCst);
        out.try_send(Event::ConnectionLost).unwrap();
        out.try_send(Event::Reconnecting).unwrap();

        assert!(poll_chat(&mut state, 8));
        assert!(!state.paging);
        assert!(
            cancelled.is_closed(),
            "disconnect must fence the superseded {edge:?} page ticket"
        );
        assert!(
            state.history_error,
            "disconnect during {edge:?} page must report history_error"
        );
        assert_eq!(
            state.transcript_display.timeline.page_retry,
            Some(edge),
            "disconnect during {edge:?} page must keep its retry direction"
        );
        assert!(
            !state.reader.as_ref().unwrap().resume_pending,
            "disconnect during explicit historical page must not clobber the window with resume"
        );
        assert!(!state.transcript_display.timeline.is_online());
        out.try_send(Event::AgentHint(true)).unwrap();
        assert!(poll_chat(&mut state, 8));
        assert!(
            state.transcript_display.timeline.is_online(),
            "reconnecting on a detached window must restore timeline online state"
        );
        assert!(older(&mut state));
        let Command::Page(retried_edge, _) = cmd_rx.try_recv().unwrap() else {
            panic!("expected retried Command::Page");
        };
        assert_eq!(retried_edge, edge);

        // Order B: PageFailed is drained before ConnectionLost/Reconnecting arrive.
        let mut state = init();
        let (mut reader, lane) = Reader::open();
        reader.install(true);
        state.reader = Some(reader);
        state.phase = Phase::Ready;
        state.history_detached = true;
        state.can_older = true;
        let (cmd_tx, cmd_rx) = bounded(4);
        let (out, incoming) = bounded(4);
        state.commands = Some(cmd_tx);
        state.incoming = Some(incoming);

        assert!(request_page(&mut state, edge));
        let Command::Page(sent_edge, cancelled) = cmd_rx.try_recv().unwrap() else {
            panic!("expected Command::Page");
        };
        assert_eq!(sent_edge, edge);

        lane.events
            .try_send((0, 0, Event::PageFailed(cancelled)))
            .unwrap();
        assert!(poll_chat(&mut state, 8));
        assert!(state.history_error && !state.paging);
        assert_eq!(state.transcript_display.timeline.page_retry, Some(edge));

        lane.connection.store(1, SeqCst);
        out.try_send(Event::ConnectionLost).unwrap();
        out.try_send(Event::Reconnecting).unwrap();
        assert!(poll_chat(&mut state, 8));
        assert!(state.history_error && !state.paging);
        assert_eq!(
            state.transcript_display.timeline.page_retry,
            Some(edge),
            "reconnecting after PageFailed must not wipe page_retry for {edge:?}"
        );
        assert!(
            !older(&mut state),
            "offline detached window must wait for stream reconnect before retrying {edge:?}"
        );
        out.try_send(Event::AgentHint(true)).unwrap();
        assert!(poll_chat(&mut state, 8));
        assert!(older(&mut state));
        let Command::Page(retried_edge, _) = cmd_rx.try_recv().unwrap() else {
            panic!("expected retried Command::Page");
        };
        assert_eq!(retried_edge, edge);
    }

    // On a non-detached window, disconnect during an explicit page still resumes and ReaderSync clears both error and retry.
    let mut state = init();
    let (mut reader, lane) = Reader::open();
    reader.install(false);
    state.reader = Some(reader);
    state.phase = Phase::Ready;
    state.can_older = true;
    let (cmd_tx, cmd_rx) = bounded(4);
    let (out, incoming) = bounded(4);
    state.commands = Some(cmd_tx);
    state.incoming = Some(incoming);
    assert!(request_page(&mut state, HistoryEdge::Oldest));
    let _ = cmd_rx.try_recv().unwrap();
    lane.connection.store(1, SeqCst);
    out.try_send(Event::ConnectionLost).unwrap();
    assert!(poll_chat(&mut state, 8));
    assert!(state.history_error);
    assert_eq!(
        state.transcript_display.timeline.page_retry,
        Some(HistoryEdge::Oldest)
    );
    assert!(
        state.reader.as_ref().unwrap().resume_pending,
        "disconnect during a non-detached page must keep reconnect resume active"
    );
    lane.events
        .try_send((
            1,
            1,
            Event::ReaderSync {
                page: crate::history::Page {
                    rows: vec![],
                    older: None,
                    newer: None,
                    running: false,
                    user_file_references: false,
                },
                version: 1,
            },
        ))
        .unwrap();
    assert!(poll_chat(&mut state, 8));
    assert!(!state.history_error);
    assert_eq!(state.transcript_display.timeline.page_retry, None);

    // When ReaderSync arrives with older still valid, the failed pagination retry direction is preserved.
    let mut state = init();
    let (mut reader, lane) = Reader::open();
    reader.install(false);
    state.reader = Some(reader);
    state.phase = Phase::Ready;
    state.can_older = true;
    let (cmd_tx, cmd_rx) = bounded(4);
    let (out, incoming) = bounded(4);
    state.commands = Some(cmd_tx);
    state.incoming = Some(incoming);
    assert!(request_page(&mut state, HistoryEdge::Oldest));
    let _ = cmd_rx.try_recv().unwrap();
    lane.connection.store(1, SeqCst);
    out.try_send(Event::ConnectionLost).unwrap();
    assert!(poll_chat(&mut state, 8));
    assert!(state.history_error);
    assert_eq!(
        state.transcript_display.timeline.page_retry,
        Some(HistoryEdge::Oldest)
    );
    lane.events
        .try_send((
            1,
            1,
            Event::ReaderSync {
                page: crate::history::Page {
                    rows: vec![],
                    older: Some(serde_json::json!({"kind":"before","messageID":"m1"})),
                    newer: None,
                    running: false,
                    user_file_references: false,
                },
                version: 1,
            },
        ))
        .unwrap();
    assert!(poll_chat(&mut state, 8));
    assert!(!state.reader.as_ref().unwrap().resume_pending);
    assert!(state.history_error);
    assert_eq!(
        state.transcript_display.timeline.page_retry,
        Some(HistoryEdge::Oldest)
    );
    assert!(older(&mut state));
    let Command::Page(retried_edge, _) = cmd_rx.try_recv().unwrap() else {
        panic!("expected retried Command::Page");
    };
    assert_eq!(retried_edge, HistoryEdge::Oldest);

    // refresh_after_message_action cancels pending paging so a later disconnect cannot resurrect history_error.
    let mut state = init();
    let (mut reader, _lane) = Reader::open();
    reader.install(true);
    state.reader = Some(reader);
    state.phase = Phase::Ready;
    state.history_detached = true;
    state.can_older = true;
    let (cmd_tx, cmd_rx) = bounded(4);
    let (out, incoming) = bounded(4);
    state.commands = Some(cmd_tx);
    state.incoming = Some(incoming);
    assert!(request_page(&mut state, HistoryEdge::After));
    let _ = cmd_rx.try_recv().unwrap();
    refresh_after_message_action(&mut state);
    assert!(!state.paging && !state.history_error);
    assert_eq!(state.transcript_display.timeline.page_retry, None);
    out.try_send(Event::ConnectionLost).unwrap();
    assert!(poll_chat(&mut state, 8));
    assert!(!state.history_error);
    assert_eq!(state.transcript_display.timeline.page_retry, None);

    // suspend and HistoryInvalidated clear history_error together with page_retry.
    state.history_error = true;
    state.transcript_display.timeline.page_retry = Some(HistoryEdge::After);
    suspend(&mut state);
    assert!(!state.history_error);
    assert_eq!(state.transcript_display.timeline.page_retry, None);

    state.history_error = true;
    state.transcript_display.timeline.page_retry = Some(HistoryEdge::Oldest);
    out.try_send(Event::HistoryInvalidated).unwrap();
    assert!(poll_chat(&mut state, 8));
    assert!(!state.history_error);
    assert_eq!(state.transcript_display.timeline.page_retry, None);

    // Terminal incoming channel closure preserves page_retry direction and history_error.
    let mut state = init();
    let (mut reader, _lane) = Reader::open();
    reader.install(true);
    state.reader = Some(reader);
    state.phase = Phase::Ready;
    state.history_detached = true;
    state.can_older = true;
    let (cmd_tx, cmd_rx) = bounded(4);
    let (out, incoming) = bounded(4);
    state.commands = Some(cmd_tx);
    state.incoming = Some(incoming);
    assert!(request_page(&mut state, HistoryEdge::After));
    let _ = cmd_rx.try_recv().unwrap();
    out.try_send(Event::ConnectionLost).unwrap();
    assert!(poll_chat(&mut state, 8));
    assert!(state.history_error);
    assert_eq!(
        state.transcript_display.timeline.page_retry,
        Some(HistoryEdge::After)
    );
    drop(out);
    assert!(poll_chat(&mut state, 8));
    assert!(matches!(state.phase, Phase::Failed));
    assert!(state.history_error);
    assert_eq!(
        state.transcript_display.timeline.page_retry,
        Some(HistoryEdge::After)
    );

    // Direct terminal closure while a page is still in flight preserves its retry edge,
    // as does Event::Failed followed by channel closure.
    for send_failed in [false, true] {
        let mut state = init();
        let (mut reader, _lane) = Reader::open();
        reader.install(true);
        state.reader = Some(reader);
        state.phase = Phase::Ready;
        state.history_detached = true;
        state.can_older = true;
        let (cmd_tx, cmd_rx) = bounded(4);
        let (out, incoming) = bounded(4);
        state.commands = Some(cmd_tx);
        state.incoming = Some(incoming);
        assert!(request_page(&mut state, HistoryEdge::Oldest));
        let _ = cmd_rx.try_recv().unwrap();
        if send_failed {
            out.try_send(Event::Failed).unwrap();
        }
        drop(out);
        assert!(poll_chat(&mut state, 8));
        assert!(matches!(state.phase, Phase::Failed));
        assert!(state.history_error);
        assert_eq!(
            state.transcript_display.timeline.page_retry,
            Some(HistoryEdge::Oldest)
        );
    }

    // Reader content-lane Event::Failed preserves the in-flight retry direction instead of wiping it.
    let mut state = init();
    let (mut reader, lane) = Reader::open();
    reader.install(true);
    state.reader = Some(reader);
    state.phase = Phase::Ready;
    state.history_detached = true;
    state.can_older = true;
    let (cmd_tx, cmd_rx) = bounded(4);
    let (_out, incoming) = bounded(4);
    state.commands = Some(cmd_tx);
    state.incoming = Some(incoming);
    assert!(request_page(&mut state, HistoryEdge::After));
    let _ = cmd_rx.try_recv().unwrap();
    lane.events.try_send((0, 0, Event::Failed)).unwrap();
    assert!(poll_chat(&mut state, 8));
    assert!(!state.paging);
    assert!(state.history_error);
    assert_eq!(
        state.transcript_display.timeline.page_retry,
        Some(HistoryEdge::After)
    );

    // WorkspaceEvent::Stopped also preserves an in-flight page retry edge and history_error.
    let mut state = init();
    let (mut reader, _lane) = Reader::open();
    reader.install(true);
    state.reader = Some(reader);
    state.phase = Phase::Ready;
    state.history_detached = true;
    state.can_older = true;
    let (cmd_tx, cmd_rx) = bounded(4);
    let (out, incoming) = bounded(4);
    state.commands = Some(cmd_tx);
    state.incoming = Some(incoming);
    assert!(request_page(&mut state, HistoryEdge::Oldest));
    let _ = cmd_rx.try_recv().unwrap();
    out.try_send(Event::Workspace(
        codenomad_client::transport::WorkspaceEvent::Stopped {
            workspace_id: "workspace".into(),
            deleted: false,
            temporary_retained: false,
        },
    ))
    .unwrap();
    assert!(poll_chat(&mut state, 8));
    assert!(matches!(state.phase, Phase::Failed));
    assert!(!state.paging);
    assert!(state.history_error);
    assert_eq!(
        state.transcript_display.timeline.page_retry,
        Some(HistoryEdge::Oldest)
    );
}

#[test]
fn restore_search_reads_new_history_detached_state_on_sync() {
    use crate::chat::search_hit::SearchHit;
    use codenomad_client::search::{Hit, Kind};
    use serde_json::json;

    crate::platform::block_on(async {
        let make_state = |initially_detached: bool| {
            let mut state = init();
            crate::settings::fixture_transcript(
                &mut state,
                json!({"toolCallExpansionDefaults":{"tools":{"websearch":"hidden"}}}),
            );
            let backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
            let mut agent = crate::agent::Ui::new(crate::agent::start(backend, state.wake.clone()));
            agent.forms = crate::agent_api::forms(
                &json!({"data":[{
                    "id":"form-ws","sessionID":"session","title":"Choose search provider",
                    "fields":[{"key":"provider"}],"metadata":{"kind":"websearch.provider"}
                }]}),
                "session",
            )
            .unwrap();
            state.agent = Some(agent);
            let (reader, lane) = Reader::open();
            state.reader = Some(reader);
            state.history_detached = initially_detached;
            (state, lane)
        };
        let make_hit = |message: &str| {
            let mut hit = SearchHit::new(
                &Hit {
                    session: "session".into(),
                    message: message.into(),
                    role: "assistant".into(),
                    part: 0,
                    kind: Kind::Tool,
                    excerpt: "Needle".into(),
                },
                "Needle",
                false,
            );
            hit.restore_pending = true;
            hit
        };
        let make_row = |id: &str, call: &str| -> crate::history::Row {
            crate::history::decode_message(&json!({
                "id": id,
                "type": "assistant",
                "time": {"completed": 1},
                "content": [{
                    "type": "tool",
                    "id": call,
                    "name": "websearch",
                    "state": {"status": "completed", "content": [{"type": "text", "text": "Needle"}]}
                }]
            }))
            .unwrap()
            .into()
        };

        // 1. Live -> detached historical window: restore_search must see history_detached = true
        //    and refuse inferring the active form onto a historical hidden websearch.
        let (mut state, lane) = make_state(false);
        state.transcript_display.search_highlight = Some(make_hit("past"));
        lane.events
            .try_send((
                0,
                0,
                Event::Sync(crate::history::Page {
                    rows: vec![make_row("past", "ws_past")],
                    older: None,
                    newer: Some("newer-cursor".into()),
                    running: false,
                    user_file_references: false,
                }),
            ))
            .unwrap();
        assert!(poll_chat(&mut state, 8));
        assert!(state.history_detached);
        assert!(
            state.transcript_display.search_highlight.is_none(),
            "detached sync must refuse hidden historical websearch during restore_search"
        );
        assert!(
            !state
                .transcript_display
                .search_revealed("tool-past:7:ws_past")
        );

        // 2. Detached -> live tail window: restore_search must see history_detached = false
        //    and admit the inferred websearch at the tail.
        let (mut state, lane) = make_state(true);
        state.transcript_display.search_highlight = Some(make_hit("tail"));
        lane.events
            .try_send((
                0,
                0,
                Event::Sync(crate::history::Page {
                    rows: vec![make_row("tail", "ws_tail")],
                    older: Some("older-cursor".into()),
                    newer: None,
                    running: false,
                    user_file_references: false,
                }),
            ))
            .unwrap();
        assert!(poll_chat(&mut state, 8));
        assert!(!state.history_detached);
        assert!(
            state.transcript_display.search_highlight.is_some(),
            "tail sync must admit inferred websearch during restore_search"
        );
        assert!(
            state
                .transcript_display
                .search_revealed("tool-tail:7:ws_tail")
        );
    });
}
