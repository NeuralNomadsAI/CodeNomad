//! Native HTTP byte stream and frame dispatch.
use super::{
    Backend, Input, Result, Sender, State, dispatch,
    frames::{Parsed, Parser},
    limits::reread,
    opened,
};
use std::time::Duration;

pub(super) async fn read_native(
    b: &Backend,
    epoch: u64,
    out: &Sender<Input>,
    state: &State,
) -> Result<()> {
    use futures_lite::StreamExt;
    let connection = format!("stream-{epoch}");
    let response = b
        .client
        .get(format!("{}api/events", b.base))
        .query(&[
            ("clientId", b.client_id.as_str()),
            ("connectionId", connection.as_str()),
            ("userFiles", crate::attachments::USER_FILES_REFERENCE),
        ])
        .timeout(Duration::from_secs(86400))
        .send()
        .await?
        .error_for_status()?;
    if !response
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.starts_with("text/event-stream"))
    {
        return Err("expected event stream".into());
    }
    b.client.children().invalidate(b, None);
    let quota = state.quota_ingress(b);
    if let Some(quota) = &quota {
        quota.transport(true);
    }
    opened(epoch, out, state).await?;
    let mut chunks = response.bytes_stream();
    let mut parser = Parser::default();
    let mut frames = Vec::new();
    while let Some(chunk) = chunks.next().await {
        collect(&mut parser, &chunk?, quota.as_ref(), &mut frames)?;
        for frame in frames.drain(..) {
            match frame {
                Parsed::Data(kind, data) => {
                    dispatch(b, epoch, out, state, &connection, &kind, &data).await?;
                }
                Parsed::Skipped => {
                    b.client.children().invalidate(b, None);
                    reread(epoch, out, state).await?;
                }
            }
        }
    }
    Err("event stream ended".into())
}

pub(super) fn collect(
    parser: &mut Parser,
    chunk: &[u8],
    quota: Option<&crate::provider_usage::Ingress>,
    frames: &mut Vec<Parsed>,
) -> Result<()> {
    // Qualify every event already received in this chunk before recovery can stall dispatch.
    for byte in chunk {
        if let Some(frame) = parser.byte(*byte)? {
            if let Some(quota) = quota {
                match &frame {
                    Parsed::Data(kind, data) if kind.is_empty() || kind == "message" => {
                        quota.frame(data)
                    }
                    Parsed::Skipped => quota.skipped(),
                    _ => {}
                }
            }
            frames.push(frame);
        }
    }
    Ok(())
}
