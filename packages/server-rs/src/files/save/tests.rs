use super::*;
use std::io::Write;

#[test]
fn an_error_after_a_partial_write_leaves_original_and_version_intact() {
    let dir = crate::shared::test_dir("atomic-save");
    let path = dir.join("note.txt");
    fs::write(&path, b"old contents").unwrap();
    let tag = version(b"old contents");
    let error = replace(
        &path,
        Some(&tag),
        || Ok(()),
        |file| {
            file.write_all(b"new but incomplete")?;
            Err(io::Error::other("injected write failure"))
        },
    );
    assert!(error.is_err());
    assert_eq!(fs::read(&path).unwrap(), b"old contents");
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    replace(&path, Some(&tag), || Ok(()), |file| file.write_all(b"new")).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"new");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_external_edit_while_preparing_the_save_keeps_its_contents() {
    let dir = crate::shared::test_dir("atomic-save-conflict");
    let path = dir.join("note.txt");
    fs::write(&path, b"old").unwrap();
    let result = replace(
        &path,
        Some(&version(b"old")),
        || Ok(()),
        |file| {
            file.write_all(b"our edit")?;
            fs::write(&path, b"external edit")
        },
    );
    assert_eq!(result.unwrap_err().0, Status::CONFLICT);
    assert_eq!(fs::read(&path).unwrap(), b"external edit");
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_parent_moved_after_verification_cannot_redirect_the_save() {
    let dir = crate::shared::test_dir("atomic-save-moved");
    let root = dir.join("root");
    let parent = root.join("parent");
    let moved = dir.join("moved");
    let path = parent.join("note.txt");
    fs::create_dir_all(&parent).unwrap();
    fs::write(&path, b"old").unwrap();
    let result = replace_with(
        &path,
        None,
        || Ok(()),
        |file| file.write_all(b"new"),
        |stage, leaf, actual| {
            match fs::rename(&parent, &moved) {
                Ok(()) => {
                    fs::create_dir(&parent).unwrap();
                    fs::write(&path, b"replacement").unwrap();
                }
                // The Windows directory handle can block the move itself.
                #[cfg(windows)]
                Err(err) if err.kind() == io::ErrorKind::PermissionDenied || err.raw_os_error() == Some(32) => {}
                Err(err) => panic!("unable to move the fixture: {err}"),
            }
            publish(stage, leaf, actual)
        },
    );
    if moved.exists() {
        assert_eq!(result.unwrap_err().0, Status::CONFLICT);
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        assert_eq!(fs::read(moved.join("note.txt")).unwrap(), b"old");
        assert_eq!(fs::read_dir(&moved).unwrap().count(), 1);
    } else {
        assert!(cfg!(windows));
        result.unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
    }
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn publishing_a_creation_does_not_replace_a_file_added_after_verification() {
    let dir = crate::shared::test_dir("atomic-save-new-race");
    let path = dir.join("note.txt");
    let result = replace_with(
        &path,
        None,
        || Ok(()),
        |file| file.write_all(b"new"),
        |stage, leaf, actual| {
            fs::write(&path, b"external").unwrap();
            publish(stage, leaf, actual)
        },
    );
    let err = result.unwrap_err();
    assert_eq!(err.0, Status::CONFLICT, "{err:?}");
    assert_eq!(fs::read(&path).unwrap(), b"external");
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn publishes_a_new_file_from_the_private_stage() {
    let dir = crate::shared::test_dir("atomic-save-new");
    let path = dir.join("note.txt");
    replace(&path, None, || Ok(()), |file| file.write_all(b"new")).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"new");
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    fs::remove_dir_all(dir).unwrap();
}

#[cfg(windows)]
#[test]
fn creation_keeps_the_synced_temporary_open_through_publication() {
    let dir = crate::shared::test_dir("atomic-save-source");
    let path = dir.join("note.txt");
    replace_with(
        &path,
        None,
        || Ok(()),
        |file| file.write_all(b"verified"),
        |stage, leaf, actual| {
            let source = stage.path.join(STAGED);
            assert!(fs::rename(source, stage.path.join("moved")).is_err());
            publish(stage, leaf, actual)
        },
    )
    .unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"verified");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn publication_failure_does_not_overwrite_the_original() {
    let dir = crate::shared::test_dir("atomic-save-publish-failure");
    let path = dir.join("note.txt");
    fs::write(&path, b"old").unwrap();
    let result = replace_with(
        &path,
        None,
        || Ok(()),
        |file| file.write_all(b"new"),
        |_stage, _leaf, _exists| Err(PublishError::Unchanged(io::Error::other("injected publication failure"))),
    );
    assert_eq!(result.unwrap_err().0, Status::BAD_REQUEST);
    assert_eq!(fs::read(&path).unwrap(), b"old");
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn permission_failure_at_publication_uses_the_verified_original() {
    let dir = crate::shared::test_dir("atomic-save-permission");
    let path = dir.join("note.txt");
    fs::write(&path, b"old contents").unwrap();
    let identity = file_identity(&path, false).unwrap();
    replace_with(
        &path,
        Some(&version(b"old contents")),
        || Ok(()),
        |file| file.write_all(b"new"),
        |_stage, _leaf, _exists| Err(PublishError::Unchanged(io::ErrorKind::PermissionDenied.into())),
    )
    .unwrap();
    assert_eq!(file_identity(&path, false).unwrap(), identity);
    assert_eq!(fs::read(&path).unwrap(), b"new");
    fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[test]
fn exclusive_creation_never_overwrites_a_concurrent_file() {
    let dir = crate::shared::test_dir("atomic-save-exclusive");
    let path = dir.join("note.txt");
    replace_with(&path, None, || Ok(()), |f| f.write_all(b"new"), |_, _, _| Ok(Publication::Exclusive)).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"new");
    fs::remove_file(&path).unwrap();
    let result = replace_with(
        &path,
        None,
        || Ok(()),
        |f| f.write_all(b"new"),
        |_, _, _| {
            fs::write(&path, b"external").unwrap();
            Ok(Publication::Exclusive)
        },
    );
    assert_eq!(result.unwrap_err().0, Status::CONFLICT);
    assert_eq!(fs::read(&path).unwrap(), b"external");
    fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[test]
fn exclusive_creation_removes_its_own_partial_file_on_error() {
    let dir = crate::shared::test_dir("atomic-save-exclusive-failure");
    let parent = dir.join("parent");
    let moved = dir.join("moved");
    fs::create_dir(&parent).unwrap();
    let path = parent.join("note.txt");
    let attempts = std::cell::Cell::new(0);
    let result = replace_with(
        &path,
        None,
        || Ok(()),
        |file| {
            file.write_all(b"partial")?;
            let attempt = attempts.replace(1);
            if attempt == 0 {
                Ok(())
            } else {
                fs::rename(&parent, &moved)?;
                Err(io::Error::other("injected write failure"))
            }
        },
        |_, _, _| Ok(Publication::Exclusive),
    );
    assert_eq!(result.unwrap_err().0, Status::BAD_REQUEST);
    assert!(!path.exists());
    assert_eq!(fs::read_dir(&moved).unwrap().count(), 0);
    fs::remove_dir_all(dir).unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn busy_mount_falls_back_to_writing_the_open_file() {
    let dir = crate::shared::test_dir("atomic-save-busy");
    let path = dir.join("note.txt");
    fs::write(&path, b"original").unwrap();
    let before = file_identity(&path, false).unwrap();
    replace_with(
        &path,
        None,
        || Ok(()),
        |file| file.write_all(b"new"),
        |_, _, _| Err(PublishError::Unchanged(io::Error::from_raw_os_error(libc::EBUSY))),
    )
    .unwrap();
    assert_eq!(file_identity(&path, false).unwrap(), before);
    assert_eq!(fs::read(&path).unwrap(), b"new");
    fs::remove_dir_all(dir).unwrap();
}

#[cfg(windows)]
#[test]
fn interrupted_replacement_restores_its_backup_without_overwriting() {
    use windows_sys::Win32::Foundation::ERROR_UNABLE_TO_MOVE_REPLACEMENT_2;
    let dir = crate::shared::test_dir("atomic-save-restore");
    let path = dir.join("note.txt");
    let root = Directory::open(&dir).unwrap();
    let stage = PrivateStage::new(&dir, &root).unwrap();
    let backup = stage.path.join("write.backup");
    let leaf = Path::new("note.txt");
    let failure = || io::Error::from_raw_os_error(ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 as i32);
    fs::write(&backup, b"old").unwrap();
    let expected = Handle::from_path(&backup).unwrap();
    assert!(matches!(windows::recover_replacement(&stage, leaf, &expected, failure()), PublishError::Interrupted(_)));
    assert_eq!(fs::read(&path).unwrap(), b"old");
    assert!(!backup.exists());
    fs::write(&backup, b"backup").unwrap();
    let expected = Handle::from_path(&backup).unwrap();
    assert!(matches!(windows::recover_replacement(&stage, leaf, &expected, failure()), PublishError::Interrupted(_)));
    assert_eq!(fs::read(&path).unwrap(), b"old");
    assert_eq!(fs::read(&backup).unwrap(), b"backup");
    drop((expected, stage));
    drop(root);
    fs::remove_dir_all(dir).unwrap();
}

#[cfg(windows)]
#[test]
fn replacing_a_windows_file_keeps_its_named_stream() {
    let dir = crate::shared::test_dir("atomic-save-stream");
    let path = dir.join("note.txt");
    let stream = dir.join("note.txt:fixture");
    fs::write(&path, b"old").unwrap();
    fs::write(&stream, b"metadata").unwrap();
    let before = Handle::from_path(&path).unwrap();
    replace(&path, None, || Ok(()), |file| file.write_all(b"new")).unwrap();
    assert_ne!(before, Handle::from_path(&path).unwrap());
    assert_eq!(fs::read(&path).unwrap(), b"new");
    assert_eq!(fs::read(&stream).unwrap(), b"metadata");
    drop(before);
    fs::remove_dir_all(dir).unwrap();
}

#[cfg(windows)]
#[test]
fn a_handle_that_blocks_replacement_but_allows_writes_keeps_the_file_writable() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
    let dir = crate::shared::test_dir("atomic-save-sharing");
    let path = dir.join("note.txt");
    fs::write(&path, b"old contents").unwrap();
    let opened = OpenOptions::new().read(true).share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE).open(&path).unwrap();
    let before = file_identity(&path, false).unwrap();
    replace(&path, None, || Ok(()), |file| file.write_all(b"new")).unwrap();
    assert_eq!(file_identity(&path, false).unwrap(), before);
    assert_eq!(fs::read(&path).unwrap(), b"new");
    drop(opened);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn hard_links_keep_their_identity_and_see_the_new_shorter_contents() {
    let dir = crate::shared::test_dir("atomic-save-hardlinks");
    let (path, alias) = (dir.join("note.txt"), dir.join("alias.txt"));
    fs::write(&path, b"old contents").unwrap();
    fs::hard_link(&path, &alias).unwrap();
    let etag = version(b"old contents");
    replace(&path, Some(&etag), || Ok(()), |file| file.write_all(b"new")).unwrap();
    assert_eq!(Handle::from_path(&path).unwrap(), Handle::from_path(&alias).unwrap());
    assert_eq!(fs::read(&path).unwrap(), b"new");
    assert_eq!(fs::read(&alias).unwrap(), b"new");
    assert!(!replace(&alias, Some(&etag), || Ok(()), |_| panic!("must refuse before writing")).is_ok());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn failed_in_place_write_does_not_truncate_the_original_tail() {
    let dir = crate::shared::test_dir("atomic-save-in-place");
    let path = dir.join("note.txt");
    let alias = dir.join("alias.txt");
    fs::write(&path, b"old contents").unwrap();
    fs::hard_link(&path, &alias).unwrap();
    let result = replace(
        &path,
        None,
        || Ok(()),
        |file| {
            file.write_all(b"new")?;
            Err(io::Error::other("injected write failure"))
        },
    );
    assert_eq!(result.unwrap_err().0, Status::BAD_REQUEST);
    assert_eq!(fs::read(alias).unwrap(), b"new contents");
    fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[test]
fn a_fifo_is_refused_without_opening_a_blocked_reader() {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let dir = crate::shared::test_dir("atomic-save-fifo");
    let pipe = dir.join("pipe");
    let name = CString::new(pipe.as_os_str().as_bytes()).unwrap();
    // SAFETY: name is an owned, NUL-terminated path inside the test directory.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert_eq!(file_identity(&pipe, false).unwrap_err().0, Status::BAD_REQUEST);
    assert_eq!(file_identity(&pipe, true).unwrap_err().0, Status::CONFLICT);
    fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[test]
fn keeps_mode_and_replaces_a_symlinks_target() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let dir = crate::shared::test_dir("atomic-save-link");
    let (path, alias) = (dir.join("note.txt"), dir.join("alias.txt"));
    fs::write(&path, b"old").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o750)).unwrap();
    symlink("note.txt", &alias).unwrap();
    let target = super::super::super::links::write_target(alias.clone(), true, false).unwrap();
    replace(&target, None, || Ok(()), |file| file.write_all(b"new")).unwrap();
    assert_eq!(fs::read_link(&alias).unwrap(), Path::new("note.txt"));
    assert_eq!(fs::read(&alias).unwrap(), b"new");
    assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o750);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn hardlink_in_place_refuses_replaced_inode_and_concurrent_alias_edit() {
    let dir = crate::shared::test_dir("atomic-save-hardlink-race");
    let (path, alias) = (dir.join("hl-a.txt"), dir.join("hl-b.txt"));
    fs::write(&path, b"orig").unwrap();
    fs::hard_link(&path, &alias).unwrap();
    let v1 = version(b"orig");

    // 1. Replacing the hardlinked path with a new inode before in-place write must return 409 without mutating either file.
    let swapped = std::cell::Cell::new(false);
    let result = replace(
        &path,
        Some(&v1),
        || {
            if !swapped.replace(true) {
                fs::remove_file(&path).unwrap();
                fs::write(&path, b"replaced-inode").unwrap();
            }
            Ok(())
        },
        |_| panic!("must not write after inode replacement"),
    );
    assert_eq!(result.unwrap_err().0, Status::CONFLICT);
    assert_eq!(fs::read(&path).unwrap(), b"replaced-inode");
    assert_eq!(fs::read(&alias).unwrap(), b"orig");

    // 2. Concurrent content edit through the hardlink alias before in-place write must return 409 without writing.
    fs::remove_file(&path).unwrap();
    fs::hard_link(&alias, &path).unwrap();
    let edited = std::cell::Cell::new(false);
    let result = replace(
        &path,
        Some(&v1),
        || {
            if !edited.replace(true) {
                fs::write(&alias, b"external-alias-edit").unwrap();
            }
            Ok(())
        },
        |_| panic!("must not write after concurrent hardlink edit"),
    );
    assert_eq!(result.unwrap_err().0, Status::CONFLICT);
    assert_eq!(fs::read(&path).unwrap(), b"external-alias-edit");
    assert_eq!(fs::read(&alias).unwrap(), b"external-alias-edit");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn conditional_replace_returns_conflict_when_parent_deleted_or_replaced_by_file() {
    let dir = crate::shared::test_dir("atomic-save-parent-conflict");
    let sub = dir.join("sub");
    let path = sub.join("note.txt");
    fs::create_dir(&sub).unwrap();
    fs::write(&path, b"v1").unwrap();
    let v1 = version(b"v1");

    fs::remove_dir_all(&sub).unwrap();
    assert_eq!(replace(&path, Some(&v1), || Ok(()), |_| panic!("must not write")).unwrap_err().0, Status::CONFLICT);

    fs::write(&sub, b"now-a-file").unwrap();
    assert_eq!(replace(&path, Some(&v1), || Ok(()), |_| panic!("must not write")).unwrap_err().0, Status::CONFLICT);

    fs::remove_dir_all(dir).unwrap();
}
