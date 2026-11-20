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
