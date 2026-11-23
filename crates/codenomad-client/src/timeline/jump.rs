use super::AnchorWindow;
use crate::{
    Receiver, Sender, Wake,
    backend::Backend,
    bounded,
    history::Row,
    stream,
    transport::{Event, publish},
};
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

pub(crate) async fn older_offer(
    cancelled: Option<&Receiver<()>>,
    page: &crate::history::Page,
    wire: &Arc<stream::State>,
    stamp: u64,
    send: impl AsyncFnOnce(Event) -> bool,
) -> bool {
    let Some(cancelled) = cancelled else {
        return true;
    };
    let (admit, verdict) = bounded(1);
    if cancelled.is_closed()
        || !send(Event::OlderOffered {
            page: page.clone(),
            admit: Admission {
                wire: wire.clone(),
                revision: wire.history_revision.load(SeqCst),
                live_version: Some(stamp),
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
    live_version: Option<u64>,
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
        self.wire.history_current(self.revision)
            && self.live_version.is_none_or(|stamp| self.wire.valid(stamp))
            && self.admit.try_send(()).is_ok()
    }
}

#[derive(Debug)]
pub struct Jump {
    pub ticket: u64,
    pub message: String,
    pub cancelled: Receiver<()>,
}

impl Jump {
    /// Offer a bounded destination to the reader before replacing the stream's rows.
    pub(crate) async fn offer(
        self,
        backend: &Backend,
        resident: &[Row],
        wire: &Arc<stream::State>,
        out: &Sender<Event>,
        wake: &Wake,
    ) -> Option<(crate::history::Page, u64)> {
        let ticket = self.ticket;
        let revision = wire.history_revision.load(SeqCst);
        let stamp = wire.version.load(SeqCst);
        let request = async {
            match backend.resolve_anchor(&self.message, resident).await {
                Ok(AnchorWindow::Loaded(page))
                    if wire.history_current(revision)
                        && (page.newer.is_some() || wire.valid(stamp)) =>
                {
                    Some(page)
                }
                _ => None,
            }
        };
        let Some(page) = futures_lite::future::or(
            async {
                self.cancelled.recv().await.ok();
                None
            },
            futures_lite::future::or(request, async {
                wire.placement_changed().await;
                None
            }),
        )
        .await
        else {
            if !self.cancelled.is_closed() {
                publish(out, wake, Event::AnchorFailed(ticket)).await;
            }
            return None;
        };
        let (admit, verdict) = bounded(1);
        if !publish(
            out,
            wake,
            Event::Anchor {
                ticket,
                page: page.clone(),
                admit: Admission {
                    wire: wire.clone(),
                    revision,
                    live_version: page.newer.is_none().then_some(stamp),
                    admit,
                },
            },
        )
        .await
        {
            return None;
        }
        // Only the receiver owning the current ticket can send admission.
        let accepted = futures_lite::future::or(async { verdict.recv().await.ok() }, async {
            self.cancelled.recv().await.ok();
            verdict.try_recv().ok()
        })
        .await;
        accepted.map(|()| (page, stamp))
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
            older_offer(Some(&cancel), &page, &wire, 0, async |event| {
                out.send(event).await.is_ok()
            }),
            async {
                assert!(matches!(
                    events.recv().await.unwrap(),
                    Event::ReaderSync { .. }
                ));
                let Event::OlderOffered { admit, .. } = events.recv().await.unwrap() else {
                    panic!("expected older offer")
                };
                assert!(admit.accept());
            },
        )
        .await;
        assert!(accepted && events.is_empty());
    });
}
