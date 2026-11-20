//! `memory/service.ts` + `memory/api.ts`: the preference, authorized targets, the
//! shared UI/agent operation contract and its fenced execution.

use super::model::{self, Code, Entry, MemoryError, Result, Scope, check, fail};
use super::store::{Mutation, Namespace, Store};
use super::{identity, rules};
use crate::App;
use serde_json::{Map, Value, json};
use std::{path::PathBuf, sync::LazyLock};
use tokio_util::sync::CancellationToken;

pub fn store(app: &App) -> Store {
    Store::new(&app.data)
}
pub fn settings_file(app: &App) -> PathBuf {
    app.data.join("config-server.json")
}
/// The raw `server` configuration owner (empty when absent).
pub fn server_owner(app: &App) -> std::result::Result<Map<String, Value>, ()> {
    match crate::storage::read_bounded(&settings_file(app), json!({}), 1024 * 1024) {
        Ok(Value::Object(m)) => Ok(m),
        _ => Err(()),
    }
}
fn preference() -> MemoryError {
    fail(Code::Unreadable, "Memory preference is unavailable")
}
/// `readMemoryEnabled`: absence means disabled; anything but a boolean is unreadable.
pub fn enabled(app: &App) -> Result<bool> {
    match server_owner(app).map_err(|_| preference())?.get("memoryEnabled") {
        None => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(preference()),
    }
}

/// `MemoryService.invalidate`: a hint only, without content or identities.
pub fn invalidate(app: &App) {
    app.emit(json!({"type":"memory.changed"}));
}

/// `withSettingsLock` + `setEnabled`: config writes share the repository lock.
pub async fn set_enabled(app: &App, value: bool, cancel: Option<&CancellationToken>) -> Result<bool> {
    check(cancel)?;
    let s = store(app);
    super::store::private_dir(&s.base, true)
        .map_err(|_| fail(Code::Unreadable, "Memory configuration is unavailable"))?;
    let guard = super::lock::acquire(&s.directory, cancel).await?;
    let outcome = (|| {
        check(cancel)?;
        // Fresh authority before the merge preserves external fields.
        let mut owner = server_owner(app).map_err(|_| preference())?;
        owner.insert("memoryEnabled".into(), json!(value));
        crate::storage::write(&settings_file(app), &Value::Object(owner.clone())).map_err(|_| preference())?;
        let mut published = json!({"serverId": app.meta["serverId"], "opencodeBinary": app.binary});
        for (k, v) in owner {
            published[k] = v;
        }
        app.emit(json!({"type":"storage.configChanged","owner":"server","value":published}));
        invalidate(app);
        enabled(app)
    })();
    guard.release().await?;
    outcome
}

#[derive(Clone, Debug)]
pub enum Operation {
    List(Scope),
    Read(Scope, String),
    Save { scope: Scope, content: Value, id: Option<String>, revision: Option<String> },
    Delete { scope: Scope, id: String, revision: String },
}
impl Operation {
    fn scope(&self) -> Scope {
        match self {
            Operation::List(s)
            | Operation::Read(s, _)
            | Operation::Save { scope: s, .. }
            | Operation::Delete { scope: s, .. } => *s,
        }
    }
}

fn api_id(v: &str) -> bool {
    static ID: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$").unwrap());
    ID.is_match(v)
}
fn api_revision(v: &str) -> bool {
    v.len() == 64 && v.bytes().all(|b| matches!(b, b'a'..=b'f' | b'0'..=b'9'))
}
fn exact(o: &Map<String, Value>, allowed: &[&str]) -> bool {
    o.keys().all(|k| allowed.contains(&k.as_str()))
}

