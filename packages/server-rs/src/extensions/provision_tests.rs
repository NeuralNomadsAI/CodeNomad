use super::*;

fn scratch() -> PathBuf {
    let dir = crate::shared::test_dir("provision");
    fs::create_dir_all(dir.join("profile").join("opencode")).unwrap();
    dir
}
fn paths(dir: &Path) -> Paths {
    namespace(dir.join("profile").join("opencode").to_str().unwrap()).unwrap()
}
const A: &[u8] = b"// CodeNomad plugin IDs: [\"codenomad-session-pruning\"]\nexport const desktopPlugin = () => ({})\n";
const B: &[u8] =
    b"// CodeNomad plugin IDs: [\"codenomad-session-pruning\"]\nexport const desktopPlugin = () => ({})\n// 2\n";

#[test]
fn namespace_is_a_hashed_sibling_of_the_discovery_root() {
    let dir = scratch();
    let p = paths(&dir);
    let identity = p.config.to_string_lossy().into_owned();
    let identity = if cfg!(windows) { identity.to_lowercase() } else { identity };
    assert_eq!(p.data, dir.join("profile").join(".codenomad").join(artifact::sha256_hex(identity.as_bytes())));
    assert!(namespace("relative/opencode").is_err());
    let root = if cfg!(windows) { "C:\\" } else { "/" };
    assert!(namespace(root).is_err());
    if cfg!(windows) {
        assert_eq!(
            namespace("C:/Users/x//cfg/./opencode").unwrap().config,
            PathBuf::from("C:\\Users\\x\\cfg\\opencode")
        );
    }
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn install_update_and_rollback_keep_payloads_and_move_the_shim() {
    let dir = scratch();
    let p = paths(&dir);
    let first = install("session-pruning", A, None, &p, "").unwrap();
    let payload_a = p.data.join("session-pruning").join(format!("{}.mjs", artifact::sha256_hex(A)));
    assert_eq!(fs::read(&payload_a).unwrap(), A);
    let shim = fs::read_to_string(&first.entry).unwrap();
    let url = reqwest::Url::from_file_path(&payload_a).unwrap();
    let leases = p.data.join("session-pruning").join("presence");
    assert_eq!(
        shim,
        format!(
            "// Managed by CodeNomad: session pruning lifecycle v1\nimport {{ desktopPlugin }} from {}\nexport default desktopPlugin({})\n",
            json!(url.as_str()),
            json!(leases)
        )
    );
    assert!(first.lease.is_file() && first.lease.starts_with(&leases));
    // Same bytes: shim untouched, a second backend lease.
    let modified = fs::metadata(&first.entry).unwrap().modified().unwrap();
    std::thread::sleep(Duration::from_millis(30));
    let again = install("session-pruning", A, None, &p, "").unwrap();
    assert_eq!(fs::metadata(&first.entry).unwrap().modified().unwrap(), modified);
    assert_ne!(again.lease, first.lease);
    // Update: new payload, old one retained for running copies.
    let next = install("session-pruning", B, None, &p, "").unwrap();
    assert!(payload_a.is_file());
    assert!(fs::read_to_string(&next.entry).unwrap().contains(&artifact::sha256_hex(B)));
    // Rollback: back to the first payload, nothing removed.
    install("session-pruning", A, None, &p, "").unwrap();
    assert_eq!(fs::read_to_string(&first.entry).unwrap(), shim);
    dispose(&[first.clone(), again, next]);
    assert!(!first.lease.exists());
    assert!(payload_a.is_file());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn damaged_payloads_are_replaced_and_foreign_entries_refused() {
    let dir = scratch();
    let p = paths(&dir);
    let folder = p.data.join("session-pruning");
    fs::create_dir_all(&folder).unwrap();
    let payload = folder.join(format!("{}.mjs", artifact::sha256_hex(A)));
    fs::write(&payload, &A[..10]).unwrap();
    install("session-pruning", A, None, &p, "").unwrap();
    assert_eq!(fs::read(&payload).unwrap(), A);
    fs::write(&payload, [A, b"x"].concat()).unwrap();
    install("session-pruning", A, None, &p, "").unwrap();
    assert_eq!(fs::read(&payload).unwrap(), A);
    // A directory at the payload name is refused and never removed.
    let b_payload = folder.join(format!("{}.mjs", artifact::sha256_hex(B)));
    fs::create_dir_all(b_payload.join("keep")).unwrap();
    let error = install("session-pruning", B, None, &p, "").unwrap_err().to_string();
    assert!(error.contains("never removes"), "{error}");
    assert!(b_payload.join("keep").is_dir());
    // A user's own entry is never replaced.
    let entry = p.config.join("plugins").join("codenomad-missions.ts");
    fs::write(&entry, "export default {}\n").unwrap();
    let error = install("missions", A, Some(b"provider"), &p, "").unwrap_err().to_string();
    assert!(error.contains("not managed by CodeNomad"), "{error}");
    assert_eq!(fs::read_to_string(&entry).unwrap(), "export default {}\n");
    fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[test]
fn a_link_at_the_payload_name_is_replaced_not_followed() {
    let dir = scratch();
    let p = paths(&dir);
    let folder = p.data.join("session-pruning");
    fs::create_dir_all(&folder).unwrap();
    let target = dir.join("target.mjs");
    fs::write(&target, b"outside").unwrap();
    let payload = folder.join(format!("{}.mjs", artifact::sha256_hex(A)));
    std::os::unix::fs::symlink(&target, &payload).unwrap();
    install("session-pruning", A, None, &p, "").unwrap();
    assert!(!fs::symlink_metadata(&payload).unwrap().file_type().is_symlink());
    assert_eq!(fs::read(&target).unwrap(), b"outside");
    fs::remove_dir_all(dir).unwrap();
}

/// Profile for `install-compare-tranche11.mjs` (TS reference on the same root):
/// `CNRS_PROVISION_FIXTURE=<dir> CNRS_PLUGIN_ASSETS=<payloads> cargo test -- --ignored ts_comparison`.
#[test]
#[ignore]
fn ts_comparison_fixture() {
    let dir = PathBuf::from(crate::bench::provision_fixture().expect("CNRS_PROVISION_FIXTURE"));
    let root = dir.join("pro fïle #%").join("opencode");
    fs::create_dir_all(&root).unwrap();
    let p = namespace(root.to_str().unwrap()).unwrap();
    for feature in ["session-pruning", "missions"] {
        let (bundle, provider) = payloads(feature).unwrap();
        install(feature, &bundle, provider.as_deref(), &p, "").map(|i| dispose(&[i])).unwrap();
    }
    println!("{}", root.display());
}

#[test]
fn missions_shim_names_both_payloads_and_retains_outside_storage() {
    let dir = scratch();
    let p = paths(&dir);
    let installed = install("missions", A, Some(b"provider"), &p, "").unwrap();
    let shim = fs::read_to_string(&installed.entry).unwrap();
    let folder = p.data.join("missions");
    let artifacts = json!({"provider":{"file":folder.join(format!("{}.provider.mjs", artifact::sha256_hex(b"provider"))),"sha256":artifact::sha256_hex(b"provider")},
        "runtime":{"file":folder.join(format!("{}.mjs", artifact::sha256_hex(A))),"sha256":artifact::sha256_hex(A)}});
    assert!(shim.ends_with(&format!(", {artifacts})\n")), "{shim}");
    assert!(parse_entry("missions", &shim).unwrap().is_some());
    // Older outside-root storage is retained and its presence kept, first ours.
    let elsewhere = dir.join("older").join("missions");
    fs::create_dir_all(elsewhere.join("presence")).unwrap();
    let old = elsewhere.join(format!("{}.mjs", artifact::sha256_hex(A)));
    fs::write(&old, A).unwrap();
    let legacy = format!(
        "{}import {{ desktopPlugin }} from {}\nexport default desktopPlugin({})\n",
        marker("missions"),
        json!(reqwest::Url::from_file_path(&old).unwrap().as_str()),
        json!(elsewhere.join("presence"))
    );
    fs::write(&installed.entry, &legacy).unwrap();
    let kept = install("missions", B, Some(b"provider"), &p, "").unwrap();
    assert!(kept.lease.starts_with(elsewhere.join("presence")));
    assert!(fs::read_to_string(&kept.entry).unwrap().contains(&json!(elsewhere.join("presence")).to_string()));
    // Invalid generated shapes fail closed.
    assert!(parse_entry("missions", &format!("{}import x\n", marker("missions"))).is_err());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn legacy_automation_entry_is_migrated_and_lease_requests_match_the_reference() {
    let dir = scratch();
    let p = paths(&dir);
    let entry = p.config.join("plugins").join("codenomad-automation.ts");
    fs::create_dir_all(entry.parent().unwrap()).unwrap();
    let server = if cfg!(windows) {
        "file:///C:/Program%20Files/CodeNomad/resources/server/dist/opencode/automation-plugin.js"
    } else {
        "file:///opt/codenomad/server/dist/opencode/automation-plugin.js"
    };
    fs::write(&entry, format!("export {{ default }} from {}\n", json!(server))).unwrap();
    assert!(legacy_automation(&fs::read_to_string(&entry).unwrap()));
    let installed = install("automation", A, None, &p, "").unwrap();
    assert!(fs::read_to_string(&entry).unwrap().starts_with("// Managed by CodeNomad: automation lifecycle v1\n"));
    dispose(&[installed]);
    // Any other foreign entry stays refused.
    fs::write(&entry, "export { default } from \"file:///tmp/elsewhere/automation-plugin.js\"\n").unwrap();
    assert!(install("automation", A, None, &p, "").is_err());
    assert!(!legacy_automation("export { default } from \"https://x/server/dist/opencode/automation-plugin.js\""));
    // Lease content (`lease-request.ts`) is written with the lease.
    assert_eq!(lease_request("design", true), "{\"version\":1,\"design\":true}");
    assert_eq!(lease_request("memory", false), "");
    let pruning = install("session-pruning", A, None, &p, &lease_request("design", true)).unwrap();
    assert_eq!(fs::read_to_string(&pruning.lease).unwrap(), "{\"version\":1,\"design\":true}");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn packaged_plugins_beside_the_binary_come_first() {
    let dir = scratch();
    assert_eq!(plugin_folder(&dir), dir.join("plugins"));
    fs::create_dir_all(dir.join("dist").join("plugins")).unwrap();
    assert_eq!(plugin_folder(&dir), dir.join("dist").join("plugins"));
}
