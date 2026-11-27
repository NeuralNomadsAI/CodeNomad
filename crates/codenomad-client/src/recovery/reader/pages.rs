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
            wire,
            out,
            wake,
            ..
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
            let revision = wire.history_revision.load(SeqCst);
            let stamp = wire.version.load(SeqCst);
            let Some(page) = crate::timeline::until_cancelled(
                cancel,
                read_page(
                    backend,
                    reading,
                    self.generation,
                    wire,
                    Fence::History(revision),
                    backend.page(target.clone()),
                ),
            )
            .await
            else {
                if self.active_reader
                    && !wire.history_current(revision)
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
                Ok(mut page) if wire.history_current(revision) => {
                    if advances(&page, edge, &target)
                        && history::edge_page(&page, &self.resident, edge).is_ok()
                    {
                        let raw_rows = page.rows.clone();
                        let mut merged = page.rows.clone();
                        if crate::content::merge_page(&self.resident, &mut merged).is_ok() {
                            page.rows = merged;
                        }
                        if !crate::timeline::page_offer(
                            cancel,
                            &page,
                            wire,
                            revision,
                            async |event| {
                                reader_event(reading, self.generation, out, wake, event).await
                            },
                        )
                        .await
                        {
                            return Ok(Turn::Next);
                        }
                        if !page.rows.is_empty() {
                            let reordered = !history::order_consistent(&self.resident, &page.rows);
                            self.historical = page.newer.is_some();
                            self.fence = stamp;
                            self.resident = page.rows.clone();
                            self.first = self.resident.first().map(|r| r.id.clone());
                            self.known = self.resident.iter().map(|r| r.id.clone()).collect();
                            self.owed.retain(|(id, _)| self.known.contains(id));
                            self.owed_tools.retain(|(id, call), _| {
                                self.known.contains(id) && !tool_settled(&raw_rows, id, call)
                            });
                            self.frozen_tools.retain(|(id, call), _| {
                                self.known.contains(id) && !tool_settled(&raw_rows, id, call)
                            });
                            let mut removed = Vec::new();
                            self.inbox.retain(|item| {
                                if self.known.contains(&item.id) {
                                    removed.push(item.id.clone());
                                    false
                                } else {
                                    true
                                }
                            });
                            if !removed.is_empty() {
                                self.schedule_inbox_sync(Duration::from_millis(100));
                                for id in removed {
                                    let _ = reader_event(
                                        reading,
                                        self.generation,
                                        out,
                                        wake,
                                        Event::InboxDelta(crate::inbox::InboxDelta::Removed(id)),
                                    )
                                    .await;
                                }
                            }
                            if !self.historical && !wire.valid(stamp) {
                                self.dirty = true;
                                self.quiet = Instant::now();
                            } else if !self.historical
                                && (reordered || !self.owed_tools.is_empty())
                                && !self.dirty
                            {
                                self.dirty = true;
                                self.quiet = Instant::now() + Duration::from_millis(100);
                            }
                        }
                        self.older = page.older.clone();
                        self.newer = page.newer.clone();
                        if cancel.is_none() {
                            reader_event(reading, self.generation, out, wake, Event::Older(page))
                                .await;
                        }
                    } else {
                        if !self.historical && !self.parked {
                            self.dirty = true;
                            self.quiet = Instant::now();
                        }
                        reader_event(reading, self.generation, out, wake, failed()).await;
                    }
                }
                Ok(_) | Err(PageFailure::StreamClosed) => {
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
    ) -> Turn {
        if jump.cancelled.is_closed() {
            return Turn::Next;
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
            return Turn::Next;
        }
        match jump
            .offer(backend, &self.resident, wire, async |event| {
                reader_event(reading, self.generation, out, wake, event).await
            })
            .await
        {
            crate::timeline::JumpOffer::Loaded(page, raw_rows, stamp) => {
                self.historical = page.newer.is_some();
                self.fence = stamp;
                self.first = page.rows.first().map(|row| row.id.clone());
                self.older = page.older.clone();
                self.newer = page.newer.clone();
                self.known = page.rows.iter().map(|row| row.id.clone()).collect();
                self.resident = page.rows;
                self.owed.retain(|(id, _)| self.known.contains(id));
                self.owed_tools.retain(|(id, call), _| {
                    self.known.contains(id) && !tool_settled(&raw_rows, id, call)
                });
                self.frozen_tools.retain(|(id, call), _| {
                    self.known.contains(id) && !tool_settled(&raw_rows, id, call)
                });
                let mut removed = Vec::new();
                self.inbox.retain(|item| {
                    if self.known.contains(&item.id) {
                        removed.push(item.id.clone());
                        false
                    } else {
                        true
                    }
                });
                if !removed.is_empty() {
                    self.schedule_inbox_sync(std::time::Duration::from_millis(100));
                    for id in removed {
                        let _ = reader_event(
                            reading,
                            self.generation,
                            out,
                            wake,
                            Event::InboxDelta(crate::inbox::InboxDelta::Removed(id)),
                        )
                        .await;
                    }
                }
                self.anchored = None;
                self.parked = false;
                if !self.historical && !wire.valid(stamp) {
                    self.dirty = true;
                    self.quiet = crate::runtime::Instant::now();
                } else if !self.historical
                    && (self.execution_settlement > 0
                        || !self.owed_tools.is_empty()
                        || !self.owed_synthetics.is_empty())
                {
                    self.dirty = true;
                    self.quiet =
                        crate::runtime::Instant::now() + std::time::Duration::from_millis(100);
                } else {
                    self.dirty = false;
                }
                Turn::Next
            }
            crate::timeline::JumpOffer::Failed => Turn::Next,
            crate::timeline::JumpOffer::AuthenticationExpired => {
                expire_reading(reading, wire, out).await;
                Turn::AuthenticationExpired
            }
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
