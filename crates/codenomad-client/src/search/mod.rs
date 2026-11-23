//! Bounded display reads through the two authenticated history routes.
use crate::{
    backend::{Backend, read_json_limited},
    history::{Result, valid_id},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;

const QUERY_UNITS: usize = 200;
const LITERAL_CURSOR: usize = 4096;
const RANKED_CURSOR: usize = 32_768;
const BATCH: usize = 32;
// Preserve the next cursor if an unusually sparse result page reaches this bound.
const SCAN_BATCHES: usize = 4096;
const RANKED_LIMIT: usize = 40;
const MAX_SAFE: u64 = (1 << 53) - 1;
const RESPONSE_BYTES: usize = 256 * 1024;
pub const MIN_QUERY_UNITS: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Text,
    Tool,
    Reasoning,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Hit {
    #[serde(rename = "sessionID")]
    pub session: String,
    #[serde(rename = "messageID")]
    pub message: String,
    pub role: String,
    #[serde(rename = "partIndex")]
    pub part: u64,
    pub kind: Kind,
    pub excerpt: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Page {
    pub hits: Vec<Hit>,
    pub scanned: u64,
    pub skipped: u64,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    pub cursor: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Exclusion {
    ForeignDirectory,
    UnknownDirectory,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Ranked {
    Ranked {
        version: u8,
        capped: bool,
        #[serde(rename = "examinedBefore")]
        examined_before: u64,
        exclusions: Vec<Exclusion>,
        #[serde(flatten)]
        page: Page,
    },
    Unsupported,
    RestartRequired,
    Blocked {
        reason: Blocked,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Blocked {
    Unavailable,
    MaintenanceRequired,
    Conflict,
    NotDeletable,
    UnsupportedStorage,
}

impl std::fmt::Display for Blocked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "history search blocked: {self:?}")
    }
}
impl std::error::Error for Blocked {}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum Literal {
    Page(Page),
    Blocked { reason: Blocked },
}

impl Backend {
    /// Publish incremental results up to one UI page; keep the last batch in full.
    pub async fn search_history(
        &self,
        query: &str,
        technical: bool,
        cursor: Option<&str>,
        mut progress: impl FnMut(&Page),
    ) -> Result<Page> {
        let query = query.trim();
        self.check_search(query, cursor, LITERAL_CURSOR)?;
        if !valid_id(&self.session) {
            return Err("invalid history search session".into());
        }
        let mut seen = HashSet::new();
        let mut result = Page {
            cursor: cursor.map(str::to_owned),
            ..Page::default()
        };
        for batch in 1..=SCAN_BATCHES {
            if result
                .cursor
                .as_ref()
                .is_some_and(|cursor| !seen.insert(cursor.clone()))
            {
                return Err(Blocked::Conflict.into());
            }
            let mut body = json!({"sessionID":self.session, "query":query, "purpose":"search", "includeTechnical":technical});
            insert_cursor(&mut body, result.cursor.as_deref());
            let response = self
                .client
                .post(self.search_url("query"))
                .json(&body)
                .send()
                .await?
                .error_for_status()?;
            let page =
                match serde_json::from_value(read_json_limited(response, RESPONSE_BYTES).await?)? {
                    Literal::Page(page) => page,
                    Literal::Blocked { reason } => return Err(reason.into()),
                };
            page.validate(BATCH, LITERAL_CURSOR, Some(&self.session))?;
            if page
                .cursor
                .as_ref()
                .is_some_and(|cursor| seen.contains(cursor))
            {
                return Err(Blocked::Conflict.into());
            }
            result.scanned = add(result.scanned, page.scanned)?;
            result.skipped = add(result.skipped, page.skipped)?;
            if page.hits.iter().any(|hit| result.hits.iter().any(|old| old.message == hit.message)) {
                return Err(Blocked::Conflict.into());
            }
            result.hits.extend(page.hits);
            result.cursor = page.cursor;
            if result.hits.len() >= BATCH || result.cursor.is_none() || batch == SCAN_BATCHES {
                return Ok(result);
            }
            progress(&result);
        }
        Ok(result)
    }

    /// Request one ranked window in broker order. A bad continuation is explicitly restartable.
    pub async fn rank_history(
        &self,
        query: &str,
        technical: bool,
        cursor: Option<&str>,
    ) -> Result<Ranked> {
        let query = query.trim();
        self.check_search(query, cursor, RANKED_CURSOR)?;
        let mut body =
            json!({"version":1, "query":query, "includeTechnical":technical, "limit":RANKED_LIMIT});
        insert_cursor(&mut body, cursor);
        let response = self
            .client
            .post(self.search_url("ranked"))
            .json(&body)
            .send()
            .await?;
        if cursor.is_some() && response.status().as_u16() == 400 {
            return Ok(Ranked::RestartRequired);
        }
        let result = serde_json::from_value(
            read_json_limited(response.error_for_status()?, RESPONSE_BYTES).await?,
        )?;
        match &result {
            Ranked::Ranked {
                version: 1,
                page,
                examined_before,
                exclusions,
                ..
            } if exclusions.len() <= 2 => {
                page.validate(RANKED_LIMIT, RANKED_CURSOR, None)?;
                add(*examined_before, page.scanned)?;
                if cursor.is_some() && page.cursor.as_deref() == cursor {
                    return Err(Blocked::Conflict.into());
                }
            }
            Ranked::Unsupported
            | Ranked::Blocked {
                reason: Blocked::UnsupportedStorage,
            } if cursor.is_some() => return Ok(Ranked::RestartRequired),
            Ranked::Blocked { reason } => return Err((*reason).into()),
            Ranked::Unsupported | Ranked::RestartRequired => {}
            _ => return Err("invalid ranked history window".into()),
        }
        Ok(result)
    }

    fn check_search(&self, query: &str, cursor: Option<&str>, max: usize) -> Result<()> {
        if !valid_id(&self.workspace)
            || !(MIN_QUERY_UNITS..=QUERY_UNITS).contains(&query.encode_utf16().count())
            || !valid_cursor(cursor, max)
        {
            return Err("invalid history search request".into());
        }
        Ok(())
    }

    fn search_url(&self, route: &str) -> String {
        format!(
            "{}api/workspaces/{}/session-history/{route}",
            self.base, self.workspace
        )
    }
}

impl Page {
    fn validate(&self, limit: usize, max_cursor: usize, session: Option<&str>) -> Result<()> {
        let mut hits = HashSet::new();
        if self.hits.len() > limit
            || self.skipped > self.scanned
            || self.scanned > MAX_SAFE
            || !valid_cursor(self.cursor.as_deref(), max_cursor)
            || self.hits.iter().any(|h| {
                !valid_id(&h.session)
                    || !valid_id(&h.message)
                    || session.is_some_and(|id| h.session != id)
                    || !hits.insert((&h.session, &h.message))
                    || h.role.encode_utf16().count() > 32
                    || h.part > MAX_SAFE
                    || h.excerpt.encode_utf16().count() > 320
            })
        {
            return Err("invalid history search page".into());
        }
        Ok(())
    }
}

fn add(first: u64, second: u64) -> Result<u64> {
    first
        .checked_add(second)
        .filter(|n| *n <= MAX_SAFE)
        .ok_or_else(|| "history search count exceeds its bound".into())
}

fn valid_cursor(cursor: Option<&str>, max: usize) -> bool {
    cursor.is_none_or(|cursor| !cursor.is_empty() && cursor.encode_utf16().count() <= max)
}

fn insert_cursor(body: &mut Value, cursor: Option<&str>) {
    if let Some(cursor) = cursor {
        body["cursor"] = json!(cursor);
    }
}

#[cfg(test)]
mod tests;
