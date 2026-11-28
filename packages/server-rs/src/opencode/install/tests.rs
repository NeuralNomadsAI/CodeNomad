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
    assert_eq!(Error::new("installation_in_use", "x").status(), Status::CONFLICT);
    assert_eq!(Error::new("legacy_replacement_required", "x").status(), Status::CONFLICT);
    assert_eq!(Error::new("binary_unavailable", "x").status(), Status::UNPROCESSABLE_ENTITY);
    assert_eq!(Error::failed("x").status(), Status::BAD_GATEWAY);
    assert_eq!(Error::new("legacy_partially_removed", "x").status(), Status::BAD_GATEWAY);
    assert_eq!(Error::new("legacy_removed_install_failed", "x").status(), Status::BAD_GATEWAY);
    assert!(newer("2.10.0", "2.9.9") && !newer("2.4.2", "2.4.2"));
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
    let notice = plan::notice(&plan::Plan { prefix: None, legacy: None, foreign: Some(foreign) });
    assert_eq!(
        notice,
        json!({"foreignInstallation": {"path": "C:\\f\\opencode.exe", "version": "1.5.0", "source": "winget",
            "packageId": "SST.opencode", "blocked": {"reason": "occupied", "path": "C:\\p\\opencode.cmd"}}})
    );
    let legacy = legacy::Legacy {
        command: "C:\\p\\opencode.cmd".into(),
        prefix: std::path::PathBuf::from("C:\\p"),
        binary: std::path::PathBuf::from("C:\\p\\node_modules\\opencode-ai\\bin\\opencode.exe"),
        version: "1.15.1".into(),
    };
    let with_prefix = plan::notice(&plan::Plan {
        prefix: Some(layout::Prefix { root: std::path::PathBuf::from("C:\\p") }),
        legacy: Some(legacy.clone()),
        foreign: None,
    });
    assert_eq!(with_prefix, json!({"legacyReplacement": {"path": "C:\\p\\opencode.cmd", "version": "1.15.1"}}));
    let without_prefix = plan::notice(&plan::Plan { prefix: None, legacy: Some(legacy), foreign: None });
    assert_eq!(without_prefix, json!({}));
    assert_eq!(plan::notice(&plan::Plan::default()), json!({}));
}

#[test]
fn replace_legacy_consent_parser_is_strict() {
    assert_eq!(
        parse_replace_legacy(&json!({"replaceLegacy": {"path": "/tmp/bin/opencode", "version": "1.15.1"}})),
        Some(LegacyConsent { path: "/tmp/bin/opencode".into(), version: "1.15.1".into() })
    );
    for invalid in [
        json!({}),
        json!({"replaceLegacy": null}),
        json!({"replaceLegacy": {"path": "", "version": "1.15.1"}}),
        json!({"replaceLegacy": {"path": "a".repeat(4097), "version": "1.15.1"}}),
        json!({"replaceLegacy": {"path": "/bin/opencode", "version": "v1.15.1"}}),
        json!({"replaceLegacy": {"path": "/bin/opencode", "version": "1.15.1", "extra": true}}),
    ] {
        assert_eq!(parse_replace_legacy(&invalid), None, "{invalid}");
    }
}

