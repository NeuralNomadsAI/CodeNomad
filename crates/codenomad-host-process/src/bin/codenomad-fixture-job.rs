//! Run a fixture with inherited stdio and contain its entire process family.
use codenomad_host_process::OwnedProcess;
use std::{
    io,
    process::{Command, Stdio},
    thread::sleep,
    time::{Duration, Instant},
};

fn run() -> io::Result<i32> {
    let mut args = std::env::args_os().skip(1);
    let program = args
        .next()
        .ok_or_else(|| io::Error::other("Expected a fixture executable and its arguments"))?;
    let mut child = OwnedProcess::spawn_inherited(
        Command::new(program)
            .args(args)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit()),
        |pid| eprintln!("CODENOMAD_FIXTURE_PID={pid}"),
    )?;
    let pause = Duration::from_millis(10);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        sleep(pause);
    };
    if !child.family_is_empty()? {
        child.terminate()?;
        let deadline = Instant::now() + Duration::from_secs(5);
        while !child.family_is_empty()? {
            if Instant::now() >= deadline {
                return Err(io::Error::other("Fixture job did not finish terminating"));
            }
            sleep(pause);
        }
    }
    Ok(status.code().unwrap_or(1))
}

fn main() {
    std::process::exit(run().unwrap_or_else(|error| {
        eprintln!("Fixture job: {error}");
        1
    }));
}
