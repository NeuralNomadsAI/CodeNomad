use super::Usage;
use crate::{
    backend::{Backend, read_json},
    history::{Result, valid_id},
};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};

pub const FAMILY_LIMIT: usize = 128;
pub type Family = HashMap<String, FamilyMember>;

#[derive(Debug, PartialEq)]
pub struct FamilySnapshot {
    pub members: Family,
    pub complete: bool,
}

#[derive(Debug, PartialEq)]
pub struct FamilyMember {
    pub usage: Usage,
    pub model: Option<(String, String)>,
}

#[derive(Debug)]
pub enum FamilyChange {
    Usage { id: String, usage: Usage },
    Membership { id: String, parent: Option<String> },
}

impl FamilyChange {
    pub(crate) fn tracks(event: &Value) -> bool {
        matches!(
            event["type"].as_str(),
            Some(
                "session.usage.updated"
                    | "session.created"
                    | "session.forked"
                    | "session.deleted"
                    | "session.moved"
                    | "session.model.selected"
            )
        ) && event["data"]["sessionID"].as_str().is_some_and(valid_id)
    }

    pub(crate) fn decode(event: &Value) -> Option<Self> {
        let data = &event["data"];
        let id = data["sessionID"].as_str().filter(|id| valid_id(id))?;
        match event["type"].as_str()? {
            "session.usage.updated" => Some(Self::Usage {
                id: id.into(),
                usage: Usage::decode(data)?,
            }),
            "session.created"
            | "session.forked"
            | "session.deleted"
            | "session.moved"
            | "session.model.selected" => {
                let parent = data["parentID"]
                    .as_str()
                    .filter(|id| valid_id(id))
                    .map(str::to_owned);
                Some(Self::Membership {
                    id: id.into(),
                    parent,
                })
            }
            _ => None,
        }
    }
}

impl Backend {
    /// Totals only: a native child-list limit and continuation are scoped to each parent.
    pub async fn family_usage(&self) -> Result<FamilySnapshot> {
        futures_lite::future::race(self.read_family_usage(), async {
            crate::runtime::sleep(crate::http::REQUEST_TIMEOUT).await;
            Err("session family timed out".into())
        })
        .await
    }

    async fn read_family_usage(&self) -> Result<FamilySnapshot> {
        if !valid_id(&self.session) {
            return Err("invalid session family root".into());
        }
        let root = self
            .control_get(&format!("session/{}", self.session))
            .await?;
        let root = root.get("data").unwrap_or(&root);
        let project = root["projectID"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or("invalid session family project")?;
        if root["id"] != self.session {
            return Err("session family root mismatch".into());
        }
        let url = format!(
            "{}workspaces/{}/instance/api/session",
            self.base, self.workspace
        );
        let mut next = VecDeque::from([self.session.clone()]);
        let mut members = Family::new();
        let mut requests = 0;
        while let Some(parent) = next.pop_front() {
            let mut cursor = None::<String>;
            let mut cursors = HashSet::new();
            loop {
                requests += 1;
                if requests > 2 * FAMILY_LIMIT {
                    return Ok(FamilySnapshot {
                        members,
                        complete: false,
                    });
                }
                let request = self.client.get(&url);
                let request = if let Some(cursor) = &cursor {
                    request.query(&[("cursor", cursor.as_str())])
                } else {
                    let request = request.query(&[("parentID", parent.as_str()), ("limit", "100")]);
                    if project != "global" {
                        request.query(&[("project", project)])
                    } else {
                        request
                    }
                };
                let page = read_json(request.send().await?.error_for_status()?).await?;
                if !add_children(
                    &page,
                    &parent,
                    project,
                    &self.session,
                    &mut members,
                    &mut next,
                )? {
                    return Ok(FamilySnapshot {
                        members,
                        complete: false,
                    });
                }
                cursor = match &page["cursor"]["next"] {
                    Value::Null => break,
                    Value::String(value)
                        if !value.is_empty()
                            && value.len() <= 65536
                            && cursors.insert(value.clone()) =>
                    {
                        Some(value.clone())
                    }
                    _ => return Err("invalid session family cursor".into()),
                };
            }
        }
        Ok(FamilySnapshot {
            members,
            complete: true,
        })
    }
}

fn add_children(
    page: &Value,
    parent: &str,
    project: &str,
    root: &str,
    members: &mut Family,
    next: &mut VecDeque<String>,
) -> Result<bool> {
    let rows = page["data"]
        .as_array()
        .filter(|rows| rows.len() <= 100)
        .ok_or("invalid session family page")?;
    for child in rows {
        let id = child["id"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or("invalid descendant id")?;
        if id == root || child["parentID"] != parent || child["projectID"] != project {
            return Err("invalid session family relationship".into());
        }
        if members.contains_key(id) {
            return Err("session family continuity lost".into());
        }
        if members.len() >= FAMILY_LIMIT {
            return Ok(false);
        }
        let model = &child["model"];
        let model = model["providerID"]
            .as_str()
            .zip(model["id"].as_str())
            .filter(|(provider, id)| provider.len() <= 256 && id.len() <= 512)
            .map(|(provider, id)| (provider.into(), id.into()));
        members.insert(
            id.into(),
            FamilyMember {
                usage: Usage::decode(child).unwrap_or_default(),
                model,
            },
        );
        next.push_back(id.into());
    }
    Ok(true)
}

#[cfg(test)]
#[test]
fn a_large_family_preserves_the_bounded_prefix_as_partial() {
    use serde_json::json;
    let page = |start, count| {
        json!({"data": (start..start + count).map(|i| json!({
        "id":format!("child-{i}"), "parentID":"root","projectID":"project",
        "tokens":{"input":1}
    })).collect::<Vec<_>>()})
    };
    let mut members = Family::new();
    let mut next = VecDeque::new();
    assert!(
        add_children(
            &page(0, 100),
            "root",
            "project",
            "root",
            &mut members,
            &mut next
        )
        .unwrap()
    );
    assert!(
        !add_children(
            &page(100, 30),
            "root",
            "project",
            "root",
            &mut members,
            &mut next
        )
        .unwrap()
    );
    assert_eq!(members.len(), FAMILY_LIMIT);
    assert_eq!(
        members
            .values()
            .map(|member| member.usage.input)
            .sum::<u64>(),
        FAMILY_LIMIT as u64
    );
}
