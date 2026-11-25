use super::super::{apply_patch, error, format, output, todo};
use super::*;

static CLIPBOARD_EPOCH: AtomicU64 = AtomicU64::new(0);

pub(crate) fn note_clipboard_write() {
    CLIPBOARD_EPOCH.fetch_add(1, Ordering::SeqCst);
}

#[cfg(test)]
pub(crate) fn clipboard_write_epoch() -> u64 {
    CLIPBOARD_EPOCH.load(Ordering::SeqCst)
}

fn next_clipboard_epoch() -> u64 {
    CLIPBOARD_EPOCH.fetch_add(1, Ordering::SeqCst) + 1
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for &b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

impl Children {
    pub(crate) fn cancel_copy(&mut self) {
        note_clipboard_write();
        self.report_copy = ReportCopy::Idle;
    }

    pub(in crate::chat::tools) fn commit_ready_copy(
        s: &mut State,
        key: &CopyKey,
        tx: &mut rune::Tx,
    ) -> bool {
        let ready = match &s.transcript_display.children.report_copy {
            ReportCopy::Ready {
                key: current,
                revocation,
                ..
            } if current == key => {
                if revocation.is_revoked() {
                    s.transcript_display.children.report_copy = ReportCopy::Idle;
                    return false;
                }
                match std::mem::take(&mut s.transcript_display.children.report_copy) {
                    ReportCopy::Ready { text, .. } => Some(text),
                    _ => None,
                }
            }
            _ => None,
        };
        let Some(text) = ready else {
            return false;
        };
        #[cfg(not(target_arch = "wasm32"))]
        {
            note_clipboard_write();
            tx.copy(text);
            s.transcript_display.children.report_copy = ReportCopy::Copied { key: key.clone() };
        }
        #[cfg(target_arch = "wasm32")]
        {
            let _ = tx;
            let epoch = next_clipboard_epoch();
            let (out, rx) = bounded(1);
            let wake = s.wake.clone();
            crate::platform::diagnostics::copy(&text, move |copied| {
                if out.try_send(copied).is_ok() {
                    wake();
                }
            });
            s.transcript_display.children.report_copy = ReportCopy::Confirming {
                key: key.clone(),
                epoch,
                rx,
            };
        }
        true
    }

    pub(in crate::chat::tools) fn copy_failed(&self, key: &CopyKey) -> bool {
        matches!(&self.report_copy, ReportCopy::Failed { key: current } if current == key)
    }

    pub(in crate::chat::tools) fn copy_copied(&self, key: &CopyKey) -> bool {
        matches!(&self.report_copy, ReportCopy::Copied { key: current } if current == key)
    }

    pub(in crate::chat::tools) fn copy_ready(&self, key: &CopyKey) -> bool {
        matches!(
            &self.report_copy,
            ReportCopy::Ready {
                key: current,
                revocation,
                ..
            } if current == key && !revocation.is_revoked()
        )
    }

    fn card_lease(&self, ui_key: &str) -> Option<Weak<()>> {
        let card = ui_key.strip_prefix("copy-").and_then(|rest| {
            rest.strip_suffix("-output")
                .or_else(|| rest.strip_suffix("-input"))
                .or_else(|| rest.strip_suffix("-error"))
                .or_else(|| rest.strip_suffix("-steps"))
        })?;
        self.entries
            .values()
            .find_map(|entry| {
                entry.cards.get(card).cloned().or_else(|| {
                    entry
                        .cards
                        .iter()
                        .find_map(|(k, w)| card.starts_with(&format!("{k}-")).then(|| w.clone()))
                })
            })
            .or_else(|| {
                self.waiting
                    .iter()
                    .find(|(_, wkey, _)| wkey == card)
                    .map(|(_, _, lease)| lease.clone())
            })
    }

    pub(super) fn fetch_report(
        s: &State,
        key: &ReportCopyKey,
        shared: Option<(Arc<codenomad_client::stream::ChildSettlement>, u64)>,
    ) -> Option<(codenomad_client::Sender<()>, Receiver<Option<String>>)> {
        let backend = s.transcript_display.children.backend.clone()?;
        let (out, rx) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        let (parent, row_id, part_index, child) = (
            key.parent.clone(),
            key.row_id.clone(),
            key.part_index,
            key.child.clone(),
        );
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        crate::platform::spawn(async move {
            crate::platform::reads::cancellable(&cancelled, async {
                let body = with_timeout(COPY_BUDGET, async {
                    let (_owned_rx, settlement, rev_before) = match shared {
                        Some((settlement, rev_before)) => (None, settlement, rev_before),
                        None => {
                            let (rx, settlement) = backend.watch_child(&parent)?;
                            let rev = settlement.revocation_gen();
                            (Some(rx), settlement, rev)
                        }
                    };
                    let _slot = reads.background(&cancelled).await?;
                    let page = backend.child_page(&parent).await.ok().flatten()?;
                    if settlement.revocation_gen() != rev_before {
                        return None;
                    }
                    page.rows
                        .iter()
                        .find(|row| row.id == row_id)
                        .and_then(|row| {
                            row.parts
                                .get(part_index)
                                .and_then(|part| match part {
                                    Part::SubagentReport(report) if report.child == child => {
                                        Some(report.body.clone())
                                    }
                                    _ => None,
                                })
                                .or_else(|| {
                                    row.parts.iter().rev().find_map(|part| match part {
                                        Part::SubagentReport(report) if report.child == child => {
                                            Some(report.body.clone())
                                        }
                                        _ => None,
                                    })
                                })
                        })
                })
                .await;
                if out.send(body).await.is_ok() {
                    wake();
                }
            })
            .await;
        });
        Some((cancel, rx))
    }

    pub(super) fn fetch_tool_section(
        s: &State,
        key: &ToolCopyKey,
        shared: Option<(Arc<codenomad_client::stream::ChildSettlement>, u64)>,
    ) -> Option<(codenomad_client::Sender<()>, Receiver<Option<String>>)> {
        let backend = s.transcript_display.children.backend.clone()?;
        let (out, rx) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        let key = key.clone();
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        crate::platform::spawn(async move {
            crate::platform::reads::cancellable(&cancelled, async {
                let expected_parent = key.parent.as_deref().unwrap_or(&backend.session);
                let body = with_timeout(COPY_BUDGET, async {
                    let (_owned_rx, settlement, rev_before) = match shared {
                        Some((settlement, rev_before)) => (None, settlement, rev_before),
                        None => {
                            let (rx, settlement) = backend.watch_child(&key.child)?;
                            let rev = settlement.revocation_gen();
                            (Some(rx), settlement, rev)
                        }
                    };
                    let location = {
                        let _slot = reads.background(&cancelled).await?;
                        backend
                            .child_ownership_token(&key.child, expected_parent)
                            .await
                            .ok()??
                    };
                    let page = {
                        let _slot = reads.background(&cancelled).await?;
                        backend
                            .child_page_request(
                                &key.child,
                                serde_json::json!({"kind": "around", "messageID": key.row_id}),
                            )
                            .await
                            .ok()
                    };
                    let page = match page {
                        Some(page) => page,
                        None => {
                            let _slot = reads.background(&cancelled).await?;
                            backend
                                .child_page_under(&key.child, expected_parent)
                                .await
                                .ok()??
                        }
                    };
                    let still_owned = {
                        let _slot = reads.background(&cancelled).await?;
                        backend
                            .child_ownership_token(&key.child, expected_parent)
                            .await
                            .ok()?
                    };
                    if still_owned != Some(location) || settlement.revocation_gen() != rev_before {
                        return None;
                    }
                    let tool =
                        page.rows
                            .iter()
                            .find(|row| row.id == key.row_id)
                            .and_then(|row| {
                                row.parts.iter().find_map(|part| match part {
                                    Part::Tool(tool) if tool.id == key.call => Some(tool.as_ref()),
                                    _ => None,
                                })
                            })?;
                    match key.section {
                        0 => format::bounded_json(&tool.input, MAX_COPY_BYTES),
                        1 => {
                            if let Some(value) = format::structured_output(tool) {
                                match format::format_unknown(value, Some(MAX_COPY_BYTES)) {
                                    format::Formatted::Text(source, _) => Some(source),
                                    _ => None,
                                }
                            } else if tool.name == "todowrite" {
                                todo::copy(tool)
                            } else if matches!(tool.name.as_str(), "apply_patch" | "patch") {
                                apply_patch::copy_all(None, tool).or_else(|| {
                                    let mut parts = [""; 4];
                                    output(tool, &mut parts);
                                    let joined = parts.concat();
                                    (!joined.is_empty()).then_some(joined)
                                })
                            } else {
                                let mut parts = [""; 4];
                                output(tool, &mut parts);
                                Some(parts.concat())
                            }
                        }
                        _ => Some(error(tool).to_owned()),
                    }
                })
                .await;
                if out.send(body).await.is_ok() {
                    wake();
                }
            })
            .await;
        });
        Some((cancel, rx))
    }

    pub(in crate::chat::tools) fn copy_report(
        s: &mut State,
        key: ReportCopyKey,
        tx: &mut rune::Tx,
    ) {
        let lease = s.transcript_display.children.card_lease(&key.key);
        let copy_key = CopyKey::Report(key.clone());
        let Some((watch_rx, settlement)) = s
            .transcript_display
            .children
            .backend
            .as_ref()
            .and_then(|b| b.watch_child(&key.parent))
        else {
            s.transcript_display.children.report_copy = ReportCopy::Failed { key: copy_key };
            return;
        };
        let rev_before = settlement.revocation_gen();
        let Some((cancel, rx)) =
            Self::fetch_report(s, &key, Some((settlement.clone(), rev_before)))
        else {
            s.transcript_display.children.report_copy = ReportCopy::Failed { key: copy_key };
            return;
        };
        let revocation = CopyRevocation {
            _rx: watch_rx,
            settlement,
            rev_before,
        };
        let epoch = next_clipboard_epoch();
        let scope = s.input_scope.clone();
        let baseline = Rc::new(Cell::new(None));
        #[cfg(not(target_arch = "wasm32"))]
        {
            let capture = baseline.clone();
            tx.read_clipboard(move |_: &mut State, content, _| {
                capture.set(Some(rune_theme_codenomad::clipboard::fingerprint(content)));
            });
        }
        #[cfg(target_arch = "wasm32")]
        let _ = tx;
        s.transcript_display.children.report_copy = ReportCopy::Loading {
            key: copy_key,
            epoch,
            scope,
            baseline,
            lease,
            revocation,
            _cancel: cancel,
            rx,
        };
    }

    pub(in crate::chat::tools) fn copy_tool_section(
        s: &mut State,
        key: ToolCopyKey,
        tx: &mut rune::Tx,
    ) {
        let lease = s.transcript_display.children.card_lease(&key.key);
        let copy_key = CopyKey::ToolSection(key.clone());
        if matches!(&s.transcript_display.children.report_copy, ReportCopy::Loading { key: current, .. } if current == &copy_key)
        {
            return;
        }
        let Some((watch_rx, settlement)) = s
            .transcript_display
            .children
            .backend
            .as_ref()
            .and_then(|b| b.watch_child(&key.child))
        else {
            s.transcript_display.children.report_copy = ReportCopy::Failed { key: copy_key };
            return;
        };
        let rev_before = settlement.revocation_gen();
        let Some((cancel, rx)) =
            Self::fetch_tool_section(s, &key, Some((settlement.clone(), rev_before)))
        else {
            s.transcript_display.children.report_copy = ReportCopy::Failed { key: copy_key };
            return;
        };
        let revocation = CopyRevocation {
            _rx: watch_rx,
            settlement,
            rev_before,
        };
        let epoch = next_clipboard_epoch();
        let scope = s.input_scope.clone();
        let baseline = Rc::new(Cell::new(None));
        #[cfg(not(target_arch = "wasm32"))]
        {
            let capture = baseline.clone();
            tx.read_clipboard(move |_: &mut State, content, _| {
                capture.set(Some(rune_theme_codenomad::clipboard::fingerprint(content)));
            });
        }
        #[cfg(target_arch = "wasm32")]
        let _ = tx;
        s.transcript_display.children.report_copy = ReportCopy::Loading {
            key: copy_key,
            epoch,
            scope,
            baseline,
            lease,
            revocation,
            _cancel: cancel,
            rx,
        };
    }

    pub(in crate::chat::tools) fn copy_steps(
        s: &mut State,
        key: String,
        parent: Option<String>,
        child: String,
        tx: &mut rune::Tx,
    ) {
        let lease = s.transcript_display.children.card_lease(&key);
        let copy_key = CopyKey::Steps {
            key,
            parent: parent.clone(),
            child: child.clone(),
        };
        if matches!(&s.transcript_display.children.report_copy, ReportCopy::Loading { key: current, .. } if current == &copy_key)
        {
            return;
        }
        let Some(backend) = s.transcript_display.children.backend.clone() else {
            s.transcript_display.children.report_copy = ReportCopy::Failed { key: copy_key };
            return;
        };
        let Some((watch_rx, settlement)) = backend.watch_child(&child) else {
            s.transcript_display.children.report_copy = ReportCopy::Failed { key: copy_key };
            return;
        };
        let rev_before = settlement.revocation_gen();
        let task_settlement = settlement.clone();
        let revocation = CopyRevocation {
            _rx: watch_rx,
            settlement,
            rev_before,
        };
        let (out, rx) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        let epoch = next_clipboard_epoch();
        let scope = s.input_scope.clone();
        let baseline = Rc::new(Cell::new(None));
        #[cfg(not(target_arch = "wasm32"))]
        {
            let capture = baseline.clone();
            tx.read_clipboard(move |_: &mut State, content, _| {
                capture.set(Some(rune_theme_codenomad::clipboard::fingerprint(content)));
            });
        }
        #[cfg(target_arch = "wasm32")]
        let _ = tx;
        s.transcript_display.children.report_copy = ReportCopy::Loading {
            key: copy_key,
            epoch,
            scope,
            baseline,
            lease,
            revocation,
            _cancel: cancel,
            rx,
        };
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        crate::platform::spawn(async move {
            crate::platform::reads::cancellable(&cancelled, async {
                let expected_parent = parent.as_deref().unwrap_or(&backend.session);
                let body = with_timeout(
                    COPY_BUDGET,
                    copy_child_steps_bounded(
                        &backend,
                        &reads,
                        &cancelled,
                        &child,
                        expected_parent,
                        &task_settlement,
                        rev_before,
                    ),
                )
                .await;
                if out.send(body).await.is_ok() {
                    wake();
                }
            })
            .await;
        });
    }

    pub(super) fn poll_copy(s: &mut State, tx: &mut rune::Tx) -> bool {
        #[cfg(target_arch = "wasm32")]
        {
            let confirm_outcome = match &s.transcript_display.children.report_copy {
                ReportCopy::Confirming { epoch, rx, .. } => {
                    if CLIPBOARD_EPOCH.load(Ordering::SeqCst) != *epoch {
                        s.transcript_display.children.report_copy = ReportCopy::Idle;
                        return false;
                    }
                    match rx.try_recv() {
                        Ok(copied) => Some(copied),
                        Err(error) if error.is_closed() => Some(false),
                        Err(_) => return false,
                    }
                }
                _ => None,
            };
            if let Some(copied) = confirm_outcome {
                if let ReportCopy::Confirming { key, epoch, .. } =
                    std::mem::take(&mut s.transcript_display.children.report_copy)
                {
                    if CLIPBOARD_EPOCH.load(Ordering::SeqCst) != epoch {
                        return false;
                    }
                    if copied {
                        note_clipboard_write();
                        s.transcript_display.children.report_copy = ReportCopy::Copied { key };
                    } else {
                        crate::shell::notifications::emit_outcome(
                            s,
                            crate::shell::notifications::Category::Sessions,
                            None,
                            crate::strings::t("messageSection.quote.copyFailed"),
                            true,
                        );
                        s.transcript_display.children.report_copy = ReportCopy::Failed { key };
                    }
                    return true;
                }
                return false;
            }
        }
        let outcome = match &s.transcript_display.children.report_copy {
            ReportCopy::Loading {
                epoch,
                scope,
                lease,
                revocation,
                rx,
                ..
            } => {
                if !s.current_scope(scope)
                    || lease.as_ref().is_some_and(|w| w.strong_count() == 0)
                    || revocation.is_revoked()
                    || CLIPBOARD_EPOCH.load(Ordering::SeqCst) != *epoch
                {
                    s.transcript_display.children.report_copy = ReportCopy::Idle;
                    return false;
                }
                match rx.try_recv() {
                    Ok(body) => Some(body),
                    Err(error) if error.is_closed() => Some(None),
                    Err(_) => return false,
                }
            }
            _ => return false,
        };
        let (key, epoch, scope, baseline, lease, revocation) =
            match std::mem::take(&mut s.transcript_display.children.report_copy) {
                ReportCopy::Loading {
                    key,
                    epoch,
                    scope,
                    baseline,
                    lease,
                    revocation,
                    ..
                } => (key, epoch, scope, baseline, lease, revocation),
                _ => return false,
            };
        if !s.current_scope(&scope)
            || lease.as_ref().is_some_and(|w| w.strong_count() == 0)
            || revocation.is_revoked()
            || CLIPBOARD_EPOCH.load(Ordering::SeqCst) != epoch
        {
            return false;
        }
        match outcome {
            Some(Some(text)) => {
                #[cfg(not(target_arch = "wasm32"))]
                {
                    let expected = baseline.get();
                    tx.read_clipboard(move |s: &mut State, current, tx| {
                        if !s.current_scope(&scope)
                            || lease.as_ref().is_some_and(|w| w.strong_count() == 0)
                            || revocation.is_revoked()
                            || CLIPBOARD_EPOCH.load(Ordering::SeqCst) != epoch
                        {
                            return;
                        }
                        if let Some(before) = expected
                            && rune_theme_codenomad::clipboard::fingerprint(current) != before
                        {
                            return;
                        }
                        note_clipboard_write();
                        tx.copy(text);
                        s.transcript_display.children.report_copy = ReportCopy::Copied { key };
                    });
                }
                #[cfg(target_arch = "wasm32")]
                {
                    let _ = (tx, baseline);
                    // On the web, never write to the clipboard asynchronously after an HTTP
                    // round trip: stage the payload so the user's next click writes it directly.
                    s.transcript_display.children.report_copy = ReportCopy::Ready {
                        key,
                        text,
                        revocation,
                    };
                }
                true
            }
            _ => {
                if matches!(key, CopyKey::ToolSection(_)) {
                    crate::shell::notifications::emit_outcome(
                        s,
                        crate::shell::notifications::Category::Sessions,
                        None,
                        crate::strings::t("messageSection.quote.copyFailed"),
                        true,
                    );
                }
                s.transcript_display.children.report_copy = ReportCopy::Failed { key };
                true
            }
        }
    }
}

async fn with_timeout<T>(
    budget: Duration,
    fut: impl std::future::Future<Output = Option<T>>,
) -> Option<T> {
    use std::{future::Future, task::Poll};
    let mut fut = std::pin::pin!(fut);
    let mut timer = std::pin::pin!(runtime::sleep(budget));
    std::future::poll_fn(|cx| {
        if let Poll::Ready(value) = fut.as_mut().poll(cx) {
            return Poll::Ready(value);
        }
        if timer.as_mut().poll(cx).is_ready() {
            return Poll::Ready(None);
        }
        Poll::Pending
    })
    .await
}

async fn copy_child_steps_bounded(
    backend: &Backend,
    reads: &crate::platform::reads::Reads,
    cancelled: &Receiver<()>,
    child: &str,
    expected_parent: &str,
    settlement: &codenomad_client::stream::ChildSettlement,
    rev_before: u64,
) -> Option<String> {
    use std::{collections::HashSet, io};
    struct Limited(Vec<u8>, usize);
    impl io::Write for Limited {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.0.len().saturating_add(bytes.len()) > self.1 {
                return Err(io::ErrorKind::FileTooLarge.into());
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let deadline = runtime::Instant::now() + COPY_BUDGET;
    let location = {
        let _slot = reads.background(cancelled).await?;
        backend
            .child_ownership_token(child, expected_parent)
            .await
            .ok()??
    };
    let mut out = Limited(Vec::new(), MAX_COPY_BYTES);
    io::Write::write_all(&mut out, b"[\n").ok()?;
    let mut count = 0usize;
    let mut seen_rows = HashSet::new();
    let mut cursor = Some(serde_json::json!({"kind": "oldest"}));
    let mut seen_cursors = HashSet::new();
    for _ in 0..MAX_COPY_PAGES {
        if runtime::Instant::now() >= deadline || settlement.revocation_gen() != rev_before {
            return None;
        }
        let Some(request) = cursor.take() else {
            break;
        };
        let encoded_cursor = request.to_string();
        if encoded_cursor.len() > 4096 {
            return None;
        }
        let cursor_key = (
            request["kind"].as_str().unwrap_or_default().to_owned(),
            request["messageID"].as_str().unwrap_or_default().to_owned(),
            fnv1a64(encoded_cursor.as_bytes()),
        );
        if !seen_cursors.insert(cursor_key) {
            return None;
        }
        let (rows, newer) = {
            let _slot = reads.background(cancelled).await?;
            backend.child_raw_tools_request(child, request).await.ok()?
        };
        if settlement.revocation_gen() != rev_before {
            return None;
        }
        for (row_id, tools) in rows {
            if !seen_rows.insert(row_id) {
                continue;
            }
            for part in tools {
                if count > 0 {
                    io::Write::write_all(&mut out, b",\n").ok()?;
                }
                serde_json::to_writer_pretty(&mut out, &part).ok()?;
                count += 1;
            }
        }
        cursor = newer;
    }
    if cursor.is_some()
        || runtime::Instant::now() >= deadline
        || settlement.revocation_gen() != rev_before
    {
        return None;
    }
    io::Write::write_all(&mut out, if count > 0 { b"\n]" } else { b"]" }).ok()?;
    let still_owned = {
        let _slot = reads.background(cancelled).await?;
        backend
            .child_ownership_token(child, expected_parent)
            .await
            .ok()?
    };
    (still_owned == Some(location) && settlement.revocation_gen() == rev_before)
        .then(|| String::from_utf8(out.0).ok())
        .flatten()
}
