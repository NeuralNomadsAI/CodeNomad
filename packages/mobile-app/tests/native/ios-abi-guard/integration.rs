#[path = "../../../src-tauri/vendor/tauri-2.12.1/codenomad_ios_abi_guard.rs"]
mod guard;

use std::{fs, path::PathBuf};

fn vendor() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../src-tauri/vendor/tauri-2.12.1")
        .canonicalize()
        .unwrap()
}

#[test]
fn native_guard_accepts_the_real_integrated_sources() {
    guard::verify_at(&vendor(), "2.12.1");
}

#[test]
fn native_guard_rejects_version_drift() {
    assert!(std::panic::catch_unwind(|| guard::verify_at(&vendor(), "2.12.2")).is_err());
}

#[test]
fn native_guard_rejects_original_swift_and_arbitrary_source_drift() {
    let original = vendor();
    let copy = original.join("../../../test-results/ios-abi/native-negative");
    assert!(!copy.exists(), "no shared or prior negative fixture overwrite");
    fs::create_dir_all(&copy).unwrap();
    for line in include_str!("../../../src-tauri/vendor/tauri-2.12.1/codenomad-ios-abi.sha256").lines() {
        let (_, name) = line.split_once("  ").unwrap();
        let destination = copy.join(name);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::copy(original.join(name), destination).unwrap();
    }
    guard::verify_at(&copy, "2.12.1");
    let swift = copy.join("mobile/ios-api/Sources/Tauri/Tauri.swift");
    let patched = fs::read_to_string(&swift).unwrap();
    let upstream = patched.replace("id: Int32,", "id: Int,")
        .replace("(Int32, Int32, UnsafePointer<CChar>)", "(Int, Bool, UnsafePointer<CChar>)")
        .replace("callback(id, success ? 1 : 0,", "callback(id, success,");
    fs::write(&swift, upstream).unwrap();
    assert!(std::panic::catch_unwind(|| guard::verify_at(&copy, "2.12.1")).is_err());
    fs::write(&swift, patched).unwrap();
    fs::write(copy.join("src/ios.rs"), "drift").unwrap();
    assert!(std::panic::catch_unwind(|| guard::verify_at(&copy, "2.12.1")).is_err());
    fs::remove_dir_all(copy).unwrap();
}
