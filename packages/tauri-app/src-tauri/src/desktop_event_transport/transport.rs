use super::*;

fn send_connection_pong(
    app: &AppHandle,
    client: &Client,
    config: &DesktopEventStreamConfig,
    payload: &Value,
) {
    let body = serde_json::json!({
        "clientId": config.client_id,
        "connectionId": config.connection_id,
        "pingTs": payload.get("ts").and_then(Value::as_u64),
    });

    let request = client
        .post(format!(
            "{}/api/client-connections/pong",
            config.base_url.trim_end_matches('/')
        ))
        .json(&body);

    let _ = attach_session_cookie(request, app, config).send();
}

pub(super) fn run_transport_loop(
    app: AppHandle,
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
                    &client,
                    &config.stream,
                    response,
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
    client: &Client,
    stream_config: &DesktopEventStreamConfig,
    response: Response,
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
    let mut sequence = 0_u64;
    let mut last_reader_activity = Instant::now();

    loop {
        if stop.load(Ordering::SeqCst) || !generation_matches(generation_atomic, generation) {
            return Some("stopped".to_string());
        }

        match rx.recv_timeout(Duration::from_millis(FLUSH_INTERVAL_MS)) {
            Ok(ReaderMessage::Activity) => {
                last_reader_activity = Instant::now();
            }
            Ok(ReaderMessage::Ping(payload)) => {
                last_reader_activity = Instant::now();
                send_connection_pong(app, client, stream_config, &payload);
            }
            Ok(ReaderMessage::Event(event)) => {
                last_reader_activity = Instant::now();
                stats.raw_events = stats.raw_events.saturating_add(1);

                pending.push(event, stats);
                if pending.pending_len() >= MAX_BATCH_EVENTS {
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

                if !pending.is_empty() {
                    if pending.should_hold_single_delta(Instant::now()) {
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
