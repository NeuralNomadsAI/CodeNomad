//! Private stdin/stdout of the owned rendering process. The surface consumes at most one frame.
#![allow(unsafe_code)]
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
    #[cfg(all(windows, feature = "ladybird-preview"))]
    pub texture: rune_theme_codenomad::preview::LoanedTexture,
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
        cfg!(all(windows, feature = "ladybird-preview"))
            && std::env::var("CODENOMAD_PROFILE").as_deref() == Ok("trial-ladybird")
            && std::env::var_os("RUNE_LADYBIRD_BIN").is_some()
            && std::env::var_os("RUNE_HOST_ROOT").is_some_and(|p| std::path::Path::new(&p).is_absolute())
            && std::env::var_os("RUNE_SERVER_BIN").is_some_and(|p| std::path::Path::new(&p).is_absolute())
            && std::env::var_os("RUNE_HOST_PERSISTENT").is_none()
    }

    pub fn start(wake: rune::Waker) -> Option<Self> {
        let path = std::path::PathBuf::from(std::env::var_os("RUNE_LADYBIRD_BIN")?);
        if !Self::available() || !path.is_absolute() {
            return None;
        }
        let output = Arc::new(Mutex::new(Output::default()));
        let offline = Arc::new(AtomicBool::new(false));
        let (send, recv) = mpsc::sync_channel(64);
        #[cfg(all(windows, feature = "ladybird-preview"))]
        let release = send.clone();
        let (state, failed) = (output.clone(), offline.clone());
        let stopped = failed.clone();
        std::thread::spawn(move || {
            let env = std::env::vars_os().filter(|(key, _)| {
                matches!(
                    key.to_string_lossy().to_ascii_uppercase().as_str(),
                    "SYSTEMROOT" | "WINDIR" | "SYSTEMDRIVE" | "LANG" | "TEMP" | "TMP"
                )
            });
            let profile =
                std::path::PathBuf::from(std::env::var_os("RUNE_HOST_ROOT").unwrap_or_default())
                    .join("ladybird");
            let mut cmd = Command::new(&path);
            cmd.arg("--headless=manual")
                .arg("--profile-path")
                .arg(&profile);
            if let Some(dir) = path.parent() {
                cmd.current_dir(dir);
            }
            let child = OwnedProcess::spawn(
                cmd.stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .env_clear()
                    .envs(env)
                    .env("HOME", &profile)
                    .env("USERPROFILE", &profile)
                    .env("LOCALAPPDATA", profile.join("Local"))
                    .env("APPDATA", profile.join("Roaming")),
            );
            if let Ok(mut child) = child
                && let (Some(mut input), Some(stdout)) = (child.take_stdin(), child.take_stdout())
            {
                let started = wake.clone();
                #[cfg(all(windows, feature = "ladybird-preview"))]
                use std::os::windows::io::AsHandle;
                #[cfg(all(windows, feature = "ladybird-preview"))]
                let process = child.as_handle().try_clone_to_owned();
                let reader = std::thread::spawn(move || {
                    #[cfg(all(windows, feature = "ladybird-preview"))]
                    let read = process.and_then(|process| {
                        read_frames(BufReader::new(stdout), &state, &*started, process, release)
                    });
                    #[cfg(not(all(windows, feature = "ladybird-preview")))]
                    let read = read_frames(BufReader::new(stdout), &state, &*started);
                    if let Err(error) = read {
                        eprintln!("Ladybird pipe: {error}");
                    }
                    failed.store(true, Ordering::Release);
                    started();
                });
                // `release` is also held by outstanding GPU loans. Explicit shutdown must not
                // depend on those references disappearing (the device may have been lost).
                loop {
                    match recv.recv_timeout(std::time::Duration::from_millis(100)) {
                        Ok(message) if message.is_null() => break,
                        Ok(message) => {
                            if input
                                .write_fmt(format_args!("{message}\n"))
                                .and_then(|_| input.flush())
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Timeout)
                            if !stopped.load(Ordering::Acquire) => {}
                        Err(_) => break,
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

impl Drop for Guest {
    fn drop(&mut self) {
        self.offline.store(true, Ordering::Release);
        let _ = self.send.try_send(Value::Null);
    }
}

fn read_frames(
    mut input: impl BufRead,
    out: &Mutex<Output>,
    wake: &dyn Fn(),
    #[cfg(all(windows, feature = "ladybird-preview"))] process: std::os::windows::io::OwnedHandle,
    #[cfg(all(windows, feature = "ladybird-preview"))] send: SyncSender<Value>,
) -> std::io::Result<()> {
    let bad = || std::io::Error::other("Invalid Ladybird message");
    loop {
        let mut line = String::new();
        if (&mut input)
            .take(4 * 1024 * 1024 + 1024)
            .read_line(&mut line)?
            == 0
        {
            return Ok(());
        }
        if !line.ends_with('\n') {
            return Err(bad());
        }
        let Some(line) = line.strip_prefix("LADYBIRD:") else {
            continue;
        };
        let header: Value = serde_json::from_str(line).map_err(|_| bad())?;
        if let Some(_id) = header["frame"].as_u64() {
            #[cfg(not(all(windows, feature = "ladybird-preview")))]
            return Err(bad());
            #[cfg(all(windows, feature = "ladybird-preview"))]
            {
                let foreign = header["handle"]
                    .as_u64()
                    .filter(|n| *n != 0)
                    .ok_or_else(bad)?;
                let handle = duplicate(&process, foreign)?;
                let send = send.clone();
                // Producer's Skia queue completed the write before publication. The loan stays
                // immutable until Rune retires it and wgpu completes every draw that sampled it.
                let texture = unsafe {
                    rune_theme_codenomad::preview::LoanedTexture::new(handle, move || {
                        let _ = send.try_send(serde_json::json!({"op":"release","frame":_id}));
                    })
                };
                let mut out = out.lock().map_err(|_| bad())?;
                if out.frame.replace(Frame { header, texture }).is_some() {
                    out.dropped += 1;
                }
            }
        } else if header["id"].is_u64() {
            out.lock().map_err(|_| bad())?.reply = Some(header);
        } else {
            out.lock().map_err(|_| bad())?.state = Some(header);
        }
        wake();
    }
}

#[cfg(all(windows, feature = "ladybird-preview"))]
fn duplicate(
    process: &std::os::windows::io::OwnedHandle,
    foreign: u64,
) -> std::io::Result<std::os::windows::io::OwnedHandle> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle},
        System::Threading::GetCurrentProcess,
    };
    let mut handle = std::ptr::null_mut();
    // Only Rune opens a handle from the owned child. The child receives no handle to Rune.
    if unsafe {
        DuplicateHandle(
            process.as_raw_handle(),
            foreign as usize as _,
            GetCurrentProcess(),
            &mut handle,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

#[cfg(all(windows, feature = "test-support"))]
pub fn elapsed_us(qpc: u64) -> u64 {
    use windows_sys::Win32::System::Performance::{
        QueryPerformanceCounter, QueryPerformanceFrequency,
    };
    static FREQUENCY: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    let frequency = *FREQUENCY.get_or_init(|| {
        let mut rate = 0;
        // QPC writes to the provided LARGE_INTEGER.
        unsafe { QueryPerformanceFrequency(&mut rate) };
        rate.max(1)
    }) as u64;
    let mut now = 0;
    unsafe { QueryPerformanceCounter(&mut now) };
    (now as u64).saturating_sub(qpc).saturating_mul(1_000_000) / frequency
}

#[cfg(all(not(windows), feature = "test-support"))]
pub fn elapsed_us(_: u64) -> u64 {
    0
}
