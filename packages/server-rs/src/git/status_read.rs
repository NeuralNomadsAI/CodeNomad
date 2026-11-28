//! Working-tree status and one file's diff (staged or not).
use super::{TWO_MIB, bad, repo, run, run_prefix};
use crate::{Error, Shared, files};
use axum::{
    Json,
    extract::{Path as Route, Query, State},
    http::HeaderValue,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
};

pub(crate) const MAX_STATUS_ENTRIES: usize = 8192;
pub(crate) const TRUNCATED_HEADER: &str = "x-codenomad-git-status-truncated";
pub(crate) const LIMIT_HEADER: &str = "x-codenomad-git-status-limit";

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
struct PrefixText {
    text: String,
    truncated: bool,
}
fn decode_nul_prefix(mut bytes: Vec<u8>, truncated: bool) -> PrefixText {
    if truncated {
        match bytes.iter().rposition(|&b| b == 0) {
            Some(pos) => bytes.truncate(pos + 1),
            None => bytes.clear(),
        }
    }
    PrefixText { text: String::from_utf8_lossy(&bytes).into_owned(), truncated }
}
fn entry<'a>(
    map: &'a mut BTreeMap<String, Entry>,
    p: &str,
    max_entries: usize,
    truncated: &mut bool,
) -> Option<&'a mut Entry> {
    let p = files::relative(p, false).ok()?;
    if map.contains_key(&p) {
        return map.get_mut(&p);
    }
    if map.len() >= max_entries {
        *truncated = true;
        return None;
    }
    map.insert(p.clone(), Entry { path: p.clone(), ..Default::default() });
    map.get_mut(&p)
}
pub fn changes(text: &str) -> impl Iterator<Item = (&str, &str, Option<&str>)> {
    let mut fields = text.split_terminator('\0');
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
fn add_changes(map: &mut BTreeMap<String, Entry>, text: &str, staged: bool, max_entries: usize, truncated: &mut bool) {
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
        if let Some(row) = entry(map, p, max_entries, truncated) {
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
    let mut fields = text.split_terminator('\0');
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
fn add_stats(map: &mut BTreeMap<String, Entry>, text: &str, staged: bool, max_entries: usize, truncated: &mut bool) {
    for (p, old, (a, d, _)) in numstats(text) {
        if let Some(e) = entry(map, p, max_entries, truncated) {
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
async fn status_metadata(dir: &Path, args: &[&str], max_bytes: usize) -> Result<PrefixText, Error> {
    let out = run_prefix(dir, args, max_bytes).await?;
    if !out.truncated && out.code != 0 {
        return Err(bad("Git read failed"));
    }
    Ok(decode_nul_prefix(out.bytes, out.truncated))
}
fn assemble_status(
    staged: &PrefixText,
    unstaged: &PrefixText,
    untracked: &PrefixText,
    staged_stats: &PrefixText,
    unstaged_stats: &PrefixText,
    whitespace: Option<&PrefixText>,
    max_entries: usize,
) -> (BTreeMap<String, Entry>, bool) {
    let mut truncated = staged.truncated
        || unstaged.truncated
        || untracked.truncated
        || staged_stats.truncated
        || unstaged_stats.truncated;
    let mut map = BTreeMap::new();
    add_changes(&mut map, &staged.text, true, max_entries, &mut truncated);
    add_changes(&mut map, &unstaged.text, false, max_entries, &mut truncated);
    for path in untracked.text.split_terminator('\0').filter(|s| !s.is_empty()) {
        if let Some(e) = entry(&mut map, path, max_entries, &mut truncated) {
            e.unstaged_status = Some("untracked");
        }
    }
    add_stats(&mut map, &staged_stats.text, true, max_entries, &mut truncated);
    add_stats(&mut map, &unstaged_stats.text, false, max_entries, &mut truncated);
    // Detection is a display aid: fail open on error or byte truncation so real changes stay visible.
    if let Some(w) = whitespace
        && !w.truncated
    {
        let listed: HashSet<_> = numstats(&w.text).map(|x| x.0).collect();
        for e in map.values_mut() {
            if e.unstaged_status == Some("modified")
                && e.staged_status != Some("unmerged")
                && e.unstaged_additions + e.unstaged_deletions > 0
            {
                e.unstaged_whitespace_only = Some(!listed.contains(e.path.as_str()));
            }
        }
    }
    (map, truncated)
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
) -> Result<Response, Error> {
    status_with_limits(app, id, slug, q.hide_whitespace.as_deref() == Some("1"), TWO_MIB, MAX_STATUS_ENTRIES).await
}
pub(super) async fn status_with_limits(
    app: Shared,
    id: String,
    slug: String,
    hide_whitespace: bool,
    max_bytes: usize,
    max_entries: usize,
) -> Result<Response, Error> {
    let w = repo(&app, &id, &slug).await?;
    let w_root = w.clone();
    tokio::task::spawn_blocking(move || files::root(&w_root))
        .await
        .map_err(|_| bad("Selected path is unavailable"))??;
    let p = w.path.as_path();
    let filter_flags = super::config_guard::filter_disables(p).await?;
    let read = |flags: &[&'static str]| {
        let args = diff_args(&filter_flags, flags, &[]);
        async move { status_metadata(p, &args, max_bytes).await }
    };
    let s = read(&["--name-status", "-z", "--cached", "--find-renames", "--find-copies"]);
    let u = read(&["--name-status", "-z", "--find-renames", "--find-copies"]);
    let n = status_metadata(p, &["ls-files", "--others", "--exclude-standard", "-z"], max_bytes);
    let sc = read(&["--numstat", "-z", "--cached", "--find-renames", "--find-copies"]);
    let uc = read(&["--numstat", "-z", "--find-renames", "--find-copies"]);
    let (s, u, n, sc, uc) = tokio::try_join!(s, u, n, sc, uc)?;
    let ws = if hide_whitespace { read(&["--numstat", "-z", "--ignore-all-space"]).await.ok() } else { None };
    let (mut map, truncated) = assemble_status(&s, &u, &n, &sc, &uc, ws.as_ref(), max_entries);
    // Keep large untracked inventories usable without queuing a process per row,
    // and keep link-guard filesystem checks off the single-threaded runtime.
    let untracked_candidates: Vec<String> =
        map.values().filter(|e| e.unstaged_status == Some("untracked")).take(128).map(|e| e.path.clone()).collect();
    if !untracked_candidates.is_empty() {
        let base = w.path.clone();
        let guarded = tokio::task::spawn_blocking(move || {
            untracked_candidates
                .into_iter()
                .filter(|rel| crate::files::links::guard(&base, rel).is_ok())
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        for path in guarded {
            if let Ok((a, d, _)) = new_file(p, &filter_flags, &path).await
                && let Some(e) = map.get_mut(&path)
            {
                e.unstaged_additions = a;
                e.unstaged_deletions = d;
            }
        }
    }
    app.workspace(&id)?;
    let mut result: Vec<_> = map.into_values().collect();
    result.sort_by_cached_key(|e| e.path.to_lowercase());
    let mut response = Json(json!(result)).into_response();
    if truncated {
        response.headers_mut().insert(TRUNCATED_HEADER, HeaderValue::from_static("1"));
        if let Ok(limit_val) = HeaderValue::from_str(&max_entries.to_string()) {
            response.headers_mut().insert(LIMIT_HEADER, limit_val);
        }
    }
    Ok(response)
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
    let (w_guard, p_guard, old_guard) = (w.clone(), p.clone(), old.clone());
    tokio::task::spawn_blocking(move || -> Result<(), Error> {
        files::root(&w_guard)?;
        crate::files::links::guard(&w_guard.path, &p_guard)?;
        if let Some(old) = &old_guard {
            crate::files::links::guard(&w_guard.path, old)?;
        }
        Ok(())
    })
    .await
    .map_err(|_| bad("Selected path is unavailable"))??;
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
    if binary.is_none() && !stage {
        let target_path = crate::files::links::target(&w.path, &p);
        let is_file = tokio::task::spawn_blocking(move || target_path.is_file()).await.unwrap_or(false);
        if is_file {
            binary = Some(new_file(&w.path, &filter_flags, &p).await?);
        }
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
        crate::files::links::read_lenient_async(w.path.clone(), p.clone(), bound).await?
    };
    let output = tokio::task::spawn_blocking(move || {
        super::sides(&mut output, image, before, after);
        output
    })
    .await
    .map_err(|_| bad("Selected path is unavailable"))?;
    app.workspace(&id)?;
    Ok(Json(output))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(text: &str, truncated: bool) -> PrefixText {
        PrefixText { text: text.to_owned(), truncated }
    }

    #[test]
    fn decode_nul_prefix_trims_to_last_complete_record_boundary() {
        let truncated = decode_nul_prefix(b"a.txt\0b.txt\0partial_utf8_\xC3".to_vec(), true);
        assert!(truncated.truncated);
        assert_eq!(truncated.text, "a.txt\0b.txt\0");

        let no_nul = decode_nul_prefix(b"only_partial_without_nul".to_vec(), true);
        assert!(no_nul.truncated);
        assert!(no_nul.text.is_empty());

        let exact = decode_nul_prefix(b"a.txt\0".to_vec(), false);
        assert!(!exact.truncated);
        assert_eq!(exact.text, "a.txt\0");
    }

    #[test]
    fn changes_and_numstats_ignore_incomplete_trailing_records_on_truncation() {
        // Cut right after status code or rename source path.
        assert_eq!(changes("M\0a.rs\0M\0").collect::<Vec<_>>(), vec![("M", "a.rs", None)]);
        assert_eq!(
            changes("R100\0old.rs\0new.rs\0R100\0orphan.rs\0").collect::<Vec<_>>(),
            vec![("R100", "new.rs", Some("old.rs"))]
        );
        assert_eq!(
            numstats("3\t1\ta.rs\04\t0\t\0old.rs\0new.rs\05\t2\t\0orphan.rs\0").collect::<Vec<_>>(),
            vec![("a.rs", None, (3, 1, false)), ("new.rs", Some("old.rs"), (4, 0, false))]
        );
    }

    #[test]
    fn assemble_status_bounds_entries_preserves_staged_updates_and_fails_open_on_truncated_whitespace() {
        let staged = pt("M\0staged.rs\0", false);
        let unstaged = pt("M\0staged.rs\0M\0dirty.rs\0", false);
        let untracked = pt("u1.txt\0u2.txt\0u3.txt\0u4.txt\0", false);
        let staged_stats = pt("2\t1\tstaged.rs\0", false);
        let unstaged_stats = pt("3\t0\tstaged.rs\05\t2\tdirty.rs\0", false);

        // Cap at 3 entries: staged.rs + dirty.rs + u1.txt fit; u2..u4 trigger truncation.
        let (map, truncated) = assemble_status(&staged, &unstaged, &untracked, &staged_stats, &unstaged_stats, None, 3);
        assert!(truncated);
        assert_eq!(map.len(), 3);
        assert_eq!(map["staged.rs"].staged_status, Some("modified"));
        assert_eq!(map["staged.rs"].unstaged_status, Some("modified"));
        assert_eq!(map["staged.rs"].staged_additions, 2);
        assert_eq!(map["staged.rs"].unstaged_additions, 3);
        assert_eq!(map["dirty.rs"].unstaged_additions, 5);
        assert_eq!(map["u1.txt"].unstaged_status, Some("untracked"));

        // Truncated `--ignore-all-space` output must fail open (never hide real changes).
        let ws_truncated = pt("", true);
        let (map_fail_open, _) = assemble_status(
            &staged,
            &unstaged,
            &pt("", false),
            &staged_stats,
            &unstaged_stats,
            Some(&ws_truncated),
            16,
        );
        assert_eq!(map_fail_open["dirty.rs"].unstaged_whitespace_only, None);

        // Complete `--ignore-all-space` output flags omitted modified files as whitespace-only.
        let ws_complete = pt("3\t0\tstaged.rs\0", false);
        let (map_ws, truncated_ws) =
            assemble_status(&staged, &unstaged, &pt("", false), &staged_stats, &unstaged_stats, Some(&ws_complete), 16);
        assert!(!truncated_ws);
        assert_eq!(map_ws["staged.rs"].unstaged_whitespace_only, Some(false));
        assert_eq!(map_ws["dirty.rs"].unstaged_whitespace_only, Some(true));
    }
}
