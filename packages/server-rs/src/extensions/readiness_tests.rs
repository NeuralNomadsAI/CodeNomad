use super::*;

fn presence() -> (PathBuf, PathBuf) {
    let dir = crate::shared::test_dir("readiness").join("presence");
    fs::create_dir_all(&dir).unwrap();
    let lease = dir.join(format!("{}.lease", uuid::Uuid::new_v4()));
    fs::write(&lease, "").unwrap();
    (dir, lease)
}

/// A daemon-side follower: answers the first request with `ack(request)` and `scope(incarnation)`.
fn follow(
    lease: PathBuf,
    ack: fn(&mut Value),
    scope: fn(&str, &str) -> Value,
) -> std::thread::JoinHandle<Option<String>> {
    std::thread::spawn(move || {
        let folder = PathBuf::from(format!("{}.prepare", lease.display()));
        for _ in 0..100 {
            // Like the plugin follower, a request still being written is read again on the next pass.
            if let Some(entry) = fs::read_dir(&folder)
                .ok()
                .and_then(|d| d.flatten().find(|e| e.path().extension().is_some_and(|x| x == "json")))
                && let Ok(text) = fs::read_to_string(entry.path())
                && let Ok(mut value) = serde_json::from_str::<Value>(&text)
            {
                let directory = value["directory"].as_str().unwrap().to_owned();
                let incarnation = uuid::Uuid::new_v4().to_string();
                value["incarnation"] = json!(incarnation);
                ack(&mut value);
                fs::write(
                    lease.with_file_name(format!("{incarnation}.scope")),
                    scope(&directory, &incarnation).to_string(),
                )
                .unwrap();
                fs::write(entry.path().with_extension("ack"), value.to_string()).unwrap();
                return Some(text);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        None
    })
}
fn exact(directory: &str, incarnation: &str) -> Value {
    json!({"version":1,"directory":directory,"incarnation":incarnation})
}
const LOCATION: &str = if cfg!(windows) { "C:\\work\\project" } else { "/work/project" };

#[tokio::test]
async fn a_registered_follower_answers_the_exact_challenge() {
    let (dir, lease) = presence();
    let owner = Owner::new(lease.clone());
    let follower = follow(lease.clone(), |_| {}, exact);
    let ack = owner.prepare(LOCATION, tokio::time::Instant::now() + WAIT).await.unwrap();
    let request = follower.join().unwrap().unwrap();
    assert!(request.starts_with("{\"version\":1,\"nonce\":\""), "{request}");
    assert!(request.contains(&format!(
        "\"lease\":{},\"directory\":{},\"expires\":",
        json!(lease.file_name().unwrap().to_str().unwrap()),
        json!(LOCATION)
    )));
    assert_eq!(ack["directory"], LOCATION);
    // The request file is ours and removed; the folder goes on close.
    let folder = PathBuf::from(format!("{}.prepare", lease.display()));
    assert!(fs::read_dir(&folder).unwrap().flatten().all(|e| e.path().extension().is_some_and(|x| x == "ack")));
    for entry in fs::read_dir(&folder).unwrap().flatten() {
        fs::remove_file(entry.path()).unwrap();
    }
    owner.close().await;
    assert!(!folder.exists());
    assert!(owner.prepare(LOCATION, tokio::time::Instant::now() + WAIT).await.is_err());
    fs::remove_dir_all(dir.parent().unwrap()).unwrap();
}

#[tokio::test]
async fn foreign_scopes_extra_fields_and_expired_leases_fail_closed() {
    let deadline = || tokio::time::Instant::now() + Duration::from_millis(900);
    let (dir, lease) = presence();
    let owner = Owner::new(lease.clone());
    let other = follow(lease.clone(), |_| {}, |_, i| json!({"version":1,"directory":"/elsewhere","incarnation":i}));
    assert!(owner.prepare(LOCATION, deadline()).await.unwrap_err().contains("timed out"));
    other.join().unwrap();
    let extra = follow(lease.clone(), |v| v["extra"] = json!(1), exact);
    assert!(owner.prepare(LOCATION, deadline()).await.is_err());
    extra.join().unwrap();
    let stale = follow(lease.clone(), |v| v["nonce"] = json!(uuid::Uuid::new_v4().to_string()), exact);
    assert!(owner.prepare(LOCATION, deadline()).await.is_err());
    stale.join().unwrap();
    // A lease older than the fifteen-second expiry proves nothing.
    let old = std::time::SystemTime::now() - Duration::from_secs(20);
    fs::OpenOptions::new().write(true).open(&lease).unwrap().set_modified(old).unwrap();
    assert_eq!(owner.prepare(LOCATION, deadline()).await.unwrap_err(), "Readiness lease expired");
    assert!(owner.prepare("relative/dir", deadline()).await.is_err());
    fs::remove_dir_all(dir.parent().unwrap()).unwrap();
}

#[test]
fn readiness_directories_follow_the_reference() {
    assert!(readiness_directory("/a") && readiness_directory("C:\\a") && readiness_directory("\\\\server\\share"));
    assert!(!readiness_directory("") && !readiness_directory("a/b") && !readiness_directory("/a\0"));
    assert!(!readiness_directory(&format!("/{}", "a".repeat(4096))));
    assert!(uuid("0f8fad5b-d9cb-469f-a165-70867728950e") && !uuid("0F8FAD5B-D9CB-469F-A165-70867728950E"));
}
