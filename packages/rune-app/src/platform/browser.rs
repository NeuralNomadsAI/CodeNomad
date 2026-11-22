//! Adapter from the owned server's native parent pipe to Rune's UI thread.
use serde_json::{Value, json};
use std::sync::{
    Mutex,
    mpsc::{self, Receiver, SyncSender},
};

pub struct Request {
    pub value: Value,
    answer: Box<dyn FnOnce(String) + Send>,
}

impl Request {
    pub fn finish(self, result: Result<Value, String>) {
        let id = &self.value["id"];
        let value = match result {
            Ok(v) => json!({"v":1,"id":id,"ok":true,"result":v}),
            Err(e) => json!({"v":1,"id":id,"ok":false,"error":{"message":e}}),
        };
        (self.answer)(format!("CODENOMAD_NATIVE_RESPONSE:{value}\n"));
    }
}

static INBOX: Mutex<Option<(SyncSender<Request>, rune::Waker)>> = Mutex::new(None);

pub fn listen(wake: rune::Waker) -> Receiver<Request> {
    let (send, recv) = mpsc::sync_channel(16);
    if let Ok(mut inbox) = INBOX.lock() {
        *inbox = Some((send, wake));
    }
    recv
}

pub fn dispatch(
    value: Value,
    fallback: String,
    answer: impl FnOnce(String) + Send + 'static,
) -> Option<String> {
    if !matches!(
        value["method"].as_str(),
        Some("browser.probe" | "browser.execute")
    ) {
        return Some(fallback);
    }
    if let Ok(inbox) = INBOX.lock()
        && let Some((send, wake)) = &*inbox
        && send
            .try_send(Request {
                value,
                answer: Box::new(answer),
            })
            .is_ok()
    {
        wake();
        return None;
    }
    Some(fallback)
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(u64::MAX, |d| d.as_millis() as u64)
}
