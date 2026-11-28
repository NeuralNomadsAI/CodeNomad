use crate::backend::{Backend, read_json_limited};
use std::time::Duration;

const FAILED: &str = "settings.opencode.setup.actionFailed";

pub async fn local_opencode_offer(
    backend: &Backend,
) -> crate::history::Result<super::OpenCodeStatus> {
    if !opencode_local(backend).await? {
        return Err("OpenCode maintenance requires the local host".into());
    }
    super::opencode_status(backend, false).await
}

pub async fn opencode_local(backend: &Backend) -> crate::history::Result<bool> {
    let request = backend.client.get(format!("{}api/meta", backend.base));
    #[cfg(target_arch = "wasm32")]
    let request = request.fetch_cache_no_store();
    let response = request.send().await?.error_for_status()?;
    let meta = read_json_limited(response, 65536).await?;
    Ok(meta["localRequest"] == true
        && backend
            .client
            .server_identity()
            .is_none_or(|id| meta["serverId"] == id))
}

pub async fn install_opencode(backend: &Backend) -> Result<(), &'static str> {
    let response = backend
        .client
        .post(format!("{}api/opencode/update", backend.base))
        .timeout(Duration::from_secs(300))
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|_| FAILED)?;
    let success = response.status().is_success();
    let value = read_json_limited(response, 4096)
        .await
        .map_err(|_| FAILED)?;
    if success
        && value["success"] == true
        && value["version"]
            .as_str()
            .is_some_and(|version| !version.is_empty() && version.len() <= 256)
    {
        return Ok(());
    }
    Err(match value["error"].as_str() {
        Some("installation_busy") => "settings.opencode.setup.installation_busy",
        Some("installation_in_use") => "settings.opencode.setup.installation_in_use",
        _ => FAILED,
    })
}