#[test]
fn legacy_npm_verification_preflight_and_removal_match_reference() {
    let root = crate::shared::test_dir("install-legacy");
    let prefix = layout::Prefix { root: root.clone() };
    let pkg = legacy::legacy_package_root(&prefix);
    std::fs::create_dir_all(pkg.join("bin")).unwrap();
    std::fs::create_dir_all(pkg.join("node_modules").join("opencode-windows-x64").join("bin")).unwrap();
    std::fs::create_dir_all(pkg.join("node_modules").join("unrelated").join("bin")).unwrap();
    std::fs::create_dir_all(prefix.commands()).unwrap();
    let bin = pkg.join("bin").join("opencode.exe");
    let nested = pkg.join("node_modules").join("opencode-windows-x64").join("bin").join("opencode.exe");
    let unrelated = pkg.join("node_modules").join("unrelated").join("bin").join("tool.exe");
    std::fs::write(&bin, b"legacy-bin").unwrap();
    std::fs::write(&nested, b"nested-bin").unwrap();
    std::fs::write(&unrelated, b"unrelated").unwrap();
    std::fs::write(
        pkg.join("package.json"),
        r#"{"name":"opencode-ai","version":"1.15.1","bin":{"opencode":"./bin/opencode.exe"}}"#,
    )
    .unwrap();

    #[cfg(windows)]
    let command = {
        let cmd = prefix.commands().join("opencode.cmd");
        std::fs::write(&cmd, "@ECHO off\r\n\"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe\" %*\r\n").unwrap();
        std::fs::write(
            prefix.commands().join("opencode.ps1"),
            layout::ps1("node_modules/opencode-ai/bin/opencode.exe"),
        )
        .unwrap();
        // Customized npm `sh` shim (keeps header + exec line, adds user env export) must NOT be deleted or overwritten.
        let customized_sh = layout::sh("node_modules/opencode-ai/bin/opencode.exe")
            .replace("\nexec ", "\nexport MY_CUSTOM_VAR=1\nexec ");
        std::fs::write(prefix.commands().join("opencode"), customized_sh).unwrap();
        // Customized `.ps1` shim with an extra user setting must also be rejected as an npm shim.
        let customized_ps1 = prefix.commands().join("custom-check.ps1");
        let ps1_with_env = layout::ps1("node_modules/opencode-ai/bin/opencode.exe")
            .replace("# Support pipeline input", "$env:MY_CUSTOM_VAR = \"1\"\n# Support pipeline input");
        std::fs::write(&customized_ps1, ps1_with_env).unwrap();
        assert!(!legacy::is_npm_companion_shim(&customized_ps1, &bin));
        let _ = std::fs::remove_file(&customized_ps1);
        cmd.to_string_lossy().into_owned()
    };
    #[cfg(not(windows))]
    let command = {
        let link = prefix.commands().join("opencode");
        std::os::unix::fs::symlink("../lib/node_modules/opencode-ai/bin/opencode.exe", &link).unwrap();
        link.to_string_lossy().into_owned()
    };

    let detected = legacy::legacy_npm_installation(&command, &prefix).expect("verified 1.x npm shim");
    assert_eq!(detected.version, "1.15.1");
    assert!(legacy::matches_consent(
        &detected,
        Some(&LegacyConsent { path: command.clone(), version: "1.15.1".into() })
    ));
    assert!(!legacy::matches_consent(
        &detected,
        Some(&LegacyConsent { path: command.clone(), version: "1.15.0".into() })
    ));
    let images = legacy::legacy_native_images(&pkg, 64);
    assert!(images.contains(&bin));
    assert!(images.contains(&nested));
    assert!(!images.contains(&unrelated));

    // A 2.x manifest version is never classified as legacy 1.x.
    std::fs::write(
        pkg.join("package.json"),
        r#"{"name":"opencode-ai","version":"2.4.0","bin":{"opencode":"./bin/opencode.exe"}}"#,
    )
    .unwrap();
    assert!(legacy::legacy_npm_installation(&command, &prefix).is_none());

    // Restore 1.15.1 and verify locked native-image preflight on Windows keeps installation intact.
    std::fs::write(
        pkg.join("package.json"),
        r#"{"name":"opencode-ai","version":"1.15.1","bin":{"opencode":"./bin/opencode.exe"}}"#,
    )
    .unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let _locked = std::fs::OpenOptions::new().read(true).share_mode(0).open(&nested).unwrap();
        let err = legacy::remove_legacy(&prefix, &detected).unwrap_err();
        assert_eq!(err.code, "installation_in_use");
        assert!(pkg.exists() && std::path::Path::new(&command).exists());
    }

    // With no lock, removal deletes the legacy package root and verified shims while preserving custom scripts,
    // and publishing V2 commands must continue preserving custom companion scripts.
    legacy::remove_legacy(&prefix, &detected).unwrap();
    assert!(!pkg.exists());
    assert!(!std::path::Path::new(&command).exists());
    #[cfg(windows)]
    {
        assert!(!prefix.commands().join("opencode.ps1").exists());
        assert!(prefix.commands().join("opencode").exists(), "customized npm shim must not be deleted");
        layout::publish_commands(&prefix, &["opencode".into()]).unwrap();
        assert!(prefix.commands().join("opencode.cmd").is_file());
        assert!(prefix.commands().join("opencode.ps1").is_file());
        let preserved = std::fs::read_to_string(prefix.commands().join("opencode")).unwrap();
        assert!(
            preserved.contains("export MY_CUSTOM_VAR=1"),
            "publish_commands must preserve customized companion script"
        );

        // OpenCode 1.0–1.15.0 used a Node launcher (`bin/opencode`): verify its npm shims are recognized and removed.
        let node_root = crate::shared::test_dir("install-legacy-node");
        let node_prefix = layout::Prefix { root: node_root.clone() };
        let node_pkg = legacy::legacy_package_root(&node_prefix);
        std::fs::create_dir_all(node_pkg.join("bin")).unwrap();
        std::fs::create_dir_all(node_prefix.commands()).unwrap();
        let node_bin = node_pkg.join("bin").join("opencode");
        std::fs::write(&node_bin, "#!/usr/bin/env node\n").unwrap();
        std::fs::write(
            node_pkg.join("package.json"),
            r#"{"name":"opencode-ai","version":"1.15.0","bin":{"opencode":"./bin/opencode"}}"#,
        )
        .unwrap();
        let node_cmd = node_prefix.commands().join("opencode.cmd");
        std::fs::write(
            &node_cmd,
            "@ECHO off\r\n\"%_prog%\"  \"%dp0%\\node_modules\\opencode-ai\\bin\\opencode\" %*\r\n",
        )
        .unwrap();
        std::fs::write(
            node_prefix.commands().join("opencode.ps1"),
            "#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n\n$exe=\"\"\n\
             if ($PSVersionTable.PSVersion -lt \"6.0\" -or $IsWindows) {\n  # Fix case when both the Windows and Linux builds of Node\n\
             \x20 # are installed in the same directory\n  $exe=\".exe\"\n}\n$ret=0\nif (Test-Path \"$basedir/node$exe\") {\n\
             \x20 # Support pipeline input\n  if ($MyInvocation.ExpectingInput) {\n    $input | & \"$basedir/node$exe\"  \"$basedir/node_modules/opencode-ai/bin/opencode\" $args\n\
             \x20 } else {\n    & \"$basedir/node$exe\"  \"$basedir/node_modules/opencode-ai/bin/opencode\" $args\n  }\n  $ret=$LASTEXITCODE\n\
             } else {\n  # Support pipeline input\n  if ($MyInvocation.ExpectingInput) {\n    $input | & \"node$exe\"  \"$basedir/node_modules/opencode-ai/bin/opencode\" $args\n\
             \x20 } else {\n    & \"node$exe\"  \"$basedir/node_modules/opencode-ai/bin/opencode\" $args\n  }\n  $ret=$LASTEXITCODE\n}\nexit $ret\n",
        )
        .unwrap();
        std::fs::write(
            node_prefix.commands().join("opencode"),
            "#!/bin/sh\nbasedir=$(dirname \"$(echo \"$0\" | sed -e 's,\\\\,/,g')\")\n\ncase `uname` in\n\
             \x20 *CYGWIN*|*MINGW*|*MSYS*)\n    if command -v cygpath > /dev/null 2>&1; then\n      basedir=`cygpath -w \"$basedir\"`\n    fi\n  ;;\nesac\n\n\
             if [ -x \"$basedir/node\" ]; then\n  exec \"$basedir/node\"  \"$basedir/node_modules/opencode-ai/bin/opencode\" \"$@\"\n\
             else \n  exec node  \"$basedir/node_modules/opencode-ai/bin/opencode\" \"$@\"\nfi\n",
        )
        .unwrap();
        let detected_node =
            legacy::legacy_npm_installation(&node_cmd.to_string_lossy(), &node_prefix).expect("1.15.0 node shim");
        legacy::remove_legacy(&node_prefix, &detected_node).unwrap();
        assert!(!node_prefix.commands().join("opencode.cmd").exists());
        assert!(!node_prefix.commands().join("opencode.ps1").exists());
        assert!(!node_prefix.commands().join("opencode").exists());
        let _ = std::fs::remove_dir_all(node_root);
    }
    let _ = std::fs::remove_dir_all(root);
}

