use super::AnchorWindow;
use crate::{Receiver, Sender, backend::Backend, bounded, history::Row, stream, transport::Event};
use std::sync::{Arc, atomic::Ordering::SeqCst};

pub(crate) async fn until_cancelled<T>(
    cancelled: Option<&Receiver<()>>,
    task: impl std::future::Future<Output = Option<T>>,
) -> Option<T> {
    let Some(cancelled) = cancelled else {
        return task.await;
    };
    futures_lite::future::or(
        async {
            cancelled.recv().await.ok();
            None
        },
        task,
    )
    .await
}

pub(crate) async fn page_offer(
    cancelled: Option<&Receiver<()>>,
    page: &crate::history::Page,
    wire: &Arc<stream::State>,
    revision: u64,
    send: impl AsyncFnOnce(Event) -> bool,
) -> bool {
    let Some(cancelled) = cancelled else {
        return true;
    };
    let (admit, verdict) = bounded(1);
    if cancelled.is_closed()
        || !send(Event::PageOffered {
            page: page.clone(),
            admit: Admission {
                wire: wire.clone(),
                revision,
                admit,
            },
            cancelled: cancelled.clone(),
        })
        .await
    {
        return false;
    }
    futures_lite::future::or(async { verdict.recv().await.is_ok() }, async {
        cancelled.recv().await.ok();
        verdict.try_recv().is_ok()
    })
    .await
}

pub struct Admission {
    wire: Arc<stream::State>,
    revision: u64,
    admit: Sender<()>,
}

impl std::fmt::Debug for Admission {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Admission")
            .field("revision", &self.revision)
            .finish()
    }
}

impl Admission {
    pub fn accept(self) -> bool {
        self.wire.history_current(self.revision) && self.admit.try_send(()).is_ok()
    }
}

#[derive(Debug)]
pub struct Jump {
    pub ticket: u64,
    pub message: String,
    pub cancelled: Receiver<()>,
}

pub(crate) enum JumpOffer {
    Loaded(crate::history::Page, Vec<Row>, u64),
    Failed,
    AuthenticationExpired,
}