const MAX_VALIDATION_BYTES: usize = 16 * 1024;
const MAX_LOGIN_START_BYTES: usize = 4 * 1024;
const MAX_LOGS_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_LOGS_TEXT_BYTES: usize = 512 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BinaryValidation {
    pub valid: bool,
    pub version: Option<String>,
    pub error: Option<String>,
    pub v2_required: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoginStartState {
    On,
    Off,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoginStartError {
    UnsupportedBinary,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenCodeLogs {
    pub path: String,
    pub text: String,
    pub truncated: bool,
}

fn clean_text(value: &serde_json::Value, max: usize) -> Option<String> {
    value
        .as_str()
        .filter(|text| !text.is_empty() && text.len() <= max && !text.contains(char::is_control))
        .map(str::to_owned)
}

fn sanitize_diagnostic(value: &serde_json::Value, max: usize) -> Option<String> {
    let raw = value.as_str()?;
    let mut out = String::new();
    let mut prev_space = true;
    for ch in raw.chars() {
        let mapped = match ch {
            '\r' | '\n' | '\t' => Some(' '),
            c if c.is_control() => None,
            c => Some(c),
        };
        let Some(ch) = mapped else {
            continue;
        };
        if ch.is_whitespace() {
            if !prev_space && out.len() < max {
                out.push(' ');
                prev_space = true;
            }
        } else {
            if out.len() + ch.len_utf8() > max {
                break;
            }
            out.push(ch);
            prev_space = false;
        }
    }
    let trimmed = out.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn parse_binary_validation(value: serde_json::Value) -> crate::history::Result<BinaryValidation> {
    let valid = value["valid"]
        .as_bool()
        .ok_or("Invalid binary validation response")?;
    let v2_required = value["errorCode"].as_str() == Some("opencode_v2_required");
    if valid && v2_required {
        return Err("Contradictory binary validation response".into());
    }
    Ok(BinaryValidation {
        valid,
        version: clean_text(&value["version"], 256),
        error: sanitize_diagnostic(&value["error"], 240),
        v2_required,
    })
}

pub async fn validate_opencode_binary(
    backend: &Backend,
    path: &str,
) -> crate::history::Result<BinaryValidation> {
    let request = backend
        .client
        .post(format!("{}api/storage/binaries/validate", backend.base))
        .json(&serde_json::json!({ "path": path }));
    #[cfg(not(target_arch = "wasm32"))]
    let request = request.timeout(Duration::from_secs(30));
    let response = request.send().await?;
    let status = response.status();
    let value = read_json_limited(response, MAX_VALIDATION_BYTES).await?;
    if !status.is_success() {
        return Err(sanitize_diagnostic(&value["error"], 240)
            .unwrap_or_else(|| "Binary validation failed".into())
            .into());
    }
    parse_binary_validation(value)
}

fn parse_login_start(value: serde_json::Value) -> crate::history::Result<LoginStartState> {
    match value["state"].as_str() {
        Some("on") => Ok(LoginStartState::On),
        Some("off") => Ok(LoginStartState::Off),
        Some("unavailable") => Ok(LoginStartState::Unavailable),
        _ => Err("Invalid login start state".into()),
    }
}

pub async fn opencode_login_start(backend: &Backend) -> crate::history::Result<LoginStartState> {
    let request = backend
        .client
        .get(format!("{}api/opencode/login-start", backend.base));
    #[cfg(target_arch = "wasm32")]
    let request = request.fetch_cache_no_store();
    #[cfg(not(target_arch = "wasm32"))]
    let request = request.timeout(Duration::from_secs(15));
    let response = request.send().await?.error_for_status()?;
    parse_login_start(read_json_limited(response, MAX_LOGIN_START_BYTES).await?)
}

fn parse_login_start_mutation(
    value: serde_json::Value,
    enabled: bool,
) -> Result<LoginStartState, LoginStartError> {
    let expected = if enabled {
        LoginStartState::On
    } else {
        LoginStartState::Off
    };
    match parse_login_start(value) {
        Ok(state) if state == expected => Ok(state),
        _ => Err(LoginStartError::Failed),
    }
}

pub async fn set_opencode_login_start(
    backend: &Backend,
    enabled: bool,
) -> Result<LoginStartState, LoginStartError> {
    let request = backend
        .client
        .post(format!("{}api/opencode/login-start", backend.base))
        .json(&serde_json::json!({ "enabled": enabled }));
    #[cfg(not(target_arch = "wasm32"))]
    let request = request.timeout(Duration::from_secs(30));
    let response = request.send().await.map_err(|_| LoginStartError::Failed)?;
    let success = response.status().is_success();
    let value = read_json_limited(response, MAX_LOGIN_START_BYTES)
        .await
        .map_err(|_| LoginStartError::Failed)?;
    if success {
        return parse_login_start_mutation(value, enabled);
    }
    Err(match value["error"].as_str() {
        Some("login-start-unsupported-binary") => LoginStartError::UnsupportedBinary,
        _ => LoginStartError::Failed,
    })
}

fn parse_opencode_logs(value: serde_json::Value) -> crate::history::Result<OpenCodeLogs> {
    let path = clean_text(&value["path"], 32_768).ok_or("Invalid OpenCode log path")?;
    let text = value["text"]
        .as_str()
        .filter(|text| text.len() <= MAX_LOGS_TEXT_BYTES)
        .ok_or("Invalid OpenCode log text")?
        .to_owned();
    let truncated = value["truncated"]
        .as_bool()
        .ok_or("Invalid OpenCode log truncated flag")?;
    Ok(OpenCodeLogs {
        path,
        text,
        truncated,
    })
}

pub async fn opencode_logs(backend: &Backend) -> crate::history::Result<OpenCodeLogs> {
    let request = backend
        .client
        .get(format!("{}api/opencode/logs", backend.base));
    #[cfg(target_arch = "wasm32")]
    let request = request.fetch_cache_no_store();
    #[cfg(not(target_arch = "wasm32"))]
    let request = request.timeout(Duration::from_secs(20));
    let response = request.send().await?.error_for_status()?;
    parse_opencode_logs(read_json_limited(response, MAX_LOGS_RESPONSE_BYTES).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_validation_login_start_and_logs_strictly() {
        let valid = parse_binary_validation(json!({
            "valid": true,
            "version": "2.4.0"
        }))
        .unwrap();
        assert!(valid.valid);
        assert_eq!(valid.version.as_deref(), Some("2.4.0"));
        assert!(!valid.v2_required);

        let v1 = parse_binary_validation(json!({
            "valid": false,
            "errorCode": "opencode_v2_required",
            "error": "Requires\nV2\tbinary"
        }))
        .unwrap();
        assert!(!v1.valid);
        assert!(v1.v2_required);
        assert_eq!(v1.error.as_deref(), Some("Requires V2 binary"));
        assert!(parse_binary_validation(json!({"version": "2.4.0"})).is_err());
        assert!(
            parse_binary_validation(json!({
                "valid": true,
                "errorCode": "opencode_v2_required"
            }))
            .is_err()
        );

        assert_eq!(
            parse_login_start(json!({"state": "on"})).unwrap(),
            LoginStartState::On
        );
        assert_eq!(
            parse_login_start(json!({"state": "off"})).unwrap(),
            LoginStartState::Off
        );
        assert_eq!(
            parse_login_start(json!({"state": "unavailable"})).unwrap(),
            LoginStartState::Unavailable
        );
        assert!(parse_login_start(json!({"state": "unknown"})).is_err());

        let logs = parse_opencode_logs(json!({
            "path": "/tmp/opencode.log",
            "text": "line 1\nline 2",
            "truncated": true
        }))
        .unwrap();
        assert_eq!(logs.path, "/tmp/opencode.log");
        assert_eq!(logs.text, "line 1\nline 2");
        assert!(logs.truncated);
        assert!(
            parse_opencode_logs(json!({"path": "bad\npath", "text": "", "truncated": false}))
                .is_err()
        );
    }

    #[test]
    fn login_start_mutation_rejects_contradictory_200_state() {
        assert_eq!(
            parse_login_start_mutation(json!({"state": "on"}), true),
            Ok(LoginStartState::On)
        );
        assert_eq!(
            parse_login_start_mutation(json!({"state": "off"}), false),
            Ok(LoginStartState::Off)
        );
        assert_eq!(
            parse_login_start_mutation(json!({"state": "off"}), true),
            Err(LoginStartError::Failed)
        );
        assert_eq!(
            parse_login_start_mutation(json!({"state": "on"}), false),
            Err(LoginStartError::Failed)
        );
        assert_eq!(
            parse_login_start_mutation(json!({"state": "unavailable"}), true),
            Err(LoginStartError::Failed)
        );
        assert_eq!(
            parse_login_start_mutation(json!({"state": "unavailable"}), false),
            Err(LoginStartError::Failed)
        );
        assert_eq!(
            parse_login_start_mutation(json!({"state": "bogus"}), true),
            Err(LoginStartError::Failed)
        );
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn set_opencode_login_start_http_rejects_mismatched_state_and_maps_422() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let responses = [
                    ("200 OK", r#"{"state":"off"}"#),
                    ("200 OK", r#"{"state":"unavailable"}"#),
                    ("200 OK", r#"{"state":"on"}"#),
                    (
                        "422 Unprocessable Entity",
                        r#"{"error":"login-start-unsupported-binary"}"#,
                    ),
                ];
                for (status, body) in responses {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut buf = [0u8; 4096];
                    let _ = stream.read(&mut buf).await.unwrap();
                    let reply = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    stream.write_all(reply.as_bytes()).await.unwrap();
                }
            });

            let backend = Backend::connect(&format!("http://{addr}"), "").await.unwrap();
            assert_eq!(
                set_opencode_login_start(&backend, true).await,
                Err(LoginStartError::Failed)
            );
            assert_eq!(
                set_opencode_login_start(&backend, false).await,
                Err(LoginStartError::Failed)
            );
            assert_eq!(
                set_opencode_login_start(&backend, true).await,
                Ok(LoginStartState::On)
            );
            assert_eq!(
                set_opencode_login_start(&backend, true).await,
                Err(LoginStartError::UnsupportedBinary)
            );
            server.await.unwrap();
        });
    }
}
