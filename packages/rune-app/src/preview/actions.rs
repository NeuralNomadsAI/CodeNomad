use super::{Panel, Value, json};

pub enum Step {
    Tree,
    Aim { point: [i32; 2], nodes: Vec<i64> },
    Focus(i64),
    Text(i64),
    Value(i64),
    Done(&'static str),
    Shot,
    Wait,
}

pub fn first(c: &Value) -> (Step, Value) {
    if c["action"] == "screenshot" {
        (Step::Shot, json!({"op":"shot"}))
    } else {
        (Step::Tree, json!({"op":"ax"}))
    }
}

pub enum Next {
    Send(Step, Value),
    Again,
    Return(Value),
}

fn tree(value: &Value) -> Result<&[Value], String> {
    value["tree"]
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| "Browser AX tree unavailable".into())
}

fn id(node: &Value) -> Option<i64> {
    node["node"].as_i64()
}

fn scope(panel: &Panel) -> u64 {
    (panel.registration << 32) | (panel.epoch & u64::from(u32::MAX))
}

fn target(c: &Value, panel: &Panel) -> Result<Option<i64>, String> {
    if c["ref"].is_null() {
        return Ok(None);
    }
    let raw = c["ref"].as_str().ok_or("Invalid browser ref")?;
    let prefix = format!("{}-e", scope(panel));
    raw.strip_prefix(&prefix)
        .and_then(|x| x.parse().ok())
        .map(Some)
        .ok_or_else(|| "Browser ref is stale".into())
}

fn point(panel: &Panel, node: Option<&Value>) -> Result<[i32; 2], String> {
    let (w, h, dpi) = panel.viewport_px;
    let (w, h, dpi) = (f64::from(w), f64::from(h), f64::from(dpi));
    let Some(n) = node else {
        return Ok([(w / 2.0) as i32, (h / 2.0) as i32]);
    };
    let get = |key| n[key].as_f64().unwrap_or_default() * dpi;
    let x = get("x");
    let y = get("y");
    let (x0, y0, x1, y1) = (
        x.max(0.),
        y.max(0.),
        (x + get("w")).min(w),
        (y + get("h")).min(h),
    );
    if x0 >= x1 || y0 >= y1 || n["disabled"] == true {
        return Err("Browser element is not visible or is disabled".into());
    }
    Ok([((x0 + x1) / 2.) as i32, ((y0 + y1) / 2.) as i32])
}

fn parents(tree: &[Value], index: usize) -> Vec<i64> {
    let mut chain = Vec::new();
    let mut node = &tree[index];
    for _ in 0..24 {
        let Some(parent) = node["parent"].as_i64().filter(|n| *n >= 0) else {
            break;
        };
        if chain.contains(&parent) {
            break;
        }
        chain.push(parent);
        let Some(next) = tree.iter().find(|x| id(x) == Some(parent)) else {
            break;
        };
        node = next;
    }
    chain
}