impl Jump {
    /// Offer a bounded destination to the reader before replacing the stream's rows.
    pub(crate) async fn offer(
        self,
        backend: &Backend,
        resident: &[Row],
        wire: &Arc<stream::State>,
        send: impl AsyncFnOnce(Event) -> bool,
    ) -> JumpOffer {
        enum Fetch {
            Loaded(crate::history::Page),
            Failed,
            AuthenticationExpired,
        }
        let ticket = self.ticket;
        let revision = wire.history_revision.load(SeqCst);
        let stamp = wire.version.load(SeqCst);
        let request = async {
            match backend.resolve_anchor(&self.message, resident).await {
                Ok(AnchorWindow::Loaded(page))
                    if wire.history_current(revision)
                        && (page.newer.is_some() || wire.valid(stamp)) =>
                {
                    Fetch::Loaded(page)
                }
                Err(error)
                    if crate::http::authentication_expired(&error)
                        && matches!(backend.authentication_status().await, Ok(false)) =>
                {
                    Fetch::AuthenticationExpired
                }
                _ => Fetch::Failed,
            }
        };
        let fetched = futures_lite::future::or(
            async {
                self.cancelled.recv().await.ok();
                Fetch::Failed
            },
            futures_lite::future::or(
                futures_lite::future::or(
                    async {
                        wire.placement_changed().await;
                        Fetch::Failed
                    },
                    async {
                        wire.stream_closed().await;
                        Fetch::Failed
                    },
                ),
                request,
            ),
        )
        .await;
        let mut page = match fetched {
            Fetch::Loaded(page) => page,
            Fetch::AuthenticationExpired => return JumpOffer::AuthenticationExpired,
            Fetch::Failed => {
                if !self.cancelled.is_closed() {
                    send(Event::AnchorFailed(ticket)).await;
                }
                return JumpOffer::Failed;
            }
        };
        let raw_rows = page.rows.clone();
        let mut merged = page.rows.clone();
        if crate::content::merge_page(resident, &mut merged).is_ok() {
            page.rows = merged;
        }
        let (admit, verdict) = bounded(1);
        if !send(Event::Anchor {
            ticket,
            page: page.clone(),
            admit: Admission {
                wire: wire.clone(),
                revision,
                admit,
            },
        })
        .await
        {
            return JumpOffer::Failed;
        }
        // Only the receiver owning the current ticket can send admission.
        let accepted = futures_lite::future::or(async { verdict.recv().await.ok() }, async {
            self.cancelled.recv().await.ok();
            verdict.try_recv().ok()
        })
        .await;
        match accepted {
            Some(()) => JumpOffer::Loaded(page, raw_rows, stamp),
            None => JumpOffer::Failed,
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn an_accepted_older_window_follows_a_queued_reader_sync() {
    use crate::history::Page;
    futures_lite::future::block_on(async {
        let wire = Arc::new(stream::State::default());
        wire.alive.store(true, SeqCst);
        wire.upstream.store(true, SeqCst);
        let (_demand, cancel) = bounded(1);
        let (out, events) = bounded(2);
        let page = Page {
            rows: vec![],
            older: None,
            newer: None,
            running: false,
            user_file_references: false,
        };
        out.try_send(Event::ReaderSync {
            page: page.clone(),
            version: 0,
        })
        .unwrap();
        let (accepted, ()) = futures_lite::future::zip(
            page_offer(Some(&cancel), &page, &wire, 0, async |event| {
                out.send(event).await.is_ok()
            }),
            async {
                assert!(matches!(
                    events.recv().await.unwrap(),
                    Event::ReaderSync { .. }
                ));
                let Event::PageOffered { admit, .. } = events.recv().await.unwrap() else {
                    panic!("expected older offer")
                };
                assert!(admit.accept());
            },
        )
        .await;
        assert!(accepted && events.is_empty());
    });
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn jump_offer_returns_authentication_expired_on_401_without_anchor_failed() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                // First request: anchor history fetch -> 401
                let (socket, _) = listener.accept().await.unwrap();
                let mut reader = BufReader::new(socket);
                let mut line = String::new();
                assert!(reader.read_line(&mut line).await.unwrap() > 0);
                let body = r#"{"error":"Unauthorized"}"#;
                reader
                    .get_mut()
                    .write_all(
                        format!(
                            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                // Second request: /api/auth/status -> authenticated: false
                let (status_socket, _) = listener.accept().await.unwrap();
                let mut status_reader = BufReader::new(status_socket);
                let mut status_line = String::new();
                assert!(status_reader.read_line(&mut status_line).await.unwrap() > 0);
                assert!(status_line.starts_with("GET /api/auth/status "));
                let status_body = r#"{"authenticated":false}"#;
                status_reader
                    .get_mut()
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{status_body}",
                            status_body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            });

            let mut backend = Backend::unauthenticated(&format!("http://{address}/")).unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();
            let wire = Arc::new(stream::State::default());
            wire.alive.store(true, SeqCst);
            wire.upstream.store(true, SeqCst);
            let (_cancel_tx, cancelled) = bounded(1);
            let (out, events) = bounded(4);
            let jump = Jump {
                ticket: 7,
                message: "msg_target".into(),
                cancelled,
            };
            let result = jump
                .offer(&backend, &[], &wire, async |event| out.send(event).await.is_ok())
                .await;
            assert!(matches!(result, JumpOffer::AuthenticationExpired));
            assert!(events.is_empty(), "401 must not emit AnchorFailed");
            server.await.unwrap();
        });
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn admission_rejects_after_placement_change_even_before_revision_bumps() {
    let (ev_tx, _ev_rx) = bounded(1);
    let wire = Arc::new(stream::State::observing_preferences(ev_tx, Arc::new(|| {})));
    wire.alive.store(true, SeqCst);
    wire.upstream.store(true, SeqCst);
    let (admit, _verdict) = bounded(1);
    let admission = Admission {
        wire: wire.clone(),
        revision: 0,
        admit,
    };
    wire.close_placement();
    assert!(!admission.accept());
}
