//! Bounded native reads of one observation, fenced before and after each read
//! (reference `observe` in `missions/activity.ts`, family readers in
//! `missions/native-session-family.ts`).
use super::ojson::{J, parse};
use crate::{App, Workspace};
use axum::http::Method;
use std::{
    collections::{HashMap, HashSet},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tokio::time::Instant;

pub const MAX_DESCENDANTS: usize = 32;

#[derive(Clone, Debug, PartialEq)]
pub struct Loc {
    pub directory: String,
    pub workspace: Option<String>,
}
impl Loc {
    pub fn read(v: Option<&J>) -> Option<Loc> {
        let v = v?;
        Some(Loc {
            directory: v.get("directory")?.str()?.to_owned(),
            workspace: match v.get("workspaceID") {
                None => None,
                Some(w) => Some(w.str()?.to_owned()),
            },
        })
    }
    /// Reference `locationKey`.
    pub fn key(&self) -> String {
        format!("{}\0{}", self.directory, self.workspace.as_deref().unwrap_or_default())
    }
}
/// Reference `sameLocation`; an absent location is never the same.
pub fn same(a: Option<&Loc>, b: Option<&Loc>) -> bool {
    matches!((a, b), (Some(a), Some(b)) if a == b)
}

/// A native `SessionInfo`, reduced to the identity fields observations compare.
#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    pub id: String,
    pub parent: Option<String>,
    pub project: Option<String>,
    pub location: Option<Loc>,
}
impl Session {
    pub fn read(v: &J) -> Session {
        Session {
            id: v.get("id").and_then(J::str).unwrap_or_default().to_owned(),
            parent: v.get("parentID").and_then(J::str).map(str::to_owned),
            project: v.get("projectID").and_then(J::str).map(str::to_owned),
            location: Loc::read(v.get("location")),
        }
    }
}

/// Insertion-ordered tree: root first, then breadth-first members.
#[derive(Clone, Debug, Default)]
pub struct Tree {
    pub order: Vec<String>,
    pub map: HashMap<String, Session>,
}
impl Tree {
    pub fn insert(&mut self, s: Session) {
        if self.map.insert(s.id.clone(), s.clone()).is_none() {
            self.order.push(s.id);
        }
    }
    pub fn get(&self, id: &str) -> Option<&Session> {
        self.map.get(id)
    }
    pub fn has(&self, id: &str) -> bool {
        self.map.contains_key(id)
    }
    pub fn len(&self) -> usize {
        self.order.len()
    }
    pub fn iter(&self) -> impl Iterator<Item = (&String, &Session)> {
        self.order.iter().map(|id| (id, &self.map[id]))
    }
}

#[derive(Debug, PartialEq)]
pub enum Fail {
    Missing,
    Other,
}

