use super::*;
use std::os::windows::process::CommandExt;
use std::{
    io::{BufRead, BufReader, Write},
    process::Stdio,
    sync::mpsc,
    time::Duration,
};
use windows_sys::Win32::System::JobObjects::IsProcessInJob;

const LAUNCHER: &str = "windows::launch::tests::fixture_suspended_launch";
const ECHO: &str = "windows::launch::tests::fixture_argv_and_environment";
const ARGS: &[&str] = &[
    "--exact",
    ECHO,
    "--nocapture",
    "--",
    "a b",
    "a\"b",
    r"C:\end\",
    "",
    "été",
];

#[test]
fn fixture_argv_and_environment() {
    if std::env::var_os("CODENOMAD_TEST_ATOMIC_ARGV").is_none() {
        return;
    }
    let args = std::env::args_os().collect::<Vec<_>>();
    assert!(
        args[1..]
            .iter()
            .map(|arg| arg.as_os_str())
            .eq(ARGS.iter().copied().map(OsStr::new))
    );
    assert_eq!(
        std::env::var("CODENOMAD_TEST_ATOMIC_ARGV").as_deref(),
        Ok("a=b")
    );
    assert!(std::env::var_os("PATH").is_none());
    let mut line = String::new();
    io::stdin().read_line(&mut line).unwrap();
    assert_eq!(line.trim_end(), "pipe input");
    eprintln!("pipe error");
    println!("pipe output");
}

#[test]
fn atomic_launch_preserves_arguments_private_environment_and_pipes() {
    use std::io::Read;
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(ARGS).env("CODENOMAD_TEST_ATOMIC_ARGV", "a=b");
    let mut child = OwnedProcess::spawn(&mut command).unwrap();
    child
        .take_stdin()
        .unwrap()
        .write_all(b"pipe input\n")
        .unwrap();
    let mut stdout = String::new();
    let mut stderr = String::new();
    child
        .take_stdout()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    child
        .take_stderr()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert!(
        child.child.wait().unwrap().unwrap().success(),
        "{stdout}\n{stderr}"
    );
    assert!(stdout.contains("pipe output") && stderr.contains("pipe error"));
}

#[test]
fn fixture_suspended_launch() {
    if std::env::var_os("CODENOMAD_TEST_SUSPENDED_LAUNCH").is_none() {
        return;
    }
    let family = Family::new().unwrap();
    let streams = duplicate_stdio(unsafe {
        [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE].map(|id| GetStdHandle(id))
    })
    .unwrap();
    let (child, _thread) = create(
        &Command::new(std::env::current_exe().unwrap()),
        true,
        &family,
        &streams,
        CREATE_SUSPENDED | CREATE_NO_WINDOW,
    )
    .unwrap();
    let mut assigned = 0;
    unsafe {
        check(IsProcessInJob(
            child.handle.as_raw_handle(),
            family.handle,
            &mut assigned,
        ))
        .unwrap();
    }
    println!("suspended:{}:{assigned}", child.id());
    io::stdout().flush().unwrap();
    // Hold before the child's first instruction, where the old spawn/adopt gap leaked it.
    let mut line = String::new();
    io::stdin().read_line(&mut line).unwrap();
}

#[test]
fn killing_launcher_before_child_resumes_closes_the_job() {
    let mut launcher = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", LAUNCHER, "--nocapture"])
        .env("CODENOMAD_TEST_SUSPENDED_LAUNCH", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .unwrap();
    let stdout = launcher.stdout.take().unwrap();
    let (out, incoming) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(line) = line.strip_prefix("suspended:") {
                let _ = out.send(line.to_owned());
                break;
            }
        }
    });
    let line = incoming.recv_timeout(Duration::from_secs(10));
    let process = line.ok().and_then(|line| {
        let (id, assigned) = line.split_once(':')?;
        let id = id.parse().ok()?;
        // SAFETY: hold the specific suspended child's handle before killing its launcher.
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, id) };
        (!handle.is_null()).then(|| {
            (
                unsafe { OwnedHandle::from_raw_handle(handle) },
                assigned == "1",
            )
        })
    });
    launcher.kill().unwrap();
    launcher.wait().unwrap();
    reader.join().unwrap();
    let (process, assigned) = process.expect("launcher reported its suspended child");
    let stopped = unsafe { WaitForSingleObject(process.as_raw_handle(), 5000) };
    if stopped != WAIT_OBJECT_0 {
        unsafe {
            TerminateProcess(process.as_raw_handle(), 1);
        }
    }
    assert!(assigned, "child was in the job at creation");
    assert_eq!(
        stopped, WAIT_OBJECT_0,
        "killing the launcher killed the suspended child"
    );
}
