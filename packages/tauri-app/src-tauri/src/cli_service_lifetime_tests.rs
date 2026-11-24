use super::*;
use std::{collections::HashMap, io::{BufRead, BufReader}, net::{TcpStream, SocketAddr}};
use serde_json::json;

struct FixtureBackend(std::process::Child);
impl Drop for FixtureBackend {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(Some(_))) { return; }
        #[cfg(unix)]
        unsafe { libc::kill(-(self.0.id() as i32), libc::SIGKILL); }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct FixtureService(SocketAddr);
impl Drop for FixtureService {
    fn drop(&mut self) {
        if let Ok(mut socket) = TcpStream::connect_timeout(&self.0, Duration::from_secs(1)) {
            let _ = socket.write_all(b"stop");
        }
    }
}

// No OpenCode executable, service state, config or database is involved.
#[test]
fn service_started_by_native_parent_survives_backend_containment_cleanup() {
    let temp = tempfile::tempdir().unwrap();
    let ready = temp.path().join("port");
    let node = which::which("node").unwrap();
    let daemon = format!(r#"
        const net = require('net'), fs = require('fs');
        const server = net.createServer(socket => socket.once('data', data => {{
            if (data.toString() === 'stop') process.exit(0);
            socket.end('alive');
        }}));
        server.listen(0, '127.0.0.1', () => fs.writeFileSync({}, String(server.address().port)));
        setTimeout(() => process.exit(0), 20000);
    "#, json!(ready));
    let starter = format!(r#"
        const child = require('child_process').spawn(process.execPath, ['-e', {}], {{ detached: true, stdio: 'ignore' }});
        child.unref(); console.log('started');
    "#, json!(daemon));
    let deadline = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 + 5_000;
    let params = json!({ "file": node, "args": ["-e", starter],
        "env": std::env::vars().collect::<HashMap<_, _>>(), "cwd": temp.path(), "windowsVerbatimArguments": false });
    let request = json!({ "v": 1, "id": "fixture", "method": "opencode.service.start", "params": params, "deadline": deadline });
    let mut command = Command::new(&node);
    // Gate the request until after Windows job assignment (same as production).
    command.args(["-e", &format!("process.stdin.once('data', () => console.log({})); setInterval(()=>{{}},1000)", json!(format!("{}{}", crate::native_request::REQUEST_PREFIX, request)))])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(unix)]
    configure_posix_process_group(&mut command);
    let mut backend = FixtureBackend(command.spawn().unwrap());
    #[cfg(windows)]
    let job = WindowsJobObject::create().unwrap();
    #[cfg(windows)]
    job.assign_child(&backend.0).unwrap();
    backend.0.stdin.as_mut().unwrap().write_all(b"go\n").unwrap();
    let mut line = String::new();
    BufReader::new(backend.0.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let request = crate::native_request::parse(line.trim()).unwrap();
    let result = crate::native_service_start::start(request.params, request.deadline).unwrap();
    assert_eq!(result["stdout"], "started\n");
    let until = Instant::now() + Duration::from_secs(5);
    let port = loop {
        if let Ok(port) = std::fs::read_to_string(&ready) {
            if let Ok(port) = port.parse::<u16>() { break port; }
        }
        assert!(Instant::now() < until, "fixture did not become ready");
        std::thread::sleep(Duration::from_millis(10));
    };
    let service = FixtureService(format!("127.0.0.1:{port}").parse().unwrap());
    // This is the destructive cleanup that used to kill the inherited daemon.
    #[cfg(windows)]
    drop(job);
    #[cfg(unix)]
    unsafe { libc::kill(-(backend.0.id() as i32), libc::SIGKILL); }
    backend.0.wait().unwrap();
    let mut socket = TcpStream::connect_timeout(&service.0, Duration::from_secs(1)).unwrap();
    socket.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    socket.write_all(b"health").unwrap();
    let mut response = String::new();
    std::io::Read::read_to_string(&mut socket, &mut response).unwrap();
    assert_eq!(response, "alive");
}
