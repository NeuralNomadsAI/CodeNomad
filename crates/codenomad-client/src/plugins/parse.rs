//! JSON parsing for plugin controls and native plugin inventory snapshots.
use super::{
    ActivationControl, ConfigScope, ConfiguredRule, ConfiguredSource, ControlTarget,
    ControllingRule, MAX_ITEMS, RuntimeEntry, RuntimeSource, RuntimeState, Scope, ScopeRuleState,
    Snapshot, location_matches, valid_revision,
};
use crate::history::Result;
use serde_json::Value;

pub(crate) fn parse_snapshot(value: &Value, expected_directory: &str) -> Result<Snapshot> {
    let dir = value["location"]["directory"]
        .as_str()
        .filter(|p| crate::absolute_server_path(p))
        .ok_or("Invalid plugin controls Location")?;
    if !location_matches(expected_directory, dir) {
        return Err("Plugin controls Location mismatch".into());
    }
    let runtime = parse_runtime_entries(&value["runtime"])?;
    let configured_rules = parse_rules(&value["configured"]["rules"])?;
    let configured_sources = parse_sources(&value["configured"]["sources"])?;
    let controls = parse_controls(&value["controls"])?;
    let targets = parse_targets(&value["targets"])?;
    Ok(Snapshot {
        directory: dir.to_owned(),
        controls_available: true,
        runtime,
        configured_rules,
        configured_sources,
        controls,
        targets,
    })
}

pub(crate) fn parse_runtime_entries(value: &Value) -> Result<Vec<RuntimeEntry>> {
    let Some(items) = value.as_array() else {
        return Err("Invalid plugin runtime list".into());
    };
    if items.len() > MAX_ITEMS {
        return Err("Too many plugin runtime entries".into());
    }
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        out.push(parse_runtime_entry(item)?);
    }
    Ok(out)
}

