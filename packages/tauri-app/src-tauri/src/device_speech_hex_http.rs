use crate::device_speech::SpeechError;
use reqwest::{blocking::Client, redirect::Policy, StatusCode};
use serde::Deserialize;
use serde_json::Value;
use std::{
    io::{self, Read},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

const TICK: Duration = Duration::from_millis(25);
const MAX_RESPONSE: u64 = 128 * 1024;

pub(super) struct RejectProxy {
    pub(super) addr: SocketAddr,
    stopped: Arc<AtomicBool>,
}

impl RejectProxy {
    pub(super) fn start() -> Result<Self, SpeechError> {
        let listener =
            TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|_| SpeechError::Failed)?;
        let addr = listener.local_addr().map_err(|_| SpeechError::Failed)?;
        let stopped = Arc::new(AtomicBool::new(false));
        let exit = stopped.clone();
        thread::spawn(move || {
            while !exit.load(Ordering::Acquire) {
                if let Err(error) = listener.accept() {
                    if error.kind() != io::ErrorKind::Interrupted {
                        break;
                    }
                }
            }
        });
        Ok(Self { addr, stopped })
    }
}

impl Drop for RejectProxy {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        let _ = TcpStream::connect_timeout(&self.addr, TICK);
    }
}

#[derive(Clone)]
pub(super) struct Endpoint {
    client: Client,
    url: String,
    token: String,
    transcription: String,
}

impl Endpoint {
    pub(super) fn from_ready(
        line: &[u8],
        child_pid: u32,
        model: String,
    ) -> Result<Self, SpeechError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Ready {
            #[serde(rename = "type")]
            kind: String,
            api_version: String,
            pid: u32,
            url: String,
            token: String,
        }
        let ready: Ready = serde_json::from_slice(line).map_err(|_| SpeechError::Failed)?;
        let port = ready
            .url
            .strip_prefix("http://127.0.0.1:")
            .and_then(|port| port.parse::<u16>().ok())
            .filter(|port| *port != 0)
            .ok_or(SpeechError::Failed)?;
        let url = format!("http://127.0.0.1:{port}");
        if ready.kind != "ready"
            || ready.api_version != "2"
            || ready.pid != child_pid
            || ready.url != url
            || !ready.token.strip_prefix("hex_").is_some_and(|token| {
                token.len() == 64
                    && token
                        .bytes()
                        .all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
            })
        {
            return Err(SpeechError::Failed);
        }
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .build()
            .map_err(|_| SpeechError::Failed)?;
        Ok(Self {
            client,
            transcription: format!("/transcriptions?model={model}&language=auto"),
            url,
            token: ready.token,
        })
    }

    pub(super) fn health(
        &self,
        version: &str,
        interrupted: &impl Fn() -> bool,
        expires: Instant,
    ) -> Result<(), SpeechError> {
        let value = self.request("/health", None, interrupted, expires)?;
        if value["apiVersion"] != "2" || value["version"] != version {
            return Err(SpeechError::Failed);
        }
        Ok(())
    }

    pub(super) fn transcribe(
        &self,
        wav: Vec<u8>,
        interrupted: &impl Fn() -> bool,
        timeout: Duration,
    ) -> Result<String, SpeechError> {
        let value = self.request(
            &self.transcription,
            Some(wav),
            interrupted,
            Instant::now() + timeout,
        )?;
        value["transcript"]
            .as_str()
            .filter(|text| text.len() <= 64 * 1024)
            .map(str::to_owned)
            .ok_or(SpeechError::Failed)
    }

    fn request(
        &self,
        path: &str,
        wav: Option<Vec<u8>>,
        interrupted: &impl Fn() -> bool,
        expires: Instant,
    ) -> Result<Value, SpeechError> {
        let url = format!("{}{path}", self.url);
        let request = match wav {
            Some(wav) => self
                .client
                .post(url)
                .header("content-type", "audio/wav")
                .body(wav),
            None => self.client.get(url),
        }
        .bearer_auth(&self.token)
        .timeout(expires.saturating_duration_since(Instant::now()));
        let (send, receive) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let value = (|| {
                let response = request.send().ok()?;
                if response.status() != StatusCode::OK {
                    return None;
                }
                let mut bytes = Vec::new();
                response
                    .take(MAX_RESPONSE + 1)
                    .read_to_end(&mut bytes)
                    .ok()?;
                if bytes.len() as u64 > MAX_RESPONSE {
                    return None;
                }
                serde_json::from_slice(&bytes).ok()
            })();
            let _ = send.send(value.ok_or(SpeechError::Failed));
        });
        await_reply(receive, interrupted, expires)
    }
}

pub(super) fn await_reply<T>(
    receive: Receiver<Result<T, SpeechError>>,
    interrupted: &impl Fn() -> bool,
    expires: Instant,
) -> Result<T, SpeechError> {
    loop {
        let remaining = expires.saturating_duration_since(Instant::now());
        if remaining.is_zero() || interrupted() {
            return Err(SpeechError::Failed);
        }
        match receive.recv_timeout(TICK.min(remaining)) {
            Ok(result) if !interrupted() => return result,
            Err(RecvTimeoutError::Timeout) => {}
            _ => return Err(SpeechError::Failed),
        }
    }
}
