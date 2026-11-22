//! Private stdin/stdout of the owned rendering process. The surface consumes at most one frame.
use codenomad_host_process::OwnedProcess;
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
    },
};

pub struct Frame {
    pub header: Value,
    pub bytes: Vec<u8>,
}
#[derive(Default)]
pub struct Output {
    pub frame: Option<Frame>,
    pub dropped: u64,
    pub state: Option<Value>,
    pub reply: Option<Value>,
}
pub struct Guest {
    pub output: Arc<Mutex<Output>>,
    pub offline: Arc<AtomicBool>,
    send: SyncSender<Value>,
}

impl Guest {
    pub fn available() -> bool {
        std::env::var_os("RUNE_SERVO_BIN").is_some()
    }

    pub fn start(wake: rune::Waker) -> Option<Self> {
        let path = std::path::PathBuf::from(std::env::var_os("RUNE_SERVO_BIN")?);
        if !path.is_absolute() {
            return None;
        }
        let output = Arc::new(Mutex::new(Output::default()));
        let offline = Arc::new(AtomicBool::new(false));
        let (send, recv) = mpsc::sync_channel(64);
        let (state, failed) = (output.clone(), offline.clone());
        let stopped = failed.clone();
        std::thread::spawn(move || {
            let env = std::env::vars_os().filter(|(key, _)| {
                matches!(
                    key.to_string_lossy().to_ascii_uppercase().as_str(),
                    "SYSTEMROOT"
                        | "WINDIR"
                        | "SYSTEMDRIVE"
                        | "LANG"
                        | "TEMP"
                        | "TMP"
                        | "RUNE_SERVO_TEST_FILE"
                        | "RUNE_SERVO_CONSOLE"
                )
            });
            let child = OwnedProcess::spawn(
                Command::new(path)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .env_clear()
                    .envs(env),
            );
            if let Ok(mut child) = child
                && let (Some(mut input), Some(stdout)) = (child.take_stdin(), child.take_stdout())
            {
                let started = wake.clone();
                let reader = std::thread::spawn(move || {
                    let _ = read_frames(BufReader::new(stdout), &state, &*started);
                    failed.store(true, Ordering::Release);
                    started();
                });
                while let Ok(message) = recv.recv() {
                    if input
                        .write_fmt(format_args!("{message}\n"))
                        .and_then(|_| input.flush())
                        .is_err()
                    {
                        break;
                    }
                }
                drop(child);
                let _ = reader.join();
            }
            stopped.store(true, Ordering::Release);
            wake();
        });
        Some(Self {
            output,
            offline,
            send,
        })
    }

    pub fn send(&self, message: Value) -> bool {
        self.send.try_send(message).is_ok()
    }
}

fn read_frames(
    mut input: impl BufRead,
    out: &Mutex<Output>,
    wake: &dyn Fn(),
) -> std::io::Result<()> {
    let bad = || std::io::Error::other("Invalid Servo message");
    loop {
        let mut line = String::new();
        if (&mut input).take(1024 * 1024).read_line(&mut line)? == 0 {
            return Ok(());
        }
        if !line.ends_with('\n') {
            return Err(bad());
        }
        let Some(line) = line.strip_prefix("SERVO:") else {
            continue;
        };
        let header: Value = serde_json::from_str(line).map_err(|_| bad())?;
        if header["frame"].is_u64() {
            let size = |key| header[key].as_u64().filter(|n| (1..=2560).contains(n));
            let len = 4 * size("w").ok_or_else(bad)? * size("h").ok_or_else(bad)?;
            let mut bytes = vec![0; len as usize];
            input.read_exact(&mut bytes)?;
            let mut out = out.lock().map_err(|_| bad())?;
            if out.frame.replace(Frame { header, bytes }).is_some() {
                out.dropped += 1;
            }
        } else if header["id"].is_u64() {
            out.lock().map_err(|_| bad())?.reply = Some(header);
        } else {
            out.lock().map_err(|_| bad())?.state = Some(header);
        }
        wake();
    }
}
