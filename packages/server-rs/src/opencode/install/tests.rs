use super::*;
use base64::Engine;
use sha2::{Digest, Sha512};

/// A loopback server answering every request with `body`, recording request heads.
async fn serve(body: Vec<u8>) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let heads = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = heads.clone();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") && socket.read(&mut byte).await.is_ok_and(|n| n == 1) {
                head.push(byte[0]);
            }
            seen.lock().unwrap().push(String::from_utf8_lossy(&head).into_owned());
            let reply = format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
            let _ = socket.write_all(reply.as_bytes()).await;
            let _ = socket.write_all(&body).await;
        }
    });
    (url, heads)
}

#[tokio::test]
async fn a_tarball_is_kept_only_when_it_matches_its_integrity_and_credentials_reach_its_registry() {
    let body = b"tarball bytes".to_vec();
    let (url, heads) = serve(body.clone()).await;
    let dir = crate::shared::test_dir("install-download");
    std::fs::create_dir_all(&dir).unwrap();
    let mut values = std::collections::HashMap::new();
    npmrc::parse(&format!("{}/:_authToken=secret-token\n", url.trim_start_matches("http:")), &mut values);
    let config = npmrc::Config::from(values);
    let client = config.client().unwrap();
    let good = base64::engine::general_purpose::STANDARD.encode(Sha512::digest(&body));
    let manifest =
        |sri: String| json!({"name": "@opencode/cli-x", "dist": {"tarball": format!("{url}/x.tgz"), "integrity": sri}});
    let file = dir.join("x.tgz");
    package::download(&client, &config, &manifest(format!("sha512-{good}")), &file).await.unwrap();
    assert_eq!(std::fs::read(&file).unwrap(), body);
    assert!(heads.lock().unwrap()[0].to_ascii_lowercase().contains("authorization: bearer secret-token"));
    let wrong = base64::engine::general_purpose::STANDARD.encode([0u8; 64]);
    let refused = package::download(&client, &config, &manifest(format!("sha512-{wrong}")), &file).await.unwrap_err();
    assert!(refused.starts_with("integrity_mismatch"), "{refused}");
    assert!(!file.exists(), "a mismatching download is removed before any read");
    let sha1 = package::download(&client, &config, &manifest("sha1-abc".into()), &file).await.unwrap_err();
    assert_eq!(sha1, "The registry package has no sha512 integrity");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn errors_carry_the_reference_status() {
    assert_eq!(Error::busy("x").status(), Status::CONFLICT);
    assert_eq!(Error::new("binary_unavailable", "x").status(), Status::UNPROCESSABLE_ENTITY);
    assert_eq!(Error::failed("x").status(), Status::BAD_GATEWAY);
    assert!(newer("2.10.0", "2.9.9") && !newer("2.3.2", "2.3.2"));
    assert!(layout::cmd_shim_matches(layout::cmd("node_modules\\@opencode\\cli\\bin\\opencode.exe").as_bytes()));
    assert!(!layout::cmd_shim_matches(b"@echo off\r\nother.exe %*\r\n"));
}

#[test]
fn the_foreign_notice_has_the_reference_shape() {
    let foreign = plan::Foreign {
        command: "C:\\f\\opencode.exe".into(),
        version: Some("1.5.0".into()),
        source: "winget",
        package_id: Some("SST.opencode".into()),
        blocked: Some(("occupied", "C:\\p\\opencode.cmd".into())),
    };
    let notice = plan::notice(&plan::Plan { prefix: None, foreign: Some(foreign) });
    assert_eq!(
        notice,
        json!({"foreignInstallation": {"path": "C:\\f\\opencode.exe", "version": "1.5.0", "source": "winget",
            "packageId": "SST.opencode", "blocked": {"reason": "occupied", "path": "C:\\p\\opencode.cmd"}}})
    );
    assert_eq!(plan::notice(&plan::Plan::default()), json!({}));
}

/// A command that starts a grandchild, then waits: once the probe expires, neither remains.
#[tokio::test]
async fn an_expired_probe_ends_its_whole_process_family() {
    let dir = crate::shared::test_dir("probe-family");
    #[cfg(windows)]
    let (command, members) = {
        // Copies of ping: a running image cannot be opened for writing, a stopped one can.
        let ping = std::path::Path::new(&std::env::var("SystemRoot").unwrap()).join("System32\\PING.EXE");
        for name in ["waiter.exe", "grandchild.exe"] {
            std::fs::copy(&ping, dir.join(name)).unwrap();
        }
        let script = "@echo off\r\nstart \"\" /b \"%~dp0grandchild.exe\" -n 60 127.0.0.1 >nul\r\n\"%~dp0waiter.exe\" -n 60 127.0.0.1 >nul\r\n";
        std::fs::write(dir.join("fake.cmd"), script).unwrap();
        (dir.join("fake.cmd"), [dir.join("waiter.exe"), dir.join("grandchild.exe")])
    };
    #[cfg(unix)]
    let (command, members) = {
        use std::os::unix::fs::PermissionsExt;
        let script = "#!/bin/sh\nsleep 60 &\necho $! > \"$(dirname \"$0\")/grandchild\"\necho $$ > \"$(dirname \"$0\")/waiter\"\nsleep 60\n";
        std::fs::write(dir.join("fake"), script).unwrap();
        std::fs::set_permissions(dir.join("fake"), std::fs::Permissions::from_mode(0o755)).unwrap();
        (dir.join("fake"), [dir.join("waiter"), dir.join("grandchild")])
    };
    #[cfg(windows)]
    let alive = |member: &std::path::Path| std::fs::OpenOptions::new().write(true).open(member).is_err();
    #[cfg(unix)]
    let alive = |member: &std::path::Path| {
        let pid: i32 = std::fs::read_to_string(member).ok().and_then(|p| p.trim().parse().ok()).unwrap_or(0);
        // SAFETY: signal 0 only checks that the process exists.
        pid > 0 && unsafe { libc::kill(pid, 0) } == 0
    };
    let during = async {
        tokio::time::sleep(Duration::from_millis(2500)).await;
        members.iter().map(|m| alive(m)).collect::<Vec<_>>()
    };
    let command = command.to_string_lossy().into_owned();
    let (probed, running) = tokio::join!(probe_version(&command, Duration::from_secs(4)), during);
    assert!(matches!(probed, Probed::Unknown));
    assert_eq!(running, [true, true], "both members ran during the probe");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while members.iter().any(|m| alive(m)) {
        assert!(std::time::Instant::now() < deadline, "a member of the expired probe still runs");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    std::fs::remove_dir_all(dir).unwrap();
}
