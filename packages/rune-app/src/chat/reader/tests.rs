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
