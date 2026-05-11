use super::*;

pub(super) fn run_transport_loop(
    app: AppHandle,
    state: Arc<Mutex<DesktopEventTransportState>>,
    generation_atomic: Arc<AtomicU64>,
    generation: u64,
    stop: Arc<AtomicBool>,
    config: DesktopEventTransportConfig,
) {
    let mut reconnect_attempt = 0_u32;
    let mut stats = DesktopEventTransportStats::default();

    let client = match build_stream_client() {
        Ok(client) => client,
        Err(error) => {
            emit_status(
                &app,
                generation,
                "error",
                0,
                true,
                Some(error.message),
                None,
                None,
                &stats,
            );
            return;
        }
    };

    loop {
        if stop.load(Ordering::SeqCst) || !generation_matches(&generation_atomic, generation) {
            break;
        }

        emit_status(
            &app,
            generation,
            "connecting",
            reconnect_attempt,
            false,
            None,
            None,
            None,
            &stats,
        );

        match open_stream(&app, &client, &config.stream) {
            Ok(response) => {
                reconnect_attempt = 0;
                emit_status(
                    &app,
                    generation,
                    "connected",
                    reconnect_attempt,
                    false,
                    None,
                    None,
                    None,
                    &stats,
                );

                let disconnect_reason = consume_stream(
                    &app,
                    response,
                    &state,
                    &generation_atomic,
                    generation,
                    stop.clone(),
                    &mut stats,
                );
                if stop.load(Ordering::SeqCst)
                    || !generation_matches(&generation_atomic, generation)
                {
                    break;
                }

                if !schedule_retry(
                    &app,
                    &generation_atomic,
                    generation,
                    stop.clone(),
                    &config.reconnect,
                    &mut reconnect_attempt,
                    "disconnected",
                    disconnect_reason,
                    None,
                    &stats,
                ) {
                    break;
                }
            }
            Err(error) => {
                let state_name = match error.kind {
                    OpenStreamErrorKind::Unauthorized => "unauthorized",
                    OpenStreamErrorKind::Http | OpenStreamErrorKind::Transport => "error",
                };

                if !schedule_retry(
                    &app,
                    &generation_atomic,
                    generation,
                    stop.clone(),
                    &config.reconnect,
                    &mut reconnect_attempt,
                    state_name,
                    Some(error.message),
                    error.status_code,
                    &stats,
                ) {
                    break;
                }
            }
        }
    }

    emit_status(
        &app,
        generation,
        "stopped",
        reconnect_attempt,
        true,
        None,
        None,
        None,
        &stats,
    );
}

fn schedule_retry(
    app: &AppHandle,
    generation_atomic: &Arc<AtomicU64>,
    generation: u64,
    stop: Arc<AtomicBool>,
    policy: &ResolvedDesktopEventReconnectPolicy,
    reconnect_attempt: &mut u32,
    state_name: &'static str,
    reason: Option<String>,
    status_code: Option<u16>,
    stats: &DesktopEventTransportStats,
) -> bool {
    *reconnect_attempt = reconnect_attempt.saturating_add(1);
    let terminal = policy
        .max_attempts
        .map(|max_attempts| *reconnect_attempt >= max_attempts)
        .unwrap_or(false);
    let next_delay_ms = if terminal {
        None
    } else {
        Some(compute_reconnect_delay_ms(*reconnect_attempt, policy))
    };

    emit_status(
        app,
        generation,
        state_name,
        *reconnect_attempt,
        terminal,
        reason,
        next_delay_ms,
        status_code,
        stats,
    );

    if terminal {
        return false;
    }

    if let Some(delay_ms) = next_delay_ms {
        wait_with_cancellation(generation_atomic, generation, stop, delay_ms);
    }

    true
}

fn wait_with_cancellation(
    generation_atomic: &Arc<AtomicU64>,
    generation: u64,
    stop: Arc<AtomicBool>,
    delay_ms: u64,
) {
    let mut remaining_ms = delay_ms;
    while remaining_ms > 0 {
        if stop.load(Ordering::SeqCst) || !generation_matches(generation_atomic, generation) {
            return;
        }

        let chunk_ms = remaining_ms.min(100);
        thread::sleep(Duration::from_millis(chunk_ms));
        remaining_ms -= chunk_ms;
    }
}

