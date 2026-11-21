//! The page engine (`page/protocol.ts`, `input.ts`, `actions.ts`): actions on refs over the closed
//! operation set, trusted input aimed like a user's, and its provenance mark in the app window.
use super::{
    input::{marked, Guard, Refusal, Target},
    keys,
    refs::RefTable,
    snapshot,
};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const VALUE_LIMIT: usize = 200;

/// A failure; `unsupported` crosses the engine's "best effort" catches, as the reference's
/// `PageDriverUnsupportedError` does.
#[derive(Debug)]
pub(crate) struct Fail {
    pub message: String,
    pub(super) unsupported: bool,
    pub(super) refusal: Option<Refusal>,
}
impl From<String> for Fail {
    fn from(message: String) -> Self {
        Self {
            message,
            unsupported: false,
            refusal: None,
        }
    }
}
impl From<&str> for Fail {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}
impl From<Refusal> for Fail {
    fn from(refusal: Refusal) -> Self {
        Self {
            message: refusal.message.clone(),
            unsupported: false,
            refusal: Some(refusal),
        }
    }
}
pub(super) type Result<T> = std::result::Result<T, Fail>;

/// One page: its operation transport, a checkpoint revalidating the target, and whether trusted
/// input carries the application's provenance mark (the app window only, never a preview).
pub(crate) struct Session<'a> {
    pub driver: &'static str,
    pub send: &'a dyn Fn(Value) -> std::result::Result<Value, String>,
    pub checkpoint: &'a dyn Fn() -> std::result::Result<(), String>,
    pub mark: bool,
    pub(crate) guard: Option<Guard<'a>>,
}

/// A target handle argument of a fixed function.
pub(crate) struct Handle(pub String);

impl Session<'_> {
    pub(super) fn run(&self, operation: Value) -> Result<Value> {
        let op = operation["op"].as_str().unwrap_or_default().to_string();
        let result = (self.send)(operation)?;
        if result["error"]["code"] == "unsupported" {
            let operation = result["error"]["operation"]
                .as_str()
                .map_or(op, str::to_owned);
            return Err(Fail {
                message: format!("{} page driver does not support {operation}", self.driver),
                unsupported: true,
                refusal: None,
            });
        }
        Ok(result)
    }
    pub(super) fn check(&self) -> Result<()> {
        Ok((self.checkpoint)()?)
    }
    pub(super) fn call(
        &self,
        function: &str,
        handle: Option<&str>,
        args: Vec<Value>,
    ) -> Result<Value> {
        let mut operation = json!({"op": "call", "function": function, "args": args});
        if let Some(handle) = handle {
            operation["handle"] = json!(handle);
        }
        self.run(operation)
    }
    /// Best effort, except an unsupported operation.
    fn lenient(&self, operation: Value) -> Result<Option<Value>> {
        match self.run(operation) {
            Err(fail) if fail.unsupported => Err(fail),
            result => Ok(result.ok()),
        }
    }
}

fn gone(reference: &str) -> Fail {
    format!("{reference} is no longer in the page; inspect again").into()
}

fn resolve(s: &Session, reference: &str, node: u64) -> Result<String> {
    let handle = match s.run(json!({"op": "resolve", "node": node})) {
        Err(fail) if fail.unsupported => return Err(fail),
        Err(_) => return Err(gone(reference)),
        Ok(result) => result["handle"].as_str().map(str::to_owned),
    };
    s.check()?;
    handle.ok_or_else(|| gone(reference))
}

enum Arg {
    Value(Value),
    Handle(Handle),
}

