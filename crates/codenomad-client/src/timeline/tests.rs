use super::*;
use serde_json::Value;

fn entry(id: &str, seq: u64) -> Value {
    json!({"id":id,"seq":seq,"type":"assistant","tools":2,"reasoning":1,"text":1,
        "toolName":"read","layout":"TR-X","omitted":{"reasoning":0,"text":0,"continues":false}})
}

fn page(after: i64, through: u64, next: Option<u64>, entries: Vec<Value>) -> Value {
    json!({"status":"outline","entries":entries,"total":2,
        "cursor":next.map(|end| json!({"after":through,"through":end})),
        "checkpoints":[{"after":after,"through":through,"digest":"a".repeat(64),"changed":true}]})
}

fn accept(scan: &mut Scan, v: Value) -> Result<Option<u64>> {
    scan.accept(serde_json::from_value(v)?)
}

#[test]
fn outline_retains_sequence_order_across_sparse_pages() {
    let mut scan = Scan::default();
    assert_eq!(
        accept(&mut scan, page(-1, 40, Some(2000), vec![entry("z", 0)])).unwrap(),
        None
    );
    assert_eq!(
        accept(&mut scan, page(40, 2000, None, vec![entry("a", 1801)])).unwrap(),
        Some(2)
    );
    assert_eq!(
        scan.entries
            .iter()
            .map(|e| e.id.as_str())
            .collect::<Vec<_>>(),
        ["z", "a"]
    );
    assert_eq!(scan.entries[0].layout.as_deref(), Some("TR-X"));
    assert_eq!(scan.entries[0].kind, Kind::Assistant);
}

#[test]
fn empty_outline_can_cover_the_zero_horizon() {
    let mut scan = Scan::default();
    let mut empty = page(-1, 0, None, vec![]);
    empty["total"] = 0.into();
    assert_eq!(accept(&mut scan, empty).unwrap(), Some(0));
    assert!(scan.entries.is_empty());
}

#[test]
fn outline_rejects_repeated_identity_and_broken_horizon() {
    for bad in [
        page(40, 2000, None, vec![entry("z", 1801)]),
        page(40, 1900, None, vec![]),
        page(39, 2000, None, vec![]),
        page(40, 500, Some(2001), vec![]),
        page(40, 2000, None, vec![entry("a", 2001)]),
    ] {
        let mut scan = Scan::default();
        assert!(accept(&mut scan, page(-1, 40, Some(2000), vec![entry("z", 0)])).is_ok());
        assert!(accept(&mut scan, bad).is_err());
    }
}

#[test]
fn outline_refuses_bodies_invalid_layouts_and_unnegotiated_deltas() {
    let mut extra = entry("z", 1);
    extra["body"] = "must stay outside the outline".into();
    let mut layout = entry("z", 1);
    layout["layout"] = "RRX".into();
    let mut unchanged = page(-1, 1, None, vec![]);
    unchanged["checkpoints"][0]["changed"] = false.into();
    for invalid in [
        page(-1, 1, None, vec![extra]),
        page(-1, 1, None, vec![layout]),
        unchanged,
    ] {
        assert!(accept(&mut Scan::default(), invalid).is_err());
    }
}

#[test]
fn outline_preserves_the_brokers_blocked_status() {
    let error = accept(
        &mut Scan::default(),
        json!({"status":"blocked","reason":"conflict"}),
    )
    .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<Blocked>(),
        Some(Blocked::Conflict)
    ));
}

#[test]
fn outline_requires_an_explicit_end_and_limits_resident_structure() {
    let mut missing = page(-1, 1, None, vec![entry("z", 1)]);
    missing.as_object_mut().unwrap().remove("cursor");
    assert!(accept(&mut Scan::default(), missing).is_err());
    let mut full = Scan {
        bytes: INDEX_BYTES,
        ..Scan::default()
    };
    assert!(accept(&mut full, page(-1, 1, None, vec![entry("z", 1)])).is_err());
}