/// `MemoryOperationSchema`.
pub fn parse_operation(value: &Value) -> Option<Operation> {
    let o = value.as_object()?;
    let scope = Scope::parse(o.get("scope")?.as_str()?)?;
    match o.get("action")?.as_str()? {
        "list" if exact(o, &["action", "scope"]) => Some(Operation::List(scope)),
        "read" if exact(o, &["action", "scope", "query"]) => {
            let q = o.get("query")?.as_str()?;
            (1..=200).contains(&model::points(q)).then(|| Operation::Read(scope, q.to_owned()))
        }
        "save" if exact(o, &["action", "scope", "content", "id", "revision"]) => {
            let c = o.get("content")?.as_object()?;
            if !exact(c, &["title", "type", "text"])
                || !c.get("title")?.is_string()
                || !c.get("text")?.is_string()
                || !matches!(c.get("type")?.as_str()?, "fact" | "preference" | "reference")
            {
                return None;
            }
            let id = match o.get("id") {
                None => None,
                Some(v) => Some(v.as_str().filter(|s| api_id(s))?.to_owned()),
            };
            let revision = match o.get("revision") {
                None => None,
                Some(v) => Some(v.as_str().filter(|s| api_revision(s))?.to_owned()),
            };
            Some(Operation::Save { scope, content: Value::Object(c.clone()), id, revision })
        }
        "delete" if exact(o, &["action", "scope", "id", "revision"]) => {
            let id = o.get("id")?.as_str().filter(|s| api_id(s))?.to_owned();
            let revision = o.get("revision")?.as_str().filter(|s| api_revision(s))?.to_owned();
            Some(Operation::Delete { scope, id, revision })
        }
        _ => None,
    }
}
/// `MemoryContextSchema`.
pub fn parse_context(value: &Value) -> Option<(String, Option<String>)> {
    let o = value.as_object().filter(|o| exact(o, &["workspaceId", "directory"]))?;
    let w = o.get("workspaceId")?.as_str().filter(|s| (1..=200).contains(&model::points(s)))?.to_owned();
    let d = match o.get("directory") {
        None => None,
        Some(v) => Some(v.as_str().filter(|s| (1..=4096).contains(&model::points(s)))?.to_owned()),
    };
    Some((w, d))
}

#[derive(Clone)]
pub enum Target {
    Ui(Option<Value>),
    Session(String),
}

/// `uiTarget`: the opened record, then its authorized execution-host directory.
pub async fn ui_target(app: &App, context: &Option<Value>) -> Result<String> {
    let (workspace, directory) = context
        .as_ref()
        .and_then(parse_context)
        .ok_or_else(|| fail(Code::Invalid, "An authorized project context is required"))?;
    let w = app.workspace(&workspace).map_err(|_| fail(Code::Invalid, "Project is unavailable"))?;
    let wanted = directory.unwrap_or_else(|| w.path.to_string_lossy().into_owned());
    let owned = crate::worktrees::ownership::resolve(app, &w, &wanted).await;
    match owned {
        Some(o) if app.workspace(&workspace).is_ok() => Ok(o.directory),
        _ => Err(fail(Code::Invalid, "Project location is not owned")),
    }
}

/// `sessionTarget`: the native session's location, owned by one opened workspace.
pub async fn session_target(app: &App, session: &str) -> Result<String> {
    if session.is_empty() || session.encode_utf16().count() > 200 {
        return Err(fail(Code::Invalid, "Invalid session"));
    }
    let record = crate::opencode::session_record(app, session)
        .await
        .map_err(|_| fail(Code::Unreadable, "Memory session is unavailable"))?;
    let not_owned = || fail(Code::Invalid, "Session location is not owned");
    let location =
        record.get("location").filter(|l| l.is_object() && l.get("workspaceID").is_none()).ok_or_else(not_owned)?;
    let directory = location["directory"].as_str().ok_or_else(not_owned)?.to_owned();
    let workspaces = app.inner.lock().unwrap().workspaces.clone();
    for w in workspaces {
        if let Some(owned) = crate::worktrees::ownership::resolve(app, &w, &directory).await
            && app.workspace(&w.id.to_string()).is_ok()
        {
            return Ok(owned.directory);
        }
    }
    Err(not_owned())
}

