use super::*;

#[test]
fn server_owner_is_normalized_and_sanitized() {
    let server = json!({"logLevel": " info ", "updateFeed": "dev", "opencodeBinary": "opencode",
        "speech": {"apiKey": " k ", "stt": {"apiKey": ""}, "tts": {"hasApiKey": true}}});
    let normalized = normalize_server(owner(Some(&server)));
    assert_eq!(
        Value::Object(normalized.clone()),
        json!({"logLevel": "INFO", "opencodeBinary": "opencode2",
        "speech": {"apiKey": " k ", "stt": {"apiKey": ""}, "tts": {"hasApiKey": true}}})
    );
    assert_eq!(normalize_server(owner(Some(&json!({"logLevel": 3}))))["logLevel"], "DEBUG");
    assert_eq!(
        Value::Object(sanitize_server(normalized))["speech"],
        json!({"hasApiKey": true,
        "stt": {"hasApiKey": false}, "tts": {"hasApiKey": false}})
    );
}

#[test]
fn speech_keys_follow_their_base_url() {
    let current = owner(Some(&json!({"speech": {"baseUrl": "a", "stt": {"baseUrl": "s"}}})));
    let patch = json!({"speech": {"baseUrl": "b", "stt": {"baseUrl": "s"}, "tts": {"baseUrl": "t"}}});
    assert_eq!(
        speech_pairing(&patch, &current),
        json!({"speech": {"baseUrl": "b", "apiKey": null,
        "stt": {"baseUrl": "s"}, "tts": {"baseUrl": "t", "apiKey": null}}})
    );
    let kept = json!({"speech": {"baseUrl": "a", "apiKey": "new"}});
    assert_eq!(speech_pairing(&kept, &current), kept);
    // A nested speech.speech object must never shadow the effective speech.baseUrl reference.
    let nested_bypass = owner(Some(&json!({
        "speech": {
            "baseUrl": "https://trusted.example/v1",
            "apiKey": "secret",
            "speech": {"baseUrl": "https://attacker.invalid/v1"}
        }
    })));
    assert_eq!(
        speech_pairing(&json!({"speech": {"baseUrl": "https://attacker.invalid/v1"}}), &nested_bypass),
        json!({"speech": {"baseUrl": "https://attacker.invalid/v1", "apiKey": null}})
    );
}

#[test]
fn remote_writes_cannot_flip_host_only_settings() {
    let doc = |value: Value| owner(Some(&value));
    let (off, on) = (doc(json!({"server": {}})), doc(json!({"server": {"sidecarsOverDirectHttps": true}})));
    assert!(matches!(host_only(&off, &on), Err(Failure::HostOnly)));
    assert!(matches!(host_only(&on, &doc(json!({}))), Err(Failure::HostOnly)));
    assert!(host_only(&on, &doc(json!({"server": {"sidecarsOverDirectHttps": true, "x": 1}}))).is_ok());
}