fn call_on(
    s: &Session,
    reference: &str,
    handle: &str,
    function: &str,
    args: Vec<Arg>,
    by_value: bool,
) -> Result<Value> {
    let args = args.into_iter().map(|arg| match arg {
        Arg::Value(value) => value,
        Arg::Handle(Handle(id)) => json!({"handle": id}),
    });
    let result = s.call(function, Some(handle), args.collect())?;
    if let Some(exception) = result.get("exception") {
        return Err(page_error(
            reference,
            exception.as_str().unwrap_or_default(),
        ));
    }
    s.check()?;
    if !by_value {
        return result["handle"]
            .as_str()
            .map(|h| json!(h))
            .ok_or_else(|| gone(reference));
    }
    Ok(result.get("value").cloned().unwrap_or(Value::Null))
}

fn page_error(reference: &str, description: &str) -> Fail {
    let line = description.split('\n').next().unwrap_or_default();
    let (code, detail) = line
        .find("codenomad:")
        .map(|at| {
            let rest = &line[at + 10..];
            let end = rest
                .find(|c: char| !(c.is_ascii_lowercase() || c == '-'))
                .unwrap_or(rest.len());
            let detail = rest[end..]
                .strip_prefix(':')
                .filter(|_| end > 0)
                .unwrap_or("");
            (
                &rest[..end],
                if rest[end..].starts_with(':') {
                    detail
                } else {
                    ""
                },
            )
        })
        .unwrap_or(("", ""));
    let quoted = snapshot::quote(&detail.chars().take(VALUE_LIMIT).collect::<String>());
    let r = reference;
    match code {
        "gone" => gone(r),
        "not-select" => format!("{r} is not a native select; click it to open its menu, then click the option").into(),
        "is-select" => format!("{r} is a native select; use select with its option labels").into(),
        "no-option" => format!("No option {quoted} in {r}; inspect it to see its options").into(),
        "options-changed" => format!("The options of {r} changed during focus; inspect again").into(),
        "delete-refused" => format!("The page refused to delete the selection in {r}").into(),
        "action-root" => "Page changed during action; inspect again".into(),
        "action-tab" => "The active tab changed during the action; inspect again".into(),
        "has-box" => format!("{r} now has a box; inspect before clicking").into(),
        "option-disabled" => format!("Option {quoted} of {r} is disabled").into(),
        "single" => format!("{r} takes exactly one value").into(),
        "disabled" => format!("{r} is disabled").into(),
        "readonly" => format!("{r} is read-only").into(),
        "not-editable" => format!("{r} is not a text field").into(),
        "not-text" => format!("{r} is not a text field; use click").into(),
        "unfocusable" => format!("{r} cannot take focus (hidden, disabled or behind a dialog); reveal it, then inspect again").into(),
        "invalid-value" => format!("{quoted} is not a valid value for {r}").into(),
        _ => format!("The page rejected the action on {r}: {}", line.chars().take(VALUE_LIMIT).collect::<String>()).into(),
    }
}

fn release_objects(s: &Session) {
    let _ = s.run(json!({"op": "release-handles"}));
}

#[derive(Clone, Copy)]
struct Point {
    x: f64,
    y: f64,
}

/// The point a user would click, or `None` for an element without a visible box.
fn aim(
    s: &Session,
    reference: &str,
    node: u64,
    scroll: bool,
    wheel: bool,
) -> Result<(Option<Point>, bool)> {
    if scroll {
        s.lenient(json!({"op": "scroll-into-view", "node": node}))?;
    }
    s.check()?;
    let geometry = s.run(json!({"op": "geometry", "node": node}))?;
    let quads = geometry["quads"]
        .as_array()
        .filter(|quads| {
            quads.iter().all(|q| {
                q.as_array()
                    .is_some_and(|q| q.len() == 8 && q.iter().all(Value::is_number))
            })
        })
        .ok_or("Invalid page geometry (content quads); inspect again")?;
    s.check()?;
    let (width, height) = viewport(s)?;
    let quad: Option<Vec<f64>> = quads.iter().find_map(|q| {
        let q: Vec<f64> = q
            .as_array()?
            .iter()
            .map(|n| n.as_f64().unwrap_or(f64::NAN))
            .collect();
        (q.len() == 8 && area(&q) >= 1.0).then_some(q)
    });
    let Some(q) = quad else {
        return Ok((None, quads.is_empty()));
    };
    // The visible part of the box, so a half-clipped element is aimed where it shows.
    let xs = [q[0], q[2], q[4], q[6]];
    let ys = [q[1], q[3], q[5], q[7]];
    let min = |v: [f64; 4]| v.into_iter().fold(f64::INFINITY, f64::min);
    let max = |v: [f64; 4]| v.into_iter().fold(f64::NEG_INFINITY, f64::max);
    let (left, right) = (min(xs).max(0.0), width.min(max(xs)));
    let (top, bottom) = (min(ys).max(0.0), height.min(max(ys)));
    if right - left < 1.0 || bottom - top < 1.0 {
        return Ok((None, false));
    }
    let point = Point {
        x: (left + right) / 2.0,
        y: (top + bottom) / 2.0,
    };
    assert_receives(s, reference, node, point, wheel)?;
    Ok((Some(point), false))
}