async fn target(app: &App, t: &Target) -> Result<String> {
    match t {
        Target::Ui(c) => ui_target(app, c).await,
        Target::Session(s) => session_target(app, s).await,
    }
}

async fn namespace(
    app: &App,
    op: &Operation,
    t: &Target,
    agent: bool,
    cancel: Option<&CancellationToken>,
) -> Result<Namespace> {
    check(cancel)?;
    // Even global agent calls must have a current native owner.
    let authorized = if agent || op.scope() == Scope::Project { Some(target(app, t).await?) } else { None };
    check(cancel)?;
    if op.scope() == Scope::Global {
        return Ok(Namespace::Global);
    }
    let directory = authorized.expect("project target");
    let project = identity::resolve(&directory).await?;
    check(cancel)?;
    if target(app, t).await? != directory {
        return Err(fail(Code::Conflict, "Memory project changed"));
    }
    Ok(Namespace::Project(project))
}

pub async fn execute(app: &App, input: &Value, t: Target, cancel: Option<&CancellationToken>) -> Result<Value> {
    check(cancel)?;
    let op = parse_operation(input).ok_or_else(|| fail(Code::Invalid, "Invalid memory operation"))?;
    let session = match &t {
        Target::Session(s) => Some(s.clone()),
        Target::Ui(_) => None,
    };
    let agent = session.is_some();
    if let Operation::Save { id, revision, .. } = &op
        && (if id.is_none() { revision.is_some() || !agent } else { revision.is_none() })
    {
        return Err(fail(Code::Invalid, "Editing memory requires its ID and revision"));
    }
    let ns = namespace(app, &op, &t, agent, cancel).await?;
    check(cancel)?;
    if agent && !enabled(app)? {
        return Err(fail(Code::Disabled, "Memory is disabled"));
    }
    let mutation = matches!(op, Operation::Save { .. } | Operation::Delete { .. });
    let revalidate = || async {
        check(cancel)?;
        let current = namespace(app, &op, &t, agent, cancel).await?;
        check(cancel)?;
        if current != ns {
            return Err(fail(Code::Conflict, "Memory project changed"));
        }
        if (agent || mutation) && !enabled(app)? {
            return Err(fail(Code::Disabled, "Memory is disabled"));
        }
        Ok::<(), MemoryError>(())
    };
    let s = store(app);
    if let Operation::List(_) | Operation::Read(..) = &op {
        // Captured before the read: a concurrent later write stays unread next visit.
        let observed = crate::now();
        let all = s.list_for_ui(&ns, cancel).await?;
        check(cancel)?;
        let entries: Vec<(Entry, bool)> = if agent { all.into_iter().filter(|(_, f)| !f).collect() } else { all };
        let writable = if !agent && matches!(op, Operation::List(_)) && enabled(app)? && entries.iter().any(|(_, f)| !f)
        {
            s.cleanup_writable(&ns, cancel).await
        } else {
            false
        };
        revalidate().await?;
        if let Operation::List(_) = op {
            if agent {
                return Ok(json!({"entries": entries.iter().map(|(e, _)| model::header(e)).collect::<Vec<_>>()}));
            }
            let usable = enabled(app)? && writable;
            return Ok(json!({"entries": entries.iter().map(|(e, f)| model::reviewed(e, *f)).collect::<Vec<_>>(),
                "scopeKey": ns.key(), "observedAt": observed, "cleanupWritable": usable}));
        }
        let Operation::Read(_, query) = &op else { unreachable!() };
        let found =
            entries.iter().find(|(e, _)| &e.id == query).or_else(|| entries.iter().find(|(e, _)| &e.title == query));
        return Ok(
            json!({"entry": found.map(|(e, f)| if agent { model::versioned(e) } else { model::reviewed(e, *f) })}),
        );
    }
    let scope = op.scope();
    let result = s
        .mutate(&ns, cancel, |entries| {
            let op = op.clone();
            let session = session.clone();
            let revalidate = &revalidate;
            async move {
                revalidate().await?;
                let (id, revision) = match &op {
                    Operation::Save { id, revision, .. } => (id.clone(), revision.clone()),
                    Operation::Delete { id, revision, .. } => (Some(id.clone()), Some(revision.clone())),
                    _ => (None, None),
                };
                let existing = id.as_ref().and_then(|id| entries.iter().find(|e| &e.id == id)).cloned();
                if id.is_some() && existing.as_ref().is_none_or(|e| Some(model::revision(e)) != revision) {
                    return Err(fail(Code::Conflict, "Memory changed; read it again before retrying"));
                }
                if agent && existing.as_ref().is_some_and(rules::flagged) {
                    return Err(fail(Code::Conflict, "Memory entry requires human review"));
                }
                if let Operation::Delete { id, .. } = &op {
                    return Ok(Mutation::Delete(id.clone(), json!({"deleted": true})));
                }
                let Operation::Save { content, .. } = &op else { unreachable!() };
                let provenance = session.clone().or_else(|| existing.as_ref().map(|e| e.session_id.clone())).unwrap_or_default();
                match rules::decide(scope, &entries, content, &provenance, id.as_deref(), &crate::now()) {
                    Ok(entry) => {
                        let result = json!({"id": entry.id, "revision": model::revision(&entry), "flagged": rules::flagged(&entry)});
                        Ok(Mutation::Save(entry, result))
                    }
                    Err(e) if agent && e.code == Code::Full => Err(MemoryError {
                        code: Code::Full,
                        message: "Memory is full. Merge or delete entries before retrying.",
                        titles: Some(rules::for_agent(&entries).into_iter().map(|e| e.title).collect()),
                    }),
                    Err(e) => Err(e),
                }
            }
        })
        .await?;
    invalidate(app);
    revalidate().await?;
    Ok(result)
}