/// Observation lifetime: the route's currentness plus the 15 s signal.
pub struct Observer<'a> {
    pub app: &'a App,
    pub workspace: &'a Workspace,
    pub deadline: Instant,
    pub current: &'a (dyn Fn() -> bool + Sync),
    stale: AtomicBool,
}
impl<'a> Observer<'a> {
    pub fn new(app: &'a App, workspace: &'a Workspace, deadline: Instant, current: &'a (dyn Fn() -> bool + Sync)) -> Self {
        Observer { app, workspace, deadline, current, stale: AtomicBool::new(false) }
    }
    /// Reference `assertCurrent`: staleness is sticky.
    pub fn assert(&self) -> bool {
        if self.stale.load(Ordering::SeqCst) || !(self.current)() {
            self.stale.store(true, Ordering::SeqCst);
            return false;
        }
        true
    }
    pub async fn observe<T>(&self, read: impl Future<Output = Result<T, Fail>>) -> Result<T, Fail> {
        if !self.assert() {
            return Err(Fail::Other);
        }
        let result = read.await;
        if !self.assert() {
            return Err(Fail::Other);
        }
        result
    }
    pub async fn get(&self, path: &str, query: &[(&str, &str)], max: usize, deadline: Instant) -> Result<J, Fail> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(Fail::Other);
        }
        let url = self.app.native.url().join(path).map_err(|_| Fail::Other)?;
        let mut response = self
            .app
            .native
            .request(Method::GET, url)
            .query(query)
            .timeout(remaining.min(Duration::from_secs(15)))
            .send()
            .await
            .map_err(|_| Fail::Other)?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(Fail::Missing);
        }
        if response.status() != reqwest::StatusCode::OK {
            return Err(Fail::Other);
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| Fail::Other)? {
            if body.len() + chunk.len() > max {
                return Err(Fail::Other);
            }
            body.extend_from_slice(&chunk);
        }
        parse(&body).ok_or(Fail::Other)
    }
    /// `client.session.get`: the response's `data`.
    pub async fn session(&self, id: &str, deadline: Instant) -> Result<J, Fail> {
        let path = format!("/api/session/{}", component(id).ok_or(Fail::Other)?);
        let body = self.get(&path, &[], 1024 * 1024, deadline).await?;
        body.get("data").filter(|d| d.obj().is_some()).cloned().ok_or(Fail::Other)
    }
    pub async fn owns(&self, location: &Loc) -> bool {
        ownable(location) && crate::worktrees::owns(self.app, self.workspace, &location.directory).await
    }

    /// Reference `readNativeMissionFamilyTree`: any partial, moved or duplicate
    /// inventory fails the whole family.
    pub async fn family(&self, root: &Session) -> Result<Tree, Fail> {
        if !self.assert() || root.id.is_empty() || root.parent.as_deref() == Some(root.id.as_str()) {
            return Err(Fail::Other);
        }
        let mut tree = Tree::default();
        tree.insert(root.clone());
        let mut index = 0;
        let mut reads = 0;
        let limit = (MAX_DESCENDANTS + 1).to_string();
        while index < tree.order.len() {
            let parent = tree.order[index].clone();
            let mut cursor: Option<String> = None;
            let mut cursors = HashSet::new();
            loop {
                if Instant::now() >= self.deadline || !self.assert() {
                    return Err(Fail::Other);
                }
                reads += 1;
                if reads > 2 * (MAX_DESCENDANTS + 1) {
                    return Err(Fail::Other);
                }
                let mut query = vec![("limit", limit.as_str()), ("parentID", parent.as_str())];
                if let Some(c) = cursor.as_deref() {
                    query.push(("cursor", c));
                }
                let page = self.get("/api/session", &query, 4 * 1024 * 1024, self.deadline).await?;
                if !self.assert() {
                    return Err(Fail::Other);
                }
                let rows = page.get("data").and_then(J::arr).ok_or(Fail::Other)?;
                if rows.len() + tree.len() > MAX_DESCENDANTS + 1 {
                    return Err(Fail::Other);
                }
                for row in rows {
                    let child = Session::read(row);
                    if !row.get("id").and_then(J::str).is_some_and(|s| !s.trim().is_empty())
                        || child.parent.as_deref() != Some(parent.as_str())
                        || child.project != root.project
                        || !same(child.location.as_ref(), root.location.as_ref())
                        || tree.has(&child.id)
                    {
                        return Err(Fail::Other);
                    }
                    tree.insert(child);
                }
                // `cursor.next ?? undefined`: only a non-empty string continues.
                cursor = page
                    .get("cursor")
                    .ok_or(Fail::Other)?
                    .get("next")
                    .and_then(J::str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned);
                match &cursor {
                    Some(c) if rows.is_empty() || !cursors.insert(c.clone()) => return Err(Fail::Other),
                    Some(_) => {}
                    None => break,
                }
            }
            index += 1;
        }
        if !self.assert() {
            return Err(Fail::Other);
        }
        Ok(tree)
    }

    /// Reference `observeActiveDescendant` with a shared parent cache and budget.
    pub async fn active_descendant(
        &self,
        root: &str,
        active: &[(String, J)],
        parents: &mut HashMap<String, Option<String>>,
        budget: &mut i64,
        deadline: Instant,
    ) -> Result<bool, Fail> {
        let ids = active.iter().filter(|(id, v)| id != root && truthy(v)).take(256);
        for (id, _) in ids {
            let mut seen = HashSet::new();
            let mut cursor = Some(id.clone());
            while let Some(current) = cursor.clone() {
                if !seen.insert(current.clone()) {
                    break;
                }
                if current == root {
                    return Ok(true);
                }
                if !parents.contains_key(&current) {
                    if *budget <= 0 {
                        break;
                    }
                    *budget -= 1;
                    if Instant::now() >= deadline {
                        return Err(Fail::Other);
                    }
                    let parent = match self.session(&current, deadline).await {
                        Ok(s) => Session::read(&s).parent,
                        Err(_) if Instant::now() >= deadline => return Err(Fail::Other),
                        Err(_) => None,
                    };
                    parents.insert(current.clone(), parent);
                }
                cursor = parents.get(&current).cloned().flatten();
            }
        }
        Ok(false)
    }
}

/// OpenCode V2 identifies locations by directory; a workspace selector is never owned
/// (reference `WorkspaceManager.ownsLocation`).
pub fn ownable(location: &Loc) -> bool {
    location.workspace.is_none()
}

/// `encodeURIComponent` of a path segment; dot segments would resolve to another route.
pub fn component(id: &str) -> Option<String> {
    const SET: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    (!id.is_empty() && id != "." && id != "..").then(|| percent_encoding::utf8_percent_encode(id, SET).to_string())
}

/// JavaScript truthiness of a native value.
pub fn truthy(v: &J) -> bool {
    match v {
        J::Null => false,
        J::Bool(b) => *b,
        J::U(n) => *n != 0,
        J::I(n) => *n != 0,
        J::F(f) => *f != 0.0 && !f.is_nan(),
        J::S(s) => !s.is_empty(),
        _ => true,
    }
}
