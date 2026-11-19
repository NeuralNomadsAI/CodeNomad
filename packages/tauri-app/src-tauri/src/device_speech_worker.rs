use crate::device_speech::{Control, Operation, SpeechError};
use serde::Deserialize;
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, Command, Stdio},
    sync::mpsc::{sync_channel, RecvTimeoutError},
    time::{Duration, Instant},
};

const MAX_FRAME: u64 = 512 * 1024; // JSON escaping of up to 64 KiB of text.
const TICK: Duration = Duration::from_millis(25);

pub(crate) fn run_worker(
    mut command: Command,
    input: Option<&[u8]>,
    control: Option<&Control>,
    timeout: Duration,
    mut send_finish: bool,
) -> Result<Value, SpeechError> {
    if control.is_some_and(Control::cancelled) {
        return Err(SpeechError::Failed);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x08000000);
    let mut process = Worker::start(command)?;
    let stdout = process.child.stdout.take().ok_or(SpeechError::Failed)?;
    let mut stdin = process.child.stdin.take();
    let (send, receive) = sync_channel(8);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = Vec::new();
            match (&mut reader)
                .take(MAX_FRAME + 1)
                .read_until(b'\n', &mut line)
            {
                Ok(0) => break,
                Ok(n) if n as u64 <= MAX_FRAME && line.last() == Some(&b'\n') => {
                    if send
                        .send(serde_json::from_slice::<Reply>(&line).ok())
                        .is_err()
                    {
                        break;
                    }
                }
                _ => {
                    let _ = send.send(None);
                    break;
                }
            }
        }
    });
    if let Some(input) = input {
        // A closed owner can terminate the worker even while the audio pipe is backpressured.
        let mut pipe = stdin.take().ok_or(SpeechError::Failed)?;
        let data = input.to_vec();
        let (send, receive) = sync_channel(1);
        std::thread::spawn(move || {
            if pipe.write_all(&data).is_ok() {
                let _ = send.send(pipe);
            }
        });
        let start = Instant::now();
        loop {
            match receive.recv_timeout(TICK) {
                Ok(pipe) => {
                    stdin = Some(pipe);
                    break;
                }
                Err(RecvTimeoutError::Timeout)
                    if start.elapsed() < Duration::from_secs(4)
                        && !control.is_some_and(Control::cancelled) => {}
                _ => return Err(SpeechError::Failed),
            }
        }
    }
    let start = Instant::now();
    let mut stopped = None::<Instant>;
    let mut result = None;
    loop {
        if start.elapsed() >= timeout || control.is_some_and(Control::cancelled) {
            if stopped.get_or_insert_with(Instant::now).elapsed() >= Duration::from_millis(750) {
                return Err(SpeechError::Failed);
            }
            drop(stdin.take());
        } else if send_finish && control.is_some_and(Control::finish_requested) {
            send_finish = false;
            // One small command on an otherwise empty pipe. EOF still revokes the operation.
            if let Some(pipe) = stdin.as_mut() {
                let _ = pipe.write_all(b"finish\n");
            }
        }
        match receive.recv_timeout(TICK) {
            Ok(Some(Reply::Progress { progress })) if result.is_none() => {
                if let Some(control) = control {
                    control.progress(progress);
                }
            }
            Ok(Some(Reply::Result { value })) if result.is_none() => result = Some(Ok(value)),
            Ok(Some(Reply::Error { error })) if result.is_none() => result = Some(Err(error)),
            Ok(_) => return Err(SpeechError::Failed),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                if let Some(status) = process.child.try_wait().map_err(|_| SpeechError::Failed)? {
                    process.exited = true;
                    return if status.success() && stopped.is_none() {
                        result.unwrap_or(Err(SpeechError::Failed))
                    } else {
                        Err(SpeechError::Failed)
                    };
                }
                std::thread::sleep(TICK);
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Reply {
    Progress { progress: Operation },
    Result { value: Value },
    Error { error: SpeechError },
}

struct Worker {
    child: Child,
    exited: bool,
    #[cfg(windows)]
    job: crate::cli_manager::WindowsJobObject,
}

impl Worker {
    fn start(mut command: Command) -> Result<Self, SpeechError> {
        #[cfg(windows)]
        let job =
            crate::cli_manager::WindowsJobObject::create().map_err(|_| SpeechError::Failed)?;
        let worker = Self {
            child: command.spawn().map_err(|_| SpeechError::Failed)?,
            exited: false,
            #[cfg(windows)]
            job,
        };
        #[cfg(windows)]
        if worker.job.assign_child(&worker.child).is_err() {
            let mut worker = worker;
            let _ = worker.child.kill();
            return Err(SpeechError::Failed);
        }
        Ok(worker)
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        if self.exited {
            return;
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        #[cfg(windows)]
        let _ = self.job.terminate();
        let _ = self.child.wait();
        #[cfg(windows)]
        {
            let stop = Instant::now() + Duration::from_secs(2);
            while self.job.active_processes().is_ok_and(|active| active > 0)
                && Instant::now() < stop
            {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}
