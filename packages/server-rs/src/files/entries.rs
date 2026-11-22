//! Entry mutations use literal, capability-relative paths, unlike preview reads.
use super::{Input, invalid, io_error, relative, root, select};
use crate::{Error, Shared, error};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode as Status,
};
use cap_std::fs::{Dir, OpenOptions, OpenOptionsExt};
use serde::Deserialize;
use std::io;

#[derive(Deserialize)]
pub(super) struct Checkout {
    directory: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Create {
    parent: String,
    name: String,
    kind: Kind,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Kind {
    File,
    Directory,
}

pub(super) async fn create(
    State(app): State<Shared>,
    Path(id): Path<String>,
    Query(checkout): Query<Checkout>,
    Json(input): Json<Create>,
) -> Result<Status, Error> {
    let _lease = app.project_mutation.lock().await;
    let workspace =
        select(&app, &id, &Input { path: None, directory: Some(checkout.directory), worktree: None }).await?;
    create_at(root(&workspace)?, &input)?;
    Ok(Status::CREATED)
}

fn create_at(root: Dir, input: &Create) -> Result<(), Error> {
    let path = checked_parent(&input.parent)?;
    let name = checked_name(&input.name)?;
    let parent = if path == "." {
        root
    } else {
        path.split('/').try_fold(root, |dir, part| open_real_dir(&dir, part).map_err(io_error))?
    };
    let result = match input.kind {
        Kind::File => parent.open_with(name, OpenOptions::new().write(true).create_new(true)).map(drop),
        Kind::Directory => parent.create_dir(name),
    };
    result.map_err(|err| {
        if err.kind() == io::ErrorKind::AlreadyExists {
            error(Status::CONFLICT, "A file or folder already has this name")
        } else {
            io_error(err)
        }
    })
}

fn checked_parent(path: &str) -> Result<&str, Error> {
    if path == "." || relative(path, false)? == path { Ok(path) } else { Err(invalid()) }
}

fn checked_name(name: &str) -> Result<&str, Error> {
    if name.contains('/') || relative(name, false)? != name { Err(invalid()) } else { Ok(name) }
}

fn open_real_dir(parent: &Dir, name: &str) -> io::Result<Dir> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY);
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        options
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE);
    }
    let opened = parent.open_with(name, &options)?.into_std();
    let metadata = opened.metadata()?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        // A DOS short name can name the same protected directory.
        match parent.open_with(".git", &options) {
            Ok(git) => {
                if same_file::Handle::from_file(git.into_std())? == same_file::Handle::from_file(opened.try_clone()?)? {
                    return Err(io::ErrorKind::PermissionDenied.into());
                }
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
    }
    if !metadata.is_dir() {
        return Err(io::ErrorKind::NotADirectory.into());
    }
    Ok(Dir::from_std_file(opened))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_std::ambient_authority;
    use std::fs;

    #[test]
    fn names_and_parents_are_literal() {
        for name in ["", ".", "..", "../escape", "/abs", "x/y", "x\\y", ".git", "x\0y"] {
            assert!(checked_name(name).is_err(), "{name:?}");
        }
        for path in ["", "./src", "a/../b", "a\\b", "/absolute", "src//nested", ".git/hooks"] {
            assert!(checked_parent(path).is_err(), "{path:?}");
        }
        assert!(checked_name("étude 日本語.txt").is_ok());
        assert_eq!(checked_parent(".").unwrap(), ".");
        assert_eq!(checked_parent("src/nested").unwrap(), "src/nested");
    }

    #[test]
    fn creates_inside_an_existing_parent_without_clobbering_entries() {
        let path = crate::shared::test_dir("entry-create");
        let open = || Dir::open_ambient_dir(&path, ambient_authority()).unwrap();
        let folder = Create { parent: ".".into(), name: "dossier".into(), kind: Kind::Directory };
        create_at(open(), &folder).unwrap();
        let file = Create { parent: "dossier".into(), name: "étude.txt".into(), kind: Kind::File };
        create_at(open(), &file).unwrap();
        let created = path.join("dossier/étude.txt");
        assert_eq!(fs::read(&created).unwrap(), b"");
        fs::write(&created, b"keep").unwrap();
        assert_eq!(create_at(open(), &file).unwrap_err().0, Status::CONFLICT);
        assert_eq!(create_at(open(), &folder).unwrap_err().0, Status::CONFLICT);
        assert_eq!(fs::read(created).unwrap(), b"keep");
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn creation_does_not_follow_linked_parents() {
        let base = crate::shared::test_dir("entry-create-links");
        let project = base.join("project");
        let outside = base.join("outside");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&outside).unwrap();
        let alias = project.join("alias");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &alias).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let status = std::process::Command::new("cmd.exe")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(&alias)
                .arg(&outside)
                .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
                .output()
                .unwrap();
            assert!(status.status.success(), "{status:?}");
        }
        let root = Dir::open_ambient_dir(&project, ambient_authority()).unwrap();
        let file = Create { parent: "alias".into(), name: "outside.txt".into(), kind: Kind::File };
        assert!(create_at(root, &file).is_err());
        assert!(!outside.join("outside.txt").exists());
        fs::remove_dir_all(&base).unwrap();
    }
}
