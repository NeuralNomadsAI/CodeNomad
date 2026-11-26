//! Working-tree status and one file's diff (staged or not).
use super::{TWO_MIB, bad, repo, run};
use crate::{Error, Shared, files};
use axum::{
    Json,
    extract::{Path as Route, Query, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
};

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    path: String,
    original_path: Option<String>,
    staged_status: Option<&'static str>,
    unstaged_status: Option<&'static str>,
    staged_additions: u64,
    staged_deletions: u64,
    unstaged_additions: u64,
    unstaged_deletions: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    unstaged_whitespace_only: Option<bool>,
}
fn entry<'a>(map: &'a mut BTreeMap<String, Entry>, p: &str) -> Option<&'a mut Entry> {
    let p = files::relative(p, false).ok()?;
    Some(map.entry(p.clone()).or_insert_with(|| Entry { path: p, ..Default::default() }))
}
pub fn changes(text: &str) -> impl Iterator<Item = (&str, &str, Option<&str>)> {
    let mut fields = text.split('\0');
    std::iter::from_fn(move || {
        let status = fields.next().filter(|s| !s.is_empty())?;
        let first = fields.next()?;
        if status.starts_with(['R', 'C']) {
            Some((status, fields.next()?, Some(first)))
        } else {
            Some((status, first, None))
        }
    })
}
fn add_changes(map: &mut BTreeMap<String, Entry>, text: &str, staged: bool) {
    for (c, p, old) in changes(text) {
        let kind = match c.as_bytes()[0] {
            b'A' => "added",
            b'M' => "modified",
            b'D' => "deleted",
            b'R' => "renamed",
            b'C' => "copied",
            b'U' => "unmerged",
            _ => continue,
        };
        if let Some(row) = entry(map, p) {
            if staged {
                row.staged_status = Some(kind);
            } else {
                row.unstaged_status = Some(kind);
            }
            if let Some(old) = old {
                row.original_path = files::relative(old, false).ok();
            }
        }
    }
}
type Counts = (u64, u64, bool);
fn count(a: &str, d: &str) -> Counts {
    (a.parse().unwrap_or(0), d.parse().unwrap_or(0), a == "-" || d == "-")
}
fn numstats(text: &str) -> impl Iterator<Item = (&str, Option<&str>, Counts)> {
    let mut fields = text.split('\0');
    std::iter::from_fn(move || {
        let mut row = fields.next()?.splitn(3, '\t');
        let stat = count(row.next()?, row.next()?);
        let p = row.next()?;
        if p.is_empty() {
            let old = fields.next()?;
            Some((fields.next()?, Some(old), stat))
        } else {
            Some((p, None, stat))
        }
    })
}
fn simple(text: &str) -> Option<Counts> {
    let mut p = text.lines().next()?.splitn(3, '\t');
    Some(count(p.next()?, p.next()?))
}
fn add_stats(map: &mut BTreeMap<String, Entry>, text: &str, staged: bool) {
    for (p, old, (a, d, _)) in numstats(text) {
        if let Some(e) = entry(map, p) {
            if staged {
                e.staged_additions = a;
                e.staged_deletions = d;
            } else {
                e.unstaged_additions = a;
                e.unstaged_deletions = d;
            }
            if let Some(old) = old {
                e.original_path = files::relative(old, false).ok();
            }
        }
    }
}
/// Every diff read: no external diff or text conversion, submodule commits only.
const SAFE: [&str; 3] = ["--no-ext-diff", "--no-textconv", "--ignore-submodules=dirty"];
fn diff_args<'a>(filter_flags: &'a [String], flags: &[&'a str], tail: &[&'a str]) -> Vec<&'a str> {
    filter_flags
        .iter()
        .map(String::as_str)
        .chain(std::iter::once("diff"))
        .chain(flags.iter().copied())
        .chain(SAFE.iter().copied())
        .chain(tail.iter().copied())
        .collect()
}
async fn metadata(dir: &Path, args: &[&str]) -> Result<String, Error> {
    Ok(run(dir, args, TWO_MIB).await?.ok()?.text())
}
async fn new_file(dir: &Path, filter_flags: &[String], p: &str) -> Result<Counts, Error> {
    let full = dir.join(p);
    let full = full.to_str().ok_or_else(|| bad("Invalid path"))?;
    let output =
        run(dir, &diff_args(filter_flags, &["--numstat"], &["--no-index", "--", "/dev/null", full]), 4096).await?;
    if !matches!(output.code, 0 | 1) {
        return Err(bad("Unable to read untracked file"));
    }
    Ok(simple(&output.text()).unwrap_or_default())
}
#[derive(Deserialize)]
pub struct StatusQuery {
    #[serde(rename = "hideWhitespace")]
    hide_whitespace: Option<String>,
}
pub async fn status(
    State(app): State<Shared>,
    Route((id, slug)): Route<(String, String)>,
    Query(q): Query<StatusQuery>,
) -> Result<Json<Value>, Error> {
    let w = repo(&app, &id, &slug).await?;
    files::root(&w)?;
    let p = w.path.as_path();
    let filter_flags = super::config_guard::filter_disables(p).await?;
    let read = |flags: &[&'static str]| {
        let args = diff_args(&filter_flags, flags, &[]);
        async move { metadata(p, &args).await }
    };
    let s = read(&["--name-status", "-z", "--cached", "--find-renames", "--find-copies"]);
    let u = read(&["--name-status", "-z", "--find-renames", "--find-copies"]);
    let n = metadata(p, &["ls-files", "--others", "--exclude-standard", "-z"]);
    let sc = read(&["--numstat", "-z", "--cached", "--find-renames", "--find-copies"]);
    let uc = read(&["--numstat", "-z", "--find-renames", "--find-copies"]);
    let (s, u, n, sc, uc) = tokio::try_join!(s, u, n, sc, uc)?;
    let mut map = BTreeMap::new();
    add_changes(&mut map, &s, true);
    add_changes(&mut map, &u, false);
    for path in n.split('\0').filter(|s| !s.is_empty()) {
        if let Some(e) = entry(&mut map, path) {
            e.unstaged_status = Some("untracked");
        }
    }
    add_stats(&mut map, &sc, true);
    add_stats(&mut map, &uc, false);
    if map.len() > 8192 {
        return Err(bad("Git status exceeds entry limit"));
    }
    if q.hide_whitespace.as_deref() == Some("1")
        && let Ok(w) = read(&["--numstat", "-z", "--ignore-all-space"]).await
    {
        let listed: HashSet<_> = numstats(&w).map(|x| x.0).collect();
        for e in map.values_mut() {
            if e.unstaged_status == Some("modified")
                && e.staged_status != Some("unmerged")
                && e.unstaged_additions + e.unstaged_deletions > 0
            {
                e.unstaged_whitespace_only = Some(!listed.contains(e.path.as_str()));
            }
        }
    }
    // Keep large untracked inventories usable without queuing a process per row.
    for e in map.values_mut().filter(|e| e.unstaged_status == Some("untracked")).take(128) {
        if crate::files::links::guard(p, &e.path).is_ok()
            && let Ok((a, d, _)) = new_file(p, &filter_flags, &e.path).await
        {
            e.unstaged_additions = a;
            e.unstaged_deletions = d;
        }
    }
    app.workspace(&id)?;
    let mut result: Vec<_> = map.into_values().collect();
    result.sort_by_cached_key(|e| e.path.to_lowercase());
    Ok(Json(json!(result)))
}
pub fn mime(p: &str) -> Option<&'static str> {
    Some(match p.rsplit('.').next()?.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}
