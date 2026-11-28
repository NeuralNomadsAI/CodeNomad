use crate::folders::{Folder, Folders, parse};
use serde_json::json;

fn folder(name: &str, path: &str) -> Folder {
    Folder {
        name: name.into(),
        path: path.into(),
    }
}

#[test]
fn an_unrestricted_server_lists_absolute_folders_with_a_parent_and_a_home() {
    let listing = parse(&json!({
        "entries": [
            {"name": "app", "path": "D:\\work\\app", "absolutePath": "D:\\work\\app", "type": "directory"},
            {"name": "notes.txt", "path": "D:\\work\\notes.txt", "type": "file", "size": 3},
        ],
        "metadata": {"scope": "unrestricted", "currentPath": "D:\\work", "rootPath": "D:\\", "homePath": "C:\\Users\\me",
            "displayPath": "D:\\work", "pathKind": "absolute", "parentPath": "D:\\"},
    }))
    .unwrap();
    assert_eq!(
        listing,
        Folders {
            absolute: Some("D:\\work".into()),
            parent: Some("D:\\".into()),
            home: Some("C:\\Users\\me".into()),
            folders: vec![folder("app", "D:\\work\\app")],
        },
        "files are left out"
    );
}

#[test]
fn a_restricted_server_lists_relative_folders_under_its_root() {
    let listing = parse(&json!({
        "entries": [{"name": "api", "path": "src/api", "absolutePath": "/srv/root/src/api", "type": "directory"}],
        "metadata": {"scope": "restricted", "currentPath": "src", "rootPath": "/srv/root", "homePath": "/srv/root",
            "displayPath": "/srv/root/src", "pathKind": "relative", "parentPath": "."},
    }))
    .unwrap();
    assert_eq!(listing.absolute.as_deref(), Some("/srv/root/src"));
    assert_eq!(
        listing.parent.as_deref(),
        Some("."),
        "what the server takes to list it"
    );
    assert_eq!(listing.home, None, "its root is all it serves");
    assert_eq!(listing.folders, [folder("api", "src/api")]);

    let root = parse(&json!({
        "entries": [],
        "metadata": {"scope": "restricted", "currentPath": ".", "rootPath": "D:\\served", "homePath": "D:\\served",
            "displayPath": "D:\\served", "pathKind": "relative"},
    }))
    .unwrap();
    assert_eq!(root.absolute.as_deref(), Some("D:\\served"));
    assert_eq!(root.parent, None);
}

#[test]
fn the_list_of_windows_drives_is_no_folder_to_open() {
    let drives = parse(&json!({
        "entries": [{"name": "C:", "path": "C:\\", "absolutePath": "C:\\", "type": "directory"}],
        "metadata": {"scope": "unrestricted", "currentPath": "__drives__", "rootPath": "D:\\", "homePath": "C:\\Users\\me",
            "displayPath": "Drives", "pathKind": "drives"},
    }))
    .unwrap();
    assert_eq!(drives.absolute, None);
    assert_eq!(drives.folders, [folder("C:", "C:\\")]);
}

#[test]
fn a_reply_without_its_metadata_or_with_too_many_folders_is_refused() {
    assert!(parse(&json!({"entries": []})).is_err());
    let entries: Vec<_> = (0..4097)
        .map(|i| json!({"name": i.to_string(), "path": format!("/{i}"), "type": "directory"}))
        .collect();
    assert!(
        parse(
            &json!({"entries": entries, "metadata": {"scope": "unrestricted", "currentPath": "/",
            "displayPath": "/", "pathKind": "absolute"}})
        )
        .is_err()
    );
}
