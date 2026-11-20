//! Requests to the desktop host (`CODENOMAD_NATIVE_PARENT=1`): one `CODENOMAD_NATIVE_REQUEST:` JSON
//! line on stdout each, answered by a `CODENOMAD_NATIVE_RESPONSE:` line on stdin (`native-parent.ts`).
use std::{collections::BTreeMap, io::Write, sync::Mutex, time::Duration};

use serde_json::{Value, json};
use tokio::sync::oneshot;

const REQUEST_PREFIX: &str = "CODENOMAD_NATIVE_REQUEST:";
const RESPONSE_PREFIX: &str = "CODENOMAD_NATIVE_RESPONSE:";
const MAX_PENDING: usize = 32;
/// The reference's default deadline.
#[allow(dead_code)]
pub const DEFAULT_DEADLINE: Duration = Duration::from_secs(90);

type Reply = oneshot::Sender<Result<Value, String>>;
/// `None` once closed for shutdown.
static PENDING: Mutex<Option<BTreeMap<String, Reply>>> = Mutex::new(Some(BTreeMap::new()));

pub fn available() -> bool {
    crate::config::native_parent()
}

#[allow(dead_code)] // First callers: the OpenCode service start and browser automation.
pub async fn request(method: &str, params: Value, deadline: Duration) -> Result<Value, String> {
    if !available() {
        return Err("Native control is unavailable in this host".into());
    }
    exchange(method, params, deadline).await
}

async fn exchange(method: &str, params: Value, deadline: Duration) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    {
        let mut pending = PENDING.lock().unwrap();
        let pending = pending.as_mut().ok_or("Native parent is shutting down")?;
        if pending.len() >= MAX_PENDING {
            return Err("Too many pending native requests".into());
        }
        pending.insert(id.clone(), tx);
    }
    let at = chrono::Utc::now().timestamp_millis() + deadline.as_millis() as i64;
    emit(format!(
        "{REQUEST_PREFIX}{}\n",
        json!({"v": 1, "id": id, "method": method, "params": params, "deadline": at})
    ));
    match tokio::time::timeout(deadline, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("Native parent is shutting down".into()),
        Err(_) => {
            PENDING.lock().unwrap().as_mut().map(|p| p.remove(&id));
            Err(format!("Native request timed out: {method}"))
        }
    }
}

fn emit(line: String) {
    #[cfg(test)]
    if let Some(sink) = tests::SINK.lock().unwrap().as_ref() {
        let _ = sink.send(line);
        return;
    }
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(line.as_bytes()).and_then(|_| out.flush());
}

/// A stdin line: true when it was a native response (answered, stale or malformed).
pub fn handle_line(line: &str) -> bool {
    let Some(body) = line.trim().strip_prefix(RESPONSE_PREFIX) else { return false };
    let Ok(response) = serde_json::from_str::<Value>(body) else { return true };
    let Some(id) = response["id"].as_str().filter(|_| response["v"] == 1) else { return true };
    let Some(reply) = PENDING.lock().unwrap().as_mut().and_then(|p| p.remove(id)) else { return true };
    let text = |key: &str| response["error"][key].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    let _ = reply.send(if response["ok"] == true {
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(text("message").or_else(|| text("code")).unwrap_or_else(|| "Native request failed".into()))
    });
    true
}

/// Fails every pending and later request, once workspaces have stopped.
pub fn close() {
    PENDING.lock().unwrap().take();
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use tokio::sync::mpsc;

    pub static SINK: Mutex<Option<mpsc::UnboundedSender<String>>> = Mutex::new(None);

    /// One test owns the process-wide pending table: the fake parent reads stdout lines and answers.
    #[tokio::test]
    async fn fake_parent_round_trips() {
        let (tx, mut lines) = mpsc::unbounded_channel();
        *SINK.lock().unwrap() = Some(tx);
        let mut next = async || -> Value {
            let line = tokio::time::timeout(Duration::from_secs(5), lines.recv()).await.unwrap().unwrap();
            assert!(line.ends_with('\n') && !line[..line.len() - 1].contains('\n'));
            serde_json::from_str(line.strip_prefix(REQUEST_PREFIX).unwrap()).unwrap()
        };

        let call = tokio::spawn(exchange("browser.probe", json!({"sessionID": "s"}), Duration::from_secs(5)));
        let sent = next().await;
        assert_eq!(
            (sent["v"].clone(), sent["method"].clone(), sent["params"].clone()),
            (json!(1), json!("browser.probe"), json!({"sessionID": "s"}))
        );
        let skew = sent["deadline"].as_i64().unwrap() - chrono::Utc::now().timestamp_millis();
        assert!((3000..=5000).contains(&skew));
        let id = sent["id"].as_str().unwrap();
        assert!(!handle_line("codenomad:other"));
        assert!(handle_line(&format!("{RESPONSE_PREFIX}not json")));
        assert!(handle_line(&format!("{RESPONSE_PREFIX}{}", json!({"v": 2, "id": id, "ok": true}))));
        assert!(handle_line(&format!(
            "  {RESPONSE_PREFIX}{}\r",
            json!({"v": 1, "id": id, "ok": true, "result": {"available": true}})
        )));
        assert_eq!(call.await.unwrap(), Ok(json!({"available": true})));

        for (error, expected) in [
            (json!({"code": "native_error", "message": "boom"}), "boom"),
            (json!({"code": "native_error", "message": ""}), "native_error"),
            (json!({}), "Native request failed"),
        ] {
            let call = tokio::spawn(exchange("developer.status", json!({}), Duration::from_secs(5)));
            let id = next().await["id"].as_str().unwrap().to_owned();
            handle_line(&format!("{RESPONSE_PREFIX}{}", json!({"v": 1, "id": id, "ok": false, "error": error})));
            assert_eq!(call.await.unwrap(), Err(expected.into()));
        }

        let late = exchange("developer.restart", json!({}), Duration::from_millis(50)).await;
        assert_eq!(late, Err("Native request timed out: developer.restart".into()));
        assert!(PENDING.lock().unwrap().as_ref().unwrap().is_empty());

        let calls: Vec<_> = (0..MAX_PENDING)
            .map(|_| tokio::spawn(exchange("browser.execute", json!({}), Duration::from_secs(5))))
            .collect();
        for _ in 0..MAX_PENDING {
            next().await;
        }
        let refused = exchange("browser.execute", json!({}), Duration::from_secs(5)).await;
        assert_eq!(refused, Err("Too many pending native requests".into()));
        close();
        for call in calls {
            assert_eq!(call.await.unwrap(), Err("Native parent is shutting down".into()));
        }
        assert_eq!(
            exchange("x", json!({}), Duration::from_secs(1)).await,
            Err("Native parent is shutting down".into())
        );
        *SINK.lock().unwrap() = None;
    }
}
