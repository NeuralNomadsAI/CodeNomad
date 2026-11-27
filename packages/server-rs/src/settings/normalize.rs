use serde_json::{Value, json};

use super::{Failure, document::Doc};

/// `normalizeServerConfigOwner`.
pub(super) fn normalize_server(mut server: Doc) -> Doc {
    if let Some(level) = server.get("logLevel") {
        let canonical = level.as_str().map(|s| js_trim(s).to_uppercase());
        let valid = canonical.filter(|s| ["DEBUG", "INFO", "WARN", "ERROR"].contains(&s.as_str()));
        server.insert("logLevel".into(), json!(valid.unwrap_or_else(|| "DEBUG".into())));
    }
    if server.get("updateFeed").is_some_and(|feed| feed != "stable" && feed != "preview") {
        server.remove("updateFeed");
    }
    if server.get("opencodeBinary").is_some_and(|binary| binary == "opencode") {
        server.insert("opencodeBinary".into(), json!("opencode2"));
    }
    server
}
pub(super) fn normalize_config(mut doc: Doc) -> Doc {
    if let Some(Value::Object(server)) = doc.get_mut("server") {
        *server = normalize_server(std::mem::take(server));
    }
    doc
}

/// ECMAScript `String.prototype.trim()` whitespace (excludes U+0085 NEL, includes U+FEFF BOM).
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{0085}') || c == '\u{feff}')
}

/// `voice-conversation-config.ts`: shared JS-trim and field validation.
fn vc_trimmed(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).map(js_trim)
}
fn vc_valid_api_key(v: Option<&Value>) -> bool {
    vc_trimmed(v).is_some_and(|s| !s.is_empty() && s.len() <= 4096 && s.bytes().all(|b| (0x21..=0x7e).contains(&b)))
}
fn vc_valid_model(v: Option<&Value>) -> Option<&str> {
    vc_trimmed(v).filter(|s| {
        !s.is_empty()
            && s.len() <= 256
            && s.as_bytes()[0].is_ascii_alphanumeric()
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'/' | b'-'))
    })
}
fn vc_valid_voice(v: Option<&Value>) -> Option<&str> {
    vc_trimmed(v).filter(|s| {
        !s.is_empty()
            && s.len() <= 128
            && s.as_bytes()[0].is_ascii_alphanumeric()
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    })
}
fn vc_valid_provider_patch(raw: &Doc) -> bool {
    raw.keys().all(|k| matches!(k.as_str(), "apiKey" | "model" | "voice"))
        && raw.get("apiKey").is_none_or(|v| v.is_null() || vc_valid_api_key(Some(v)))
        && raw.get("model").is_none_or(|v| v.is_null() || vc_valid_model(Some(v)).is_some())
        && raw.get("voice").is_none_or(|v| v.is_null() || vc_valid_voice(Some(v)).is_some())
}

/// `assertVoiceConversationPatch` (`packages/server/src/speech/voice-conversation-config.ts`).
pub(super) fn assert_voice_conversation_patch(patch: &Value) -> Result<(), Failure> {
    let Some(vc) = patch.as_object().and_then(|o| o.get("voiceConversation")) else {
        return Ok(());
    };
    if vc.is_null() {
        return Ok(());
    }
    let valid = vc.as_object().is_some_and(|obj| {
        obj.keys().all(|k| matches!(k.as_str(), "geminiLive" | "openaiRealtime"))
            && obj.values().all(|v| v.is_null() || v.as_object().is_some_and(vc_valid_provider_patch))
    });
    if valid { Ok(()) } else { Err(Failure::Invalid("Invalid voice conversation settings patch".into())) }
}

/// `checkConversationDefault` (`packages/server/src/server/routes/settings.ts`).
pub(super) fn check_conversation_default(before: &Doc, after: &Doc) -> Result<(), Failure> {
    fn mode(doc: &Doc) -> Option<&Value> {
        doc.get("ui")
            .and_then(Value::as_object)
            .and_then(|ui| ui.get("settings"))
            .and_then(Value::as_object)
            .and_then(|s| s.get("newConversationPermissions"))
    }
    let next = mode(after);
    if next != mode(before) {
        let valid = match next {
            None => true,
            Some(Value::String(s)) if s == "autonomous" || s == "supervised" => true,
            _ => false,
        };
        if !valid {
            return Err(Failure::Invalid("Invalid new conversation permissions".into()));
        }
    }
    Ok(())
}