#[test]
fn owners_follow_the_reference_documents() {
    let dir = crate::shared::test_dir("settings-patch");
    let settings = Settings::new(Location::resolve(dir.join("config.yaml").to_str().unwrap()));
    let id = settings.server_id().unwrap();
    assert_eq!(settings.server_id().unwrap(), id);
    let saved = settings.patch(Kind::Config, "server", &json!({"logLevel": "warn", "x": null})).ok();
    assert_eq!(saved, Some(json!({"serverId": id, "logLevel": "WARN"})));
    assert!(matches!(settings.patch(Kind::Config, "ui", &json!([1])), Err(Failure::Invalid(_))));
    settings.patch(Kind::State, "ui", &json!({"recentFolders": [{"path": "p"}]})).ok().unwrap();
    assert_eq!(settings.owner(Kind::State, "ui")["recentFolders"][0]["path"], "p");
    // An unreadable document is displayed empty and never overwritten.
    std::fs::write(&settings.location.state, "a: [\n").unwrap();
    assert!(settings.owner(Kind::State, "ui").is_empty());
    assert!(matches!(settings.patch(Kind::State, "ui", &json!({"a": 1})), Err(Failure::Unreadable)));
    assert_eq!(std::fs::read_to_string(&settings.location.state).unwrap(), "a: [\n");
    // A legacy binary name is repaired on read; a malformed UI owner is unreadable.
    std::fs::write(&settings.location.config, "server:\n  opencodeBinary: opencode\nui:\n  settings: 1\n").unwrap();
    assert_eq!(Value::Object(settings.owner(Kind::Config, "server")), json!({"opencodeBinary": "opencode2"}));
    assert!(std::fs::read_to_string(&settings.location.config).unwrap().contains("opencode2"));
    assert_eq!(settings.raw_config_owner("ui"), Err(Unreadable));
    // M8: unreadable/corrupt config.yaml makes server_id() fail without overwriting config or sidecar.
    let corrupt_dir = crate::shared::test_dir("settings-corrupt-server-id");
    let corrupt_config = corrupt_dir.join("config.yaml");
    std::fs::write(&corrupt_config, "server: [\n").unwrap();
    let corrupt_settings = Settings::new(Location::resolve(corrupt_config.to_str().unwrap()));
    assert!(corrupt_settings.server_id().is_err());
    assert_eq!(std::fs::read_to_string(&corrupt_config).unwrap(), "server: [\n");
    assert!(!corrupt_dir.join("config.yaml.server-id").exists());
    let _ = std::fs::remove_dir_all(corrupt_dir);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn legacy_transcript_defaults_derive_only_from_authoritative_absent_fields() {
    let dir = crate::shared::test_dir("settings-transcript-legacy");
    let settings = Settings::new(Location::resolve(dir.join("config.yaml").to_str().unwrap()));
    // Legacy Everything without saved toolGroupVisibility preserves expanded on switch to custom.
    settings
        .patch(Kind::Config, "ui", &json!({"settings": {"toolCallExpansionDefaults": {"preset": "everything"}}}))
        .ok()
        .unwrap();
    let saved = settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"toolCallExpansionDefaults": {"preset": "custom", "tools": {"read": "collapsed"}}}}),
        )
        .ok()
        .unwrap();
    assert_eq!(saved["settings"]["toolGroupVisibility"], "expanded");
    assert!(saved["settings"].get("usageMetricsExpansion").is_none());
    assert_eq!(saved["settings"]["toolCallExpansionDefaults"]["tools"]["read"], "collapsed");
    assert_eq!(saved["settings"]["toolCallExpansionDefaults"]["tools"]["bash"], "expanded");
    assert_eq!(saved["settings"]["toolCallExpansionDefaults"]["thinking"], "collapsed");

    // Balanced with thinkingBlocksExpansion: expanded and a concurrent skill edit keeps both.
    settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {
                "showThinkingBlocks": true,
                "thinkingBlocksExpansion": "expanded",
                "toolCallExpansionDefaults": {"preset": "balanced", "thinking": null, "tools": null},
                "toolGroupVisibility": "hidden"
            }}),
        )
        .ok()
        .unwrap();
    let first = settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"toolCallExpansionDefaults": {"preset": "custom", "tools": {"skill": "hidden"}}}}),
        )
        .ok()
        .unwrap();
    assert_eq!(first["settings"]["toolGroupVisibility"], "hidden");
    assert_eq!(first["settings"]["usageMetricsExpansion"], "collapsed");
    assert_eq!(first["settings"]["toolCallExpansionDefaults"]["thinking"], "expanded");
    assert_eq!(first["settings"]["toolCallExpansionDefaults"]["tools"]["skill"], "hidden");
    assert_eq!(first["settings"]["toolCallExpansionDefaults"]["tools"]["bash"], "expanded");
    assert_eq!(first["settings"]["toolCallExpansionDefaults"]["tools"]["read"], "collapsed");

    // A concurrent minimal patch for read arriving after skill:hidden keeps skill:hidden.
    let second = settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"toolCallExpansionDefaults": {"preset": "custom", "tools": {"read": "expanded"}}}}),
        )
        .ok()
        .unwrap();
    assert_eq!(second["settings"]["toolCallExpansionDefaults"]["tools"]["read"], "expanded");
    assert_eq!(second["settings"]["toolCallExpansionDefaults"]["tools"]["skill"], "hidden");

    // Retired detailed with other:hidden preserves hidden for unlisted tools like write.
    settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"toolCallExpansionDefaults": {"preset": "detailed", "tools": null}}}),
        )
        .ok()
        .unwrap();
    settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"toolCallExpansionDefaults": {"preset": "detailed", "tools": {"other": "hidden"}}}}),
        )
        .ok()
        .unwrap();
    let detailed = settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"toolCallExpansionDefaults": {"preset": "custom", "tools": {"read": "expanded"}}}}),
        )
        .ok()
        .unwrap();
    assert_eq!(detailed["settings"]["toolCallExpansionDefaults"]["tools"]["read"], "expanded");
    assert_eq!(detailed["settings"]["toolCallExpansionDefaults"]["tools"]["write"], "hidden");
    assert_eq!(detailed["settings"]["toolCallExpansionDefaults"]["tools"]["skill"], "collapsed");

    // Retired detailed with tools.other: "hidden" switching to custom via thinking expansion alone
    // must still freeze read/skill/invalid at "collapsed" and other tools at "hidden".
    settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"toolCallExpansionDefaults": {"preset": "detailed", "tools": null}}}),
        )
        .ok()
        .unwrap();
    settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"toolCallExpansionDefaults": {"preset": "detailed", "tools": {"other": "hidden"}}}}),
        )
        .ok()
        .unwrap();
    let detailed_thinking = settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"thinkingBlocksExpansion": "expanded", "toolCallExpansionDefaults": {"preset": "custom", "thinking": "expanded"}}}),
        )
        .ok()
        .unwrap();
    assert_eq!(detailed_thinking["settings"]["toolCallExpansionDefaults"]["thinking"], "expanded");
    assert_eq!(detailed_thinking["settings"]["toolCallExpansionDefaults"]["tools"]["read"], "collapsed");
    assert_eq!(detailed_thinking["settings"]["toolCallExpansionDefaults"]["tools"]["write"], "hidden");

    settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"toolCallExpansionDefaults": {"preset": "detailed", "thinking": null, "tools": null}}}),
        )
        .ok()
        .unwrap();
    settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"toolCallExpansionDefaults": {"preset": "detailed", "tools": {"other": "hidden"}}}}),
        )
        .ok()
        .unwrap();
    let detailed_legacy_thinking = settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"thinkingBlocksExpansion": "expanded", "toolCallExpansionDefaults": {"preset": "custom"}}}),
        )
        .ok()
        .unwrap();
    assert_eq!(detailed_legacy_thinking["settings"]["toolCallExpansionDefaults"]["thinking"], "expanded");
    assert_eq!(detailed_legacy_thinking["settings"]["toolCallExpansionDefaults"]["tools"]["read"], "collapsed");
    assert_eq!(detailed_legacy_thinking["settings"]["toolCallExpansionDefaults"]["tools"]["write"], "hidden");

    // Partial custom hiding "other" freezes unlisted tools at their pre-patch effective value.
    settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"toolOutputExpansion": "expanded", "toolCallExpansionDefaults": {"preset": "custom", "tools": null}}}),
        )
        .ok()
        .unwrap();
    settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"toolCallExpansionDefaults": {"preset": "custom", "tools": {"bash": "collapsed"}}}}),
        )
        .ok()
        .unwrap();
    let partial_custom = settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"toolCallExpansionDefaults": {"preset": "custom", "tools": {"other": "hidden"}}}}),
        )
        .ok()
        .unwrap();
    assert_eq!(partial_custom["settings"]["toolCallExpansionDefaults"]["tools"]["other"], "hidden");
    assert_eq!(partial_custom["settings"]["toolCallExpansionDefaults"]["tools"]["bash"], "collapsed");
    assert_eq!(partial_custom["settings"]["toolCallExpansionDefaults"]["tools"]["write"], "expanded");

    // Explicit tools: null deletion is honored rather than overwritten.
    settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"toolCallExpansionDefaults": {"preset": "balanced", "tools": {"read": "hidden"}}}}),
        )
        .ok()
        .unwrap();
    let deleted = settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"showThinkingBlocks": false, "toolCallExpansionDefaults": {"preset": "custom", "tools": null}}}),
        )
        .ok()
        .unwrap();
    assert!(deleted["settings"]["toolCallExpansionDefaults"].get("tools").is_none());

    // Explicit thinkingBlocksExpansion in the same PATCH is not clobbered by legacy fallback.
    settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"thinkingBlocksExpansion": "collapsed", "toolCallExpansionDefaults": {"preset": "balanced", "thinking": null, "tools": null}}}),
        )
        .ok()
        .unwrap();
    let explicit_thinking = settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"thinkingBlocksExpansion": "expanded", "toolCallExpansionDefaults": {"preset": "custom", "tools": {"read": "expanded"}}}}),
        )
        .ok()
        .unwrap();
    assert_eq!(explicit_thinking["settings"]["thinkingBlocksExpansion"], "expanded");
    assert_eq!(explicit_thinking["settings"]["toolCallExpansionDefaults"]["thinking"], "expanded");

    // Hiding Tokens on a partial detailed profile freezes implicit usageMetricsExpansion ("expanded"),
    // without clobbering an explicit concurrent usageMetricsExpansion ("collapsed").
    settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"usageMetricsExpansion": null, "toolCallExpansionDefaults": {"preset": "detailed"}}}),
        )
        .ok()
        .unwrap();
    let hidden_detailed_usage =
        settings.patch(Kind::Config, "ui", &json!({"settings": {"showUsageMetrics": false}})).ok().unwrap();
    assert_eq!(hidden_detailed_usage["settings"]["showUsageMetrics"], false);
    assert_eq!(hidden_detailed_usage["settings"]["usageMetricsExpansion"], "expanded");

    settings.patch(Kind::Config, "ui", &json!({"settings": {"usageMetricsExpansion": "collapsed"}})).ok().unwrap();
    let hidden_explicit_usage =
        settings.patch(Kind::Config, "ui", &json!({"settings": {"showUsageMetrics": false}})).ok().unwrap();
    assert_eq!(hidden_explicit_usage["settings"]["usageMetricsExpansion"], "collapsed");

    // Explicit null entries on a fresh empty profile strip nulls instead of storing null keys.
    let fresh_settings = Settings::new(Location::resolve(dir.join("fresh-config.yaml").to_str().unwrap()));
    let fresh_deleted = fresh_settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"showThinkingBlocks": false, "toolCallExpansionDefaults": {"preset": "custom", "thinking": null, "tools": null}}}),
        )
        .ok()
        .unwrap();
    assert!(fresh_deleted["settings"]["toolCallExpansionDefaults"].get("tools").is_none());
    assert!(fresh_deleted["settings"]["toolCallExpansionDefaults"].get("thinking").is_none());
    let fresh_usage_settings = Settings::new(Location::resolve(dir.join("fresh-usage-null.yaml").to_str().unwrap()));
    let fresh_usage_null = fresh_usage_settings
        .patch(Kind::Config, "ui", &json!({"settings": {"showUsageMetrics": false, "usageMetricsExpansion": null}}))
        .ok()
        .unwrap();
    assert_eq!(fresh_usage_null["settings"]["showUsageMetrics"], false);
    assert!(fresh_usage_null["settings"].get("usageMetricsExpansion").is_none());
    let fresh_balanced_settings = Settings::new(Location::resolve(dir.join("fresh-balanced.yaml").to_str().unwrap()));
    let fresh_balanced = fresh_balanced_settings
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"toolCallExpansionDefaults": {"preset": "balanced", "tools": null}}}),
        )
        .ok()
        .unwrap();
    assert!(fresh_balanced["settings"]["toolCallExpansionDefaults"].get("tools").is_none());

    // Pure preset:"custom" PATCH on a partial "nothing" profile preserves inherited hidden tools.
    let nothing_settings = Settings::new(Location::resolve(dir.join("nothing-config.yaml").to_str().unwrap()));
    nothing_settings
        .patch(Kind::Config, "ui", &json!({"settings": {"toolCallExpansionDefaults": {"preset": "nothing"}}}))
        .ok()
        .unwrap();
    let pure_custom = nothing_settings
        .patch(Kind::Config, "ui", &json!({"settings": {"toolCallExpansionDefaults": {"preset": "custom"}}}))
        .ok()
        .unwrap();
    assert_eq!(pure_custom["settings"]["usageMetricsExpansion"], "collapsed");
    assert_eq!(pure_custom["settings"]["toolCallExpansionDefaults"]["tools"]["read"], "hidden");
    assert_eq!(pure_custom["settings"]["toolCallExpansionDefaults"]["tools"]["bash"], "hidden");

    // Partial "detailed" profile without a tools object strips explicit read:null instead of persisting null.
    let detailed_null = Settings::new(Location::resolve(dir.join("detailed-null.yaml").to_str().unwrap()));
    detailed_null
        .patch(Kind::Config, "ui", &json!({"settings": {"toolCallExpansionDefaults": {"preset": "detailed"}}}))
        .ok()
        .unwrap();
    let detailed_deleted_read = detailed_null
        .patch(
            Kind::Config,
            "ui",
            &json!({"settings": {"toolCallExpansionDefaults": {"preset": "custom", "tools": {"read": null}}}}),
        )
        .ok()
        .unwrap();
    assert!(detailed_deleted_read["settings"]["toolCallExpansionDefaults"]["tools"].get("read").is_none());
    assert_eq!(detailed_deleted_read["settings"]["toolCallExpansionDefaults"]["tools"]["skill"], "collapsed");
    assert_eq!(detailed_deleted_read["settings"]["toolCallExpansionDefaults"]["tools"]["bash"], "expanded");

    // Deeply nested RFC 7396 nulls inside newly created containers under settings are stripped recursively.
    let nested_null_settings = Settings::new(Location::resolve(dir.join("nested-null.yaml").to_str().unwrap()));
    let nested_null = nested_null_settings
        .patch(Kind::Config, "ui", &json!({"settings": {"notificationRouting": {"sessionDone": {"system": null}}}}))
        .ok()
        .unwrap();
    assert_eq!(nested_null["settings"]["notificationRouting"]["sessionDone"]["screen"], false);
    assert!(nested_null["settings"]["notificationRouting"]["sessionDone"].get("system").is_none());

    // Top-level {settings: null} on an empty profile strips settings instead of storing null.
    let null_settings = Settings::new(Location::resolve(dir.join("null-settings.yaml").to_str().unwrap()));
    let stripped_ui = null_settings.patch(Kind::Config, "ui", &json!({"settings": null})).ok().unwrap();
    assert!(stripped_ui.get("settings").is_none());
    assert!(null_settings.raw_config_owner("ui").is_ok());

    // First notificationRouting migration seeds legacy flags under the write lock without clobbering concurrent cells.
    let routing_settings = Settings::new(Location::resolve(dir.join("routing.yaml").to_str().unwrap()));
    routing_settings
        .patch(Kind::Config, "ui", &json!({"settings": {"osNotificationsEnabled": false, "notifyOnIdle": false}}))
        .ok()
        .unwrap();
    let routed1 = routing_settings
        .patch(Kind::Config, "ui", &json!({"settings": {"notificationRouting": {"copy": {"history": true}}}}))
        .ok()
        .unwrap();
    assert_eq!(routed1["settings"]["notificationRouting"]["copy"]["history"], true);
    assert_eq!(routed1["settings"]["notificationRouting"]["updates"]["system"], false);
    assert_eq!(routed1["settings"]["notificationRouting"]["sessionDone"]["system"], false);
    let routed2 = routing_settings
        .patch(Kind::Config, "ui", &json!({"settings": {"notificationRouting": {"files": {"screen": false}}}}))
        .ok()
        .unwrap();
    assert_eq!(routed2["settings"]["notificationRouting"]["copy"]["history"], true);
    assert_eq!(routed2["settings"]["notificationRouting"]["files"]["screen"], false);

    // Atomic secureEnvVarsMask merges concurrent secrets under the write lock without storing the transient key.
    let env_settings = Settings::new(Location::resolve(dir.join("env-mask.yaml").to_str().unwrap()));
    let first_env = env_settings
        .patch(
            Kind::Config,
            "server",
            &json!({"environmentVariables": {"SECRET_A": "1"}, "secureEnvVarsMask": {"SECRET_A": true}}),
        )
        .ok()
        .unwrap();
    assert_eq!(first_env["secureEnvVars"], json!(["SECRET_A"]));
    assert!(first_env.get("secureEnvVarsMask").is_none());
    let second_env = env_settings
        .patch(
            Kind::Config,
            "server",
            &json!({"environmentVariables": {"SECRET_B": "2"}, "secureEnvVarsMask": {"SECRET_B": true}}),
        )
        .ok()
        .unwrap();
    assert_eq!(second_env["secureEnvVars"], json!(["SECRET_A", "SECRET_B"]));
    let removed_env = env_settings
        .patch(
            Kind::Config,
            "server",
            &json!({"environmentVariables": {"SECRET_A": null}, "secureEnvVarsMask": {"SECRET_A": false}}),
        )
        .ok()
        .unwrap();
    assert_eq!(removed_env["secureEnvVars"], json!(["SECRET_B"]));

    // Unicode case-folding matches Solid's toUpperCase() (É_TOKEN and é_TOKEN share one mask entry).
    let accented1 = env_settings
        .patch(
            Kind::Config,
            "server",
            &json!({"environmentVariables": {"É_TOKEN": "1"}, "secureEnvVarsMask": {"É_TOKEN": true}}),
        )
        .ok()
        .unwrap();
    let accented2 = env_settings
        .patch(
            Kind::Config,
            "server",
            &json!({"environmentVariables": {"é_TOKEN": "2"}, "secureEnvVarsMask": {"é_TOKEN": true}}),
        )
        .ok()
        .unwrap();
    assert_eq!(accented1["secureEnvVars"], json!(["SECRET_B", "É_TOKEN"]));
    assert_eq!(accented2["secureEnvVars"], json!(["SECRET_B", "é_TOKEN"]));
    let conflict_mask = env_settings
        .patch(
            Kind::Config,
            "server",
            &json!({"environmentVariables": {"TOKEN": "3"}, "secureEnvVarsMask": {"token": false, "TOKEN": true}}),
        )
        .ok()
        .unwrap();
    assert_eq!(conflict_mask["secureEnvVars"], json!(["SECRET_B", "é_TOKEN", "TOKEN"]));

    // Deleting `token` while `TOKEN` survives keeps the case-insensitive mask intact.
    let lower_env = env_settings
        .patch(
            Kind::Config,
            "server",
            &json!({"environmentVariables": {"token": "lower"}, "secureEnvVarsMask": {"token": true}}),
        )
        .ok()
        .unwrap();
    assert_eq!(lower_env["secureEnvVars"], json!(["SECRET_B", "é_TOKEN", "token"]));
    let after_del = env_settings
        .patch(
            Kind::Config,
            "server",
            &json!({"environmentVariables": {"token": null}, "secureEnvVarsMask": {"token": false}}),
        )
        .ok()
        .unwrap();
    assert_eq!(after_del["secureEnvVars"], json!(["SECRET_B", "é_TOKEN", "token"]));
    assert_eq!(after_del["environmentVariables"]["TOKEN"], "3");
    assert!(after_del["environmentVariables"].get("token").is_none());

    // Explicit `secureEnvVars: null` resets prior masks before applying `secureEnvVarsMask`.
    let reset_mask = env_settings
        .patch(Kind::Config, "server", &json!({"secureEnvVars": null, "secureEnvVarsMask": {"NEW": true}}))
        .ok()
        .unwrap();
    assert_eq!(reset_mask["secureEnvVars"], json!(["NEW"]));

    // speech_pairing runs inside the write lock and preserves explicit null deletion for stt/tts.
    let speech_settings = Settings::new(Location::resolve(dir.join("speech-lock.yaml").to_str().unwrap()));
    speech_settings
        .patch(Kind::Config, "server", &json!({"speech": {"baseUrl": "https://a.example", "apiKey": "key-a"}}))
        .ok()
        .unwrap();
    let paired_drop = speech_settings
        .patch(Kind::Config, "server", &json!({"speech": {"baseUrl": "https://b.example"}}))
        .ok()
        .unwrap();
    assert!(paired_drop["speech"].get("apiKey").is_none());
    let mut speech_current = Doc::new();
    speech_current.insert("speech".into(), json!({"stt": {"baseUrl": "https://stt.example", "apiKey": "secret"}}));
    let cleared_patch = speech_pairing(&json!({"speech": {"stt": null}}), &speech_current);
    assert_eq!(cleared_patch, json!({"speech": {"stt": null}}));

    // sanitize_server redacts voiceConversation apiKeys like TS publicVoiceConversationConfig
    // (matching JS String.prototype.trim(): strips U+FEFF BOM, does NOT strip U+0085 NEL).
    let mut raw_server = Doc::new();
    raw_server.insert(
        "voiceConversation".into(),
        json!({
            "geminiLive": {"apiKey": "\u{feff}gem-secret", "model": "gem-secret", "voice": "Puck"},
            "openaiRealtime": {"apiKey": "oa-secret", "model": "gpt-realtime", "voice": "Alloy"}
        }),
    );
    raw_server.insert("speech".into(), json!({"apiKey": "\u{feff}"}));
    let clean = sanitize_server(raw_server);
    assert_eq!(clean["speech"], json!({"hasApiKey": false}));
    assert_eq!(
        clean["voiceConversation"],
        json!({
            "geminiLive": {"hasApiKey": true, "voice": "Puck"},
            "openaiRealtime": {"hasApiKey": true, "model": "gpt-realtime", "voice": "Alloy"}
        })
    );
    let mut non_obj_speech = Doc::new();
    non_obj_speech.insert("speech".into(), json!("not-an-object"));
    assert!(sanitize_server(non_obj_speech).get("speech").is_none());
    // assert_voice_conversation_patch & check_conversation_default reject invalid patches with 400.
    assert!(assert_voice_conversation_patch(&json!({"voiceConversation": {"geminiLive": {"apiKey": 123}}})).is_err());
    assert!(
        assert_voice_conversation_patch(
            &json!({"voiceConversation": {"geminiLive": {"apiKey": "\u{0085}demo\u{0085}"}}})
        )
        .is_err()
    );
    assert!(
        assert_voice_conversation_patch(&json!({"voiceConversation": {"geminiLive": {"model": "gemini-live-2.5"}}}))
            .is_ok()
    );
    assert!(
        check_conversation_default(
            &Doc::new(),
            &json!({"ui": {"settings": {"newConversationPermissions": "invalid"}}}).as_object().unwrap().clone()
        )
        .is_err()
    );
    assert!(
        check_conversation_default(
            &Doc::new(),
            &json!({"ui": {"settings": {"newConversationPermissions": "supervised"}}}).as_object().unwrap().clone()
        )
        .is_ok()
    );

    // Editing TOKEN with mask=false removes legacy mixed-case ["Token"] even when both variants exist.
    let mixed_settings = Settings::new(Location::resolve(dir.join("mixed-mask.yaml").to_str().unwrap()));
    mixed_settings
        .patch(
            Kind::Config,
            "server",
            &json!({"environmentVariables": {"TOKEN": "old", "token": "other"}, "secureEnvVars": ["Token"]}),
        )
        .ok()
        .unwrap();
    let after_mixed = mixed_settings
        .patch(
            Kind::Config,
            "server",
            &json!({"environmentVariables": {"TOKEN": "new"}, "secureEnvVarsMask": {"TOKEN": false}}),
        )
        .ok()
        .unwrap();
    assert_eq!(after_mixed["secureEnvVars"], json!([]));

    // Remote project history compaction matches TS: out-of-order access, profile purge, legacy delete.
    let rh_settings = Settings::new(Location::resolve(dir.join("remote-history.yaml").to_str().unwrap()));
    let first_p = json!({"id": "first", "baseUrl": "https://first.example", "skipTlsVerify": false});
    let second_p =
        json!({"id": "second", "baseUrl": "https://second.example", "skipTlsVerify": true, "ssh": {"host": "remote"}});
    let key_first =
        serde_json::to_string(&json!(["first", "https://first.example", false, null, "/canonical"])).unwrap();
    let key_legacy = serde_json::to_string(&json!(["first", "https://first.example", false, null, "/legacy"])).unwrap();
    let _ = rh_settings
        .patch(
            Kind::State,
            "ui",
            &json!({
                "remoteServers": [
                    {"id": "first", "name": "first", "baseUrl": "https://first.example", "skipTlsVerify": false},
                    {"id": "second", "name": "second", "baseUrl": "https://second.example", "skipTlsVerify": true, "ssh": {"host": "remote"}}
                ],
                "remoteProjectRecents": [
                    {"policy": first_p, "path": "/legacy", "lastAccessed": 50}
                ]
            }),
        )
        .ok()
        .unwrap();
    let after_legacy_del = rh_settings
        .patch(Kind::State, "ui", &json!({"remoteProjectHistory": {key_legacy.clone(): null}}))
        .ok()
        .unwrap();
    assert_eq!(after_legacy_del["remoteProjectHistory"], json!({}));
    assert!(after_legacy_del.get("remoteProjectRecents").is_none());
    let _ = rh_settings
        .patch(
            Kind::State,
            "ui",
            &json!({"remoteProjectHistory": {key_first.clone(): {"policy": first_p, "path": "/canonical", "lastAccessed": 300}}}),
        )
        .ok()
        .unwrap();
    let after_older = rh_settings
        .patch(
            Kind::State,
            "ui",
            &json!({"remoteProjectHistory": {key_first.clone(): {"policy": first_p, "path": "/canonical", "lastAccessed": 100}}}),
        )
        .ok()
        .unwrap();
    assert_eq!(after_older["remoteProjectHistory"][&key_first]["lastAccessed"], 300);
    // Removing a profile purges its history entries.
    let after_profile_drop = rh_settings
        .patch(
            Kind::State,
            "ui",
            &json!({"remoteServers": [{"id": "second", "name": "second", "baseUrl": "https://second.example", "skipTlsVerify": true, "ssh": {"host": "remote"}}]}),
        )
        .ok()
        .unwrap();
    assert_eq!(after_profile_drop["remoteProjectHistory"], json!({}));

    // Equal-timestamp tie-breaking at the 20-entry limit matches JS wire insertion order (/z first, /a20 evicted).
    let mut raw_entries = Vec::new();
    let z_key = serde_json::to_string(&json!(["second", "https://second.example", true, "remote", "/z"])).unwrap();
    raw_entries.push(format!(
        "{}:{}",
        serde_json::to_string(&z_key).unwrap(),
        json!({"policy": second_p, "path": "/z", "lastAccessed": 500})
    ));
    for i in 1..=20usize {
        let path = format!("/a{i:02}");
        let key = serde_json::to_string(&json!(["second", "https://second.example", true, "remote", path])).unwrap();
        raw_entries.push(format!(
            "{}:{}",
            serde_json::to_string(&key).unwrap(),
            json!({"policy": second_p, "path": path, "lastAccessed": 500})
        ));
    }
    let raw_json = format!(r#"{{"remoteProjectHistory":{{{}}}}}"#, raw_entries.join(","));
    let wire_order = remote_project_history::json_history_key_order(raw_json.as_bytes());
    let parsed: Value = serde_json::from_str(&raw_json).unwrap();
    let (after_tied, tied_order) =
        rh_settings.patch_checked_with_order(Kind::State, "ui", &parsed, &wire_order, |_, _| Ok(())).ok().unwrap();
    let wire_reply =
        serde_json::to_string(&remote_project_history::OrderedStateOwner(after_tied.as_object().unwrap(), &tied_order))
            .unwrap();
    assert!(
        wire_reply.find("/z").unwrap() < wire_reply.find("/a01").unwrap(),
        "JSON wire response must preserve /z before /a01"
    );
    let kept = after_tied["remoteProjectHistory"].as_object().unwrap();
    assert_eq!(kept.len(), 20);
    assert!(kept.contains_key(&z_key), "first wire-order entry /z must survive equal-timestamp compaction");
    let dropped_key =
        serde_json::to_string(&json!(["second", "https://second.example", true, "remote", "/a20"])).unwrap();
    assert!(!kept.contains_key(&dropped_key), "21st wire-order entry /a20 must be deterministically evicted");
    // Subsequent PATCH adding a newer entry reads persisted YAML order (/z first, /a19 last) and evicts /a19, not /z.
    let newer_key =
        serde_json::to_string(&json!(["second", "https://second.example", true, "remote", "/newer"])).unwrap();
    let after_newer = rh_settings
        .patch(
            Kind::State,
            "ui",
            &json!({"remoteProjectHistory": {newer_key.clone(): {"policy": second_p, "path": "/newer", "lastAccessed": 600}}}),
        )
        .ok()
        .unwrap();
    let kept2 = after_newer["remoteProjectHistory"].as_object().unwrap();
    let a19_key = serde_json::to_string(&json!(["second", "https://second.example", true, "remote", "/a19"])).unwrap();
    assert!(kept2.contains_key(&z_key), "persisted YAML order must keep /z on subsequent eviction");
    assert!(kept2.contains_key(&newer_key));
    assert!(!kept2.contains_key(&a19_key), "persisted YAML order must evict /a19 on subsequent newer entry");

    // Legacy remoteProjectRecents order is preserved across its first migration + newer entry,
    // and Windows paths under 4096 UTF-16 code units (>4096 UTF-8 bytes) survive compaction.
    let legacy_recents_path = dir.join("legacy-recents-state.yaml");
    let legacy_recents_settings = Settings::new(Location::resolve(legacy_recents_path.to_str().unwrap()));
    let mut legacy_items = vec![json!({"policy": second_p, "path": "/z", "lastAccessed": 500})];
    for i in 1..=19usize {
        legacy_items.push(json!({"policy": second_p, "path": format!("/a{i:02}"), "lastAccessed": 500}));
    }
    let mut legacy_doc = Doc::new();
    legacy_doc.insert(
        "ui".into(),
        json!({
            "remoteServers": [{"id": "second", "name": "second", "baseUrl": "https://second.example", "skipTlsVerify": true, "ssh": {"host": "remote"}}],
            "remoteProjectRecents": legacy_items,
        }),
    );
    document::write(&legacy_recents_settings.location.state, &legacy_doc).unwrap();
    let after_legacy_newer = legacy_recents_settings
        .patch(
            Kind::State,
            "ui",
            &json!({"remoteProjectHistory": {newer_key.clone(): {"policy": second_p, "path": "/newer", "lastAccessed": 600}}}),
        )
        .ok()
        .unwrap();
    let kept_legacy = after_legacy_newer["remoteProjectHistory"].as_object().unwrap();
    assert!(kept_legacy.contains_key(&z_key), "legacy remoteProjectRecents order must keep /z");
    assert!(!kept_legacy.contains_key(&a19_key), "legacy remoteProjectRecents order must evict /a19");

    let unicode_win_path = format!("C:\\{}", std::iter::repeat_n("界".repeat(160), 10).collect::<Vec<_>>().join("\\"));
    assert!(unicode_win_path.len() > 4096 && unicode_win_path.encode_utf16().count() < 4096);
    let unicode_win_key = serde_json::to_string(&json!([
        "second",
        "https://second.example",
        true,
        "remote",
        unicode_win_path.replace('\\', "/").to_lowercase()
    ]))
    .unwrap();
    let after_utf16 = legacy_recents_settings
        .patch(
            Kind::State,
            "ui",
            &json!({"remoteProjectHistory": {unicode_win_key.clone(): {"policy": second_p, "path": unicode_win_path, "lastAccessed": 700}}}),
        )
        .ok()
        .unwrap();
    assert!(
        after_utf16["remoteProjectHistory"].as_object().unwrap().contains_key(&unicode_win_key),
        "Windows Unicode path under 4096 UTF-16 units must survive compaction"
    );

    // Empty query (`?`) and legacy truthy `skipTlsVerify: "true"` match JS selection-policy.ts.
    let query_policy = json!({"id": "q", "baseUrl": "https://example.test/?", "skipTlsVerify": true});
    let query_key = serde_json::to_string(&json!(["q", "https://example.test/?", true, null, "/q"])).unwrap();
    let mut q_doc = Doc::new();
    q_doc.insert(
        "ui".into(),
        json!({
            "remoteServers": [{"id": "q", "name": "q", "baseUrl": "https://example.test/?", "skipTlsVerify": "true"}],
            "remoteProjectHistory": {
                query_key.clone(): {"policy": query_policy, "path": "/q", "lastAccessed": 100}
            }
        }),
    );
    let q_settings = Settings::new(Location::resolve(dir.join("query-policy.yaml").to_str().unwrap()));
    document::write(&q_settings.location.state, &q_doc).unwrap();
    let after_q = q_settings.patch(Kind::State, "ui", &json!({"recentFolders": []})).ok().unwrap();
    assert!(
        after_q["remoteProjectHistory"].as_object().unwrap().contains_key(&query_key),
        "empty `?` baseUrl and legacy truthy skipTlsVerify must survive compaction"
    );

    // Unicode case-folding in secureEnvVarsMask matches Solid's toUpperCase().
    let unicode_env = Settings::new(Location::resolve(dir.join("unicode-env.yaml").to_str().unwrap()));
    let saved_u = unicode_env
        .patch(
            Kind::Config,
            "server",
            &json!({"environmentVariables": {"É_TOKEN": "1", "é_TOKEN": "2"}, "secureEnvVars": ["É_TOKEN"]}),
        )
        .ok()
        .unwrap();
    assert_eq!(saved_u["secureEnvVars"], json!(["É_TOKEN"]));
    let after_del_one = unicode_env
        .patch(
            Kind::Config,
            "server",
            &json!({"environmentVariables": {"é_TOKEN": null}, "secureEnvVarsMask": {"é_TOKEN": false}}),
        )
        .ok()
        .unwrap();
    assert_eq!(after_del_one["secureEnvVars"], json!(["É_TOKEN"]));
    let after_del_last = unicode_env
        .patch(
            Kind::Config,
            "server",
            &json!({"environmentVariables": {"É_TOKEN": null}, "secureEnvVarsMask": {"É_TOKEN": false}}),
        )
        .ok()
        .unwrap();
    assert_eq!(after_del_last["secureEnvVars"], json!([]));

    // Deleting a notification category, environment variable, or state/ui field on first creation leaves it absent.
    let deleted_cat_settings = Settings::new(Location::resolve(dir.join("deleted-cat.yaml").to_str().unwrap()));
    let deleted_cat = deleted_cat_settings
        .patch(Kind::Config, "ui", &json!({"settings": {"notificationRouting": {"sessionDone": null}}}))
        .ok()
        .unwrap();
    assert!(deleted_cat["settings"]["notificationRouting"].get("sessionDone").is_none());
    assert!(deleted_cat["settings"]["notificationRouting"].get("needsInput").is_some());

    let deleted_env_settings = Settings::new(Location::resolve(dir.join("deleted-env.yaml").to_str().unwrap()));
    let deleted_env = deleted_env_settings
        .patch(Kind::Config, "server", &json!({"environmentVariables": {"TOKEN": null}}))
        .ok()
        .unwrap();
    assert_eq!(deleted_env["environmentVariables"], json!({}));

    let deleted_state_settings = Settings::new(Location::resolve(dir.join("deleted-state.yaml").to_str().unwrap()));
    let deleted_state = deleted_state_settings
        .patch(
            Kind::State,
            "ui",
            &json!({"appearancePreferences": {"light": {"presetId": null, "scheme": {"id": "linen"}}}}),
        )
        .ok()
        .unwrap();
    assert!(deleted_state["appearancePreferences"]["light"].get("presetId").is_none());
    assert_eq!(deleted_state["appearancePreferences"]["light"]["scheme"]["id"], "linen");

    // JS trim parity (`\u{0085}` is non-whitespace in ECMAScript), exact float_roundtrip
    // (`1700000000000.0003` vs `.0004`), and replace_private_state compacting legacy recents.
    let nel_settings = Settings::new(Location::resolve(dir.join("nel-float.yaml").to_str().unwrap()));
    let nel_policy = json!({"id": "nel", "baseUrl": "https://nel.example", "skipTlsVerify": false});
    let nel_key_old = serde_json::to_string(&json!(["nel", "https://nel.example", false, null, "/old"])).unwrap();
    let nel_key_new = serde_json::to_string(&json!(["nel", "https://nel.example", false, null, "/new"])).unwrap();
    let mut nel_doc = Doc::new();
    nel_doc.insert(
        "ui".into(),
        json!({
            "remoteServers": [{"id": "nel", "name": "\u{0085}", "baseUrl": "https://nel.example", "skipTlsVerify": false}],
            "remoteProjectRecents": [{"policy": nel_policy, "path": "/legacy", "lastAccessed": 100}]
        }),
    );
    document::write(&nel_settings.location.state, &nel_doc).unwrap();
    assert!(
        nel_settings
            .replace_private_state("sessionPermissionBlocks", "ses-1", None, Some(json!({"blocked": true})))
            .unwrap()
    );
    let after_private = document::read(&nel_settings.location.state).unwrap();
    assert!(
        after_private["ui"].get("remoteProjectRecents").is_none()
            && after_private["ui"]["remoteProjectHistory"].as_object().is_some_and(|m| m.len() == 1),
        "replace_private_state must compact legacy remoteProjectRecents and keep \\u{{0085}} profile"
    );
    let mut float_entries = vec![
        format!(
            "{}:{}",
            serde_json::to_string(&nel_key_old).unwrap(),
            r#"{"policy":{"id":"nel","baseUrl":"https://nel.example","skipTlsVerify":false},"path":"/old","lastAccessed":1700000000000.0003}"#
        ),
        format!(
            "{}:{}",
            serde_json::to_string(&nel_key_new).unwrap(),
            r#"{"policy":{"id":"nel","baseUrl":"https://nel.example","skipTlsVerify":false},"path":"/new","lastAccessed":1700000000000.0004}"#
        ),
    ];
    for i in 1..=19usize {
        let path = format!("/p{i:02}");
        let key = serde_json::to_string(&json!(["nel", "https://nel.example", false, null, path])).unwrap();
        float_entries.push(format!(
            "{}:{}",
            serde_json::to_string(&key).unwrap(),
            json!({"policy": nel_policy, "path": path, "lastAccessed": 1700000000001.0 + i as f64})
        ));
    }
    let float_json = format!(r#"{{"remoteProjectHistory":{{{}}}}}"#, float_entries.join(","));
    let float_order = remote_project_history::json_history_key_order(float_json.as_bytes());
    let float_patch: Value = serde_json::from_str(&float_json).unwrap();
    let (after_float, _) = nel_settings
        .patch_checked_with_order(Kind::State, "ui", &float_patch, &float_order, |_, _| Ok(()))
        .ok()
        .unwrap();
    let kept_float = after_float["remoteProjectHistory"].as_object().unwrap();
    assert!(kept_float.contains_key(&nel_key_new), "float_roundtrip must keep .0004 over .0003");
    assert!(!kept_float.contains_key(&nel_key_old), "float_roundtrip must evict .0003");

    // Large JS integer timestamps (>= 2^64) written by TS as unquoted YAML integers must remain
    // readable by Rust and never saturate to u64::MAX on direct Rust PATCH.
    let big_ts_settings = Settings::new(Location::resolve(dir.join("big-ts.yaml").to_str().unwrap()));
    let big_key = serde_json::to_string(&json!(["nel", "https://nel.example", false, null, "/big"])).unwrap();
    let big_yaml = format!(
        "ui:\n  remoteServers:\n    - id: nel\n      name: nel\n      baseUrl: https://nel.example\n      skipTlsVerify: false\n  remoteProjectHistory:\n    {}: \n      policy:\n        id: nel\n        baseUrl: https://nel.example\n        skipTlsVerify: false\n      path: /big\n      lastAccessed: 18446744073709552000\n",
        serde_json::to_string(&big_key).unwrap()
    );
    std::fs::write(&big_ts_settings.location.state, big_yaml).unwrap();
    let read_big = big_ts_settings.private_state_owner("ui").unwrap();
    assert_eq!(read_big["remoteProjectHistory"][&big_key]["lastAccessed"].as_f64(), Some(18446744073709551616.0));
    let patched_big = big_ts_settings
        .patch(
            Kind::State,
            "ui",
            &json!({"remoteProjectHistory": {big_key.clone(): {"policy": nel_policy, "path": "/big", "lastAccessed": 18446744073709551616.0}}}),
        )
        .ok()
        .unwrap();
    assert_eq!(
        patched_big["remoteProjectHistory"][&big_key]["lastAccessed"].as_f64(),
        Some(18446744073709551616.0),
        "2^64 lastAccessed must not saturate to u64::MAX"
    );

    // Non-finite YAML floats (.nan / .inf) in an invalid history entry must only drop that
    // entry instead of failing authoritative reads with 503.
    let nan_settings = Settings::new(Location::resolve(dir.join("nan-state.yaml").to_str().unwrap()));
    let nan_yaml = format!(
        "ui:\n  keep: true\n  note: !keep exemple\n  123: old\n  \"123\": note\n  remoteServers:\n    - id: nel\n      name: nel\n      baseUrl: https://nel.example\n      skipTlsVerify: false\n  remoteProjectHistory:\n    {}:\n      policy:\n        id: nel\n        baseUrl: https://nel.example\n        skipTlsVerify: false\n      path: /big\n      lastAccessed: .nan\n",
        serde_json::to_string(&big_key).unwrap()
    );
    std::fs::write(&nan_settings.location.state, nan_yaml).unwrap();
    let read_nan = nan_settings.private_state_owner("ui").unwrap();
    assert_eq!(read_nan["keep"], true);
    assert_eq!(read_nan["note"], "exemple");
    assert_eq!(read_nan["123"], "note");
    assert_eq!(read_nan["remoteProjectHistory"], json!({}));

    // Invalid non-boolean secureEnvVarsMask is rejected cleanly without saving the secret unmasked.
    assert!(
        env_settings
            .patch(
                Kind::Config,
                "server",
                &json!({"environmentVariables": {"BAD_MASK": "secret"}, "secureEnvVarsMask": {"BAD_MASK": "true"}}),
            )
            .is_err()
    );
    // Duplicate remoteProjectHistory JSON key where the first is a non-object still preserves the last map's wire order.
    let dup_json = br#"{"remoteProjectHistory":[1],"remoteProjectHistory":{"/z":{},"a":{}}}"#;
    assert_eq!(remote_project_history::json_history_key_order(dup_json), vec!["/z", "a"]);

    // Corrupt config.yaml and non-object server owner fail authoritative reads and patches.
    let corrupt_path = dir.join("corrupt-server.yaml");
    std::fs::write(&corrupt_path, "server: [unclosed").unwrap();
    let corrupt_settings = Settings::new(Location::resolve(corrupt_path.to_str().unwrap()));
    assert!(corrupt_settings.raw_config_owner("server").is_err());
    let list_server_path = dir.join("list-server.yaml");
    std::fs::write(&list_server_path, "server:\n  - a\n  - b\n").unwrap();
    let list_server = Settings::new(Location::resolve(list_server_path.to_str().unwrap()));
    assert!(list_server.patch(Kind::Config, "server", &json!({"logLevel": "INFO"})).is_err());
    assert_eq!(std::fs::read_to_string(&list_server_path).unwrap(), "server:\n  - a\n  - b\n");

    // Indented blank line inside a multi-line plain scalar starting with 0b10, literal U+2028/U+2029
    // inside double-quoted scalars, and ECMAScript js_trim on logLevel (BOM trimmed, NEL kept).
    let yaml_edge_path = dir.join("yaml-edge.yaml");
    std::fs::write(
        &yaml_edge_path,
        "server:\n  environmentVariables:\n    CODE: 0b10\n      \n      suffix\n    LS: \"a\u{2028}b\"\n    PS: \"c\u{2029}d\"\n",
    )
    .unwrap();
    let yaml_edge = Settings::new(Location::resolve(yaml_edge_path.to_str().unwrap()));
    let read_edge = yaml_edge.raw_config_owner("server").unwrap();
    assert_eq!(read_edge["environmentVariables"]["CODE"], "0b10\nsuffix");
    assert_eq!(read_edge["environmentVariables"]["LS"], "a\u{2028}b");
    assert_eq!(read_edge["environmentVariables"]["PS"], "c\u{2029}d");
    let bom_level = yaml_edge.patch(Kind::Config, "server", &json!({"logLevel": "\u{feff}INFO"})).ok().unwrap();
    assert_eq!(bom_level["logLevel"], "INFO");
    let nel_level = yaml_edge.patch(Kind::Config, "server", &json!({"logLevel": "\u{0085}INFO"})).ok().unwrap();
    assert_eq!(nel_level["logLevel"], "DEBUG");

    // Scientific float keys (1e-7) and integers above 2^53 match ECMAScript Number::toString.
    let sci_path = dir.join("sci-keys.yaml");
    std::fs::write(
        &sci_path,
        "ui:\n  1e-7: keep1\n  \"0.0000001\": keep2\n  1e21: keep3\n  -0.0: keep4\n  9007199254740993: keep5\n",
    )
    .unwrap();
    let sci_settings = Settings::new(Location::resolve(sci_path.to_str().unwrap()));
    let after_sci =
        sci_settings.patch(Kind::Config, "ui", &json!({"settings": {"showThinkingBlocks": true}})).ok().unwrap();
    assert_eq!(after_sci["1e-7"], "keep1");
    assert_eq!(after_sci["0.0000001"], "keep2");
    assert_eq!(after_sci["1e+21"], "keep3");
    assert_eq!(after_sci["0"], "keep4");
    assert_eq!(after_sci["9007199254740992"], "keep5");
    let _ = std::fs::remove_dir_all(dir);
}