fn consume_stream(
    app: &AppHandle,
    response: Response,
    state: &Arc<Mutex<DesktopEventTransportState>>,
    generation_atomic: &Arc<AtomicU64>,
    generation: u64,
    stop: Arc<AtomicBool>,
    stats: &mut DesktopEventTransportStats,
) -> Option<String> {
    let (tx, rx) = mpsc::sync_channel::<ReaderMessage>(4096);
    let reader_stop = stop.clone();
    let reader_generation_atomic = generation_atomic.clone();
    thread::spawn(move || {
        read_sse(
            response,
            tx,
            reader_stop,
            reader_generation_atomic,
            generation,
        )
    });

    let mut pending = PendingBatch::default();
    let mut active_text_assembler = ActiveTextAssembler::default();
    let mut active_text_snapshots = ActiveTextSnapshotBuffer::default();
    let mut sequence = 0_u64;
    let mut last_active_target: Option<ActiveSessionTarget> = None;
    let mut last_reader_activity = Instant::now();

    loop {
        if stop.load(Ordering::SeqCst) || !generation_matches(generation_atomic, generation) {
            return Some("stopped".to_string());
        }

        match rx.recv_timeout(Duration::from_millis(FLUSH_INTERVAL_MS)) {
            Ok(ReaderMessage::Activity) => {
                last_reader_activity = Instant::now();
            }
            Ok(ReaderMessage::Event(event)) => {
                last_reader_activity = Instant::now();
                stats.raw_events = stats.raw_events.saturating_add(1);

                let now = Instant::now();
                let active_target = state.lock().active_target.clone();
                let max_batch_events = if active_target.is_some() {
                    ACTIVE_SESSION_MAX_BATCH_EVENTS
                } else {
                    MAX_BATCH_EVENTS
                };
                let mut should_flush_active = false;
                if active_target != last_active_target {
                    for flushed in active_text_assembler.flush_store_only_all(now) {
                        pending.push(flushed, stats);
                    }
                    for flushed in active_text_snapshots.flush_all() {
                        pending.push(flushed, stats);
                    }
                    last_active_target = active_target.clone();
                }

                let due = active_text_assembler.take_due(now);
                if !due.is_empty() {
                    should_flush_active = true;
                }
                for flushed in due {
                    pending.push(flushed, stats);
                }

                let snapshot_due = active_text_snapshots.take_due(now);
                if !snapshot_due.is_empty() {
                    should_flush_active = true;
                }
                for flushed in snapshot_due {
                    pending.push(flushed, stats);
                }

                let flushes = active_text_assembler.flush_for_event(&event, now);
                if !flushes.is_empty() {
                    should_flush_active = true;
                }
                for flushed in flushes {
                    pending.push(flushed, stats);
                }

                let snapshot_flushes = active_text_snapshots.flush_for_event(&event);
                if !snapshot_flushes.is_empty() {
                    should_flush_active = true;
                }
                for flushed in snapshot_flushes {
                    pending.push(flushed, stats);
                }

                if let Some(snapshot) = parse_active_text_snapshot(&event, active_target.as_ref()) {
                    active_text_snapshots.buffer(snapshot, now);

                    if should_flush_active {
                        emit_pending_batch(
                            app,
                            generation,
                            &mut pending,
                            &mut sequence,
                            generation_atomic,
                            stats,
                        );
                    }

                    if pending.pending_len() >= max_batch_events {
                        emit_pending_batch(
                            app,
                            generation,
                            &mut pending,
                            &mut sequence,
                            generation_atomic,
                            stats,
                        );
                    }
                    continue;
                }

                if let Some(delta) = parse_active_text_delta(&event, active_target.as_ref()) {
                    let assembled_events = active_text_assembler.absorb(delta, now);
                    if !assembled_events.is_empty() {
                        should_flush_active = true;
                    }
                    for assembled in assembled_events {
                        pending.push(assembled, stats);
                    }

                    if should_flush_active {
                        emit_pending_batch(
                            app,
                            generation,
                            &mut pending,
                            &mut sequence,
                            generation_atomic,
                            stats,
                        );
                    }

                    if pending.pending_len() >= max_batch_events {
                        emit_pending_batch(
                            app,
                            generation,
                            &mut pending,
                            &mut sequence,
                            generation_atomic,
                            stats,
                        );
                    }
                    continue;
                }

                pending.push(event, stats);
                if should_flush_active {
                    emit_pending_batch(
                        app,
                        generation,
                        &mut pending,
                        &mut sequence,
                        generation_atomic,
                        stats,
                    );
                }
                if pending.pending_len() >= max_batch_events {
                    emit_pending_batch(
                        app,
                        generation,
                        &mut pending,
                        &mut sequence,
                        generation_atomic,
                        stats,
                    );
                }
            }
            Ok(ReaderMessage::End(reason)) => {
                for flushed in active_text_assembler.take_due(Instant::now()) {
                    pending.push(flushed, stats);
                }
                for flushed in active_text_assembler.flush_store_only_all(Instant::now()) {
                    pending.push(flushed, stats);
                }
                for flushed in active_text_snapshots.take_due(Instant::now()) {
                    pending.push(flushed, stats);
                }
                for flushed in active_text_snapshots.flush_all() {
                    pending.push(flushed, stats);
                }
                if !pending.is_empty() {
                    emit_pending_batch(
                        app,
                        generation,
                        &mut pending,
                        &mut sequence,
                        generation_atomic,
                        stats,
                    );
                }
                return reason;
            }
            Err(RecvTimeoutError::Timeout) => {
                if last_reader_activity.elapsed() >= Duration::from_millis(STREAM_STALL_TIMEOUT_MS)
                {
                    for flushed in active_text_assembler.take_due(Instant::now()) {
                        pending.push(flushed, stats);
                    }
                    for flushed in active_text_assembler.flush_store_only_all(Instant::now()) {
                        pending.push(flushed, stats);
                    }
                    for flushed in active_text_snapshots.take_due(Instant::now()) {
                        pending.push(flushed, stats);
                    }
                    for flushed in active_text_snapshots.flush_all() {
                        pending.push(flushed, stats);
                    }
                    if !pending.is_empty() {
                        sequence += 1;
                        emit_batch(
                            app,
                            generation,
                            &mut pending,
                            sequence,
                            generation_atomic,
                            stats,
                        );
                    }
                    return Some("stream stalled".to_string());
                }

                for flushed in active_text_assembler.take_due(Instant::now()) {
                    pending.push(flushed, stats);
                }
                for flushed in active_text_snapshots.take_due(Instant::now()) {
                    pending.push(flushed, stats);
                }
                if !pending.is_empty() {
                    if pending.should_hold_single_delta(
                        Instant::now(),
                        state.lock().active_target.as_ref(),
                    ) {
                        continue;
                    }
                    emit_pending_batch(
                        app,
                        generation,
                        &mut pending,
                        &mut sequence,
                        generation_atomic,
                        stats,
                    );
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                for flushed in active_text_assembler.take_due(Instant::now()) {
                    pending.push(flushed, stats);
                }
                for flushed in active_text_assembler.flush_store_only_all(Instant::now()) {
                    pending.push(flushed, stats);
                }
                for flushed in active_text_snapshots.take_due(Instant::now()) {
                    pending.push(flushed, stats);
                }
                for flushed in active_text_snapshots.flush_all() {
                    pending.push(flushed, stats);
                }
                if !pending.is_empty() {
                    emit_pending_batch(
                        app,
                        generation,
                        &mut pending,
                        &mut sequence,
                        generation_atomic,
                        stats,
                    );
                }
                return Some("reader disconnected".to_string());
            }
        }
    }
}

fn emit_pending_batch(
    app: &AppHandle,
    generation: u64,
    pending: &mut PendingBatch,
    sequence: &mut u64,
    generation_atomic: &Arc<AtomicU64>,
    stats: &mut DesktopEventTransportStats,
) {
    if pending.is_empty() {
        return;
    }

    *sequence += 1;
    emit_batch(
        app,
        generation,
        pending,
        *sequence,
        generation_atomic,
        stats,
    );
}

fn emit_batch(
    app: &AppHandle,
    generation: u64,
    pending: &mut PendingBatch,
    sequence: u64,
    generation_atomic: &Arc<AtomicU64>,
    stats: &mut DesktopEventTransportStats,
) {
    if !generation_matches(generation_atomic, generation) {
        return;
    }

    let events = pending.take_events();
    if events.is_empty() {
        return;
    }

    stats.emitted_batches = stats.emitted_batches.saturating_add(1);
    stats.emitted_events = stats.emitted_events.saturating_add(events.len() as u64);

    let _ = app.emit(
        EVENT_BATCH_NAME,
        WorkspaceEventBatchPayload {
            generation,
            sequence,
            emitted_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            events,
        },
    );
}

fn emit_status(
    app: &AppHandle,
    generation: u64,
    state_name: &'static str,
    reconnect_attempt: u32,
    terminal: bool,
    reason: Option<String>,
    next_delay_ms: Option<u64>,
    status_code: Option<u16>,
    stats: &DesktopEventTransportStats,
) {
    let _ = app.emit(
        EVENT_STATUS_NAME,
        DesktopEventStreamStatusPayload {
            generation,
            state: state_name,
            reconnect_attempt,
            terminal,
            reason,
            next_delay_ms,
            status_code,
            stats: stats.clone(),
        },
    );
}

pub(super) fn generation_matches(generation_atomic: &Arc<AtomicU64>, generation: u64) -> bool {
    generation_atomic.load(Ordering::SeqCst) == generation
}

pub(super) fn compute_reconnect_delay_ms(
    attempt: u32,
    policy: &ResolvedDesktopEventReconnectPolicy,
) -> u64 {
    let exponent = attempt.saturating_sub(1) as i32;
    let scaled = (policy.initial_delay_ms as f64) * policy.multiplier.powi(exponent);
    (scaled.round().max(policy.initial_delay_ms as f64) as u64).min(policy.max_delay_ms)
}