/// Refuses a point that another element covers, instead of acting on whatever is on top. Like
/// real events, hit testing passes through `pointer-events: none` layers.
fn assert_receives(
    s: &Session,
    reference: &str,
    node: u64,
    point: Point,
    wheel: bool,
) -> Result<()> {
    let hit = s.lenient(json!({"op": "hit-test", "x": point.x.floor(), "y": point.y.floor()}))?;
    s.check()?;
    let Some(hit) = hit
        .and_then(|r| r["node"].as_u64())
        .filter(|hit| *hit != node)
    else {
        return Ok(());
    };
    let target = resolve(s, reference, node)?;
    let Ok(other) = resolve(s, reference, hit) else {
        return Ok(());
    };
    let covered = call_on(
        s,
        reference,
        &target,
        if wheel { "receives-wheel" } else { "receives" },
        vec![Arg::Handle(Handle(other))],
        true,
    )?;
    match covered.as_str() {
        Some(by) => Err(format!(
            "{reference} is covered by {by}; close or move it first, then inspect again"
        )
        .into()),
        None => Ok(()),
    }
}

fn viewport(s: &Session) -> Result<(f64, f64)> {
    let result = s.run(json!({"op": "viewport"}))?;
    let side = |key: &str| result[key].as_f64().filter(|n| n.is_finite() && *n > 0.0);
    side("width")
        .zip(side("height"))
        .ok_or_else(|| "Invalid page viewport; inspect again".into())
}

fn area(q: &[f64]) -> f64 {
    let mut sum = 0.0;
    for i in 0..4 {
        let next = (i + 1) % 4;
        sum += q[i * 2] * q[next * 2 + 1] - q[next * 2] * q[i * 2 + 1];
    }
    sum.abs() / 2.0
}

fn at(point: Point, mut event: Value) -> Value {
    event["x"] = json!(point.x);
    event["y"] = json!(point.y);
    event
}

fn buttons(button: &str) -> u32 {
    match button {
        "right" => 2,
        "middle" => 4,
        _ => 1,
    }
}

fn click_at(s: &Session, point: Point, button: &str, target: Target) -> Result<()> {
    marked(s, |dispatch| {
        dispatch(
            "pointer",
            at(point, json!({"type": "mouseMoved"})),
            Some(target),
        )?;
        dispatch(
            "pointer",
            at(
                point,
                json!({"type": "mousePressed", "button": button, "buttons": buttons(button), "clickCount": 1}),
            ),
            Some(target),
        )?;
        dispatch(
            "pointer",
            at(
                point,
                json!({"type": "mouseReleased", "button": button, "buttons": 0, "clickCount": 1}),
            ),
            Some(target),
        )
    })
}

