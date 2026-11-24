//! Explicit navigation on the same generation-fenced reader lane.
use super::*;

impl Reader {
    pub(in crate::recovery) async fn page(
        &mut self,
        lane: &Lane<'_>,
        opened: bool,
        edge: HistoryEdge,
        cancel: Option<&Receiver<()>>,
    ) -> history::Result<Turn> {
        let Lane {
            backend,
            reading,
            rx,
            wire,
            out,
            wake,
        } = *lane;
        let failed = || {
            cancel
                .cloned()
                .map_or(Event::PagingFailed, Event::PageFailed)
        };
        let target = match edge {
            HistoryEdge::Before => self.older.clone(),
            HistoryEdge::After => self.newer.clone(),
            HistoryEdge::Oldest => Some(serde_json::json!({"kind":"oldest"})),
        };
        if let Some(target) = target.filter(|_| {
            self.active_reader
                && opened
                && (!self.dirty || self.historical)
                && wire.upstream.load(SeqCst)
        }) {
            let stamp = wire.version.load(SeqCst);
            let Some(page) = crate::timeline::until_cancelled(
                cancel,
                read_page(
                    backend,
                    reading,
                    self.generation,
                    wire,
                    backend.page(target.clone()),
                ),
            )
            .await
            else {
                if self.active_reader
                    && !wire.valid(stamp)
                    && !wire.placement_closed()
                    && !cancel.is_some_and(Receiver::is_closed)
                {
                    self.dirty = true;
                    self.quiet = Instant::now() + Duration::from_millis(100);
                    reader_event(reading, self.generation, out, wake, failed()).await;
                }
                return Ok(Turn::Next);
            };
            match page {
                Ok(page) if wire.valid(stamp) && rx.is_empty() => {
                    if advances(&page, edge, &target)
                        && history::edge_page(&page, &self.resident, edge).is_ok()
                    {
                        if !crate::timeline::page_offer(cancel, &page, wire, stamp, async |event| {
                            reader_event(reading, self.generation, out, wake, event).await
                        })
                        .await
                        {
                            return Ok(Turn::Next);
                        }
                        if !page.rows.is_empty() {
                            self.historical = page.newer.is_some();
                            self.resident = page.rows.clone();
                            self.first = self.resident.first().map(|r| r.id.clone());
                            self.known = self.resident.iter().map(|r| r.id.clone()).collect();
                            self.owed.retain(|(id, _)| self.known.contains(id));
                        }
                        self.older = page.older.clone();
                        self.newer = page.newer.clone();
                        if cancel.is_none() {
                            reader_event(reading, self.generation, out, wake, Event::Older(page))
                                .await;
                        }
                    } else {
                        reader_event(reading, self.generation, out, wake, failed()).await;
                    }
                }
                Ok(_) => {
                    self.dirty = true;
                    self.quiet = Instant::now() + Duration::from_millis(100);
                    reader_event(reading, self.generation, out, wake, failed()).await;
                }
                Err(PageFailure::AuthenticationExpired) => {
                    expire_reading(reading, wire, out).await;
                    return Ok(Turn::AuthenticationExpired);
                }
                Err(PageFailure::Read(_)) => {
                    reader_event(reading, self.generation, out, wake, failed()).await;
                }
            }
        } else if self.active_reader {
            reader_event(reading, self.generation, out, wake, failed()).await;
        }
        Ok(Turn::Process)
    }

    pub(in crate::recovery) async fn anchor(
        &mut self,
        lane: &Lane<'_>,
        opened: bool,
        jump: crate::timeline::Jump,
    ) {
        if jump.cancelled.is_closed() {
            return;
        }
        let Lane {
            backend,
            reading,
            wire,
            out,
            wake,
            ..
        } = *lane;
        if !self.active_reader || !opened || !wire.upstream.load(SeqCst) {
            reader_event(
                reading,
                self.generation,
                out,
                wake,
                Event::AnchorFailed(jump.ticket),
            )
            .await;
            return;
        }
        if let Some((page, stamp)) = jump
            .offer(backend, &self.resident, wire, async |event| {
                reader_event(reading, self.generation, out, wake, event).await
            })
            .await
        {
            self.historical = page.newer.is_some();
            self.fence = stamp;
            self.first = page.rows.first().map(|row| row.id.clone());
            self.older = page.older.clone();
            self.newer = page.newer.clone();
            self.known = page.rows.iter().map(|row| row.id.clone()).collect();
            self.resident = page.rows;
            self.owed.retain(|(id, _)| self.known.contains(id));
            self.anchored = None;
            self.parked = false;
            self.dirty = false;
        }
    }
}

fn advances(page: &history::Page, edge: HistoryEdge, target: &Value) -> bool {
    match edge {
        HistoryEdge::Before => page.older.as_ref() != Some(target),
        HistoryEdge::After => page.newer.as_ref() != Some(target),
        HistoryEdge::Oldest => true,
    }
}

#[cfg(test)]
#[test]
fn a_neighbor_repeating_its_requested_cursor_is_not_admitted() {
    let before = serde_json::json!({"kind":"before","messageID":"m"});
    let after = serde_json::json!({"kind":"after","messageID":"m"});
    let mut page = history::Page {
        rows: vec![],
        older: Some(before.clone()),
        newer: Some(after.clone()),
        running: false,
        user_file_references: false,
    };
    assert!(!advances(&page, HistoryEdge::Before, &before));
    assert!(!advances(&page, HistoryEdge::After, &after));
    page.newer = None;
    assert!(advances(&page, HistoryEdge::After, &after));
}
