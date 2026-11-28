#![cfg(not(target_arch = "wasm32"))]
use codenomad_client::{
    backend::Backend,
    files::{WriteConflict, WriteResult},
};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

#[test]
#[ignore = "requires files-fixture.mjs --write with an explicit private manifest"]
fn real_rust_files_write_contract() {
    let manifest = PathBuf::from(std::env::var_os("RUNE_FILES_TEST_MANIFEST").unwrap());
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("target/rune-files-tests");
    assert!(manifest.is_absolute() && manifest.starts_with(&base));
    assert_eq!(manifest.file_name().unwrap(), "manifest.json");
    let root = fs::canonicalize(manifest.parent().unwrap()).unwrap();
    assert!(root.starts_with(fs::canonicalize(base).unwrap()));
    assert!(
        root.file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("trial-")
    );
    assert_eq!(
        fs::canonicalize(&manifest).unwrap(),
        root.join("manifest.json")
    );
    let data: Value = serde_json::from_slice(&fs::read(manifest).unwrap()).unwrap();
    assert_eq!(data["write"], true);
    let project = data["directory"].as_str().unwrap();
    let foreign = data["foreign"].as_str().unwrap();
    assert_eq!(fs::canonicalize(project).unwrap(), root.join("project"));
    assert_eq!(fs::canonicalize(foreign).unwrap(), root.join("foreign"));
    let origin = data["origin"].as_str().unwrap();
    let url = reqwest::Url::parse(origin).unwrap();
    assert_eq!(url.scheme(), "http");
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    assert!(url.port().is_some() && url.username().is_empty() && url.password().is_none());
    let password = std::env::var("RUNE_FILES_TEST_PASSWORD").unwrap();
    let file = "été 日本語.txt";
    let private = root.join("project").join(file);
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let mut backend = Backend::connect(origin, &password).await.unwrap();
        backend.workspace = data["workspaceId"].as_str().unwrap().into();
        let initial = backend.preview_file(project, file).await.unwrap();
        assert_eq!(initial.bytes, fs::read(&private).unwrap());
        let first = "Enregistré · été 🦀\n日本語\r\n";
        let WriteResult::Saved(first_version) = backend.write_file(project, file, first, initial.version.as_deref().unwrap()).await.unwrap() else { panic!("write refused") };
        let saved = backend.preview_file(project, file).await.unwrap();
        assert_eq!(saved.bytes, first.as_bytes());
        assert_eq!(saved.bytes, fs::read(&private).unwrap());
        assert_ne!(saved.version, initial.version);
        assert_eq!(first_version, saved.version);
        let external = "Modification externe · 京都\nà conserver";
        fs::write(&private, external).unwrap();
        assert_eq!(backend.write_file(project, file, "obsolete", saved.version.as_deref().unwrap()).await.unwrap(), WriteResult::Conflict(WriteConflict::ChangedOnDisk));
        assert_eq!(fs::read(&private).unwrap(), external.as_bytes());
        let current = backend.preview_file(project, file).await.unwrap();
        assert_eq!(current.bytes, external.as_bytes());
        assert_ne!(current.version, saved.version);
        let final_text = "Version courante · τέλος 🦀\nseconde sauvegarde";
        let WriteResult::Saved(final_version) = backend.write_file(project, file, final_text, current.version.as_deref().unwrap()).await.unwrap() else { panic!("write refused") };
        let final_read = backend.preview_file(project, file).await.unwrap();
        assert_eq!(final_read.bytes, final_text.as_bytes());
        assert_eq!(fs::read(&private).unwrap(), final_text.as_bytes());
        assert_ne!(final_read.version, current.version);
        assert_eq!(final_version, final_read.version);
        fs::remove_file(&private).unwrap();
        assert_eq!(backend.write_file(project, file, "must not recreate", final_read.version.as_deref().unwrap()).await.unwrap(), WriteResult::Conflict(WriteConflict::ChangedOnDisk));
        assert!(!private.exists());
        assert!(backend.write_file(foreign, "foreign.txt", "refused", final_read.version.as_deref().unwrap()).await.is_err());
        assert_eq!(fs::read(root.join("foreign/foreign.txt")).unwrap(), b"private sibling bytes");
        assert!(backend.write_file(project, ".git/private.txt", "refused", final_read.version.as_deref().unwrap()).await.is_err());
        assert_eq!(fs::read(root.join("project/.git/private.txt")).unwrap(), b"protected");
        println!("{}", json!({"type":"files-native-proof","result":"ok","write":true,
            "unicodeSavedAndReadBack":true,"externalConflictPreserved":true,"currentVersionSaved":true,
            "deletedConflictNoRecreate":true,"foreignDirectoryRefused":true,"protectedGitRefused":true,
            "versions":[initial.version,saved.version,current.version,final_read.version],
            "contents":[String::from_utf8(initial.bytes).unwrap(),first,external,final_text]}));
    });
}
