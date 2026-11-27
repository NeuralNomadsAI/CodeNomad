//! Commit history and one commit's changed files with their contents.
use super::{
    TWO_MIB, bad, repo, run, run_with_stdin, sha,
    status_read::{changes, mime},
};
use crate::{Error, Shared, files};
use axum::{
    Json,
    extract::{Path as Route, Query, State},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::Path;

async fn git(dir: &Path, args: &[&str]) -> Result<String, Error> {
    Ok(run(dir, args, TWO_MIB).await?.ok()?.text())
}
async fn has_alternates(dir: &Path) -> Result<bool, Error> {
    let common = git(dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await?;
    let alternates = Path::new(common.trim()).join("objects").join("info").join("alternates");
    match std::fs::symlink_metadata(alternates) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        // Fail closed on permission or I/O errors: require reachability proof unless absence is confirmed.
        Err(_) => Ok(true),
    }
}
async fn ensure_commit_reachable(dir: &Path, commit: &str, err_msg: &str) -> Result<String, Error> {
    let alt_before = has_alternates(dir).await?;
    let verify = run(dir, &["rev-parse", "--verify", "--quiet", &format!("{commit}^{{commit}}")], 1024).await?;
    if verify.code != 0 {
        return Err(bad(err_msg));
    }
    let resolved = verify.text().trim().to_owned();
    if !sha(&resolved) {
        return Err(bad(err_msg));
    }
    if !alt_before && !has_alternates(dir).await? {
        return Ok(resolved);
    }
    let on_head = run(dir, &["merge-base", "--is-ancestor", &resolved, "HEAD"], 1024).await?;
    if on_head.code == 0 {
        return Ok(resolved);
    }
    let on_ref =
        run(dir, &["for-each-ref", &format!("--contains={resolved}"), "--count=1", "--format=%(refname)"], 4096)
            .await?;
    if on_ref.code == 0 && !on_ref.bytes.is_empty() {
        return Ok(resolved);
    }
    // Preserve pinned history pagination anchors AND every ancestor commit shown on those pages
    // after a local rebase/reset in shared clones by checking ancestry against this worktree's
    // HEAD reflog tips.
    let reflog = run(dir, &["log", "--no-show-signature", "-g", "--format=%H", "HEAD"], TWO_MIB).await?;
    if reflog.code == 0 {
        let mut tips = std::collections::HashSet::new();
        let mut stdin = String::with_capacity(resolved.len() + 128);
        stdin.push_str(&resolved);
        stdin.push('\n');
        for line in reflog.text().lines() {
            let tip = line.trim();
            if sha(tip) && tips.insert(tip.to_owned()) {
                stdin.push('^');
                stdin.push_str(tip);
                stdin.push('\n');
            }
        }
        if !tips.is_empty() {
            // Omit `--ignore-missing` so a missing candidate `<resolved>` fails closed (exit 128)
            // rather than producing an empty stdout that could be mistaken for ancestry.
            let check = run_with_stdin(dir, &["rev-list", "--max-count=1", "--stdin"], stdin.as_bytes(), 1024).await?;
            if check.code == 0 && check.bytes.is_empty() {
                return Ok(resolved);
            }
        }
    }
    Err(bad(err_msg))
}
#[derive(Deserialize)]
pub struct Page {
    #[serde(default)]
    offset: u64,
    head: Option<String>,
}
pub async fn history(
    State(app): State<Shared>,
    Route((id, slug)): Route<(String, String)>,
    Query(q): Query<Page>,
) -> Result<Json<Value>, Error> {
    let w = repo(&app, &id, &slug).await?;
    if q.offset > 9007199254740991 {
        return Err(bad("Invalid history offset"));
    }
    let head = if let Some(h) = q.head {
        if !sha(&h) {
            return Err(bad("Invalid commit ID"));
        }
        Some(ensure_commit_reachable(&w.path, &h, "Invalid commit ID").await?)
    } else {
        let h = run(&w.path, &["rev-parse", "--verify", "--quiet", "HEAD"], 1024).await?;
        if h.code == 1 { None } else { Some(h.ok()?.text().trim().to_owned()) }
    };
    let b = git(&w.path, &["branch", "--show-current"]).await?;
    let branch = Some(b.trim()).filter(|v| !v.is_empty());
    let mut commits = Vec::new();
    let mut more = false;
    if let Some(head) = &head {
        let text = git(
            &w.path,
            &[
                "log",
                "--no-show-signature",
                "-z",
                "--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%D",
                "--max-count=51",
                &format!("--skip={}", q.offset),
                head,
                "--",
            ],
        )
        .await?;
        for fields in text.split('\0').collect::<Vec<_>>().chunks_exact(6) {
            if commits.len() == 50 {
                more = true;
                break;
            }
            commits.push(json!({"id":fields[0],"parents":fields[1].split_whitespace().collect::<Vec<_>>(),"author":fields[2],"date":fields[3],"subject":fields[4],"refs":fields[5]}));
        }
    }
    app.workspace(&id)?;
    Ok(Json(json!({"head":head,"branch":branch,"commits":commits,"hasMore":more})))
}
async fn file(dir: &Path, revision: &str, p: &str, binary: bool) -> Result<Vec<u8>, Error> {
    let out = git(dir, &["ls-tree", "-z", revision, "--", p]).await?;
    let (meta, path) = out.trim_end_matches('\0').split_once('\t').ok_or_else(|| bad("Commit file is unavailable"))?;
    let mut fields = meta.split(' ');
    let mode = fields.next().unwrap_or_default();
    let kind = fields.next().unwrap_or_default();
    let object = fields.next().filter(|p| sha(p)).ok_or_else(|| bad("Commit file is unavailable"))?;
    if path != p {
        return Err(bad("Commit file is unavailable"));
    }
    if mode == "160000" && kind == "commit" {
        return Ok(format!("Subproject commit {object}\n").into_bytes());
    }
    if kind != "blob" {
        return Err(bad("Commit file is unavailable"));
    }
    Ok(run(dir, &["cat-file", "blob", object], if binary { files::MAX } else { TWO_MIB }).await?.ok()?.bytes)
}
#[derive(Deserialize)]
pub struct Details {
    path: Option<String>,
}
pub async fn commit_details(
    State(app): State<Shared>,
    Route((id, slug, commit)): Route<(String, String, String)>,
    Query(q): Query<Details>,
) -> Result<Json<Value>, Error> {
    if !sha(&commit) {
        return Err(bad("Invalid commit ID"));
    }
    let w = repo(&app, &id, &slug).await?;
    let _slot = app.file_reader.acquire().await.unwrap();
    let commit = ensure_commit_reachable(&w.path, &commit, "Object is not a commit").await?;
    let text = git(
        &w.path,
        &["show", "--no-show-signature", "-s", "--format=%P%x00%B", &format!("{commit}^{{commit}}"), "--"],
    )
    .await
    .map_err(|_| bad("Object is not a commit"))?;
    let (parents, message) = text.split_once('\0').ok_or_else(|| bad("Object is not a commit"))?;
    let parent = parents.split_whitespace().next().filter(|p| sha(p));
    let mut args = vec![
        "diff-tree",
        "--root",
        "--no-commit-id",
        "-r",
        "-M",
        "--name-status",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
    ];
    if let Some(parent) = parent {
        args.push(parent);
    }
    args.extend([commit.as_str(), "--"]);
    let changed = git(&w.path, &args).await?;
    let list: Vec<_> = changes(&changed).collect();
    let response = if let Some(input) = q.path {
        let p = files::relative(&input, false)?;
        let (kind, _, old) =
            *list.iter().find(|(_, p, _)| *p == input).ok_or_else(|| bad("File does not belong to this commit"))?;
        if let Some(old) = old {
            files::relative(old, false)?;
        }
        let image = mime(&p);
        let before = if let Some(parent) = parent.filter(|_| kind != "A") {
            Some(file(&w.path, parent, old.unwrap_or(&p), image.is_some()).await?)
        } else {
            None
        };
        let after = if kind != "D" { Some(file(&w.path, &commit, &p, image.is_some()).await?) } else { None };
        let mut out = json!({"path":p,"before":"","after":"","isBinary":false});
        super::sides(&mut out, image, before, after);
        out
    } else {
        let files = list
            .into_iter()
            .filter(|(_, p, _)| files::relative(p, false).is_ok())
            .map(|(s, p, old)| json!({"path":p,"originalPath":old,"status":&s[..1]}))
            .collect::<Vec<_>>();
        json!({"id":commit,"parent":parent,"message":message.trim_end(),"files":files})
    };
    app.workspace(&id)?;
    Ok(Json(response))
}
