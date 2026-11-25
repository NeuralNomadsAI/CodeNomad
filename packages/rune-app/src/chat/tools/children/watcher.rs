use super::{
    snapshot::{child_tool_settled, same_synthetic_report, snapshot_with_frozen},
    *,
};

impl Children {
    pub(super) fn start_entry(s: &mut State, ck: ChildKey, key: &str, lease: &Rc<()>) -> bool {
        let children = &mut s.transcript_display.children;
        #[cfg(test)]
        children
            .started_entries
            .push((ck.0.clone(), ck.1.clone(), key.to_owned()));
        let Some(backend) = children.backend.clone() else {
            return false;
        };
        let Some((dirty, settlement)) = backend.watch_child(&ck.1) else {
            return false;
        };
        let (out, result) = bounded(2);
        let (cancel, cancelled) = bounded(1);
        let (retry, retry_rx) = bounded(1);
        let (expected_parent, child) = ck.clone();
        let watcher = Watcher {
            _cancel: cancel,
            retry,
            result,
        };
        if let Some(entry) = children.entries.get_mut(&ck) {
            entry.cards.insert(key.into(), Rc::downgrade(lease));
            entry.watch = WatchState::Active(watcher);
            entry.load_error = false;
            entry.settled = false;
        } else {
            while children.entries.len() >= RETAINED_LIMIT {
                let evict = children
                    .entries
                    .iter()
                    .find(|(_, e)| !matches!(e.watch, WatchState::Active(_)))
                    .map(|(k, _)| k.clone());
                let Some(evict) = evict else {
                    break;
                };
                children.entries.remove(&evict);
                children.evict_unwatched_cache(std::slice::from_ref(&evict.1));
            }
            children.entries.insert(
                ck,
                Entry {
                    cards: HashMap::from([(key.into(), Rc::downgrade(lease))]),
                    watch: WatchState::Active(watcher),
                    snapshot: Snapshot::default(),
                    load_error: false,
                    settled: false,
                },
            );
        }
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        crate::platform::spawn(async move {
            crate::platform::reads::cancellable(&cancelled, async {
                let mut owed_calls: HashMap<(Option<String>, String), (u8, Option<u64>)> =
                    HashMap::new();
                let mut frozen_ends: HashMap<(Option<String>, String), u64> = HashMap::new();
                let mut pending_events = Vec::new();
                let mut pending_bytes = 0usize;
                let mut owed_synthetics: Vec<(u8, usize, crate::history::Row)> = Vec::new();
                let mut synthetic_owed = 0u8;
                let mut execution_owed = 0u8;
                let mut last_exec_end: Option<u64> = None;
                let mut live_page: Option<crate::history::Page> = None;
                loop {
                    let drain = settlement.take();
                    if drain.revoked {
                        owed_calls.clear();
                        frozen_ends.clear();
                        pending_events.clear();
                        pending_bytes = 0;
                        owed_synthetics.clear();
                        synthetic_owed = 0;
                        execution_owed = 0;
                        last_exec_end = None;
                        live_page = None;
                        if out.send(ChildUpdate::Unverified).await.is_err() {
                            break;
                        }
                        wake();
                    } else {
                        for end in drain.calls {
                            let key = (end.message, end.call);
                            if let Some(ts) = end.ended
                                && (frozen_ends.contains_key(&key) || frozen_ends.len() < 128)
                            {
                                frozen_ends.entry(key.clone()).or_insert(ts);
                            }
                            if owed_calls.contains_key(&key) || owed_calls.len() < 64 {
                                let entry = owed_calls.entry(key).or_insert((0, end.ended));
                                if entry.1.is_none() {
                                    entry.1 = end.ended;
                                }
                            }
                        }
                        if drain.execution_ended {
                            execution_owed = 3;
                            last_exec_end = drain
                                .execution_ended_at
                                .or(Some(crate::platform::storage::unix_millis()));
                        }
                        let mut live_changed = false;
                        if drain.synthetic_dirty {
                            if drain.synthetics.is_empty() {
                                synthetic_owed = 3;
                            }
                            for row in drain.synthetics {
                                let prior_matches = live_page.as_ref().map_or(0, |page| {
                                    page.rows
                                        .iter()
                                        .filter(|p| same_synthetic_report(p, &row))
                                        .count()
                                });
                                if owed_synthetics.len() < 16
                                    && !owed_synthetics.iter().any(|(_, _, r)| r.id == row.id)
                                {
                                    owed_synthetics.push((0, prior_matches, row.clone()));
                                }
                                if let Some(page) = live_page.as_mut()
                                    && page.rows.len() < codenomad_client::history::MAX_ROWS
                                    && !page.rows.iter().any(|p| p.id == row.id)
                                {
                                    page.rows.push(row);
                                    if codenomad_client::history::check(&page.rows).is_err() {
                                        page.rows.pop();
                                    } else {
                                        live_changed = true;
                                    }
                                }
                            }
                        }
                        if !drain.events.is_empty() {
                            let mut overflowed = false;
                            for ev in drain.events {
                                let outcome = live_page.as_mut().map_or(
                                    codenomad_client::content::ToolEventOutcome::Pending,
                                    |page| {
                                        codenomad_client::content::apply_tool_event(
                                            &mut page.rows,
                                            ev.message.as_deref(),
                                            &ev.kind,
                                            &ev.data,
                                            ev.at,
                                        )
                                    },
                                );
                                match outcome {
                                    codenomad_client::content::ToolEventOutcome::Applied => {
                                        if live_page.as_ref().is_some_and(|page| {
                                            codenomad_client::history::check(&page.rows).is_err()
                                        }) {
                                            live_page = None;
                                            overflowed = true;
                                            break;
                                        }
                                        live_changed = true;
                                    }
                                    codenomad_client::content::ToolEventOutcome::Drop => {}
                                    codenomad_client::content::ToolEventOutcome::Pending => {
                                        if pending_events.len() < MAX_PENDING_EVENTS
                                            && pending_bytes.saturating_add(ev.bytes)
                                                <= MAX_PENDING_BYTES
                                        {
                                            pending_bytes = pending_bytes.saturating_add(ev.bytes);
                                            pending_events.push((0, ev));
                                        }
                                    }
                                }
                            }
                            if overflowed {
                                live_changed = false;
                            }
                        }
                        if live_changed && let Some(page) = live_page.as_ref() {
                            let snap = snapshot_with_frozen(page.clone(), &frozen_ends);
                            if out
                                .try_send(ChildUpdate::Loaded {
                                    snapshot: snap,
                                    settled: false,
                                    unavailable: false,
                                })
                                .is_ok()
                            {
                                wake();
                            }
                        }
                    }
                    let rev_before = settlement.revocation_gen();
                    let fetched = {
                        let Some(_slot) = reads.background(&cancelled).await else {
                            break;
                        };
                        let parent_id = expected_parent.as_deref().unwrap_or(&backend.session);
                        backend.child_page_under(&child, parent_id).await
                    };
                    if settlement.revocation_gen() != rev_before {
                        owed_calls.clear();
                        frozen_ends.clear();
                        pending_events.clear();
                        pending_bytes = 0;
                        owed_synthetics.clear();
                        synthetic_owed = 0;
                        execution_owed = 0;
                        last_exec_end = None;
                        live_page = None;
                        if out.send(ChildUpdate::Unverified).await.is_err() {
                            break;
                        }
                        wake();
                        let _ = dirty.try_recv();
                        continue;
                    }
                    let (update, last_settled, last_running, last_failed) = match fetched {
                        Ok(Some(mut page)) => {
                            owed_calls.retain(|(msg, call), _| {
                                !child_tool_settled(&page.rows, msg.as_deref(), call)
                            });
                            frozen_ends.retain(|(msg, call), _| {
                                !child_tool_settled(&page.rows, msg.as_deref(), call)
                            });
                            if execution_owed > 0 {
                                let turn_start = page
                                    .rows
                                    .iter()
                                    .rposition(|r| r.role == "user")
                                    .map_or(0, |idx| idx + 1);
                                if !page.running {
                                    for row in &page.rows[turn_start..] {
                                        for part in &row.parts {
                                            if let Part::Tool(tool) = part
                                                && matches!(
                                                    tool.status.as_str(),
                                                    "pending" | "streaming" | "running"
                                                )
                                            {
                                                let k = (Some(row.id.clone()), tool.id.clone());
                                                if let Some(ts) = last_exec_end
                                                    && tool.started.is_none_or(|start| start <= ts)
                                                    && (frozen_ends.contains_key(&k)
                                                        || frozen_ends.len() < 128)
                                                {
                                                    frozen_ends.entry(k.clone()).or_insert(ts);
                                                }
                                                if owed_calls.len() < 64 {
                                                    owed_calls
                                                        .entry(k)
                                                        .or_insert((0, last_exec_end));
                                                }
                                            }
                                        }
                                    }
                                    execution_owed = 0;
                                    last_exec_end = None;
                                } else {
                                    if let Some(ts) = last_exec_end {
                                        for row in &page.rows[turn_start..] {
                                            for part in &row.parts {
                                                if let Part::Tool(tool) = part
                                                    && matches!(
                                                        tool.status.as_str(),
                                                        "streaming" | "running"
                                                    )
                                                    && tool.started.is_some_and(|start| start <= ts)
                                                {
                                                    let k = (Some(row.id.clone()), tool.id.clone());
                                                    if frozen_ends.contains_key(&k)
                                                        || frozen_ends.len() < 128
                                                    {
                                                        frozen_ends.entry(k).or_insert(ts);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    execution_owed -= 1;
                                    if execution_owed == 0 {
                                        last_exec_end = None;
                                    }
                                }
                            }
                            if let Some(prior) = live_page.as_ref() {
                                let mut merged = page.rows.clone();
                                if codenomad_client::content::merge_page(&prior.rows, &mut merged)
                                    .is_ok()
                                {
                                    page.rows = merged;
                                }
                            }
                            if !pending_events.is_empty() {
                                let mut kept = Vec::new();
                                pending_bytes = 0;
                                for (age, ev) in pending_events.drain(..) {
                                    let outcome = codenomad_client::content::apply_tool_event(
                                        &mut page.rows,
                                        ev.message.as_deref(),
                                        &ev.kind,
                                        &ev.data,
                                        ev.at,
                                    );
                                    if matches!(
                                        outcome,
                                        codenomad_client::content::ToolEventOutcome::Pending
                                    ) && age < 2
                                    {
                                        pending_bytes = pending_bytes.saturating_add(ev.bytes);
                                        kept.push((age + 1, ev));
                                    }
                                }
                                pending_events = kept;
                                if codenomad_client::history::check(&page.rows).is_err() {
                                    live_page = None;
                                    pending_events.clear();
                                    pending_bytes = 0;
                                    continue;
                                }
                            }
                            if !owed_synthetics.is_empty() && page.newer.is_none() {
                                owed_synthetics.retain(|(_, prior_matches, r)| {
                                    if page.rows.iter().any(|p| p.id == r.id) {
                                        return false;
                                    }
                                    if r.id.starts_with("msg_") {
                                        return true;
                                    }
                                    let page_matches = page
                                        .rows
                                        .iter()
                                        .filter(|p| same_synthetic_report(p, r))
                                        .count();
                                    page_matches <= *prior_matches
                                });
                                for (_, _, row) in &owed_synthetics {
                                    if page.rows.len() < codenomad_client::history::MAX_ROWS
                                        && !page.rows.iter().any(|p| p.id == row.id)
                                    {
                                        page.rows.push(row.clone());
                                        if codenomad_client::history::check(&page.rows).is_err() {
                                            page.rows.pop();
                                            break;
                                        }
                                    }
                                }
                            }
                            if synthetic_owed > 0 {
                                synthetic_owed -= 1;
                            }
                            let settled = !page.running
                                && owed_calls.is_empty()
                                && owed_synthetics.is_empty()
                                && synthetic_owed == 0
                                && execution_owed == 0
                                && pending_events.is_empty();
                            let running = page.running;
                            live_page = Some(page.clone());
                            (
                                ChildUpdate::Loaded {
                                    snapshot: snapshot_with_frozen(page, &frozen_ends),
                                    settled,
                                    unavailable: false,
                                },
                                settled,
                                running,
                                false,
                            )
                        }
                        Ok(None) => {
                            owed_calls.clear();
                            frozen_ends.clear();
                            pending_events.clear();
                            pending_bytes = 0;
                            owed_synthetics.clear();
                            synthetic_owed = 0;
                            execution_owed = 0;
                            last_exec_end = None;
                            live_page = None;
                            (
                                ChildUpdate::Loaded {
                                    snapshot: Snapshot::default(),
                                    settled: true,
                                    unavailable: true,
                                },
                                true,
                                false,
                                false,
                            )
                        }
                        Err(_) => {
                            if execution_owed > 0 {
                                execution_owed -= 1;
                                if execution_owed == 0 {
                                    last_exec_end = None;
                                }
                            }
                            if synthetic_owed > 0 {
                                synthetic_owed -= 1;
                            }
                            if !pending_events.is_empty() {
                                let mut kept = Vec::new();
                                pending_bytes = 0;
                                for (age, ev) in pending_events.drain(..) {
                                    if age < 2 {
                                        pending_bytes = pending_bytes.saturating_add(ev.bytes);
                                        kept.push((age + 1, ev));
                                    }
                                }
                                pending_events = kept;
                            }
                            (ChildUpdate::Failed, false, false, true)
                        }
                    };
                    if out.send(update).await.is_err() {
                        break;
                    }
                    wake();
                    let mut max_attempt = 0u8;
                    owed_calls.retain(|_, (attempts, _)| {
                        *attempts = attempts.saturating_add(1);
                        if *attempts <= 3 {
                            max_attempt = max_attempt.max(*attempts);
                            true
                        } else {
                            false
                        }
                    });
                    owed_synthetics.retain_mut(|(attempts, _, _)| {
                        *attempts = attempts.saturating_add(1);
                        if *attempts <= 3 {
                            max_attempt = max_attempt.max(*attempts);
                            true
                        } else {
                            false
                        }
                    });
                    if !owed_calls.is_empty()
                        || !owed_synthetics.is_empty()
                        || synthetic_owed > 0
                        || execution_owed > 0
                        || !pending_events.is_empty()
                    {
                        let step = max_attempt.max(1);
                        let delay = Duration::from_millis(100 * u64::from(step));
                        runtime::sleep(delay).await;
                        let _ = dirty.try_recv();
                        let _ = retry_rx.try_recv();
                        continue;
                    }
                    if !last_settled
                        && !last_running
                        && pending_events.is_empty()
                        && (live_page.is_some() || last_failed)
                    {
                        if out.send(ChildUpdate::Settled).await.is_err() {
                            break;
                        }
                        wake();
                    }
                    if !last_running && !last_failed && pending_events.is_empty() {
                        // Release full HTTP page buffer while idle; next wake re-fetches fresh.
                        live_page = None;
                    }
                    if !wait_wake(&dirty, &retry_rx).await {
                        break;
                    }
                    runtime::sleep(Duration::from_millis(100)).await;
                    let _ = dirty.try_recv();
                    let _ = retry_rx.try_recv();
                }
            })
            .await;
        });
        true
    }
}

async fn wait_wake(dirty: &Receiver<()>, retry: &Receiver<()>) -> bool {
    use std::{future::Future, task::Poll};
    let mut d = std::pin::pin!(dirty.recv());
    let mut r = std::pin::pin!(retry.recv());
    std::future::poll_fn(|cx| {
        if let Poll::Ready(res) = d.as_mut().poll(cx) {
            return Poll::Ready(res.is_ok());
        }
        if let Poll::Ready(res) = r.as_mut().poll(cx) {
            return Poll::Ready(res.is_ok());
        }
        Poll::Pending
    })
    .await
}
