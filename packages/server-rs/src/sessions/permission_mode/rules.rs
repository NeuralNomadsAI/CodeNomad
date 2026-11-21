use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Rule {
    action: String,
    resource: String,
    effect: Effect,
}

impl Rule {
    pub(super) fn deny(&self) -> bool {
        self.effect == Effect::Deny
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Effect {
    Allow,
    Ask,
    Deny,
}

pub(super) fn parse(value: &Value) -> Result<Vec<Rule>, ()> {
    if value.is_null() { Ok(vec![]) } else { serde_json::from_value(value.clone()).map_err(|_| ()) }
}

pub(super) fn start() -> Vec<Rule> {
    ["edit", "shell"].map(|action| Rule { action: action.into(), resource: "*".into(), effect: Effect::Ask }).into()
}

pub(super) fn config(entries: &Value) -> Result<Vec<Rule>, ()> {
    let mut block = start();
    for entry in entries.as_array().ok_or(())? {
        match entry["type"].as_str() {
            Some("document") if entry["info"].is_object() => {
                project(&mut block, &parse(&entry["info"]["permissions"])?, cfg!(windows), true)?;
            }
            Some("directory") => {}
            _ => return Err(()),
        }
    }
    Ok(block)
}

pub(super) fn project(block: &mut Vec<Rule>, rules: &[Rule], ignore_case: bool, from_config: bool) -> Result<(), ()> {
    for rule in rules {
        let action_pattern = rule.action.replace('\\', "/");
        let action_pattern = if ignore_case { action_pattern.to_ascii_lowercase() } else { action_pattern };
        let (pattern, suffix) =
            action_pattern.strip_suffix(" *").map_or((action_pattern.as_str(), ""), |p| (p, "(?: .*)?"));
        let mut re = String::from(r"(?s)\A");
        for c in pattern.chars() {
            match c {
                '*' => re.push_str(".*"),
                '?' => re.push('.'),
                _ => re.push_str(&regex::escape(&c.to_string())),
            }
        }
        re.push_str(suffix);
        re.push_str(r"\z");
        let matcher = regex::Regex::new(&re).map_err(|_| ())?;
        for action in ["edit", "shell"] {
            if !matcher.is_match(action) {
                continue;
            }
            // Only the native config loader expands these resources.
            if from_config
                && rule.action == "edit"
                && action == "edit"
                && (rule.resource == "~"
                    || rule.resource.starts_with("~/")
                    || rule.resource == "$HOME"
                    || rule.resource.strip_prefix("$HOME").is_some_and(|tail| tail.starts_with(['/', '\\'])))
            {
                return Err(());
            }
            block.push(Rule {
                action: action.into(),
                resource: rule.resource.clone(),
                effect: if rule.effect == Effect::Allow { Effect::Ask } else { rule.effect },
            });
        }
    }
    Ok(())
}

pub(super) fn positions<'a>(rules: &'a [Rule], block: &'a [Rule]) -> impl Iterator<Item = usize> + 'a {
    rules.windows(block.len()).enumerate().filter_map(move |(i, candidate)| (candidate == block).then_some(i))
}

/// Active and pending revisions can be prefixes of one another at a single position.
pub(super) fn span(
    rules: &[Rule],
    active: Option<&[Rule]>,
    pending: Option<&[Rule]>,
) -> Result<Option<(usize, usize)>, ()> {
    let mut span: Option<(usize, usize)> = None;
    for block in [active, pending].into_iter().flatten() {
        for pos in positions(rules, block) {
            if span.is_some_and(|(index, _)| index != pos) {
                return Err(());
            }
            span = Some((pos, span.map_or(block.len(), |(_, len)| len.max(block.len()))));
        }
    }
    Ok(span)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn project_order_wildcards_and_effects_without_altering_other_actions() {
        let docs = json!([
            {"type":"directory"},
            {"type":"document","info":{"permissions":[
                {"action":"*","resource":"all","effect":"allow"},
                {"action":"edit *","resource":"src/**","effect":"deny"},
                {"action":"read","resource":"*","effect":"deny"},
                {"action":"sh?ll","resource":"literal","effect":"ask"},
                {"action":"[shell]","resource":"ignored","effect":"deny"}
            ]}},
            {"type":"document","info":{"permissions":[{"action":"edit","resource":"src/specific","effect":"ask"}]}}
        ]);
        assert_eq!(
            serde_json::to_value(config(&docs).unwrap()).unwrap(),
            json!([
                {"action":"edit","resource":"*","effect":"ask"}, {"action":"shell","resource":"*","effect":"ask"},
                {"action":"edit","resource":"all","effect":"ask"}, {"action":"shell","resource":"all","effect":"ask"},
                {"action":"edit","resource":"src/**","effect":"deny"},
                {"action":"shell","resource":"literal","effect":"ask"},
                {"action":"edit","resource":"src/specific","effect":"ask"}
            ])
        );
        assert!(
            config(&json!([{"type":"document","info":{"permissions":[
            {"action":"edit","resource":"$HOME\\private","effect":"deny"}]}}]))
            .is_err()
        );
        assert!(config(&json!({})).is_err());
        let mut block = vec![];
        let upper = parse(&json!([{"action":"EDIT","resource":"*","effect":"deny"}])).unwrap();
        project(&mut block, &upper, false, true).unwrap();
        assert!(block.is_empty());
        project(&mut block, &upper, true, true).unwrap();
        assert_eq!(block[0].action, "edit");
    }
}