fn parse_runtime_entry(item: &Value) -> Result<RuntimeEntry> {
    let source = match item["source"]["type"].as_str() {
        Some("builtin") => RuntimeSource::Builtin,
        Some("package") => RuntimeSource::Package {
            target: item["source"]["target"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("Missing package target")?
                .to_owned(),
            version: item["source"]["version"].as_str().map(str::to_owned),
            revision: item["source"]["revision"].as_str().map(str::to_owned),
            outdated: item["source"]["outdated"] == Value::Bool(true),
            updating: item["source"]["updating"] == Value::Bool(true),
        },
        Some("local") => RuntimeSource::Local {
            path: item["source"]["path"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("Missing local plugin path")?
                .to_owned(),
        },
        Some("sdk") => RuntimeSource::Sdk,
        _ => return Err("Invalid plugin runtime source".into()),
    };
    let state = match item["state"]["status"].as_str() {
        Some("active") => RuntimeState::Active,
        Some("failed") => RuntimeState::Failed {
            error: item["state"]["error"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
            error_ref: item["state"]["ref"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
        },
        _ => return Err("Invalid plugin runtime state".into()),
    };
    let id = item["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let key = item["key"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| id.clone())
        .unwrap_or_else(|| match &source {
            RuntimeSource::Package { target, .. } => target.clone(),
            RuntimeSource::Local { path } => path.clone(),
            RuntimeSource::Builtin => "builtin".to_owned(),
            RuntimeSource::Sdk => "sdk".to_owned(),
        });
    Ok(RuntimeEntry {
        key,
        managed_by_codenomad: item["managedBy"].as_str() == Some("codenomad"),
        id,
        source,
        gui_feature: item["features"]["gui"] == Value::Bool(true),
        state,
    })
}

fn parse_rules(value: &Value) -> Result<Vec<ConfiguredRule>> {
    let Some(items) = value.as_array() else {
        return Err("Invalid plugin configured rules".into());
    };
    if items.len() > MAX_ITEMS {
        return Err("Too many plugin rules".into());
    }
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let selector = item["selector"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Missing rule selector")?;
        let enabled = item["enabled"].as_bool().ok_or("Missing rule enabled")?;
        let scope = item["scope"]
            .as_str()
            .and_then(ConfigScope::parse)
            .ok_or("Invalid rule scope")?;
        let entry_index = item["entryIndex"].as_u64().ok_or("Missing rule index")?;
        out.push(ConfiguredRule {
            selector: selector.to_owned(),
            enabled,
            scope,
            path: item["path"].as_str().map(str::to_owned),
            entry_index,
        });
    }
    Ok(out)
}

fn parse_sources(value: &Value) -> Result<Vec<ConfiguredSource>> {
    let Some(items) = value.as_array() else {
        return Err("Invalid plugin configured sources".into());
    };
    if items.len() > MAX_ITEMS {
        return Err("Too many plugin sources".into());
    }
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let target = item["target"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Missing source target")?;
        let scope = item["scope"]
            .as_str()
            .and_then(ConfigScope::parse)
            .ok_or("Invalid source scope")?;
        let entry_index = item["entryIndex"].as_u64().ok_or("Missing source index")?;
        out.push(ConfiguredSource {
            target: target.to_owned(),
            scope,
            path: item["path"].as_str().map(str::to_owned),
            entry_index,
            plugin_id: item["pluginId"].as_str().map(str::to_owned),
            managed_by_codenomad: item["managedBy"].as_str() == Some("codenomad"),
            expected_revision: item["expectedRevision"]
                .as_str()
                .filter(|r| valid_revision(r))
                .map(str::to_owned),
        });
    }
    Ok(out)
}

fn parse_controls(value: &Value) -> Result<Vec<ActivationControl>> {
    let Some(items) = value.as_array() else {
        return Err("Invalid plugin controls list".into());
    };
    if items.len() > MAX_ITEMS {
        return Err("Too many plugin controls".into());
    }
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let id = item["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Missing control ID")?;
        let runtime = if item["runtime"].is_null() {
            None
        } else {
            Some(parse_runtime_entry(&item["runtime"])?)
        };
        let builtin = item["builtin"].as_bool().unwrap_or(false);
        let effective = item["effective"]
            .as_str()
            .and_then(ScopeRuleState::parse)
            .ok_or("Invalid control effective state")?;
        let global = item["global"]
            .as_str()
            .and_then(ScopeRuleState::parse)
            .ok_or("Invalid control global state")?;
        let project = item["project"]
            .as_str()
            .and_then(ScopeRuleState::parse)
            .ok_or("Invalid control project state")?;
        let controlling_rule = item.get("controllingRule").and_then(|rule| {
            let selector = rule["selector"].as_str().filter(|s| !s.is_empty())?;
            let enabled = rule["enabled"].as_bool()?;
            let scope = rule["scope"].as_str().and_then(ConfigScope::parse)?;
            Some(ControllingRule {
                selector: selector.to_owned(),
                enabled,
                scope,
                path: rule["path"].as_str().map(str::to_owned),
            })
        });
        out.push(ActivationControl {
            id: id.to_owned(),
            managed_by_codenomad: item["managedBy"].as_str() == Some("codenomad"),
            runtime,
            builtin,
            effective,
            global,
            project,
            controlling_rule,
            orphan: item["orphan"] == Value::Bool(true),
        });
    }
    Ok(out)
}

fn parse_targets(value: &Value) -> Result<Vec<ControlTarget>> {
    let Some(items) = value.as_array() else {
        return Err("Invalid plugin control targets".into());
    };
    if items.len() > 8 {
        return Err("Too many plugin targets".into());
    }
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let scope = item["scope"]
            .as_str()
            .and_then(Scope::parse)
            .ok_or("Invalid target scope")?;
        let path = item["path"]
            .as_str()
            .filter(|p| !p.is_empty())
            .ok_or("Missing target path")?;
        let exists = item["exists"].as_bool().unwrap_or(false);
        out.push(ControlTarget {
            scope,
            path: path.to_owned(),
            exists,
            expected_revision: item["expectedRevision"]
                .as_str()
                .filter(|r| valid_revision(r))
                .map(str::to_owned),
        });
    }
    Ok(out)
}