fn text(node: &Value, field: &str) -> String {
    node[field]
        .as_str()
        .unwrap_or_default()
        .chars()
        .take(300)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

fn matches_text(nodes: &[Value], needle: &str) -> bool {
    let mut parent = None;
    let mut run = String::new();
    for n in nodes {
        if ["name", "description", "value"].iter().any(|k| {
            (*k != "value" || n["password"] != true)
                && n[k].as_str().is_some_and(|s| s.contains(needle))
        }) {
            return true;
        }
        if n["role"] != "text leaf" {
            parent = None;
            run.clear();
            continue;
        }
        let next_parent = n["parent"].as_i64();
        if next_parent != parent || run.len() > 4096 {
            run.clear();
        }
        parent = next_parent;
        if let Some(name) = n["name"].as_str().filter(|s| s.len() <= 4096) {
            run.push_str(name);
            if run.contains(needle) {
                return true;
            }
        }
    }
    false
}

fn outline(panel: &Panel, tree: &[Value], c: &Value) -> Result<Value, String> {
    let root = target(c, panel)?;
    if root.is_some_and(|r| !tree.iter().any(|n| id(n) == Some(r))) {
        return Err("Browser element disappeared".into());
    }
    let query = c["query"].as_str().map(str::to_lowercase);
    let mut rows = String::new();
    let named: std::collections::HashSet<_> = tree
        .iter()
        .filter(|n| {
            matches!(
                n["role"].as_str(),
                Some("textbox" | "button" | "heading" | "link" | "combobox")
            )
        })
        .filter_map(|n| n["name"].as_str().filter(|s| !s.is_empty()))
        .collect();
    let mut visible = std::collections::HashSet::new();
    if let Some(q) = &query {
        for (i, n) in tree.iter().enumerate() {
            if ["role", "name", "description", "value"]
                .iter()
                .any(|field| text(n, field).to_lowercase().contains(q))
            {
                visible.extend(parents(tree, i));
                visible.extend(id(n));
            }
        }
    }
    for (i, n) in tree.iter().enumerate() {
        let Some(node_id) = id(n) else {
            continue;
        };
        let chain = parents(tree, i);
        if root.is_some_and(|r| r != node_id && !chain.contains(&r))
            || (query.is_some()
                && !visible.contains(&node_id)
                && !chain
                    .iter()
                    .any(|p| visible.contains(p) && root == Some(*p)))
        {
            continue;
        }
        let role = text(n, "role");
        let name = text(n, "name");
        let value = if n["password"] == true {
            String::new()
        } else {
            text(n, "value")
        };
        if role == "text leaf" && named.contains(name.trim()) && root != Some(node_id) {
            continue;
        }
        if name.is_empty() && value.is_empty() && matches!(role.as_str(), "" | "generic" | "group")
        {
            continue;
        }
        if rows.len() >= 28_000 {
            rows.push_str("  (+ more)\n");
            break;
        }
        let indent = chain.len().min(18) * 2;
        rows.push_str(&format!(
            "{:indent$}[{}-e{node_id}] {role} {name} {value}\n",
            "",
            scope(panel)
        ));
    }
    Ok(json!({"snapshot":rows,"url":panel.url}))
}

fn click(point: [i32; 2], c: &Value) -> Value {
    json!({"op":"click","x":point[0],"y":point[1],"button":c["button"]})
}

fn wheel(panel: &Panel, point: [i32; 2], c: &Value) -> Value {
    let amount =
        c["amount"].as_f64().unwrap_or(600.).clamp(1., 10_000.) * f64::from(panel.viewport_px.2);
    let (dx, dy) = match c["direction"].as_str() {
        Some("up") => (0., -amount),
        Some("left") => (-amount, 0.),
        Some("right") => (amount, 0.),
        _ => (0., amount),
    };
    json!({"op":"wheel","x":point[0],"y":point[1],"dx":dx,"dy":dy})
}

fn press(c: &Value) -> Result<Next, String> {
    let mut parts = c["key"].as_str().ok_or("Missing browser key")?.rsplit('+');
    let key = parts
        .next()
        .filter(|k| !k.is_empty())
        .ok_or("Missing browser key")?;
    let mut v = json!({"op":"press","key":if key == "Space" {" "} else {key}});
    for modifier in parts {
        let field = match modifier.to_ascii_lowercase().as_str() {
            "control" | "ctrl" | "mod" => "ctrl",
            "shift" => "shift",
            "alt" => "alt",
            "meta" => "meta",
            _ => return Err("Unsupported browser modifier".into()),
        };
        v[field] = true.into();
    }
    Ok(Next::Send(Step::Done("pressed"), v))
}

pub fn advance(panel: &Panel, c: &Value, step: Step, response: Value) -> Result<Next, String> {
    if let Some(error) = response["error"].as_str() {
        return Err(error.into());
    }
    let action = c["action"].as_str().unwrap_or_default();
    let send = |step, value| Ok(Next::Send(step, value));
    let finish = |value| Ok(Next::Return(value));
    match step {
        Step::Tree => {
            let nodes = tree(&response)?;
            if action == "snapshot" {
                return finish(outline(panel, nodes, c)?);
            }
            if action == "wait" {
                let needle = c["text"]
                    .as_str()
                    .filter(|t| !t.is_empty())
                    .ok_or("Missing wait text")?;
                let matching = matches_text(nodes, needle);
                return if matching != (c["gone"] == true) {
                    finish(json!({"matched":true}))
                } else {
                    Ok(Next::Again)
                };
            }
            let reference = target(c, panel)?;
            let node = if let Some(reference) = reference {
                Some(
                    nodes
                        .iter()
                        .find(|n| id(n) == Some(reference))
                        .ok_or("Browser element disappeared")?,
                )
            } else {
                None
            };
            match action {
                "type" | "press" if node.is_some() => {
                    let n = node.ok_or("Missing browser ref")?;
                    point(panel, Some(n))?;
                    if action == "type"
                        && (n["editable"] != true || n["readonly"] == true || n["password"] == true)
                    {
                        return Err("Browser ref is not a supported editable field".into());
                    }
                    let id = reference.ok_or("Missing browser ref")?;
                    send(Step::Focus(id), json!({"op":"ax-focus","node":id}))
                }
                "press" => press(c),
                "scroll" if node.is_none() => {
                    send(Step::Done("scrolled"), wheel(panel, point(panel, None)?, c))
                }
                "click" | "scroll" => {
                    let reference = reference.ok_or("Missing browser ref")?;
                    let point = point(panel, node)?;
                    let accept = nodes
                        .iter()
                        .enumerate()
                        .filter(|(i, n)| {
                            id(n) == Some(reference) || parents(nodes, *i).contains(&reference)
                        })
                        .filter_map(|(_, n)| id(n))
                        .collect();
                    send(
                        Step::Aim {
                            point,
                            nodes: accept,
                        },
                        json!({"op":"hit","x":point[0],"y":point[1]}),
                    )
                }
                _ => Err("Browser action is unsupported in this trial".into()),
            }
        }
        Step::Aim { point, nodes } => {
            if !response["hit"]
                .as_i64()
                .is_some_and(|id| nodes.contains(&id))
            {
                return Err("Browser element is covered or changed".into());
            }
            if action == "click" {
                send(Step::Done("clicked"), click(point, c))
            } else {
                send(Step::Done("scrolled"), wheel(panel, point, c))
            }
        }
        Step::Focus(node) => send(Step::Text(node), json!({"op":"ax"})),
        Step::Text(node) => {
            let field = tree(&response)?
                .iter()
                .find(|n| id(n) == Some(node) && n["focused"] == true)
                .ok_or("Browser field did not take focus")?;
            if action == "press" {
                return press(c);
            }
            let t = c["text"]
                .as_str()
                .filter(|s| s.len() <= 8_000)
                .ok_or("Invalid browser text length")?;
            let previous = field["value"]
                .as_str()
                .filter(|s| s.len() <= 8_000)
                .ok_or("Browser field value unavailable")?;
            send(
                Step::Value(node),
                json!({"op":"text","node":node,"text":t,"clear":c["clear"]!=false,"previous":previous}),
            )
        }
        Step::Value(node) => send(Step::Done("typed"), json!({"op":"ax","node":node})),
        Step::Done("typed") => {
            let expected = target(c, panel)?;
            let n = tree(&response)?
                .iter()
                .find(|n| id(n) == expected && n["focused"] == true)
                .ok_or("Browser field changed during typing")?;
            finish(json!({"value":n["value"]}))
        }
        Step::Done(key) => finish(json!({(key):true})),
        Step::Shot => {
            let data = response["png"]
                .as_str()
                .ok_or("Browser screenshot unavailable")?;
            finish(json!({"image":{"mimeType":"image/png","data":data}}))
        }
        Step::Wait => send(Step::Tree, json!({"op":"ax"})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waits_across_adjacent_ax_text_leaves_but_not_unrelated_nodes() {
        let nodes = json!([
            {"role":"text leaf","parent":1,"name":"React value: "},
            {"role":"text leaf","parent":1,"name":"Été React"},
            {"role":"text leaf","parent":2,"name":"another node"},
            {"role":"textbox","password":true,"value":"secret"},
        ]);
        let nodes = nodes.as_array().unwrap();
        assert!(matches_text(nodes, "React value: Été React"));
        assert!(!matches_text(nodes, "Reactanother"));
        assert!(!matches_text(nodes, "secret"));
    }
}