fn wheel_at(
    s: &Session,
    point: Option<Point>,
    dx: f64,
    dy: f64,
    target: Option<Target>,
) -> Result<()> {
    let point = match point {
        Some(point) => point,
        None => {
            let (w, h) = viewport(s)?;
            Point {
                x: w / 2.0,
                y: h / 2.0,
            }
        }
    };
    marked(s, |dispatch| {
        dispatch("pointer", at(point, json!({"type": "mouseMoved"})), target)?;
        dispatch(
            "wheel",
            at(
                point,
                json!({"type": "mouseWheel", "deltaX": dx, "deltaY": dy}),
            ),
            target,
        )
    })
}

/// A pointer drag in small steps, so pointer-based drag libraries pass their activation distance.
fn drag_between(
    s: &Session,
    from: Point,
    to: Point,
    source: Option<Target>,
    target: Option<Target>,
) -> Result<()> {
    marked(s, |dispatch| {
        dispatch("pointer", at(from, json!({"type": "mouseMoved"})), source)?;
        dispatch(
            "pointer",
            at(
                from,
                json!({"type": "mousePressed", "button": "left", "buttons": 1, "clickCount": 1}),
            ),
            source,
        )?;
        for step in 1..=10 {
            let p = Point {
                x: from.x + (to.x - from.x) * step as f64 / 10.0,
                y: from.y + (to.y - from.y) * step as f64 / 10.0,
            };
            dispatch(
                "pointer",
                at(
                    p,
                    json!({"type": "mouseMoved", "button": "left", "buttons": 1}),
                ),
                if step == 10 { target } else { None },
            )?;
        }
        dispatch(
            "pointer",
            at(
                to,
                json!({"type": "mouseReleased", "button": "left", "buttons": 0, "clickCount": 1}),
            ),
            target,
        )
    })
}

/// Polls the page for text, in its rendered text or in labels, titles, placeholders and values.
fn wait_for_text(s: &Session, text: &str, gone: bool, timeout: u64) -> Result<Value> {
    let started = Instant::now();
    loop {
        let root = s.call("document-root", None, vec![])?;
        s.check()?;
        let found = match root["handle"].as_str() {
            Some(handle) => {
                call_on(
                    s,
                    "the page",
                    handle,
                    "contains",
                    vec![Arg::Value(json!(text))],
                    true,
                )? == true
            }
            None => false,
        };
        let waited = started.elapsed().as_millis() as u64;
        if found != gone {
            return Ok(json!({"found": found, "waitedMs": waited}));
        }
        if waited >= timeout {
            let quoted = snapshot::quote(text);
            return Err(if gone {
                format!("{quoted} is still shown after {timeout} ms")
            } else {
                format!("{quoted} did not appear within {timeout} ms")
            }
            .into());
        }
        std::thread::sleep(Duration::from_millis(200.min(timeout - waited)));
    }
}

fn focused(s: &Session) -> Result<String> {
    let active = s.call("active-element", None, vec![])?;
    s.check()?;
    let handle = active["handle"].as_str().ok_or("Missing focused element")?;
    call_on(s, "the focused element", handle, "describe", vec![], true)?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "Invalid focus description".into())
}