/// `publicVoiceConversationConfig` (`packages/server/src/speech/voice-conversation-config.ts`).
fn sanitize_voice_conversation(value: &Value) -> Option<Value> {
    let vc = value.as_object()?;
    let secrets: Vec<&str> = ["geminiLive", "openaiRealtime"]
        .into_iter()
        .filter_map(|p| vc.get(p).and_then(Value::as_object).and_then(|o| vc_trimmed(o.get("apiKey"))))
        .collect();
    let project = |provider: &str| {
        let Some(raw) = vc.get(provider).and_then(Value::as_object) else {
            return json!({ "hasApiKey": false });
        };
        let mut out = Doc::new();
        out.insert("hasApiKey".into(), json!(vc_valid_api_key(raw.get("apiKey"))));
        if let Some(model) = vc_valid_model(raw.get("model"))
            && !secrets.contains(&model)
        {
            out.insert("model".into(), json!(model));
        }
        if let Some(voice) = vc_valid_voice(raw.get("voice"))
            && vc_valid_provider_patch(raw)
            && !secrets.contains(&voice)
        {
            out.insert("voice".into(), json!(voice));
        }
        Value::Object(out)
    };
    Some(json!({
        "geminiLive": project("geminiLive"),
        "openaiRealtime": project("openaiRealtime"),
    }))
}

/// `sanitizeServerOwner`: speech and voiceConversation keys are replaced by `hasApiKey`.
pub(super) fn sanitize_server(mut server: Doc) -> Doc {
    if let Some(vc) = server.remove("voiceConversation").and_then(|v| sanitize_voice_conversation(&v)) {
        server.insert("voiceConversation".into(), vc);
    }
    let hide = |owner: &mut Doc| {
        let key = owner.remove("apiKey");
        owner.insert(
            "hasApiKey".into(),
            json!(key.as_ref().and_then(Value::as_str).is_some_and(|s| !js_trim(s).is_empty())),
        );
    };
    let Some(Value::Object(speech)) = server.get_mut("speech") else {
        server.remove("speech");
        return server;
    };
    hide(speech);
    for direction in ["stt", "tts"] {
        if let Some(Value::Object(sub)) = speech.get_mut(direction) {
            hide(sub);
        } else {
            speech.remove(direction);
        }
    }
    server
}

/// `HOST_ONLY_SERVER_KEYS` and `hostOnlyServerCheck`: a non-local request may not flip them.
const HOST_ONLY: &[&str] = &["sidecarsOverDirectHttps"];
pub(super) fn host_only(before: &Doc, after: &Doc) -> Result<(), Failure> {
    let enabled = |doc: &Doc, key: &str| doc.get("server").and_then(|s| s.get(key)) == Some(&json!(true));
    match HOST_ONLY.iter().all(|key| enabled(before, key) == enabled(after, key)) {
        true => Ok(()),
        false => Err(Failure::HostOnly),
    }
}

/// `enforceSpeechCredentialPairing`: a changed base URL saved without its key clears the stored key.
pub(super) fn speech_pairing(patch: &Value, current: &Doc) -> Value {
    let mut patch = patch.clone();
    let Some(Value::Object(speech)) = patch.get_mut("speech") else { return patch };
    let current = current.get("speech").and_then(Value::as_object);
    let url = |o: Option<&Doc>| o.and_then(|o| o.get("baseUrl")).filter(|v| !v.is_null()).cloned().unwrap_or(json!(""));
    let unpaired = |patch: &Doc, current: Option<&Doc>| {
        patch.contains_key("baseUrl") && !patch.contains_key("apiKey") && url(Some(patch)) != url(current)
    };
    if unpaired(speech, current) {
        speech.insert("apiKey".into(), Value::Null);
    }
    for direction in ["stt", "tts"] {
        if let Some(Value::Object(fields)) = speech.get_mut(direction)
            && fields.contains_key("baseUrl")
            && !fields.contains_key("apiKey")
            && unpaired(fields, current.and_then(|c| c.get(direction)).and_then(Value::as_object))
        {
            fields.insert("apiKey".into(), Value::Null);
        }
    }
    patch
}
