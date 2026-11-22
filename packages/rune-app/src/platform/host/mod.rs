//! Owned desktop server lifetime. Call blocking methods from a worker thread.
mod config;
mod persistent;
mod protocol;
use codenomad_client::backend::Backend;
use codenomad_host_process::OwnedProcess;
pub use config::LaunchConfig;
pub(crate) use config::profile_name;
use std::{
    io::{self, BufReader, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Default)]
pub struct Controller {
    generation: Arc<AtomicU64>,
}
#[derive(Default)]
struct Output {
    token: Option<String>,
    url: Option<String>,
    cleanup: Option<bool>,
    failed: bool,
}
enum Control {
    Native {
        response: String,
        expires: Instant,
        deadline: u64,
    },
}
pub struct ChildHost {
    process: OwnedProcess,
    authority: Arc<AtomicU64>,
    generation: u64,
    output: Arc<Mutex<Output>>,
    shutdown: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
    url: String,
    stopped: bool,
    lease: Option<persistent::Lease>,
}
#[derive(Debug)]
pub struct StopReport {
    pub forced: bool,
    pub native_cleanup_confirmed: bool,
    pub exit_code: Option<i32>,
}
impl Controller {
    pub fn launch(&self, config: LaunchConfig) -> io::Result<ChildHost> {
        let lease = persistent::acquire(&config)?;
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        ChildHost::start(config, self.generation.clone(), generation, lease)
    }
}
impl ChildHost {
    fn start(
        config: LaunchConfig,
        authority: Arc<AtomicU64>,
        generation: u64,
        lease: Option<persistent::Lease>,
    ) -> io::Result<Self> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos();
        let cookie = format!("codenomad_session_{}_{nonce}", std::process::id());
        let mut process = OwnedProcess::spawn(&mut config.command(&cookie)?)?;
        let mut stdin = process
            .take_stdin()
            .ok_or_else(|| io::Error::other("Backend stdin unavailable"))?;
        let stdout = process
            .take_stdout()
            .ok_or_else(|| io::Error::other("Backend stdout unavailable"))?;
        let stderr = process
            .take_stderr()
            .ok_or_else(|| io::Error::other("Backend stderr unavailable"))?;
        let output = Arc::new(Mutex::new(Output::default()));
        let (writer, receiver) = mpsc::sync_channel::<Control>(32);
        let shutdown = Arc::new(AtomicBool::new(false));
        let writer_shutdown = shutdown.clone();
        let writer_authority = authority.clone();
        let writer_thread = thread::spawn(move || {
            loop {
                if writer_shutdown.load(Ordering::SeqCst) {
                    let _ = stdin
                        .write_all(protocol::SHUTDOWN)
                        .and_then(|_| stdin.flush());
                    break;
                }
                let control = match receiver.recv_timeout(Duration::from_millis(20)) {
                    Ok(control) => control,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(_) => break,
                };
                match control {
                    Control::Native {
                        response,
                        expires,
                        deadline,
                    } => {
                        if writer_authority.load(Ordering::SeqCst) == generation {
                            let response = protocol::fenced_response(response, expires, deadline);
                            if stdin
                                .write_all(response.as_bytes())
                                .and_then(|_| stdin.flush())
                                .is_err()
                            {
                                break;
                            }
                        }
                    }
                }
            }
        });
        let reader_output = output.clone();
        let reader_authority = authority.clone();
        let replies = writer.clone();
        let stdout_thread = thread::spawn(move || {
            let result = protocol::pump(BufReader::new(stdout), |line| {
                if reader_authority.load(Ordering::SeqCst) != generation {
                    return;
                }
                let Some(line) = line else {
                    return;
                };
                match protocol::classify(line) {
                    protocol::Line::Token(token) => {
                        if !token.is_empty() {
                            reader_output.lock().unwrap().token = Some(token);
                        }
                    }
                    protocol::Line::Ready(url) => reader_output.lock().unwrap().url = Some(url),
                    protocol::Line::Shutdown(complete) => {
                        reader_output.lock().unwrap().cleanup = Some(complete)
                    }
                    protocol::Line::Native {
                        response,
                        expires,
                        deadline,
                    } => {
                        let _ = replies.try_send(Control::Native {
                            response,
                            expires,
                            deadline,
                        });
                    }
                    protocol::Line::Diagnostic => {}
                }
            });
            if result.is_err() {
                reader_output.lock().unwrap().failed = true;
            }
        });
        // Drain diagnostics without retaining secrets or unbounded output.
        let stderr_output = output.clone();
        let stderr_thread = thread::spawn(move || {
            if protocol::pump(BufReader::new(stderr), |_| {}).is_err() {
                stderr_output.lock().unwrap().failed = true;
            }
        });
        let mut host = Self {
            process,
            authority,
            generation,
            output,
            shutdown,
            threads: vec![writer_thread, stdout_thread, stderr_thread],
            url: String::new(),
            stopped: false,
            lease,
        };
        let deadline = Instant::now() + config.startup_timeout;
        loop {
            if !host.current() {
                return Err(io::Error::other("Backend launch superseded"));
            }
            {
                let output = host.output.lock().unwrap();
                if let (Some(url), Some(_)) = (&output.url, &output.token) {
                    host.url = url.clone();
                    break;
                }
                if output.failed {
                    return Err(io::Error::other("Backend output failed"));
                }
            }
            if host.process.try_wait()?.is_some() {
                return Err(io::Error::other("Backend exited before readiness"));
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Backend startup timed out",
                ));
            }
            thread::sleep(Duration::from_millis(10));
        }
        Ok(host)
    }
    fn current(&self) -> bool {
        self.authority.load(Ordering::SeqCst) == self.generation
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn url(&self) -> &str {
        &self.url
    }
    pub fn connect(&mut self) -> io::Result<Backend> {
        if !self.current() || self.process.try_wait()?.is_some() {
            return Err(io::Error::other("Backend generation unavailable"));
        }
        let token = self
            .output
            .lock()
            .unwrap()
            .token
            .take()
            .ok_or_else(|| io::Error::other("Bootstrap token already consumed"))?;
        // Errors deliberately exclude the authentication request or token.
        let backend =
            crate::platform::block_on(Backend::connect_with_bootstrap(&self.url, "", Some(&token)))
                .map_err(|_| io::Error::other("Backend bootstrap authentication failed"))?;
        if !self.current() || self.process.try_wait()?.is_some() {
            return Err(io::Error::other(
                "Backend generation changed during authentication",
            ));
        }
        Ok(backend)
    }
    pub fn stop(&mut self) -> io::Result<StopReport> {
        if self.stopped {
            return Ok(StopReport {
                forced: false,
                native_cleanup_confirmed: self.output.lock().unwrap().cleanup == Some(true),
                exit_code: self.process.try_wait()?.and_then(|s| s.code()),
            });
        }
        // Keep this generation active during graceful drain so its final cleanup
        // receipt is consumed; an already replaced generation remains fenced.
        self.shutdown.store(true, Ordering::SeqCst);
        let grace = if cfg!(windows) {
            Duration::from_secs(2)
        } else {
            Duration::from_secs(30)
        };
        let mut deadline = Instant::now() + grace;
        let mut forced = false;
        let status = loop {
            let status = self.process.try_wait()?;
            if status.is_some() && self.process.family_is_empty()? {
                break status;
            }
            if Instant::now() >= deadline {
                if forced {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "Owned backend containment did not empty",
                    ));
                }
                self.process.terminate()?;
                forced = true;
                deadline = Instant::now() + Duration::from_secs(2);
            }
            thread::sleep(Duration::from_millis(10));
        };
        let drain_deadline = Instant::now() + Duration::from_secs(2);
        while self.threads.iter().any(|thread| !thread.is_finished()) {
            if Instant::now() >= drain_deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Owned backend readers did not drain",
                ));
            }
            thread::sleep(Duration::from_millis(10));
        }
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
        let _ = self.authority.compare_exchange(
            self.generation,
            self.generation + 1,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
        self.stopped = true;
        self.lease.take();
        Ok(StopReport {
            forced,
            native_cleanup_confirmed: self.output.lock().unwrap().cleanup == Some(true),
            exit_code: status.and_then(|s| s.code()),
        })
    }
}
impl Drop for ChildHost {
    fn drop(&mut self) {
        if !self.stopped {
            let _ = self.stop();
        }
    }
}
#[cfg(test)]
mod tests;
