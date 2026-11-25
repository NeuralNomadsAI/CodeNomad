use super::git_discovery::{shares_common_directory, shares_common_directory_strict};
use super::*;

#[test]
fn missing_components_resolve_under_their_real_ancestor() {
    let base = dunce::canonicalize(std::env::temp_dir()).unwrap();
    let virtual_path = base.join("depth-owner-missing").join("a").join("b");
    let _ = std::fs::remove_dir_all(base.join("depth-owner-missing"));
    assert_eq!(resolve_directory(&virtual_path.to_string_lossy()), Some(virtual_path.clone()));
    assert_eq!(resolve_directory(&format!("  {}  ", base.to_string_lossy())), Some(base.clone()));
    assert_eq!(resolve_directory("   "), None);
    assert!(within(&base, &virtual_path) && within(&base, &base) && !within(&virtual_path, &base));
}

#[cfg(windows)]
#[tokio::test]
async fn a_junction_to_a_foreign_folder_shares_no_common_directory() {
    let base = crate::shared::test_dir("depth-owner");
    let (repo, foreign) = (base.join("repo"), base.join("foreign"));
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::create_dir_all(&foreign).unwrap();
    let init = crate::git::run(&repo, &["init", "--quiet"], 4096).await.unwrap();
    assert_eq!(init.code, 0);
    let link = repo.join("link");
    let made =
        std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(&link).arg(&foreign).output().unwrap();
    assert!(made.status.success());
    let real = dunce::canonicalize(&link).unwrap();
    assert_eq!(real, foreign);
    assert!(!within(&repo, &real));
    assert_eq!(shares_common_directory(&repo, &real).await, Ok(false));
    assert_eq!(shares_common_directory(&repo, &repo).await, Ok(true));
    std::fs::write(foreign.join(".git"), "gitdir: missing").unwrap();
    assert_eq!(shares_common_directory(&repo, &real).await, Err(()));
    std::fs::remove_dir(&link).unwrap();
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn resolve_media_path_normalizes_parent_segments_within_scope() {
    let base = crate::shared::test_dir("media-norm");
    let scope = dunce::canonicalize(&base).unwrap();
    let sub_a = scope.join("a");
    let sub_b = scope.join("b");
    std::fs::create_dir_all(&sub_a).unwrap();
    std::fs::create_dir_all(&sub_b).unwrap();
    let with_dotdot =
        format!("{}{}..{}b", sub_a.to_string_lossy(), std::path::MAIN_SEPARATOR, std::path::MAIN_SEPARATOR);
    let (resolved, anchor) = resolve_media_path(&scope, &with_dotdot).expect("normalized subfolder resolves");
    assert_eq!(resolved, sub_b);
    assert_eq!(anchor, sub_b);
    let escaping =
        format!("{}{}..{}outside", scope.to_string_lossy(), std::path::MAIN_SEPARATOR, std::path::MAIN_SEPARATOR);
    assert!(resolve_media_path(&scope, &escaping).is_none());
    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn strict_common_directory_rejects_incomplete_nested_git_dir() {
    let base = crate::shared::test_dir("strict-incomplete-git");
    let repo = base.join("repo");
    let sub = repo.join("sub");
    std::fs::create_dir_all(&sub).unwrap();
    let init = crate::git::run(&repo, &["init", "--quiet"], 4096).await.unwrap();
    assert_eq!(init.code, 0);
    assert_eq!(shares_common_directory_strict(&repo, &sub).await, Ok(true));
    std::fs::create_dir_all(sub.join(".git")).unwrap();
    assert_eq!(shares_common_directory_strict(&repo, &sub).await, Err(()));
    let _ = std::fs::remove_dir_all(&base);
}
