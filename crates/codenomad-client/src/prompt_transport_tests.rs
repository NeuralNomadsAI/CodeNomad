//! Regression tests for prompt POST connect/idle timeouts and shared cookie jars.
use crate::{backend::Backend, http::Http, prompt::PromptError};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

fn run(test: impl std::future::Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(test)
}

fn backend_with_client(client: Http, addr: std::net::SocketAddr) -> Backend {
    Backend {
        client,
        base: format!("http://{addr}/"),
        workspace: "workspace".into(),
        session: "session".into(),
        session_directory: None,
        client_id: "fixture".into(),
        fresh_mode: false,
    }
}

async fn read_request_headers(
    req: &mut BufReader<tokio::net::TcpStream>,
) -> (String, Vec<(String, String)>) {
    let mut first = String::new();
    assert!(req.read_line(&mut first).await.unwrap() > 0);
    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        assert!(req.read_line(&mut line).await.unwrap() > 0);
        if line == "\r\n" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_owned()));
        }
    }
    (first, headers)
}

#[test]
fn slow_prompt_upload_outlives_idle_timeout_while_progress_continues() {
    run(async {
        tokio::time::timeout(Duration::from_secs(10), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let id = "msg_00000000000000000000000000000101";
            let chunk_count = 6usize;
            let body_prefix = format!(r#"{{"id":"{id}","text":""#);
            let body_suffix = r#""}"#;
            let chunk_payload = "a".repeat(16 * 1024);
            let expected_len =
                body_prefix.len() + chunk_count * chunk_payload.len() + body_suffix.len();

            let server = tokio::spawn(async move {
                let (socket, _) = listener.accept().await.unwrap();
                let mut req = BufReader::new(socket);
                let (first, headers) = read_request_headers(&mut req).await;
                assert!(
                    first.starts_with(
                        "POST /workspaces/workspace/instance/api/session/session/prompt "
                    ),
                    "unexpected request line: {first}"
                );
                let declared: usize = headers
                    .iter()
                    .find(|(k, _)| k == "content-length")
                    .expect("explicit Content-Length header required")
                    .1
                    .parse()
                    .unwrap();
                assert_eq!(declared, expected_len);

                let mut buf = vec![0u8; declared];
                req.read_exact(&mut buf).await.unwrap();
                let ack = format!(r#"{{"id":"{id}","sessionID":"session"}}"#);
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{ack}",
                    ack.len()
                );
                req.get_mut().write_all(reply.as_bytes()).await.unwrap();
            });

            let idle_timeout = Duration::from_millis(220);
            let client =
                Http::with_prompt_timeouts(Duration::from_secs(2), idle_timeout).unwrap();
            let progress = std::sync::Arc::new(tokio::sync::Notify::new());
            let mut pieces = Vec::with_capacity(chunk_count + 2);
            pieces.push(body_prefix.into_bytes());
            for _ in 0..chunk_count {
                pieces.push(chunk_payload.as_bytes().to_vec());
            }
            pieces.push(body_suffix.as_bytes().to_vec());
            let stream_progress = progress.clone();
            let stream = futures_lite::stream::unfold(
                (pieces.into_iter(), false),
                move |(mut iter, paced)| {
                    let progress = stream_progress.clone();
                    async move {
                        let chunk = iter.next()?;
                        if paced {
                            tokio::time::sleep(Duration::from_millis(80)).await;
                        }
                        progress.notify_one();
                        Some((Ok::<Vec<u8>, std::io::Error>(chunk), (iter, true)))
                    }
                },
            );
            let request = client
                .post_prompt(format!(
                    "http://{addr}/workspaces/workspace/instance/api/session/session/prompt"
                ))
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .header(reqwest::header::CONTENT_LENGTH, expected_len)
                .body(reqwest::Body::wrap_stream(stream));
            let started = Instant::now();
            let response =
                crate::backend::send_prompt_with_idle_timeout(request, idle_timeout, progress)
                    .await
                    .expect("progressive upload longer than idle_timeout must succeed");
            assert!(response.status().is_success());
            let ack = crate::prompt_receipt::read_with_idle_timeout(response, Some(idle_timeout))
                .await
                .unwrap();
            assert_eq!(ack["id"].as_str(), Some(id));
            assert!(
                started.elapsed() > idle_timeout,
                "paced upload ({:?}) must outlive idle_timeout ({idle_timeout:?}) to prove no total request timeout applies",
                started.elapsed()
            );
            server.await.unwrap();
        })
        .await
        .expect("slow progressive upload test must finish promptly");
    });
}

