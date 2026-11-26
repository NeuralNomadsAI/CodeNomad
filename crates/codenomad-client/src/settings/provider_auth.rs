//! Provider authentication catalog, connection flows (API key, OAuth, command, external),
//! and saved credential account management over the workspace OpenCode relay.
use crate::{
    backend::{Backend, read_json},
    history::{Result, valid_id},
};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashSet};

const MAX_ITEMS: usize = 2048;
const MAX_LABEL: usize = 256;
const MAX_ERROR_LEN: usize = 512;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthError {
    Unsupported,
    Message(String),
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderSource {
    Api,
    Env,
    Config,
    Custom,
    Unknown,
}

impl ProviderSource {
    pub fn i18n_key(self) -> &'static str {
        match self {
            Self::Api => "settings.providers.source.api",
            Self::Env => "settings.providers.source.env",
            Self::Config => "settings.providers.source.config",
            Self::Custom => "settings.providers.source.custom",
            Self::Unknown => "settings.providers.source.unknown",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Connection {
    Credential {
        id: String,
        label: String,
        method: String,
        needs_auth: Option<String>,
    },
    Env {
        name: String,
        needs_auth: Option<String>,
    },
}

impl Connection {
    pub fn identity_key(&self) -> String {
        match self {
            Self::Credential { id, .. } => format!("credential:{id}"),
            Self::Env { name, .. } => format!("env:{name}"),
        }
    }

    pub fn credential_id(&self) -> Option<&str> {
        match self {
            Self::Credential { id, .. } => Some(id.as_str()),
            Self::Env { .. } => None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountSelection {
    pub supported: bool,
    pub enabled: bool,
    pub logins: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FieldOption {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FieldCondition {
    pub key: String,
    pub equal: bool,
    pub value: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub enum FormFieldKind {
    String {
        required: bool,
        placeholder: Option<String>,
        default: Option<String>,
        format: Option<String>,
        // Parsed from native schema; client-side regex evaluation requires a regex dependency
        // outside codenomad-client's current Cargo.toml, so server validation remains authoritative.
        pattern: Option<String>,
        min_length: Option<usize>,
        max_length: Option<usize>,
        options: Vec<FieldOption>,
        custom: bool,
    },
    Number {
        integer: bool,
        required: bool,
        default: Option<f64>,
        min: Option<f64>,
        max: Option<f64>,
    },
    Boolean {
        required: bool,
        default: Option<bool>,
    },
    Multiselect {
        required: bool,
        default: Option<Vec<String>>,
        min_items: Option<usize>,
        max_items: Option<usize>,
        options: Vec<FieldOption>,
        custom: bool,
    },
    External {
        url: String,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct FormField {
    pub key: String,
    pub title: String,
    pub description: Option<String>,
    pub hidden: bool,
    pub when: Vec<FieldCondition>,
    pub kind: FormFieldKind,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AuthMethod {
    Key {
        label: Option<String>,
        form: Vec<FormField>,
    },
    OAuth {
        id: String,
        label: String,
        form: Vec<FormField>,
    },
    Command {
        id: String,
        label: String,
        command: Vec<String>,
    },
    External {
        id: String,
        label: String,
        form: Vec<FormField>,
    },
}

impl AuthMethod {
    pub fn form(&self) -> &[FormField] {
        match self {
            Self::Key { form, .. } | Self::OAuth { form, .. } | Self::External { form, .. } => form,
            Self::Command { .. } => &[],
        }
    }

    pub fn display_label<'a>(&'a self, fallback_api: &'a str, fallback_oauth: &'a str) -> &'a str {
        match self {
            Self::Key { label, .. } => label
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(fallback_api),
            Self::OAuth { label, .. } => {
                if label.is_empty() {
                    fallback_oauth
                } else {
                    label.as_str()
                }
            }
            Self::Command { label, .. } | Self::External { label, .. } => label.as_str(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ListedProvider {
    pub id: String,
    pub name: String,
    pub model_count: usize,
    pub source: ProviderSource,
    pub can_connect: bool,
    pub methods: Vec<AuthMethod>,
    pub connections: Vec<Connection>,
    pub account_selection: AccountSelection,
}

impl ListedProvider {
    pub fn is_configured(&self) -> bool {
        self.source != ProviderSource::Unknown
    }

    pub fn is_configurable(&self) -> bool {
        self.source == ProviderSource::Unknown && self.can_connect
    }

    pub fn active_connection(&self) -> Option<&Connection> {
        self.connections.first()
    }

    pub fn credential_count(&self) -> usize {
        self.connections
            .iter()
            .filter(|conn| matches!(conn, Connection::Credential { .. }))
            .count()
    }

    pub fn connection_display_label<'a>(&'a self, conn: &'a Connection) -> &'a str {
        match conn {
            Connection::Credential { id, label, .. } => {
                if label == "default" {
                    self.account_selection
                        .logins
                        .get(id)
                        .map(String::as_str)
                        .unwrap_or(label.as_str())
                } else {
                    label.as_str()
                }
            }
            Connection::Env { name, .. } => name.as_str(),
        }
    }

    pub fn method_summary_key(&self) -> &'static str {
        if self.methods.is_empty() {
            return self.source.i18n_key();
        }
        let mut has_key = false;
        let mut has_oauth = false;
        let mut has_command = false;
        for method in &self.methods {
            match method {
                AuthMethod::Key { .. } | AuthMethod::External { .. } => has_key = true,
                AuthMethod::OAuth { .. } => has_oauth = true,
                AuthMethod::Command { .. } => has_command = true,
            }
        }
        let kinds = usize::from(has_key) + usize::from(has_oauth) + usize::from(has_command);
        if kinds > 1 {
            "settings.providers.method.mixed"
        } else if has_oauth {
            "settings.providers.method.oauth"
        } else if has_command {
            "settings.providers.method.command"
        } else {
            "settings.providers.method.api"
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CatalogSnapshot {
    pub directory: String,
    pub providers: Vec<ListedProvider>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OAuthMode {
    Auto,
    Code,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OAuthAttempt {
    pub attempt_id: String,
    pub url: String,
    pub instructions: String,
    pub mode: OAuthMode,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttemptPoll {
    Pending(Option<String>),
    Complete,
    Failed(Option<String>),
    Expired,
}

pub fn is_http_url(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    reqwest::Url::parse(trimmed)
        .ok()
        .is_some_and(|parsed| matches!(parsed.scheme(), "http" | "https"))
}

pub fn initial_form_answers(fields: &[FormField]) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    for field in fields {
        match &field.kind {
            FormFieldKind::String {
                default: Some(v), ..
            } => {
                out.insert(field.key.clone(), Value::String(v.clone()));
            }
            FormFieldKind::Number {
                default: Some(v),
                integer,
                ..
            } if v.is_finite() => {
                if *integer {
                    out.insert(field.key.clone(), json!(*v as i64));
                } else {
                    out.insert(field.key.clone(), json!(*v));
                }
            }
            FormFieldKind::Boolean {
                default: Some(v), ..
            } => {
                out.insert(field.key.clone(), Value::Bool(*v));
            }
            FormFieldKind::Multiselect {
                default: Some(items),
                ..
            } => {
                out.insert(field.key.clone(), json!(items));
            }
            _ => {}
        }
    }
    out
}

fn json_values_equal(left: &Value, right: &Value) -> bool {
    if let (Some(a), Some(b)) = (left.as_f64(), right.as_f64()) {
        a == b
    } else {
        left == right
    }
}

pub fn is_field_active(field: &FormField, values: &BTreeMap<String, Value>) -> bool {
    if matches!(field.kind, FormFieldKind::External { .. }) || field.when.is_empty() {
        return true;
    }
    field.when.iter().all(|cond| {
        let Some(current) = values.get(&cond.key) else {
            return false;
        };
        let eq = match current {
            Value::Array(items) => {
                let target = cond
                    .value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| cond.value.to_string());
                items
                    .iter()
                    .any(|item| item.as_str() == Some(target.as_str()))
            }
            _ => json_values_equal(current, &cond.value),
        };
        if cond.equal { eq } else { !eq }
    })
}

pub fn is_field_visible(field: &FormField, values: &BTreeMap<String, Value>) -> bool {
    (matches!(field.kind, FormFieldKind::External { .. }) || !field.hidden)
        && is_field_active(field, values)
}

pub fn is_field_complete(field: &FormField, values: &BTreeMap<String, Value>) -> bool {
    if !is_field_visible(field, values) || matches!(field.kind, FormFieldKind::External { .. }) {
        return true;
    }
    let val = values.get(&field.key);
    match &field.kind {
        FormFieldKind::External { .. } => true,
        FormFieldKind::Boolean { required, .. } => match val {
            None => !required,
            Some(v) => v.is_boolean(),
        },
        FormFieldKind::String {
            required,
            format,
            min_length,
            max_length,
            options,
            custom,
            ..
        } => {
            let Some(val) = val else {
                return !required;
            };
            let Some(s) = val.as_str() else {
                return false;
            };
            if *required && s.trim().is_empty() {
                return false;
            }
            let len = s.chars().count();
            if min_length.is_some_and(|min| len < min) || max_length.is_some_and(|max| len > max) {
                return false;
            }
            if let Some(fmt) = format.as_deref()
                && !matches_format(s, fmt)
            {
                return false;
            }
            if !options.is_empty() && !*custom && !options.iter().any(|opt| opt.value == s) {
                return false;
            }
            // Deliberate shortcut: `pattern` is preserved from schema but client-side JS RegExp
            // evaluation requires a regex crate outside codenomad-client; server validation enforces it.
            true
        }
        FormFieldKind::Number {
            integer,
            required,
            min,
            max,
            ..
        } => {
            let Some(val) = val else {
                return !required;
            };
            let Some(n) = val.as_f64().filter(|n| n.is_finite()) else {
                return false;
            };
            if *integer && n.fract() != 0.0 {
                return false;
            }
            if min.is_some_and(|m| n < m) || max.is_some_and(|m| n > m) {
                return false;
            }
            true
        }
        FormFieldKind::Multiselect {
            required,
            min_items,
            max_items,
            options,
            custom,
            ..
        } => {
            let Some(val) = val else {
                return !required;
            };
            let Some(items) = val.as_array() else {
                return false;
            };
            if !items.iter().all(Value::is_string) {
                return false;
            }
            if *required && items.is_empty() {
                return false;
            }
            if min_items.is_some_and(|m| items.len() < m)
                || max_items.is_some_and(|m| items.len() > m)
            {
                return false;
            }
            if !*custom
                && items.iter().any(|item| {
                    item.as_str()
                        .is_none_or(|s| !options.iter().any(|opt| opt.value == s))
                })
            {
                return false;
            }
            true
        }
    }
}

pub fn build_form_answer(fields: &[FormField], values: &BTreeMap<String, Value>) -> Option<Value> {
    if fields.is_empty() {
        return None;
    }
    let mut map = Map::new();
    for field in fields {
        if matches!(field.kind, FormFieldKind::External { .. }) || !is_field_active(field, values) {
            continue;
        }
        if let Some(val) = values.get(&field.key) {
            map.insert(field.key.clone(), val.clone());
        } else if field.hidden {
            let default = match &field.kind {
                FormFieldKind::String {
                    default: Some(v), ..
                } => Some(Value::String(v.clone())),
                FormFieldKind::Number {
                    default: Some(v),
                    integer,
                    ..
                } if v.is_finite() => Some(if *integer {
                    json!(*v as i64)
                } else {
                    json!(*v)
                }),
                FormFieldKind::Boolean {
                    default: Some(v), ..
                } => Some(Value::Bool(*v)),
                FormFieldKind::Multiselect {
                    default: Some(items),
                    ..
                } => Some(json!(items)),
                _ => None,
            };
            if let Some(val) = default {
                map.insert(field.key.clone(), val);
            }
        }
    }
    Some(Value::Object(map))
}

fn valid_calendar_date(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
    {
        return false;
    }
    let (Ok(year), Ok(month), Ok(day)) = (
        s[0..4].parse::<u32>(),
        s[5..7].parse::<u32>(),
        s[8..10].parse::<u32>(),
    ) else {
        return false;
    };
    let leap = (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400);
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=max_day).contains(&day)
}

fn valid_date_time(s: &str) -> bool {
    let Some((date, rest)) = s.split_once('T') else {
        return false;
    };
    if !valid_calendar_date(date) {
        return false;
    }
    let time_part = if let Some(stripped) = rest.strip_suffix('Z') {
        stripped
    } else if let Some(pos) = rest.rfind(['+', '-']) {
        let offset = &rest[pos + 1..];
        let ob = offset.as_bytes();
        if ob.len() != 5
            || ob[2] != b':'
            || !ob[0].is_ascii_digit()
            || !ob[1].is_ascii_digit()
            || !ob[3].is_ascii_digit()
            || !ob[4].is_ascii_digit()
        {
            return false;
        }
        let (Ok(oh), Ok(om)) = (offset[0..2].parse::<u32>(), offset[3..5].parse::<u32>()) else {
            return false;
        };
        if oh > 23 || om > 59 {
            return false;
        }
        &rest[..pos]
    } else {
        rest
    };
    let (hms, frac) = match time_part.split_once('.') {
        Some((hms, frac)) => {
            if frac.is_empty() || !frac.bytes().all(|b| b.is_ascii_digit()) {
                return false;
            }
            (hms, true)
        }
        None => (time_part, false),
    };
    let hb = hms.as_bytes();
    let valid_hm = hb.len() == 5 && hb[2] == b':' && !frac;
    let valid_hms = hb.len() == 8 && hb[2] == b':' && hb[5] == b':';
    if !valid_hm && !valid_hms {
        return false;
    }
    if !hb
        .iter()
        .enumerate()
        .all(|(i, b)| i == 2 || i == 5 || b.is_ascii_digit())
    {
        return false;
    }
    let (Ok(hour), Ok(minute)) = (hms[0..2].parse::<u32>(), hms[3..5].parse::<u32>()) else {
        return false;
    };
    if hour > 23 || minute > 59 {
        return false;
    }
    if valid_hms {
        let Ok(second) = hms[6..8].parse::<u32>() else {
            return false;
        };
        if second > 59 {
            return false;
        }
    }
    true
}

fn matches_format(value: &str, format: &str) -> bool {
    match format {
        "uri" => reqwest::Url::parse(value).is_ok(),
        "email" => {
            let Some((local, domain)) = value.split_once('@') else {
                return false;
            };
            !local.is_empty()
                && !domain.is_empty()
                && !domain.contains('@')
                && !value.chars().any(char::is_whitespace)
        }
        "date" => valid_calendar_date(value),
        "date-time" => valid_date_time(value),
        _ => true,
    }
}

pub async fn load_catalog(
    backend: &Backend,
    workspace: &str,
    session: Option<&str>,
) -> std::result::Result<CatalogSnapshot, AuthError> {
    if !valid_id(workspace) || session.is_some_and(|id| !valid_id(id)) {
        return Err(AuthError::Failed);
    }
    let base = format!("{}workspaces/{workspace}/instance/api", backend.base);
    let location = if let Some(session) = session {
        Some(
            super::session_directory(backend, workspace, session)
                .await
                .map_err(|_| AuthError::Failed)?,
        )
    } else {
        None
    };
    let directory = location.as_deref();
    let base = base.as_str();
    let load = |kind| async move {
        let mut request = backend.client.get(format!("{base}/{kind}"));
        if let Some(directory) = directory {
            request = request.query(&[("location[directory]", directory)]);
        }
        let response = request.send().await.map_err(|_| AuthError::Failed)?;
        let status = response.status();
        if status.is_success() {
            return read_json(response).await.map_err(|_| AuthError::Failed);
        }
        if status.as_u16() == 403 {
            return Err(AuthError::Unsupported);
        }
        Err(classify_error(status, response).await)
    };
    use futures_lite::future::zip;
    let ((integrations, providers), (models, search)) = zip(
        zip(load("integration"), load("provider")),
        zip(load("model"), load("websearch/provider")),
    )
    .await;
    let (integrations, providers, models, search) = (integrations?, providers?, models?, search?);
    let received = integrations["location"]["directory"]
        .as_str()
        .filter(|path| crate::absolute_server_path(path))
        .ok_or(AuthError::Failed)?
        .to_owned();
    if [&providers, &models, &search]
        .iter()
        .any(|response| response["location"]["directory"] != received)
        || directory.is_some_and(|requested| !crate::same_server_path(requested, &received))
    {
        return Err(AuthError::Failed);
    }
    let mut listed = parse_catalog(
        &integrations["data"],
        &providers["data"],
        &models["data"],
        &search["data"],
    )
    .map_err(|_| AuthError::Failed)?;
    let needs_selection = |row: &ListedProvider| {
        let mut credentials = 0usize;
        let mut has_default = false;
        for conn in &row.connections {
            if let Connection::Credential { id, label, .. } = conn
                && !id.is_empty()
            {
                credentials += 1;
                if label == "default" {
                    has_default = true;
                }
            }
        }
        has_default || credentials > 1
    };
    if listed.iter().any(needs_selection) && accounts_available(backend).await {
        for row in &mut listed {
            if !needs_selection(row) {
                continue;
            }
            if let Some(selection) =
                fetch_account_selection(backend, workspace, &row.id, &received).await
            {
                row.account_selection = selection;
            }
        }
    }
    Ok(CatalogSnapshot {
        directory: received,
        providers: listed,
    })
}

pub async fn connect_key(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    integration_id: &str,
    key: &str,
    answer: Option<Value>,
) -> std::result::Result<(), AuthError> {
    let url = instance_url(
        backend,
        workspace,
        &["integration", integration_id, "connect", "key"],
    )?;
    let mut body = Map::new();
    body.insert("key".into(), Value::String(key.to_owned()));
    if let Some(answer) = answer {
        body.insert("answer".into(), answer);
    }
    let response = backend
        .client
        .post(url)
        .query(&[("location[directory]", directory)])
        .json(&Value::Object(body))
        .send()
        .await
        .map_err(|_| AuthError::Failed)?;
    check_empty_response(response).await
}

pub async fn connect_external(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    integration_id: &str,
    method_id: &str,
    answer: Option<Value>,
) -> std::result::Result<(), AuthError> {
    let url = instance_url(
        backend,
        workspace,
        &["integration", integration_id, "connect", "external"],
    )?;
    let mut body = Map::new();
    body.insert("methodID".into(), Value::String(method_id.to_owned()));
    if let Some(answer) = answer {
        body.insert("answer".into(), answer);
    }
    let response = backend
        .client
        .post(url)
        .query(&[("location[directory]", directory)])
        .json(&Value::Object(body))
        .send()
        .await
        .map_err(|_| AuthError::Failed)?;
    check_empty_response(response).await
}

async fn cancel_on_close<T>(
    cancelled: &crate::Receiver<()>,
    task: impl std::future::Future<Output = T>,
) -> Option<T> {
    use std::future::Future;
    let mut task = std::pin::pin!(task);
    let mut rx = std::pin::pin!(cancelled.recv());
    std::future::poll_fn(|cx| {
        if rx.as_mut().poll(cx).is_ready() {
            return std::task::Poll::Ready(None);
        }
        task.as_mut().poll(cx).map(Some)
    })
    .await
}

pub async fn oauth_connect(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    integration_id: &str,
    method_id: &str,
    answer: Option<Value>,
    cancelled: &crate::Receiver<()>,
) -> Option<std::result::Result<OAuthAttempt, AuthError>> {
    let url = match instance_url(
        backend,
        workspace,
        &["integration", integration_id, "connect", "oauth"],
    ) {
        Ok(url) => url,
        Err(err) => return Some(Err(err)),
    };
    let mut body = Map::new();
    body.insert("methodID".into(), Value::String(method_id.to_owned()));
    if let Some(answer) = answer {
        body.insert("answer".into(), answer);
    }
    let response = match cancel_on_close(
        cancelled,
        backend
            .client
            .post(url)
            .query(&[("location[directory]", directory)])
            .json(&Value::Object(body))
            .send(),
    )
    .await?
    {
        Ok(response) => response,
        Err(_) => return Some(Err(AuthError::Failed)),
    };
    // Once response headers arrive, decode the body and cancel any invalid-mode attemptID
    // outside `cancel_on_close` so closing the dialog cannot abort the cleanup DELETE.
    let value = match check_json_response(response).await {
        Ok(value) => value,
        Err(err) => return Some(Err(err)),
    };
    if let Err(err) = verify_response_location(&value, directory) {
        return Some(Err(err));
    }
    let data = &value["data"];
    let Some(attempt_id) = clean_token(&data["attemptID"]) else {
        return Some(Err(AuthError::Failed));
    };
    let auth_url = data["url"].as_str().unwrap_or_default().trim().to_owned();
    let instructions = sanitize_text(&data["instructions"]).unwrap_or_default();
    let mode = match data["mode"].as_str() {
        Some("code") => OAuthMode::Code,
        Some("auto") => OAuthMode::Auto,
        _ => {
            oauth_cancel(backend, workspace, directory, integration_id, &attempt_id).await;
            return Some(Err(AuthError::Failed));
        }
    };
    Some(Ok(OAuthAttempt {
        attempt_id,
        url: auth_url,
        instructions,
        mode,
    }))
}

pub async fn oauth_status(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    integration_id: &str,
    attempt_id: &str,
) -> std::result::Result<AttemptPoll, AuthError> {
    let url = instance_url(
        backend,
        workspace,
        &[
            "integration",
            integration_id,
            "connect",
            "oauth",
            attempt_id,
        ],
    )?;
    let response = backend
        .client
        .get(url)
        .query(&[("location[directory]", directory)])
        .send()
        .await
        .map_err(|_| AuthError::Failed)?;
    let value = check_json_response(response).await?;
    verify_response_location(&value, directory)?;
    parse_attempt_poll(&value["data"])
}

pub async fn oauth_complete(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    integration_id: &str,
    attempt_id: &str,
    code: &str,
) -> std::result::Result<(), AuthError> {
    let url = instance_url(
        backend,
        workspace,
        &[
            "integration",
            integration_id,
            "connect",
            "oauth",
            attempt_id,
            "complete",
        ],
    )?;
    let response = backend
        .client
        .post(url)
        .query(&[("location[directory]", directory)])
        .json(&json!({ "code": code }))
        .send()
        .await
        .map_err(|_| AuthError::Failed)?;
    check_empty_response(response).await
}

pub async fn oauth_cancel(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    integration_id: &str,
    attempt_id: &str,
) {
    let Ok(url) = instance_url(
        backend,
        workspace,
        &[
            "integration",
            integration_id,
            "connect",
            "oauth",
            attempt_id,
        ],
    ) else {
        return;
    };
    let _ = backend
        .client
        .delete(url)
        .query(&[("location[directory]", directory)])
        .send()
        .await;
}

pub async fn command_connect(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    integration_id: &str,
    method_id: &str,
    cancelled: &crate::Receiver<()>,
) -> Option<std::result::Result<String, AuthError>> {
    let url = match instance_url(
        backend,
        workspace,
        &["integration", integration_id, "connect", "command"],
    ) {
        Ok(url) => url,
        Err(err) => return Some(Err(err)),
    };
    let response = match cancel_on_close(
        cancelled,
        backend
            .client
            .post(url)
            .query(&[("location[directory]", directory)])
            .json(&json!({ "methodID": method_id }))
            .send(),
    )
    .await?
    {
        Ok(response) => response,
        Err(_) => return Some(Err(AuthError::Failed)),
    };
    let value = match check_json_response(response).await {
        Ok(value) => value,
        Err(err) => return Some(Err(err)),
    };
    if let Err(err) = verify_response_location(&value, directory) {
        return Some(Err(err));
    }
    Some(clean_token(&value["data"]["attemptID"]).ok_or(AuthError::Failed))
}

pub async fn command_status(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    integration_id: &str,
    attempt_id: &str,
) -> std::result::Result<AttemptPoll, AuthError> {
    let url = instance_url(
        backend,
        workspace,
        &[
            "integration",
            integration_id,
            "connect",
            "command",
            attempt_id,
        ],
    )?;
    let response = backend
        .client
        .get(url)
        .query(&[("location[directory]", directory)])
        .send()
        .await
        .map_err(|_| AuthError::Failed)?;
    let value = check_json_response(response).await?;
    verify_response_location(&value, directory)?;
    parse_attempt_poll(&value["data"])
}

pub async fn command_cancel(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    integration_id: &str,
    attempt_id: &str,
) {
    let Ok(url) = instance_url(
        backend,
        workspace,
        &[
            "integration",
            integration_id,
            "connect",
            "command",
            attempt_id,
        ],
    ) else {
        return;
    };
    let _ = backend
        .client
        .delete(url)
        .query(&[("location[directory]", directory)])
        .send()
        .await;
}

const LOCATION_CONTEXT_HEADER: &str = "x-codenomad-location";

fn encode_location_header(directory: &str) -> String {
    let raw = json!({ "directory": directory }).to_string();
    let mut out = String::with_capacity(raw.len() * 2);
    for byte in raw.bytes() {
        let unreserved = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if unreserved {
            out.push(byte as char);
        } else {
            use std::fmt::Write;
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

fn verify_response_location(
    value: &Value,
    expected_directory: &str,
) -> std::result::Result<(), AuthError> {
    let Some(loc) = value.get("location") else {
        return Err(AuthError::Failed);
    };
    let Some(dir) = loc["directory"]
        .as_str()
        .filter(|path| crate::absolute_server_path(path))
    else {
        return Err(AuthError::Failed);
    };
    if !crate::same_server_path(dir, expected_directory) {
        return Err(AuthError::Failed);
    }
    Ok(())
}

pub async fn activate_credential(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    credential_id: &str,
) -> std::result::Result<(), AuthError> {
    let url = instance_url(
        backend,
        workspace,
        &["credential", credential_id, "activate"],
    )?;
    let response = backend
        .client
        .post(url)
        .header(LOCATION_CONTEXT_HEADER, encode_location_header(directory))
        .send()
        .await
        .map_err(|_| AuthError::Failed)?;
    check_empty_response(response).await
}

pub async fn rename_credential(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    credential_id: &str,
    label: &str,
) -> std::result::Result<(), AuthError> {
    let trimmed = label.trim();
    if trimmed.is_empty()
        || trimmed.chars().take(MAX_LABEL + 1).count() > MAX_LABEL
        || trimmed.contains(char::is_control)
    {
        return Err(AuthError::Failed);
    }
    let url = instance_url(backend, workspace, &["credential", credential_id])?;
    let response = backend
        .client
        .patch(url)
        .header(LOCATION_CONTEXT_HEADER, encode_location_header(directory))
        .json(&json!({ "label": trimmed }))
        .send()
        .await
        .map_err(|_| AuthError::Failed)?;
    check_empty_response(response).await
}

pub async fn remove_credential(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    credential_id: &str,
) -> std::result::Result<(), AuthError> {
    let url = instance_url(backend, workspace, &["credential", credential_id])?;
    let response = backend
        .client
        .delete(url)
        .header(LOCATION_CONTEXT_HEADER, encode_location_header(directory))
        .send()
        .await
        .map_err(|_| AuthError::Failed)?;
    check_empty_response(response).await
}

pub async fn set_account_auto_select(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    integration_id: &str,
    enabled: bool,
) -> std::result::Result<AccountSelection, AuthError> {
    if !valid_id(workspace) || !valid_segment(integration_id) {
        return Err(AuthError::Failed);
    }
    let mut url = reqwest::Url::parse(&format!(
        "{}api/workspaces/{workspace}/provider-accounts",
        backend.base
    ))
    .map_err(|_| AuthError::Failed)?;
    url.path_segments_mut()
        .map_err(|_| AuthError::Failed)?
        .push(integration_id);
    let response = backend
        .client
        .put(url)
        .json(&json!({ "directory": directory, "enabled": enabled }))
        .send()
        .await
        .map_err(|_| AuthError::Failed)?;
    let value = check_json_response(response).await?;
    parse_account_selection(&value).ok_or(AuthError::Failed)
}

fn instance_url(
    backend: &Backend,
    workspace: &str,
    segments: &[&str],
) -> std::result::Result<reqwest::Url, AuthError> {
    if !valid_id(workspace) || segments.iter().any(|s| !valid_segment(s)) {
        return Err(AuthError::Failed);
    }
    let mut url = reqwest::Url::parse(&format!(
        "{}workspaces/{workspace}/instance/api",
        backend.base
    ))
    .map_err(|_| AuthError::Failed)?;
    {
        let mut path = url.path_segments_mut().map_err(|_| AuthError::Failed)?;
        for seg in segments {
            path.push(seg);
        }
    }
    Ok(url)
}

fn valid_segment(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= 256
        && !value.contains(['/', '\\', '\0', '?', '#'])
        && !value.contains(char::is_control)
}

async fn check_empty_response(response: reqwest::Response) -> std::result::Result<(), AuthError> {
    let status = response.status();
    if matches!(status.as_u16(), 200 | 204) {
        return Ok(());
    }
    Err(classify_error(status, response).await)
}

async fn check_json_response(response: reqwest::Response) -> std::result::Result<Value, AuthError> {
    let status = response.status();
    if status.is_success() {
        return read_json(response).await.map_err(|_| AuthError::Failed);
    }
    Err(classify_error(status, response).await)
}

fn classify_error_body(status: u16, body: Option<&Value>) -> AuthError {
    if matches!(status, 405 | 501) {
        return AuthError::Unsupported;
    }
    if let Some(body) = body {
        let is_server_rs_route_404 = status == 404
            && body.as_object().is_some_and(|obj| {
                obj.len() == 1
                    && obj
                        .get("error")
                        .and_then(Value::as_str)
                        .is_some_and(|s| s.eq_ignore_ascii_case("not found"))
            });
        if is_server_rs_route_404 {
            return AuthError::Unsupported;
        }
        let message = body["data"]["message"]
            .as_str()
            .or_else(|| body["error"]["data"]["message"].as_str())
            .or_else(|| body["error"]["message"].as_str())
            .or_else(|| body["message"].as_str())
            .or_else(|| body["error"].as_str());
        if let Some(msg) = message.and_then(|s| sanitize_str(s, MAX_ERROR_LEN)) {
            if status == 404 && msg.starts_with("Route ") && msg.ends_with(" not found") {
                return AuthError::Unsupported;
            }
            return AuthError::Message(msg);
        }
    }
    if status == 404 {
        return AuthError::Unsupported;
    }
    AuthError::Failed
}

async fn classify_error(status: reqwest::StatusCode, response: reqwest::Response) -> AuthError {
    let code = status.as_u16();
    if matches!(code, 405 | 501) {
        return AuthError::Unsupported;
    }
    let body = read_json(response).await.ok();
    classify_error_body(code, body.as_ref())
}

fn parse_attempt_poll(data: &Value) -> std::result::Result<AttemptPoll, AuthError> {
    match data["status"].as_str() {
        Some("pending") => Ok(AttemptPoll::Pending(sanitize_text(&data["message"]))),
        Some("complete") => Ok(AttemptPoll::Complete),
        Some("failed") => Ok(AttemptPoll::Failed(sanitize_text(&data["message"]))),
        Some("expired") => Ok(AttemptPoll::Expired),
        _ => Err(AuthError::Failed),
    }
}

async fn accounts_available(backend: &Backend) -> bool {
    let Ok(response) = backend
        .client
        .get(format!("{}api/meta", backend.base))
        .send()
        .await
    else {
        return false;
    };
    let Ok(response) = response.error_for_status() else {
        return false;
    };
    read_json(response).await.ok().is_some_and(|meta| {
        meta["capabilities"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item == "integrations"))
    })
}

async fn fetch_account_selection(
    backend: &Backend,
    workspace: &str,
    integration: &str,
    directory: &str,
) -> Option<AccountSelection> {
    if !valid_segment(integration) {
        return None;
    }
    let mut url = reqwest::Url::parse(&format!(
        "{}api/workspaces/{workspace}/provider-accounts",
        backend.base
    ))
    .ok()?;
    url.path_segments_mut().ok()?.push(integration);
    let response = backend
        .client
        .get(url)
        .query(&[("directory", directory)])
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let snapshot = read_json(response).await.ok()?;
    parse_account_selection(&snapshot)
}

fn parse_account_selection(value: &Value) -> Option<AccountSelection> {
    let supported = value["supported"].as_bool()?;
    let enabled = value["enabled"].as_bool()?;
    let mut logins = BTreeMap::new();
    if let Some(obj) = value["logins"].as_object() {
        for (cred_id, val) in obj.iter().take(MAX_ITEMS) {
            if valid_segment(cred_id)
                && let Some(mail) = email(val)
            {
                logins.insert(cred_id.clone(), mail);
            }
        }
    }
    Some(AccountSelection {
        supported,
        enabled,
        logins,
    })
}

fn parse_catalog(
    integrations: &Value,
    providers: &Value,
    models: &Value,
    search: &Value,
) -> Result<Vec<ListedProvider>> {
    let integrations = integrations
        .as_array()
        .filter(|rows| rows.len() <= MAX_ITEMS)
        .ok_or("Invalid integrations")?;
    let providers = providers
        .as_array()
        .filter(|rows| rows.len() <= MAX_ITEMS)
        .ok_or("Invalid providers")?;
    let models = models.as_array().ok_or("Invalid models")?;
    let search: HashSet<&str> = search
        .as_array()
        .ok_or("Invalid search providers")?
        .iter()
        .filter_map(|r| r["id"].as_str())
        .collect();

    let mut models_by_provider: BTreeMap<&str, usize> = BTreeMap::new();
    for model in models {
        if let Some(pid) = model["providerID"].as_str() {
            *models_by_provider.entry(pid).or_insert(0) += 1;
        }
    }

    let mut matched_provider_ids: HashSet<String> = HashSet::new();
    let mut listed: Vec<ListedProvider> = Vec::new();
    let mut listed_ids: HashSet<String> = HashSet::new();

    for integration in integrations {
        let Some(id) = clean_label(&integration["id"]) else {
            continue;
        };
        let name = clean_label(&integration["name"]).unwrap_or_else(|| id.clone());
        let mut model_count = 0usize;
        let mut has_provider_entry = false;
        for provider in providers {
            let Some(pid) = clean_label(&provider["id"]) else {
                continue;
            };
            let key = clean_label(&provider["integrationID"]).unwrap_or_else(|| pid.clone());
            if key == id {
                has_provider_entry = true;
                matched_provider_ids.insert(pid.clone());
                model_count += models_by_provider.get(pid.as_str()).copied().unwrap_or(0);
            }
        }
        let connections = parse_connections(&integration["connections"]);
        let methods = parse_methods(&integration["methods"]);
        let has_cred = connections
            .iter()
            .any(|c| matches!(c, Connection::Credential { .. }));
        let has_env = connections
            .iter()
            .any(|c| matches!(c, Connection::Env { .. }));
        let source = if has_cred {
            ProviderSource::Api
        } else if has_env {
            ProviderSource::Env
        } else if has_provider_entry {
            ProviderSource::Config
        } else {
            ProviderSource::Unknown
        };
        if search.contains(id.as_str()) && model_count == 0 {
            continue;
        }
        listed_ids.insert(id.clone());
        listed.push(ListedProvider {
            id,
            name,
            model_count,
            source,
            can_connect: !methods.is_empty(),
            methods,
            connections,
            account_selection: AccountSelection::default(),
        });
    }

    for provider in providers {
        let Some(pid) = clean_label(&provider["id"]) else {
            continue;
        };
        if matched_provider_ids.contains(&pid) || listed_ids.contains(&pid) {
            continue;
        }
        let model_count = models_by_provider.get(pid.as_str()).copied().unwrap_or(0);
        if search.contains(pid.as_str()) && model_count == 0 {
            continue;
        }
        let name = clean_label(&provider["name"]).unwrap_or_else(|| pid.clone());
        listed_ids.insert(pid.clone());
        listed.push(ListedProvider {
            id: pid,
            name,
            model_count,
            source: ProviderSource::Custom,
            can_connect: false,
            methods: Vec::new(),
            connections: Vec::new(),
            account_selection: AccountSelection::default(),
        });
    }

    for (pid, model_count) in models_by_provider {
        if matched_provider_ids.contains(pid)
            || listed_ids.contains(pid)
            || (search.contains(pid) && model_count == 0)
        {
            continue;
        }
        let Some(id) = clean_str_label(pid) else {
            continue;
        };
        listed_ids.insert(id.clone());
        listed.push(ListedProvider {
            name: id.clone(),
            id,
            model_count,
            source: ProviderSource::Unknown,
            can_connect: false,
            methods: Vec::new(),
            connections: Vec::new(),
            account_selection: AccountSelection::default(),
        });
    }

    listed.sort_by_cached_key(|row| (row.name.to_lowercase(), row.id.to_lowercase()));
    Ok(listed)
}

fn parse_connections(value: &Value) -> Vec<Connection> {
    let Some(rows) = value.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in rows.iter().take(MAX_ITEMS) {
        let needs_auth = (entry["status"]["status"] == "needs_auth")
            .then(|| sanitize_text(&entry["status"]["message"]))
            .flatten();
        match entry["type"].as_str() {
            Some("credential") => {
                let Some(label) = clean_label(&entry["label"]) else {
                    // Invalid primary credential must never promote a secondary account.
                    if out.is_empty() {
                        return Vec::new();
                    }
                    continue;
                };
                let id = clean_token(&entry["id"]).unwrap_or_default();
                let method = entry["method"].as_str().unwrap_or("key").to_owned();
                out.push(Connection::Credential {
                    id,
                    label,
                    method,
                    needs_auth,
                });
            }
            Some("env") => {
                let Some(name) = clean_label(&entry["name"]) else {
                    if out.is_empty() {
                        return Vec::new();
                    }
                    continue;
                };
                out.push(Connection::Env { name, needs_auth });
            }
            _ => {}
        }
    }
    out
}

fn parse_methods(value: &Value) -> Vec<AuthMethod> {
    let Some(rows) = value.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in rows.iter().take(64) {
        match entry["type"].as_str() {
            Some("key") => out.push(AuthMethod::Key {
                label: clean_label(&entry["label"]),
                form: parse_form_fields(&entry["form"]),
            }),
            Some("oauth") => {
                if let Some(id) = clean_token(&entry["id"]) {
                    out.push(AuthMethod::OAuth {
                        id,
                        label: clean_label(&entry["label"]).unwrap_or_default(),
                        form: parse_form_fields(&entry["form"]),
                    });
                }
            }
            Some("command") => {
                if let Some(id) = clean_token(&entry["id"]) {
                    let command = entry["command"]
                        .as_array()
                        .map(|arr| arr.iter().filter_map(sanitize_text).collect::<Vec<_>>())
                        .unwrap_or_default();
                    out.push(AuthMethod::Command {
                        id,
                        label: clean_label(&entry["label"]).unwrap_or_default(),
                        command,
                    });
                }
            }
            Some("external") => {
                if let Some(id) = clean_token(&entry["id"]) {
                    out.push(AuthMethod::External {
                        id,
                        label: clean_label(&entry["label"]).unwrap_or_default(),
                        form: parse_form_fields(&entry["form"]),
                    });
                }
            }
            _ => {}
        }
    }
    out
}

fn parse_form_fields(value: &Value) -> Vec<FormField> {
    let Some(rows) = value.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in rows.iter().take(64) {
        let Some(key) = clean_label(&entry["key"]) else {
            continue;
        };
        let title = clean_label(&entry["title"])
            .or_else(|| clean_label(&entry["label"]))
            .unwrap_or_else(|| key.clone());
        let description = sanitize_text(&entry["description"]);
        let hidden = entry["hidden"].as_bool().unwrap_or(false);
        let when = entry["when"]
            .as_array()
            .map(|conds| {
                conds
                    .iter()
                    .filter_map(|c| {
                        let k = clean_label(&c["key"])?;
                        let op = c["op"].as_str()?;
                        if !matches!(op, "eq" | "neq") {
                            return None;
                        }
                        Some(FieldCondition {
                            key: k,
                            equal: op == "eq",
                            value: c["value"].clone(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let kind = match entry["type"].as_str() {
            Some("string") => FormFieldKind::String {
                required: entry["required"].as_bool().unwrap_or(false),
                placeholder: sanitize_text(&entry["placeholder"]),
                default: entry["default"].as_str().map(str::to_owned),
                format: entry["format"].as_str().map(str::to_owned),
                pattern: entry["pattern"].as_str().map(str::to_owned),
                min_length: entry["minLength"].as_u64().map(|n| n as usize),
                max_length: entry["maxLength"].as_u64().map(|n| n as usize),
                options: parse_field_options(&entry["options"]),
                custom: entry["custom"].as_bool().unwrap_or(false),
            },
            Some(kind @ ("number" | "integer")) => FormFieldKind::Number {
                integer: kind == "integer",
                required: entry["required"].as_bool().unwrap_or(false),
                default: entry["default"].as_f64().filter(|n| n.is_finite()),
                min: entry["minimum"].as_f64().filter(|n| n.is_finite()),
                max: entry["maximum"].as_f64().filter(|n| n.is_finite()),
            },
            Some("boolean") => FormFieldKind::Boolean {
                required: entry["required"].as_bool().unwrap_or(false),
                default: entry["default"].as_bool(),
            },
            Some("multiselect") => FormFieldKind::Multiselect {
                required: entry["required"].as_bool().unwrap_or(false),
                default: entry["default"].as_array().map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                }),
                min_items: entry["minItems"].as_u64().map(|n| n as usize),
                max_items: entry["maxItems"].as_u64().map(|n| n as usize),
                options: parse_field_options(&entry["options"]),
                custom: entry["custom"].as_bool().unwrap_or(false),
            },
            Some("external") => {
                let Some(url) = entry["url"].as_str().filter(|u| is_http_url(u)) else {
                    continue;
                };
                FormFieldKind::External {
                    url: url.to_owned(),
                }
            }
            _ => continue,
        };
        out.push(FormField {
            key,
            title,
            description,
            hidden,
            when,
            kind,
        });
    }
    out
}

fn parse_field_options(value: &Value) -> Vec<FieldOption> {
    value
        .as_array()
        .map(|arr| {
            arr.iter()
                .take(128)
                .filter_map(|item| {
                    let val = item["value"].as_str()?.to_owned();
                    let label = clean_label(&item["label"]).unwrap_or_else(|| val.clone());
                    Some(FieldOption {
                        value: val,
                        label,
                        description: sanitize_text(&item["description"]),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn clean_label(value: &Value) -> Option<String> {
    clean_str_label(value.as_str()?)
}

fn clean_str_label(s: &str) -> Option<String> {
    (!s.is_empty()
        && s.chars().take(MAX_LABEL + 1).count() <= MAX_LABEL
        && !s.contains(char::is_control))
    .then(|| s.to_owned())
}

fn clean_token(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| valid_segment(s))
        .map(str::to_owned)
}

fn sanitize_text(value: &Value) -> Option<String> {
    sanitize_str(value.as_str()?, MAX_ERROR_LEN)
}

fn sanitize_str(s: &str, max_chars: usize) -> Option<String> {
    let cleaned: String = s
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(max_chars)
        .collect();
    let trimmed = cleaned.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn email(value: &Value) -> Option<String> {
    let email = value.as_str()?;
    let (local, domain) = email.split_once('@')?;
    let (host, suffix) = domain.rsplit_once('.')?;
    (!local.is_empty()
        && !host.is_empty()
        && !suffix.is_empty()
        && !domain.contains('@')
        && email.encode_utf16().take(255).count() <= 254
        && !email.chars().any(|c| c.is_control() || c.is_whitespace()))
    .then(|| email.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_catalog_classifies_configured_configurable_and_excludes_search_only() {
        let rows = parse_catalog(
            &json!([
                {
                    "id": "openai",
                    "name": "OpenAI",
                    "methods": [
                        { "type": "env", "names": ["OPENAI_API_KEY"] },
                        { "type": "key", "label": "API key" },
                        { "id": "codex", "type": "oauth", "label": "ChatGPT" }
                    ],
                    "connections": [
                        { "type": "credential", "id": "cred_1", "label": "default", "method": "oauth" },
                        { "type": "env", "name": "OPENAI_API_KEY" }
                    ]
                },
                {
                    "id": "anthropic",
                    "name": "Anthropic",
                    "methods": [{ "type": "key", "label": "API key" }],
                    "connections": []
                },
                {
                    "id": "search-only",
                    "name": "SearchOnly",
                    "methods": [{ "type": "key", "label": "API key" }],
                    "connections": []
                }
            ]),
            &json!([{ "id": "openai", "integrationID": "openai", "name": "OpenAI" }]),
            &json!([{ "id": "gpt-5", "providerID": "openai" }]),
            &json!([{ "id": "search-only" }]),
        )
        .unwrap();

        assert_eq!(rows.len(), 2);
        let anth = rows.iter().find(|r| r.id == "anthropic").unwrap();
        assert!(anth.is_configurable());
        assert!(!anth.is_configured());
        assert!(anth.can_connect);

        let openai = rows.iter().find(|r| r.id == "openai").unwrap();
        assert!(openai.is_configured());
        assert!(!openai.is_configurable());
        assert_eq!(openai.model_count, 1);
        assert_eq!(openai.methods.len(), 2);
        assert_eq!(openai.connections.len(), 2);
        assert_eq!(
            openai.method_summary_key(),
            "settings.providers.method.mixed"
        );
    }

    #[test]
    fn form_schema_handles_visibility_conditions_hidden_defaults_and_validation() {
        let fields = parse_form_fields(&json!([
            { "key": "mode", "type": "string", "required": true, "default": "cloud",
              "options": [{ "value": "cloud", "label": "Cloud" }, { "value": "enterprise", "label": "Enterprise" }] },
            { "key": "host", "type": "string", "required": true, "format": "uri",
              "when": [{ "key": "mode", "op": "eq", "value": "enterprise" }] },
            { "key": "protocol", "type": "string", "hidden": true, "default": "v2" },
            { "key": "hidden_req", "type": "string", "hidden": true, "required": true },
            { "key": "tags", "type": "multiselect", "default": [], "options": [{ "value": "a", "label": "A" }] },
            { "key": "born", "type": "string", "format": "date" },
            { "key": "when_ts", "type": "string", "format": "date-time" },
            { "key": "docs", "type": "external", "title": "Docs", "url": "https://example.test/docs" },
            { "key": "bad_link", "type": "external", "title": "Bad", "url": "javascript:alert(1)" }
        ]));
        assert_eq!(fields.len(), 8);
        let mut answers = initial_form_answers(&fields);
        assert!(!is_field_visible(&fields[1], &answers));
        assert!(!is_field_visible(&fields[2], &answers));
        assert!(!is_field_visible(&fields[3], &answers));
        // Hidden required field does not block submission, and explicit [] multiselect default is kept.
        assert!(fields.iter().all(|f| is_field_complete(f, &answers)));
        let built = build_form_answer(&fields, &answers).unwrap();
        assert_eq!(
            built,
            json!({ "mode": "cloud", "protocol": "v2", "tags": [] })
        );

        // Calendar date and date-time validation reject impossible dates.
        answers.insert("born".into(), json!("2025-02-29"));
        assert!(!is_field_complete(&fields[5], &answers));
        answers.insert("born".into(), json!("2024-02-29"));
        assert!(is_field_complete(&fields[5], &answers));
        answers.insert("when_ts".into(), json!("2024-02-29T25:00:00Z"));
        assert!(!is_field_complete(&fields[6], &answers));
        answers.insert("when_ts".into(), json!("2024-02-29T12:30:00Z"));
        assert!(is_field_complete(&fields[6], &answers));

        answers.insert("mode".into(), json!("enterprise"));
        assert!(is_field_visible(&fields[1], &answers));
        assert!(!is_field_complete(&fields[1], &answers));
        answers.insert("host".into(), json!("not a url"));
        assert!(!is_field_complete(&fields[1], &answers));
        answers.insert("host".into(), json!("https://corp.example.test"));
        assert!(is_field_complete(&fields[1], &answers));
        let built = build_form_answer(&fields, &answers).unwrap();
        assert_eq!(
            built,
            json!({
                "mode": "enterprise",
                "host": "https://corp.example.test",
                "protocol": "v2",
                "tags": [],
                "born": "2024-02-29",
                "when_ts": "2024-02-29T12:30:00Z"
            })
        );
    }

    #[test]
    fn account_selection_and_response_location_fail_closed() {
        assert!(parse_account_selection(&json!({})).is_none());
        assert!(parse_account_selection(&json!({ "supported": true })).is_none());
        assert!(parse_account_selection(&json!({ "supported": true, "enabled": false })).is_some());
        assert!(
            verify_response_location(
                &json!({ "location": { "directory": "/repo/a" } }),
                "/repo/a"
            )
            .is_ok()
        );
        assert!(
            verify_response_location(
                &json!({ "location": { "directory": "/repo/b" } }),
                "/repo/a"
            )
            .is_err()
        );
        assert!(verify_response_location(&json!({ "location": {} }), "/repo/a").is_err());
        assert!(verify_response_location(&json!({ "data": {} }), "/repo/a").is_err());
    }

    #[test]
    fn form_numeric_when_required_boolean_and_error_classification() {
        let fields = parse_form_fields(&json!([
            { "key": "tier", "type": "number", "default": 1.0 },
            { "key": "extra", "type": "string", "required": true,
              "when": [{ "key": "tier", "op": "eq", "value": 1 }] },
            { "key": "accept", "type": "boolean", "required": true }
        ]));
        let mut answers = initial_form_answers(&fields);
        assert!(is_field_visible(&fields[1], &answers));
        assert!(!is_field_complete(&fields[2], &answers));
        answers.insert("accept".into(), Value::Bool(false));
        assert!(is_field_complete(&fields[2], &answers));

        assert_eq!(
            classify_error_body(
                404,
                Some(&json!({ "data": { "message": "Attempt expired" } }))
            ),
            AuthError::Message("Attempt expired".into())
        );
        assert_eq!(
            classify_error_body(404, Some(&json!({ "data": { "message": "Not found" } }))),
            AuthError::Message("Not found".into())
        );
        assert_eq!(
            classify_error_body(404, Some(&json!({ "error": { "message": "Not found" } }))),
            AuthError::Message("Not found".into())
        );
        assert_eq!(
            classify_error_body(404, Some(&json!({ "error": "Not found" }))),
            AuthError::Unsupported
        );
        assert_eq!(
            classify_error_body(404, Some(&json!({ "message": "Route POST:/x not found" }))),
            AuthError::Unsupported
        );
        assert_eq!(classify_error_body(404, None), AuthError::Unsupported);
        assert_eq!(classify_error_body(501, None), AuthError::Unsupported);
    }

    #[test]
    fn http_url_validator_accepts_http_and_rejects_unsafe_schemes() {
        assert!(is_http_url("https://auth.example.test/authorize?x=1"));
        assert!(is_http_url("http://127.0.0.1:8080/callback"));
        assert!(!is_http_url("javascript:alert(1)"));
        assert!(!is_http_url("file:///etc/passwd"));
        assert!(!is_http_url("https://bad.example/\nnewline"));
    }
}