#[cfg(not(target_arch = "wasm32"))]
fn http_scan(steps: Vec<(&'static str, Option<Value>, Value, bool)>) -> Result<Outline> {
    http_probe(steps, async |backend, revision| {
        backend.read_outline(&revision).await
    })
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn http_probe<T>(
    steps: Vec<(&'static str, Option<Value>, Value, bool)>,
    run: impl AsyncFnOnce(Backend, std::sync::Arc<OutlineRevision>) -> T,
) -> T {
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
        time::Duration,
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}/", listener.local_addr().unwrap());
    let revision = std::sync::Arc::new(OutlineRevision::default());
    let events = revision.clone();
    let server = std::thread::spawn(move || {
        for (route, body, reply, invalidate) in steps {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(&mut socket);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert_eq!(line.trim_end(), route);
            let mut len = 0;
            loop {
                line.clear();
                assert_ne!(reader.read_line(&mut line).unwrap(), 0);
                if line == "\r\n" {
                    break;
                }
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") {
                        len = value.trim().parse().unwrap();
                    }
                }
            }
            let mut bytes = vec![0; len];
            reader.read_exact(&mut bytes).unwrap();
            if let Some(body) = body {
                assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), body);
            } else {
                assert!(bytes.is_empty());
            }
            if invalidate {
                events.invalidate();
            }
            let body = reply.to_string();
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        }
    });
    let result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut backend = Backend::unauthenticated(&address).unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();
            run(backend, revision).await
        });
    server.join().unwrap();
    result
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn native_anchor_navigation_fetches_one_around_window_and_never_searches_neighbours() {
    const ROUTE: &str = "POST /api/workspaces/workspace/session-history/window HTTP/1.1";
    let steps = ["target","gone"].map(|id| {
        let target=json!({"kind":"around","messageID":id});
        (ROUTE,Some(json!({"sessionID":"session","target":target})),
            json!({"status":"window","messages":[{"id":"target","type":"user","text":"History","time":{"created":1}}],
                "older":null,"newer":null,"latest":true,"resume":target}),false)
    });
    http_probe(Vec::from(steps), async |backend, _| {
        let AnchorWindow::Loaded(page) = backend.resolve_anchor("target", &[]).await.unwrap()
        else {
            panic!("distant target needs a page");
        };
        assert!(matches!(
            backend.resolve_anchor("target", &page.rows).await.unwrap(),
            AnchorWindow::Resident
        ));
        assert!(backend.resolve_anchor("gone", &page.rows).await.is_err());
    });
}

