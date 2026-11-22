use super::{request::Read, state::Tree};
use codenomad_client::files::{Entry, EntryKind};

fn entry(path: &str, identity: Option<&str>) -> Entry {
    Entry {
        name: path.rsplit('/').next().unwrap().into(),
        path: path.into(),
        kind: if identity.is_some() {
            EntryKind::Directory
        } else {
            EntryKind::File
        },
        directory_identity: identity.map(str::to_owned),
        absolute_path: None,
        size: None,
        modified_at: None,
    }
}
fn tree() -> Tree {
    let mut tree = Tree::new("/a".into());
    tree.activate(true);
    tree
}
#[test]
fn another_occurrence_cannot_complete_a_read_for_the_same_directory() {
    let mut first = tree();
    let mut second = tree();
    let foreign = first.take_refresh().pop().unwrap();
    let own = second.take_refresh().pop().unwrap();
    assert!(!second.complete(foreign, Ok(vec![entry("foreign", None)]), Ok));
    assert!(second.busy("."));
    assert!(paths(&second).is_empty());
    finish(&mut second, own, vec![entry("own", None)]);
    assert_eq!(paths(&second), ["own"]);
}
fn finish(tree: &mut Tree, read: Read, entries: Vec<Entry>) {
    let collation = crate::platform::collation::Collation::try_default().unwrap();
    assert!(tree.complete(read, Ok(entries), |entries| collation.sort_files(entries)));
}
fn root(tree: &mut Tree, entries: Vec<Entry>) {
    let read = tree.take_refresh().pop().unwrap();
    assert_eq!(read.path, ".");
    finish(tree, read, entries);
}
fn paths(tree: &Tree) -> Vec<&str> {
    tree.rows()
        .into_iter()
        .map(|row| row.entry.path.as_str())
        .collect()
}

#[test]
fn filesystem_events_match_windows_spelling_and_preserve_posix_case_and_aliases() {
    for (owned, observed, matches) in [
        ("D:/Fixture", "d:\\fixture", true),
        ("/Fixture", "/fixture", false),
        ("/fixture", "/fixture-alias", false),
    ] {
        let mut tree = Tree::new(owned.into());
        tree.activate(true);
        root(&mut tree, vec![]);
        tree.invalidate(observed, Some("."));
        let requests = tree.take_refresh();
        assert_eq!(!requests.is_empty(), matches, "{owned} / {observed}");
        for read in requests {
            finish(&mut tree, read, vec![]);
        }
        tree.switch("/other".into());
        root(&mut tree, vec![]);
        tree.invalidate(observed, Some("."));
        tree.switch(owned.into());
        assert_eq!(
            !tree.take_refresh().is_empty(),
            matches,
            "cached {owned} / {observed}"
        );
    }
}

#[test]
fn lazy_empty_directories_keep_explicit_branch_state_and_selection() {
    let mut tree = tree();
    root(
        &mut tree,
        vec![entry("empty", Some("1")), entry("unopened", Some("2"))],
    );
    assert_eq!(tree.rows()[0].expanded, Some(false));
    tree.select("empty".into());
    let read = tree.toggle("empty").pop().unwrap();
    assert_eq!(read.path, "empty");
    assert_eq!(tree.rows()[0].expanded, Some(true));
    finish(&mut tree, read, vec![]);
    assert!(tree.take_refresh().is_empty());
    assert!(tree.toggle("empty").is_empty());
    assert!(tree.toggle("empty").is_empty());
    tree.switch("/b".into());
    root(&mut tree, vec![entry("b", None)]);
    tree.switch("/a".into());
    assert_eq!(tree.selected(), Some("empty"));
    assert_eq!(tree.rows()[0].expanded, Some(true));
    assert!(tree.take_refresh().is_empty());
}

#[test]
fn stale_collapsed_subtrees_wait_until_reopened_and_other_scopes_remain_cached() {
    let mut tree = tree();
    root(
        &mut tree,
        vec![entry("src", Some("1")), entry("other", Some("2"))],
    );
    let read = tree.toggle("src").pop().unwrap();
    finish(&mut tree, read, vec![entry("src/old", None)]);
    tree.toggle("src");
    tree.invalidate("/a", Some("src"));
    assert!(tree.take_refresh().is_empty());
    tree.switch("/b".into());
    root(&mut tree, vec![]);
    tree.invalidate("/a", Some("src"));
    tree.switch("/a".into());
    assert!(tree.take_refresh().is_empty());
    let read = tree.toggle("src").pop().unwrap();
    assert_eq!(read.path, "src");
    finish(&mut tree, read, vec![entry("src/new", None)]);
    assert_eq!(paths(&tree), ["other", "src", "src/new"]);
}