async fn blob(dir: &Path, revision: &str, sub: &str, max: usize) -> Result<Option<Vec<u8>>, Error> {
    let args = if sub == "cat-file" { vec![sub, "-p", revision] } else { vec![sub, revision] };
    let result = run(dir, &args, max).await?;
    if result.code == 0 { Ok(Some(result.bytes)) } else { Ok(None) }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffQuery {
    path: String,
    original_path: Option<String>,
    scope: String,
}
pub async fn diff(
    State(app): State<Shared>,
    Route((id, slug)): Route<(String, String)>,
    Query(q): Query<DiffQuery>,
) -> Result<Json<Value>, Error> {
    let w = repo(&app, &id, &slug).await?;
    let p = files::relative(q.path.trim(), false)?;
    let old =
        q.original_path.as_deref().filter(|p| !p.is_empty()).map(|p| files::relative(p.trim(), false)).transpose()?;
    let stage = match q.scope.as_str() {
        "staged" => true,
        "unstaged" => false,
        _ => return Err(bad("Invalid diff scope")),
    };
    let _slot = app.file_reader.acquire().await.unwrap();
    files::root(&w)?;
    crate::files::links::guard(&w.path, &p)?;
    if let Some(old) = &old {
        crate::files::links::guard(&w.path, old)?;
    }
    let filter_flags = super::config_guard::filter_disables(&w.path).await?;
    let mut args = diff_args(&filter_flags, &["--numstat", "--find-renames", "--find-copies"], &[]);
    if stage {
        args.push("--cached");
    }
    args.extend(["--", &p]);
    if let Some(old) = &old
        && old != &p
    {
        args.push(old);
    }
    let mut binary = simple(&metadata(&w.path, &args).await?);
    if binary.is_none() && !stage && crate::files::links::target(&w.path, &p).is_file() {
        binary = Some(new_file(&w.path, &filter_flags, &p).await?);
    }
    let mut output = json!({"path":p,"originalPath":old,"scope":q.scope,"before":"","after":"","isBinary":false});
    let image = mime(&p);
    if image.is_none() && binary.is_some_and(|v| v.2) {
        output["isBinary"] = json!(true);
        return Ok(Json(output));
    }
    let bound = if image.is_some() { files::MAX } else { TWO_MIB };
    let current = format!(":{p}");
    let mut before = if stage {
        blob(&w.path, &format!("HEAD:{}", old.as_deref().unwrap_or(&p)), "show", bound).await?
    } else {
        blob(&w.path, &current, "cat-file", bound).await?
    };
    if !stage
        && before.is_none()
        && let Some(old) = &old
    {
        before = blob(&w.path, &format!(":{old}"), "cat-file", bound).await?;
    }
    let after = if stage {
        blob(&w.path, &current, "cat-file", bound).await?
    } else {
        crate::files::links::read_lenient(&w.path, &p, bound)?
    };
    super::sides(&mut output, image, before, after);
    app.workspace(&id)?;
    Ok(Json(output))
}
