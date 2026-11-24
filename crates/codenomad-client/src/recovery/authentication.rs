//! Authentication settlement for an expired history read or prompt.
use super::ReadingLane;
use crate::{
    Sender,
    backend::Backend,
    runtime, stream,
    transport::{Event, PromptOutcome, publish},
};
use std::{sync::atomic::Ordering::SeqCst, time::Duration};

async fn close_for_authentication(wire: &stream::State, out: &Sender<Event>) {
    wire.cancelled.store(true, SeqCst);
    while wire.running.load(SeqCst) && !out.is_closed() {
        runtime::sleep(Duration::from_millis(25)).await;
    }
}

pub(super) async fn expire_reading(
    reading: Option<&ReadingLane>,
    wire: &stream::State,
    out: &Sender<Event>,
) {
    ReadingLane::invalidate_connection(reading);
    close_for_authentication(wire, out).await;
}

pub(super) async fn rejected_by_authentication(
    backend: &Backend,
    attempted: &str,
    out: &Sender<Event>,
    wake: &crate::Wake,
    wire: &stream::State,
) -> Option<bool> {
    let authenticated = backend.authentication_status().await;
    if matches!(authenticated, Ok(true)) {
        return None;
    }
    close_for_authentication(wire, out).await;
    // A native proxy mutation is detached before revocation, so a 401 response cannot prove it was not transmitted.
    publish(
        out,
        wake,
        Event::PromptAcknowledged {
            attempted: attempted.into(),
            outcome: PromptOutcome::Unconfirmed,
        },
    )
    .await;
    Some(matches!(authenticated, Ok(false)))
}