#[test]
fn send_encoded_prompt_outlives_connect_timeout_and_preserves_content_length() {
    run(async {
        tokio::time::timeout(Duration::from_secs(10), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let id = "msg_00000000000000000000000000000106";
            // Exceeds PROMPT_UPLOAD_CHUNK (64 KiB) to exercise multi-chunk UploadChunks.
            let payload = format!(r#"{{"id":"{id}","text":"{}"}}"#, "b".repeat(160 * 1024));
            let expected_len = payload.len();

            let server = tokio::spawn(async move {
                let (socket, _) = listener.accept().await.unwrap();
                let mut req = BufReader::new(socket);
                let (_, headers) = read_request_headers(&mut req).await;
                let declared: usize = headers
                    .iter()
                    .find(|(k, _)| k == "content-length")
                    .expect("explicit Content-Length header required")
                    .1
                    .parse()
                    .unwrap();
                assert_eq!(declared, expected_len);
                let mut buf = vec![0u8; declared];
                req.read_exact(&mut buf).await.unwrap();
                // Delay beyond connect_timeout while staying below idle_timeout.
                tokio::time::sleep(Duration::from_millis(220)).await;
                let ack = format!(r#"{{"id":"{id}","sessionID":"session"}}"#);
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{ack}",
                    ack.len()
                );
                req.get_mut().write_all(reply.as_bytes()).await.unwrap();
            });

            let connect_timeout = Duration::from_millis(120);
            let idle_timeout = Duration::from_millis(600);
            let client = Http::with_prompt_timeouts(connect_timeout, idle_timeout).unwrap();
            let backend = backend_with_client(client, addr);
            let started = Instant::now();
            let ack = backend
                .send_encoded_prompt(Some(id), payload.into_bytes())
                .await
                .expect("prompt send exceeding connect_timeout must succeed under idle_timeout");
            assert_eq!(ack.id, id);
            assert!(started.elapsed() > connect_timeout);
            server.await.unwrap();
        })
        .await
        .expect("send_encoded_prompt multi-chunk test must finish promptly");
    });
}

#[test]
fn stalled_prompt_headers_and_body_fail_as_unconfirmed_after_idle_timeout() {
    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();

            let server = tokio::spawn(async move {
                // 1. Read full body then stall before sending HTTP response headers.
                let (s1, _) = listener.accept().await.unwrap();
                let mut req1 = BufReader::new(s1);
                let (_, headers1) = read_request_headers(&mut req1).await;
                let len1: usize = headers1
                    .iter()
                    .find(|(k, _)| k == "content-length")
                    .unwrap()
                    .1
                    .parse()
                    .unwrap();
                let mut body1 = vec![0u8; len1];
                req1.read_exact(&mut body1).await.unwrap();
                // Keep socket open until the client drops it on idle timeout.
                let mut eof = [0u8; 1];
                let _ = req1.read(&mut eof).await;

                // 2. Send 200 OK headers + truncated JSON body then stall mid-body.
                let (s2, _) = listener.accept().await.unwrap();
                let mut req2 = BufReader::new(s2);
                let (_, headers2) = read_request_headers(&mut req2).await;
                let len2: usize = headers2
                    .iter()
                    .find(|(k, _)| k == "content-length")
                    .unwrap()
                    .1
                    .parse()
                    .unwrap();
                let mut body2 = vec![0u8; len2];
                req2.read_exact(&mut body2).await.unwrap();
                req2.get_mut()
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 64\r\nConnection: close\r\n\r\n{\"id\":",
                    )
                    .await
                    .unwrap();
                let _ = req2.read(&mut eof).await;
            });

            let idle_timeout = Duration::from_millis(120);
            let client =
                Http::with_prompt_timeouts(Duration::from_secs(2), idle_timeout).unwrap();
            let backend = backend_with_client(client, addr);

            let err_headers = backend
                .send_encoded_prompt(
                    Some("msg_00000000000000000000000000000102"),
                    br#"{"id":"msg_00000000000000000000000000000102","text":"stall headers"}"#
                        .to_vec(),
                )
                .await
                .unwrap_err();
            assert_eq!(
                err_headers.downcast_ref::<PromptError>(),
                Some(&PromptError::Unconfirmed)
            );

            let err_body = backend
                .send_encoded_prompt(
                    Some("msg_00000000000000000000000000000103"),
                    br#"{"id":"msg_00000000000000000000000000000103","text":"stall body"}"#
                        .to_vec(),
                )
                .await
                .unwrap_err();
            assert_eq!(
                err_body.downcast_ref::<PromptError>(),
                Some(&PromptError::Unconfirmed)
            );

            server.await.unwrap();
        })
        .await
        .expect("stalled header/body idle timeout tests must finish promptly");
    });
}

