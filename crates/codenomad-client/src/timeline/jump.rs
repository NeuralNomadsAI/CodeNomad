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
