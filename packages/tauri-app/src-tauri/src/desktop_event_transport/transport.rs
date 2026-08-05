use super::*;

fn send_connection_pong(
    app: &AppHandle,
    client: &Client,
    config: &DesktopEventStreamConfig,
    payload: &Value,
    generation_atomic: &Arc<AtomicU64>,
    generation: u64,
    operation_fence: &Arc<Mutex<()>>,
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

    let _ = with_current_transport(operation_fence, generation_atomic, generation, || {
        attach_session_cookie(request, app, config)
            .timeout(Duration::from_millis(STREAM_CONNECT_TIMEOUT_MS))
            .send()
    });
}

pub(super) fn run_transport_loop(
    app: AppHandle,
    generation_atomic: Arc<AtomicU64>,
    generation: u64,
    stop: Arc<AtomicBool>,
    operation_fence: Arc<Mutex<()>>,
    config: DesktopEventTransportConfig,
    last_event_id: Arc<Mutex<Option<String>>>,
) {
    let mut reconnect_attempt = 0_u32;
    let mut stats = DesktopEventTransportStats::default();
    let client = match build_stream_client() {
        Ok(client) => client,
        Err(error) => {
            stop.store(true, Ordering::SeqCst);
            emit_status(
                &app,
                &generation_atomic,
                generation,
                &operation_fence,
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
            &generation_atomic,
            generation,
            &operation_fence,
            "connecting",
            reconnect_attempt,
            false,
            None,
            None,
            None,
            &stats,
        );

        let replay_cursor = last_event_id.lock().clone();
        let Some(opened) =
            with_current_transport(&operation_fence, &generation_atomic, generation, || {
                open_stream(&app, &client, &config.stream, replay_cursor.as_deref())
            })
        else {
            break;
        };
        match opened {
            Ok(response) => {
                reconnect_attempt = 0;
                emit_status(
                    &app,
                    &generation_atomic,
                    generation,
                    &operation_fence,
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
                    &operation_fence,
                    &last_event_id,
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
                    &operation_fence,
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
                    &operation_fence,
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

    stop.store(true, Ordering::SeqCst);
    emit_status(
        &app,
        &generation_atomic,
        generation,
        &operation_fence,
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
    operation_fence: &Arc<Mutex<()>>,
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
        generation_atomic,
        generation,
        operation_fence,
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
    operation_fence: &Arc<Mutex<()>>,
    last_event_id: &Arc<Mutex<Option<String>>>,
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
            Ok(ReaderMessage::Cursor(id)) => {
                if !generation_matches(generation_atomic, generation) {
                    return Some("stopped".to_string());
                }
                last_reader_activity = Instant::now();
                pending.set_last_event_id(id);
                sequence += 1;
                emit_batch(
                    app,
                    generation,
                    &mut pending,
                    sequence,
                    generation_atomic,
                    operation_fence,
                    last_event_id,
                    stats,
                );
            }
            Ok(ReaderMessage::Ping(payload)) => {
                last_reader_activity = Instant::now();
                send_connection_pong(
                    app,
                    client,
                    stream_config,
                    &payload,
                    generation_atomic,
                    generation,
                    operation_fence,
                );
            }
            Ok(ReaderMessage::Event { event, id }) => {
                last_reader_activity = Instant::now();
                stats.raw_events = stats.raw_events.saturating_add(1);

                pending.push_sequenced(event, id, stats);
                if pending.pending_len() >= MAX_BATCH_EVENTS
                    || pending.single_delta_window_elapsed(Instant::now())
                {
                    emit_pending_batch(
                        app,
                        generation,
                        &mut pending,
                        &mut sequence,
                        generation_atomic,
                        operation_fence,
                        last_event_id,
                        stats,
                    );
                }
            }
            Ok(ReaderMessage::ReplayReset { details, id }) => {
                last_reader_activity = Instant::now();
                if !pending.is_empty() {
                    emit_pending_batch(
                        app,
                        generation,
                        &mut pending,
                        &mut sequence,
                        generation_atomic,
                        operation_fence,
                        last_event_id,
                        stats,
                    );
                }
                let _ =
                    with_current_transport(operation_fence, generation_atomic, generation, || {
                        app.emit(
                            EVENT_REPLAY_RESET_NAME,
                            WorkspaceEventReplayResetPayload {
                                generation,
                                details,
                                last_event_id: id,
                            },
                        )
                    });
            }
            Ok(ReaderMessage::End(reason)) => {
                if !pending.is_empty() {
                    emit_pending_batch(
                        app,
                        generation,
                        &mut pending,
                        &mut sequence,
                        generation_atomic,
                        operation_fence,
                        last_event_id,
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
                            operation_fence,
                            last_event_id,
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
                        operation_fence,
                        last_event_id,
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
                        operation_fence,
                        last_event_id,
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
    operation_fence: &Arc<Mutex<()>>,
    last_event_id: &Arc<Mutex<Option<String>>>,
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
        operation_fence,
        last_event_id,
        stats,
    );
}

fn emit_batch(
    app: &AppHandle,
    generation: u64,
    pending: &mut PendingBatch,
    sequence: u64,
    generation_atomic: &Arc<AtomicU64>,
    operation_fence: &Arc<Mutex<()>>,
    _last_event_id: &Arc<Mutex<Option<String>>>,
    stats: &mut DesktopEventTransportStats,
) {
    let _ = with_current_transport(operation_fence, generation_atomic, generation, || {
        let events = pending.take_events();
        let event_id = pending.take_last_event_id();
        if events.is_empty() && event_id.is_none() {
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
                last_event_id: event_id,
            },
        );
    });
}

fn emit_status(
    app: &AppHandle,
    generation_atomic: &Arc<AtomicU64>,
    generation: u64,
    operation_fence: &Arc<Mutex<()>>,
    state_name: &'static str,
    reconnect_attempt: u32,
    terminal: bool,
    reason: Option<String>,
    next_delay_ms: Option<u64>,
    status_code: Option<u16>,
    stats: &DesktopEventTransportStats,
) {
    let _ = with_current_transport(operation_fence, generation_atomic, generation, || {
        app.emit(
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
        )
    });
}

pub(super) fn with_current_transport<T>(
    operation_fence: &Arc<Mutex<()>>,
    generation_atomic: &Arc<AtomicU64>,
    generation: u64,
    operation: impl FnOnce() -> T,
) -> Option<T> {
    let _operation = operation_fence.lock();
    generation_matches(generation_atomic, generation).then(operation)
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