#[cfg(not(target_arch = "wasm32"))]
const RECORD: &str = "GET /workspaces/workspace/instance/api/session/session HTTP/1.1";
#[cfg(not(target_arch = "wasm32"))]
const OUTLINE: &str = "POST /api/workspaces/workspace/session-history/outline HTTP/1.1";

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn saved_outline_revalidates_sparse_ranges_and_refuses_a_different_undo_boundary() {
    const ROOT: &str = "/owned/project";
    let session =
        json!({"data":{"id":"session","projectID":"project","location":{"directory":ROOT}}});
    let mut reverted = session.clone();
    reverted["data"]["revert"] = json!({"messageID":"new"});
    let cold = json!({"sessionID":"session"});
    let first = page(-1, 40, Some(2000), vec![entry("old", 1)]);
    let tail = page(40, 2000, None, vec![entry("gone", 1801)]);
    let known = json!([
        {"after":-1,"through":40,"digest":"a".repeat(64)},
        {"after":40,"through":2000,"digest":"a".repeat(64)},
    ]);
    let mut unchanged = first.clone();
    unchanged["entries"] = json!([]);
    unchanged["checkpoints"][0]["changed"] = false.into();
    let mut changed = page(40, 2000, None, vec![entry("new", 1802)]);
    changed["checkpoints"][0]["digest"] = "b".repeat(64).into();
    let cursor = json!({"after":40,"through":2000});
    let mut after_undo = page(-1, 40, None, vec![entry("old", 1)]);
    after_undo["total"] = 1.into();
    let upgraded = after_undo.clone();
    http_probe(
        vec![
            (RECORD, None, session.clone(), false),
            (OUTLINE, Some(cold.clone()), first, false),
            (RECORD, None, session.clone(), false),
            (
                OUTLINE,
                Some(json!({"sessionID":"session","cursor":cursor})),
                tail,
                false,
            ),
            (RECORD, None, session.clone(), false),
            (RECORD, None, session.clone(), false),
            (
                OUTLINE,
                Some(json!({"sessionID":"session","known":known})),
                unchanged,
                false,
            ),
            (RECORD, None, session.clone(), false),
            (
                OUTLINE,
                Some(json!({"sessionID":"session","cursor":cursor,"known":known})),
                changed,
                false,
            ),
            (RECORD, None, session, false),
            (RECORD, None, reverted.clone(), false),
            (OUTLINE, Some(cold.clone()), after_undo, false),
            (RECORD, None, reverted.clone(), false),
            (RECORD, None, reverted.clone(), false),
            (OUTLINE, Some(cold), upgraded, false),
            (RECORD, None, reverted, false),
        ],
        async |mut backend, revision| {
            assert!(backend.client.attest("installation", vec![]));
            backend.session_directory = Some(ROOT.into());
            let first = backend
                .read_outline_cached(&revision, Some(ROOT), None, |_| panic!("cold seed"))
                .await
                .unwrap();
            let bytes = encode_saved_outlines(&[Arc::new(first)]);
            let mut corrupted: Value = serde_json::from_slice(&bytes).unwrap();
            corrupted[0][0] = "0".repeat(64).into();
            assert!(decode_saved_outlines(&serde_json::to_vec(&corrupted).unwrap()).is_empty());
            let saved = decode_saved_outlines(&bytes).pop().unwrap();
            let current = backend
                .read_outline_cached(&revision, Some(ROOT), Some(saved.clone()), |seed| {
                    let seed = seed.unwrap();
                    assert!(Arc::ptr_eq(&seed, &saved));
                    assert_eq!(seed.entries[1].id, "gone");
                })
                .await
                .unwrap();
            assert_eq!(
                current
                    .entries
                    .iter()
                    .map(|e| e.id.as_str())
                    .collect::<Vec<_>>(),
                ["old", "new"]
            );
            let reverted = backend
                .read_outline_cached(&revision, Some(ROOT), Some(Arc::new(current)), |seed| {
                    assert!(seed.is_none(), "the previous undo boundary cannot be shown");
                })
                .await
                .unwrap();
            assert_eq!(reverted.entries.len(), 1);
            let mut legacy = reverted;
            legacy.entries[0].layout = None;
            legacy.entries[0].omitted = None;
            let current = backend
                .read_outline_cached(&revision, Some(ROOT), Some(Arc::new(legacy)), |seed| {
                    assert!(seed.unwrap().entries[0].layout.is_none());
                })
                .await
                .unwrap();
            assert!(current.entries[0].layout.is_some());
        },
    );
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn a_proposed_anchor_commits_only_with_a_current_admission() {
    use crate::{bounded, stream, transport::Event};
    use std::sync::{Arc, atomic::Ordering::SeqCst};
    for (invalidate, superseded) in [(false, false), (true, false), (false, true)] {
        let target = json!({"kind":"around","messageID":"target"});
        http_probe(
            vec![(
                "POST /api/workspaces/workspace/session-history/window HTTP/1.1",
                Some(json!({"sessionID":"session","target":target})),
                json!({"status":"window","messages":[{"id":"target","type":"user","text":"Here","time":{"created":1}}],
                "older":null,"newer":null,"latest":true,"resume":target}),
                false,
            )],
            async |backend, _| {
                let wire = Arc::new(stream::State::default());
                wire.alive.store(true, SeqCst);
                wire.upstream.store(true, SeqCst);
                let (out, events) = bounded(1);
                let (cancel, cancelled) = bounded(1);
                let offer = Jump {
                    ticket: 1,
                    message: "target".into(),
                    cancelled,
                };
                let (read, ()) = futures_lite::future::zip(
                    offer.offer(&backend, &[], &wire, async |event| {
                        out.send(event).await.is_ok()
                    }),
                    async {
                        let Event::Anchor { ticket, admit, .. } = events.recv().await.unwrap()
                        else {
                            panic!("expected an anchor proposal");
                        };
                        assert_eq!(ticket, 1);
                        if invalidate {
                            wire.history_revision.fetch_add(1, SeqCst);
                        }
                        if superseded {
                            drop(cancel);
                            drop(admit);
                        } else {
                            assert_eq!(admit.accept(), !invalidate);
                        }
                    },
                )
                .await;
                assert_eq!(
                    matches!(read, crate::timeline::JumpOffer::Loaded(..)),
                    !invalidate && !superseded
                );
            },
        );
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn outline_http_uses_the_owned_scope_and_returned_cursor_only() {
    let record = json!({"data":{"id":"session"}});
    let result = http_scan(vec![
        (RECORD, None, record.clone(), false),
        (
            OUTLINE,
            Some(json!({"sessionID":"session"})),
            page(-1, 40, Some(2000), vec![entry("z", 0)]),
            false,
        ),
        (RECORD, None, record.clone(), false),
        (
            OUTLINE,
            Some(json!({"sessionID":"session","cursor":{"after":40,"through":2000}})),
            page(40, 2000, None, vec![entry("a", 1801)]),
            false,
        ),
        (RECORD, None, record, false),
    ])
    .unwrap();
    assert_eq!(result.entries[1].seq, 1801);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn undo_between_pages_discards_the_entire_outline() {
    let record = json!({"data":{"id":"session"}});
    for (next_record, invalidate) in [
        (
            json!({"data":{"id":"session","revert":{"messageID":"z"}}}),
            false,
        ),
        (record.clone(), true),
    ] {
        let error = http_scan(vec![
            (RECORD, None, record.clone(), false),
            (
                OUTLINE,
                Some(json!({"sessionID":"session"})),
                page(-1, 40, Some(2000), vec![entry("z", 0)]),
                false,
            ),
            (RECORD, None, next_record, invalidate),
        ])
        .unwrap_err();
        if invalidate {
            assert!(matches!(
                error.downcast_ref::<Blocked>(),
                Some(Blocked::Conflict)
            ));
        } else {
            assert!(error.is::<OutlineIdentityChanged>());
        }
    }
}

#[test]
fn outline_total_keeps_large_active_indexes_out_of_cache_from_the_first_page() {
    let mut scan = Scan::default();
    let mut first = page(-1, 10, Some(250_000), vec![entry("first", 1)]);
    first["total"] = 250_001.into();
    assert_eq!(accept(&mut scan, first).unwrap(), None);
    assert!(!scan.cacheable);
    scan.entries.resize(CACHE_ENTRIES, scan.entries[0].clone());
    assert_eq!(
        accept(
            &mut scan,
            page(10, 250_000, None, vec![entry("last", 250_000)])
        )
        .unwrap(),
        Some(2)
    );
    assert_eq!(scan.entries.len(), CACHE_ENTRIES + 1);
    assert!(!scan.cacheable);
}

#[test]
fn impossible_active_total_stops_on_the_first_page() {
    let mut scan = Scan::default();
    let mut first = page(-1, 10, Some(250_000), vec![entry("first", 1)]);
    first["total"] = MAX_SEQ.into();
    assert!(accept(&mut scan, first).is_err());
    assert!(scan.entries.is_empty() && scan.cursor.is_none());
}
