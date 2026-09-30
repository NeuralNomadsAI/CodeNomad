//! Exercise the real plugin's HTTP and signature path without invoking an installer.
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri_plugin_updater::UpdaterExt;

// Public-only fixture signed by the Tauri CLI. The corresponding test private
// key is outside the repository; these bytes cannot sign any release.
const KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEFCRDhENEY5NUFFM0JEQTMKUldTanZlTmErZFRZcTNFc3MzdmxZUWVXN3JxYWJtVS96YVVrczhldlNUWmhYdkd6cmRWTVYySnEK";
const SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTanZlTmErZFRZcS92bW9GamNjb3J2QkMrdXVoVmhXM1RhN0VXVGxWTzc4VWhIaXpIVExQajNZZWpNUlM2aStHR1ZYdU9GcDN0MHFuL3ArOTRmWjdtaDVwdGNiNGhHdXdJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkwMzkyMzAxCWZpbGU6dXBkYXRlci1uYXRpdmUtc2lnbmF0dXJlLWZpeHR1cmUudHh0CnpuOUtzd3F4QmVyOG5yMmh3QTR1cHpZUU5XVndzUk1LeWI4bnQ1L1dGU1ZDbkRyMkVxU29pMzJFTXV1SFFGeGF2RTFlbkNwQzhlSncwZExsZ05RbkJ3PT0K";
const PAYLOAD: &[u8] = b"CodeNomad updater test payload - never an installable release";

fn download_fixture(payload: Vec<u8>) -> tauri_plugin_updater::Result<Vec<u8>> {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    server.set_nonblocking(true).unwrap();
    let address = server.local_addr().unwrap();
    let endpoint = format!("http://{address}/latest.json");
    let worker = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut requests = 0;
        while requests < 2 && Instant::now() < deadline {
            let (mut socket, _) = match server.accept() {
                Ok(connection) => connection,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10)); continue;
                }
                Err(error) => panic!("{error}"),
            };
            socket.set_nonblocking(false).unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut request = String::new();
            reader.read_line(&mut request).unwrap();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() { break; }
            }
            let response = if request.starts_with("GET /latest.json ") {
                serde_json::to_vec(&serde_json::json!({
                    "version": "9999.0.0", "signature": SIGNATURE,
                    "url": format!("http://{address}/fixture.bin"),
                })).unwrap()
            } else {
                assert!(request.starts_with("GET /fixture.bin "));
                payload.clone()
            };
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response.len()).unwrap();
            socket.write_all(&response).unwrap();
            requests += 1;
        }
        assert_eq!(requests, 2);
    });
    let mut context = mock_context(noop_assets());
    context.config_mut().plugins.0.insert("updater".into(), serde_json::json!({
        "pubkey": KEY, "endpoints": [endpoint],
        "dangerousInsecureTransportProtocol": true,
    }));
    let app = crate::desktop_updater::register(mock_builder(), context.config()).build(context).unwrap();
    let temporary = tempfile::tempdir().unwrap();
    let executable = temporary.path().join("CodeNomad.app/Contents/MacOS/CodeNomad");
    std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
    std::fs::write(&executable, b"not an executable").unwrap();
    let result = tauri::async_runtime::block_on(async {
        let update = app.updater_builder().executable_path(&executable)
            .timeout(Duration::from_secs(5)).build()?.check().await?.unwrap();
        update.download(|_, _| {}, || {}).await
    });
    worker.join().unwrap();
    assert_eq!(std::fs::read(&executable).unwrap(), b"not an executable");
    result
}

#[test]
fn native_plugin_accepts_cli_signature_and_rejects_tampered_download() {
    assert_eq!(download_fixture(PAYLOAD.to_vec()).unwrap(), PAYLOAD);
    assert!(download_fixture(b"tampered installer".to_vec()).is_err());
}

#[test]
fn unsigned_configuration_starts_without_initializing_the_updater_plugin() {
    let context = mock_context(noop_assets());
    assert!(!context.config().plugins.0.contains_key("updater"));
    crate::desktop_updater::register(mock_builder(), context.config()).build(context).unwrap();
}