#[test]
fn burst_invalidation_and_explicit_refresh_coalesce_one_trailing_visible_pass() {
    let mut tree = tree();
    root(
        &mut tree,
        vec![entry("src", Some("1")), entry("hidden", Some("2"))],
    );
    let read = tree.toggle("src").pop().unwrap();
    finish(&mut tree, read, vec![]);
    tree.invalidate("/a", Some("src"));
    let read = tree.take_refresh().pop().unwrap();
    for _ in 0..30 {
        tree.invalidate("/a", Some("src"));
        tree.refresh(true);
        assert!(tree.take_refresh().is_empty());
    }
    finish(&mut tree, read, vec![]);
    let trailing = tree.take_refresh();
    assert_eq!(
        trailing
            .iter()
            .map(|read| read.path.as_str())
            .collect::<Vec<_>>(),
        [".", "src"]
    );
    for read in trailing {
        let entries = if read.path == "." {
            vec![entry("src", Some("1")), entry("hidden", Some("2"))]
        } else {
            vec![]
        };
        finish(&mut tree, read, entries);
    }
    assert!(tree.take_refresh().is_empty());
}

#[test]
fn replacement_cancels_only_descendants_and_reloads_expanded_chain() {
    let mut tree = tree();
    root(
        &mut tree,
        vec![entry("src", Some("old")), entry("sibling", Some("same"))],
    );
    let read = tree.toggle("src").pop().unwrap();
    finish(&mut tree, read, vec![entry("src/deep", Some("deep-old"))]);
    let read = tree.toggle("src/deep").pop().unwrap();
    finish(&mut tree, read, vec![entry("src/deep/old", None)]);
    let sibling = tree.toggle("sibling").pop().unwrap();
    finish(&mut tree, sibling, vec![entry("sibling/keep", None)]);
    tree.select("src/deep/old".into());
    let stale = tree.load("src/deep", true).unwrap();
    let sibling = tree.load("sibling", true).unwrap();
    let root = tree.load(".", true).unwrap();
    finish(
        &mut tree,
        root,
        vec![entry("src", Some("new")), entry("sibling", Some("same"))],
    );
    assert!(stale.cancelled());
    assert!(!sibling.cancelled());
    assert!(
        !tree.complete(stale, Ok(vec![entry("src/deep/old", None)]), |_| panic!(
            "stale reply ordered"
        ))
    );
    finish(&mut tree, sibling, vec![entry("sibling/keep", None)]);
    let read = tree.take_refresh().pop().unwrap();
    assert_eq!(read.path, "src");
    finish(&mut tree, read, vec![entry("src/deep", Some("deep-new"))]);
    let read = tree.take_refresh().pop().unwrap();
    assert_eq!(read.path, "src/deep");
    finish(&mut tree, read, vec![entry("src/deep/new", None)]);
    assert_eq!(
        paths(&tree),
        ["sibling", "sibling/keep", "src", "src/deep", "src/deep/new"]
    );
    assert_eq!(tree.selected(), Some("src/deep/old"));
}

#[test]
fn cancellation_hide_switch_close_and_drop_fence_late_replies() {
    let mut tree = tree();
    root(&mut tree, vec![entry("src", Some("1"))]);
    let read = tree.toggle("src").pop().unwrap();
    tree.activate(false);
    assert!(read.cancelled());
    assert!(
        !tree.complete(read, Ok(vec![entry("src/stale", None)]), |_| panic!(
            "hidden reply ordered"
        ))
    );
    tree.activate(true);
    let read = tree.take_refresh().pop().unwrap();
    assert_eq!(read.path, "src");
    tree.switch("/b".into());
    assert!(read.cancelled());
    tree.switch("/a".into());
    assert!(
        !tree.complete(read, Ok(vec![entry("src/stale", None)]), |_| panic!(
            "obsolete scope ordered"
        ))
    );
    let read = tree.take_refresh().pop().unwrap();
    finish(&mut tree, read, vec![entry("src/new", None)]);
    let read = tree.load("src", true).unwrap();
    tree.close();
    assert!(read.cancelled());
    tree.activate(true);
    tree.refresh(true);
    assert!(tree.take_refresh().is_empty());
    let mut other = Tree::new("/a".into());
    other.activate(true);
    let read = other.take_refresh().pop().unwrap();
    drop(other);
    assert!(read.cancelled());
}