#[test]
fn prompt_transport_shares_cookie_jar_with_standard_and_session_clients() {
    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            // 1. Standard client receives Set-Cookie on GET, then prompt POST sends it.
            let listener1 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr1 = listener1.local_addr().unwrap();
            let server1 = tokio::spawn(async move {
                let (s1, _) = listener1.accept().await.unwrap();
                let mut req1 = BufReader::new(s1);
                let _ = read_request_headers(&mut req1).await;
                req1.get_mut()
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nSet-Cookie: cn_session=jar_xyz; Path=/\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                    )
                    .await
                    .unwrap();

                let (s2, _) = listener1.accept().await.unwrap();
                let mut req2 = BufReader::new(s2);
                let (_, headers2) = read_request_headers(&mut req2).await;
                let cookie = headers2
                    .iter()
                    .find(|(k, _)| k == "cookie")
                    .map(|(_, v)| v.as_str());
                assert_eq!(cookie, Some("cn_session=jar_xyz"));
                let len2: usize = headers2
                    .iter()
                    .find(|(k, _)| k == "content-length")
                    .unwrap()
                    .1
                    .parse()
                    .unwrap();
                let mut body2 = vec![0u8; len2];
                req2.read_exact(&mut body2).await.unwrap();
                let ack = r#"{"id":"msg_00000000000000000000000000000104","sessionID":"session"}"#;
                req2.get_mut()
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{ack}",
                            ack.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            });
            let backend1 = backend_with_client(Http::new().unwrap(), addr1);
            let _ = backend1
                .client
                .get(format!("{}api/auth/login", backend1.base))
                .send()
                .await
                .unwrap();
            let ack1 = backend1
                .send_encoded_prompt(
                    Some("msg_00000000000000000000000000000104"),
                    br#"{"id":"msg_00000000000000000000000000000104","text":"with jar"}"#.to_vec(),
                )
                .await
                .unwrap();
            assert_eq!(ack1.id, "msg_00000000000000000000000000000104");
            server1.await.unwrap();

            // 2. Pre-seeded session cookie client sends its cookie on prompt POST.
            let listener2 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr2 = listener2.local_addr().unwrap();
            let server2 = tokio::spawn(async move {
                let (s, _) = listener2.accept().await.unwrap();
                let mut req = BufReader::new(s);
                let (_, headers) = read_request_headers(&mut req).await;
                let cookie = headers
                    .iter()
                    .find(|(k, _)| k == "cookie")
                    .map(|(_, v)| v.as_str());
                assert_eq!(cookie, Some("cn_session=tok_abc"));
                let len: usize = headers
                    .iter()
                    .find(|(k, _)| k == "content-length")
                    .unwrap()
                    .1
                    .parse()
                    .unwrap();
                let mut body = vec![0u8; len];
                req.read_exact(&mut body).await.unwrap();
                let ack = r#"{"id":"msg_00000000000000000000000000000105","sessionID":"session"}"#;
                req.get_mut()
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{ack}",
                            ack.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            });
            let client2 =
                Http::with_session_cookie(&format!("http://{addr2}/"), "cn_session", "tok_abc")
                    .unwrap();
            let backend2 = backend_with_client(client2, addr2);
            let ack2 = backend2
                .send_encoded_prompt(
                    Some("msg_00000000000000000000000000000105"),
                    br#"{"id":"msg_00000000000000000000000000000105","text":"seeded"}"#.to_vec(),
                )
                .await
                .unwrap();
            assert_eq!(ack2.id, "msg_00000000000000000000000000000105");
            server2.await.unwrap();
        })
        .await
        .expect("cookie sharing test must complete");
    });
}