/// `executeUI`: list results also carry the authorized cleanup directory.
pub async fn execute_ui(
    app: &App,
    input: &Value,
    context: Option<Value>,
    cancel: Option<&CancellationToken>,
) -> Result<Value> {
    check(cancel)?;
    let listing = context.is_some() && matches!(parse_operation(input), Some(Operation::List(_)));
    let cleanup = if listing { Some(ui_target(app, &context).await?) } else { None };
    let mut result = execute(app, input, Target::Ui(context.clone()), cancel).await?;
    if let Some(directory) = cleanup {
        if ui_target(app, &context).await? != directory {
            return Err(fail(Code::Conflict, "Memory project changed"));
        }
        check(cancel)?;
        result["cleanupDirectory"] = json!(directory);
    }
    Ok(result)
}

pub type Titles = Vec<(Scope, Vec<(String, String)>)>;

/// `sessionTitles`: both safe scope projections, `None` while disabled.
pub async fn session_titles(app: &App, session: &str) -> Result<Option<Titles>> {
    let target = session_target(app, session).await?;
    if !enabled(app)? {
        return Ok(None);
    }
    let s = store(app);
    let mut scopes: Titles = Vec::new();
    let mut project_id = None;
    for scope in [Scope::Global, Scope::Project] {
        let read = async {
            let ns = match scope {
                Scope::Global => Namespace::Global,
                Scope::Project => {
                    let id = identity::resolve(&target).await?;
                    project_id = Some(id.clone());
                    Namespace::Project(id)
                }
            };
            s.list(&ns, None).await
        };
        // An unreadable scope stays absent, rather than looking empty.
        if let Ok(entries) = read.await {
            scopes.push((scope, entries.into_iter().map(|e| (e.title, e.kind)).collect()));
        }
    }
    let current = session_target(app, session).await?;
    if current != target {
        return Err(fail(Code::Conflict, "Memory session moved"));
    }
    if let Some(id) = project_id
        && identity::resolve(&current).await? != id
    {
        return Err(fail(Code::Conflict, "Memory project changed"));
    }
    if session_target(app, session).await? != target {
        return Err(fail(Code::Conflict, "Memory session moved"));
    }
    Ok(if enabled(app)? { Some(scopes) } else { None })
}
