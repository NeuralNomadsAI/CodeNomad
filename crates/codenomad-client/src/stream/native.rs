//! Native HTTP byte stream and frame dispatch.
use super::{
    Backend, Input, Result, Sender, State, dispatch,
    frames::{Parsed, Parser},
    limits::reread,
    opened,
};
use async_channel::TrySendError;
use std::time::Duration;

pub(super) async fn read_native(
    b: &Backend,
    epoch: u64,
    out: &Sender<Input>,
    state: &State,
) -> Result<()> {
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
    read_frames(b, epoch, out, state, &connection, response.bytes_stream()).await
}

pub(super) async fn read_frames<B: AsRef<[u8]>>(
    b: &Backend,
    epoch: u64,
    out: &Sender<Input>,
    state: &State,
    connection: &str,
    chunks: impl futures_lite::Stream<Item = std::result::Result<B, reqwest::Error>>,
) -> Result<()> {
    use futures_lite::StreamExt;
    let quota = state.quota_ingress(b);
    if let Some(quota) = &quota {
        quota.transport(true);
    }
    // One bounded frame of read-ahead keeps SSE authority ahead of transcript dispatch.
    let (send, receive) = crate::bounded(1);
    let read = async move {
        let result: Result<()> = async {
            let mut chunks = std::pin::pin!(chunks);
            let mut parser = Parser::default();
            while let Some(chunk) = chunks.next().await {
                receive_chunk(&mut parser, chunk?.as_ref(), quota.as_ref(), &send).await?;
            }
            Err("event stream ended".into())
        }
        .await;
        if let Some(quota) = &quota {
            quota.transport(false);
        }
        Ok::<_, crate::history::Error>(result)
    };
    let route = async move {
        opened(epoch, out, state).await?;
        while let Ok(frame) = receive.recv().await {
            match frame {
                Parsed::Data(kind, data) => {
                    dispatch(b, epoch, out, state, connection, &kind, &data).await?;
                }
                Parsed::Skipped => {
                    b.client.children().invalidate(b, None);
                    reread(epoch, out, state).await?;
                }
            }
        }
        Ok(())
    };
    let (read, ()) = futures_lite::future::try_zip(read, route).await?;
    read
}

async fn receive_chunk(
    parser: &mut Parser,
    chunk: &[u8],
    quota: Option<&crate::provider_usage::Ingress>,
    frames: &Sender<Parsed>,
) -> Result<()> {
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
            match frames.try_send(frame) {
                Ok(()) => {}
                Err(TrySendError::Full(frame)) => {
                    if let Some(quota) = quota {
                        quota.backpressure(true);
                    }
                    let sent = frames.send(frame).await;
                    if let Some(quota) = quota {
                        quota.backpressure(false);
                    }
                    sent?;
                }
                Err(TrySendError::Closed(_)) => return Err("event reader closed".into()),
            }
        }
    }
    Ok(())
}