/// JS `String(value)` of a page value.
fn string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.as_f64().map(snapshot::number).unwrap_or_default(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/// `snapshotPage`: the outline of the page or of one ref's subtree, with this generation's refs.
/// `window`: the app window names the departed ref, as its inspection does.
pub(crate) fn snapshot(
    s: &Session,
    refs: &mut RefTable,
    generation: &str,
    scope: &Value,
    window: bool,
) -> Result<(String, usize)> {
    let root = scope["ref"]
        .as_str()
        .map(|r| refs.resolve(r, generation))
        .transpose()?;
    let tree = s.run(json!({"op": "tree"}))?;
    s.check()?;
    let nodes = tree["nodes"].as_array().cloned().unwrap_or_default();
    refs.begin(generation);
    let options = snapshot::Options {
        root,
        query: scope["query"].as_str(),
        budget: None,
    };
    let mut issue = |node| refs.issue(generation, node);
    match snapshot::render(&nodes, &mut issue, &options) {
        Ok(out) => Ok((out.text, out.collapsed)),
        Err(snapshot::Gone) if window => Err(gone(scope["ref"].as_str().unwrap_or_default())),
        Err(snapshot::Gone) => Err("The element is no longer in the page; inspect again".into()),
    }
}

/// `performAction` for a command the backend validated; refs resolve before any page operation.
pub(crate) fn act(
    s: &Session,
    command: &Value,
    resolve_ref: &dyn Fn(&str) -> std::result::Result<u64, String>,
) -> Result<Value> {
    let target = |field: &str| -> Result<Option<(String, u64)>> {
        command[field]
            .as_str()
            .map(|r| Ok((r.to_string(), resolve_ref(r)?)))
            .transpose()
    };
    let out = (|| perform(s, command, target("ref")?, target("to")?))();
    release_objects(s);
    out
}

fn perform(
    s: &Session,
    command: &Value,
    main: Option<(String, u64)>,
    to: Option<(String, u64)>,
) -> Result<Value> {
    let missing = || Fail::from("Invalid page action");
    let pointer = |r: &str, n| {
        if s.guard.is_some() {
            resolve(s, r, n).map(Some)
        } else {
            Ok(None)
        }
    };
    let action = command["action"].as_str().unwrap_or_default();
    match action {
        "click" => {
            let (r, node) = main.ok_or_else(missing)?;
            let element = resolve(s, &r, node)?;
            let selected = call_on(s, &r, &element, "option-click", vec![], true)?;
            if let Some(selected) = selected.as_array() {
                return Ok(json!({"selected": selected.iter().map(string).collect::<Vec<_>>()}));
            }
            let button = command["button"].as_str();
            match aim(s, &r, node, true, false)? {
                (None, true) if button.is_some_and(|b| b != "left") => Err(format!(
                    "{r} has no visible box to {}-click",
                    button.unwrap_or_default()
                )
                .into()),
                (None, true) => {
                    call_on(s, &r, &element, "programmatic-click", vec![], true).map(|_| json!({}))
                }
                (None, false) => Err(format!("{r} has no visible box to click").into()),
                (Some(point), _) => click_at(
                    s,
                    point,
                    button.unwrap_or("left"),
                    Target::new(&r, &element),
                )
                .map(|()| json!({})),
            }
        }
        "type" => {
            let (r, node) = main.ok_or_else(missing)?;
            let element = resolve(s, &r, node)?;
            s.lenient(json!({"op": "scroll-into-view", "node": node}))?;
            s.check()?;
            let field = call_on(s, &r, &element, "field", vec![], false)?;
            let field = field.as_str().unwrap_or_default();
            let (text, clear) = (
                command["text"].as_str().unwrap_or_default(),
                command["clear"] != false,
            );
            let mode = call_on(
                s,
                &r,
                field,
                "prepare",
                vec![Arg::Value(json!(clear))],
                true,
            )?;
            if mode == "value" || mode == "append" {
                call_on(
                    s,
                    &r,
                    field,
                    "set-value",
                    vec![Arg::Value(json!(text)), Arg::Value(json!(mode == "append"))],
                    true,
                )?;
            } else if !text.is_empty() {
                marked(s, |dispatch| {
                    dispatch(
                        "insert-text",
                        json!({"text": text}),
                        Some(Target::new(&r, field)),
                    )
                })?;
            } else if clear {
                call_on(s, &r, field, "delete-selection", vec![], true)?;
            }
            let read = call_on(s, &r, field, "read-value", vec![], true).and_then(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "Invalid field value".into())
            });
            read.map(|value| json!({"value": value})).map_err(|error| {
                if text.is_empty() && !clear && mode != "value" && mode != "append" { error }
                else { "Text input was sent, but the field value could not be read; inspect before retrying.".into() }
            })
        }
        "select" => {
            let (r, node) = main.ok_or_else(missing)?;
            let element = resolve(s, &r, node)?;
            let chosen = call_on(
                s,
                &r,
                &element,
                "select",
                vec![Arg::Value(command["values"].clone())],
                true,
            )?;
            Ok(
                json!({"selected": chosen.as_array().into_iter().flatten().map(string).collect::<Vec<_>>()}),
            )
        }
        "hover" => {
            let (r, node) = main.ok_or_else(missing)?;
            let point = aim(s, &r, node, true, false)?
                .0
                .ok_or_else(|| Fail::from(format!("{r} has no visible box to hover")))?;
            let handle = pointer(&r, node)?;
            marked(s, |dispatch| {
                dispatch(
                    "pointer",
                    at(point, json!({"type": "mouseMoved"})),
                    handle.as_deref().map(|h| Target::new(&r, h)),
                )
            })
            .map(|()| json!({}))
        }
        "drag" => {
            let ((r, node), (to_ref, to_node)) =
                (main.ok_or_else(missing)?, to.ok_or_else(missing)?);
            let from = aim(s, &r, node, false, false)?.0;
            let to = aim(s, &to_ref, to_node, false, false)?.0;
            match (from, to) {
                (Some(from), Some(to)) => {
                    let source = pointer(&r, node)?;
                    let target = pointer(&to_ref, to_node)?;
                    drag_between(
                        s,
                        from,
                        to,
                        source.as_deref().map(|h| Target::new(&r, h)),
                        target.as_deref().map(|h| Target {
                            reference: &to_ref,
                            handle: h,
                            drag_source: source.as_deref(),
                        }),
                    )
                    .map(|()| json!({}))
                }
                (None, _) => Err(format!("{r} has no visible box to drag from").into()),
                (_, None) => Err(format!("{to_ref} has no visible box to drag to").into()),
            }
        }
        "scroll" => {
            let point = match &main {
                Some((r, node)) => Some(
                    aim(s, r, *node, true, true)?
                        .0
                        .ok_or_else(|| Fail::from(format!("{r} has no visible box to scroll")))?,
                ),
                None => None,
            };
            let direction = command["direction"].as_str().unwrap_or_default();
            let amount = command["amount"].as_f64().unwrap_or(600.0);
            let sign = if direction == "up" || direction == "left" {
                -1.0
            } else {
                1.0
            };
            let vertical = direction == "up" || direction == "down";
            let (dx, dy) = if vertical {
                (0.0, sign * amount)
            } else {
                (sign * amount, 0.0)
            };
            let handle = main
                .as_ref()
                .map(|(r, n)| pointer(r, *n))
                .transpose()?
                .flatten();
            let target = main
                .as_ref()
                .zip(handle.as_deref())
                .map(|((r, _), h)| Target::new(r, h));
            wheel_at(s, point, dx, dy, target).map(|()| json!({}))
        }
        "press" => {
            let handle = if let Some((r, node)) = &main {
                let element = resolve(s, r, *node)?;
                call_on(s, r, &element, "focus", vec![], true)?;
                Some(element)
            } else {
                None
            };
            let target = main
                .as_ref()
                .zip(handle.as_deref())
                .map(|((r, _), h)| Target::new(r, h));
            let events = keys::chord(
                command["key"].as_str().unwrap_or_default(),
                cfg!(target_os = "macos"),
            )?;
            marked(s, |dispatch| {
                events
                    .into_iter()
                    .try_for_each(|event| dispatch("keyboard", event, target))
            })?;
            focused(s).map(|focus| json!({"focused": focus})).map_err(|_| {
                "Key input was sent, but the current focus could not be read; inspect before retrying.".into()
            })
        }
        "wait" => wait_for_text(
            s,
            command["text"].as_str().unwrap_or_default(),
            command["gone"] == true,
            command["timeout"].as_u64().unwrap_or(5_000),
        ),
        _ => Err("Unsupported page action".into()),
    }
}