/// A command that starts a grandchild, then waits: once the probe expires, neither remains.
#[tokio::test]
async fn an_expired_probe_ends_its_whole_process_family() {
    struct CleanupDir(Option<std::path::PathBuf>);
    impl Drop for CleanupDir {
        fn drop(&mut self) {
            if let Some(dir) = self.0.take() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }
    let dir = crate::shared::test_dir("probe-family");
    let mut cleanup = CleanupDir(Some(dir.clone()));
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
        if pid <= 0 {
            return false;
        }
        #[cfg(target_os = "linux")]
        if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat"))
            && stat.rfind(')').and_then(|i| stat[i + 1..].split_whitespace().next()) == Some("Z")
        {
            return false;
        }
        // SAFETY: signal 0 only checks that the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    };
    let (expire_tx, expire_rx) = tokio::sync::oneshot::channel::<()>();
    let wait_ready = async {
        let start_deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let states: Vec<bool> = members.iter().map(|m| alive(m)).collect();
            if states.iter().all(|&up| up) || std::time::Instant::now() >= start_deadline {
                let _ = expire_tx.send(());
                return states;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    };
    let command = command.to_string_lossy().into_owned();
    let (probed, running) = tokio::join!(
        probe_version_until(&command, || async {
            let _ = expire_rx.await;
        }),
        wait_ready,
    );
    assert!(matches!(probed, Probed::Unknown));
    assert_eq!(running, [true, true], "both members ran during the probe");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while members.iter().any(|m| alive(m)) {
        assert!(std::time::Instant::now() < deadline, "a member of the expired probe still runs");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    cleanup.0 = None;
    std::fs::remove_dir_all(dir).unwrap();
}