#[test]
fn cache_retains_eight_departed_directories_and_errors_retry_explicitly() {
    let mut tree = tree();
    root(&mut tree, vec![entry("keep", None)]);
    for n in 0..8 {
        tree.switch(format!("/other-{n}"));
        root(&mut tree, vec![]);
    }
    tree.switch("/a".into());
    assert_eq!(paths(&tree), ["keep"]);
    assert!(tree.take_refresh().is_empty());
    for n in 0..9 {
        tree.switch(format!("/new-{n}"));
        root(&mut tree, vec![]);
    }
    tree.switch("/a".into());
    assert!(paths(&tree).is_empty());
    let read = tree.take_refresh().pop().unwrap();
    assert!(
        tree.complete(read, Err("fixture failure".into()), |_| panic!(
            "failed reply ordered"
        ))
    );
    assert_eq!(tree.errors()["."], "fixture failure");
    assert!(tree.take_refresh().is_empty());
    let read = tree.load(".", true).unwrap();
    assert!(tree.errors().is_empty());
    finish(&mut tree, read, vec![]);
}

#[test]
fn ordering_uses_the_supplied_capturing_sorter() {
    let mut tree = Tree::new("/a".into());
    tree.activate(true);
    let read = tree.take_refresh().pop().unwrap();
    let expected = vec!["Zdir", "a", "E", "é", "z"];
    assert!(tree.complete(
        read,
        Ok(vec![
            entry("z", None),
            entry("é", None),
            entry("E", None),
            entry("a", None),
            entry("Zdir", Some("1")),
        ]),
        |mut entries| {
            assert_eq!(entries.len(), expected.len());
            entries.reverse();
            Ok(entries)
        },
    ));
    assert_eq!(paths(&tree), expected);
}

#[test]
fn ordering_failure_after_buffer_mutation_preserves_listing_descendants_and_versions() {
    let mut tree = tree();
    root(
        &mut tree,
        vec![entry("src", Some("old")), entry("sibling", Some("same"))],
    );
    let read = tree.toggle("src").pop().unwrap();
    finish(&mut tree, read, vec![entry("src/keep", None)]);
    let pending = tree.load("src", true).unwrap();
    tree.select("src/keep".into());
    tree.invalidate("/a", Some("."));
    let read = tree.load(".", true).unwrap();
    assert!(tree.complete(
        read,
        Ok(vec![
            entry("src", Some("new")),
            entry("sibling", Some("same")),
            entry("z", None),
            entry("a", None)
        ]),
        |mut entries| {
            entries.reverse();
            entries.pop();
            Err("collation unavailable".into())
        }
    ));
    assert_eq!(paths(&tree), ["sibling", "src", "src/keep"]);
    assert_eq!(tree.selected(), Some("src/keep"));
    assert_eq!(tree.errors()["."], "collation unavailable");
    assert!(!pending.cancelled());
    finish(&mut tree, pending, vec![entry("src/keep", None)]);
    let retry = tree.take_refresh();
    assert_eq!(
        retry
            .iter()
            .map(|read| read.path.as_str())
            .collect::<Vec<_>>(),
        ["."]
    );
}

#[test]
fn stale_response_never_calls_the_fallible_sorter() {
    let mut tree = tree();
    let read = tree.take_refresh().pop().unwrap();
    tree.switch("/b".into());
    tree.switch("/a".into());
    assert!(
        !tree.complete(read, Ok(vec![entry("b", None), entry("a", None)]), |_| {
            panic!("obsolete request reached ordering")
        })
    );
    assert!(paths(&tree).is_empty());
    assert!(tree.errors().is_empty());
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn cancelled_read_yields_before_an_unreachable_backend() {
    crate::platform::block_on(async {
        let backend = codenomad_client::backend::Backend::connect("http://127.0.0.1:1", "")
            .await
            .unwrap();
        let mut tree = tree();
        let read = tree.take_refresh().pop().unwrap();
        tree.close();
        assert!(
            read.fetch(&backend, &crate::platform::reads::Reads::default())
                .await
                .is_none()
        );
    });
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn hiding_cancels_an_already_dispatched_http_read_without_waiting_for_the_server() {
    crate::platform::block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut backend = codenomad_client::backend::Backend::connect(
            &format!("http://{}", listener.local_addr().unwrap()),
            "",
        )
        .await
        .unwrap();
        backend.workspace = "fixture".into();
        let mut tree = tree();
        let read = tree.take_refresh().pop().unwrap();
        let task = tokio::spawn(async move {
            read.fetch(&backend, &crate::platform::reads::Reads::default())
                .await
        });
        let socket = tokio::time::timeout(std::time::Duration::from_secs(2), listener.accept())
            .await
            .unwrap()
            .unwrap();
        tree.activate(false);
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), task)
                .await
                .unwrap()
                .unwrap()
                .is_none()
        );
        assert!(!tree.busy("."));
        drop(socket);
    });
}
