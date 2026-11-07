//! Semantic input mapped to the already-qualified, target-local native adapters.
use serde_json::{json, Value};
use std::{
    ffi::{c_char, c_void, CString},
    sync::{Arc, Mutex},
};
extern "C" {
    fn cn_pointer(view: *mut c_void, action: i32, x: f64, y: f64, modifiers: u32) -> i32;
    fn cn_wheel(view: *mut c_void, x: f64, y: f64, dx: f64, dy: f64, modifiers: u32) -> i32;
    fn cn_key(view: *mut c_void, key: *const c_char, modifiers: u32, down: i32) -> i32;
    fn cn_text(view: *mut c_void, text: *const c_char) -> i32;
}
pub(crate) type Held = Arc<Mutex<Vec<(String, Value)>>>;
fn flags(event: &Value) -> u32 {
    let flags = event["modifiers"].as_u64().unwrap_or(0) as u32;
    ((flags & 8) >> 3) | (flags & 2) | ((flags & 1) << 2) | ((flags & 4) << 1)
}
fn key(value: &str) -> &str {
    match value {
        "Enter" => "Return",
        "Backspace" => "BackSpace",
        "ArrowUp" => "Up",
        "ArrowDown" => "Down",
        "ArrowLeft" => "Left",
        "ArrowRight" => "Right",
        "PageUp" => "Page_Up",
        "PageDown" => "Page_Down",
        "Shift" => "Shift_L",
        "Control" => "Control_L",
        "Alt" => "Alt_L",
        "Meta" => "Meta_L",
        "ContextMenu" => "Menu",
        other => other,
    }
}
pub(crate) unsafe fn dispatch(
    view: *mut c_void,
    operation: &Value,
    held: &Held,
) -> Result<(), String> {
    let event = &operation["event"];
    let kind = operation["op"].as_str().unwrap_or("");
    if kind == "pointer" && event["button"] == "middle" {
        return Err("Native middle-button input is unsupported".into());
    }
    let down = matches!(
        event["type"].as_str(),
        Some("mousePressed" | "keyDown" | "rawKeyDown")
    );
    let up = matches!(event["type"].as_str(), Some("mouseReleased" | "keyUp"));
    let identity = format!(
        "{kind}:{}",
        if kind == "pointer" {
            event["button"].as_str().unwrap_or("")
        } else {
            event["code"].as_str().unwrap_or("")
        }
    );
    {
        let mut held = held.lock().map_err(|error| error.to_string())?;
        if kind == "pointer" {
            for (_, release) in held.iter_mut().filter(|(_, item)| item["op"] == "pointer") {
                release["event"]["x"] = event["x"].clone();
                release["event"]["y"] = event["y"].clone();
            }
        }
        if down {
            if held.len() >= 64 && !held.iter().any(|(id, _)| id == &identity) {
                return Err("Too many held native inputs".into());
            }
            let mut release = operation.clone();
            release["event"]["type"] = json!(if kind == "pointer" {
                "mouseReleased"
            } else {
                "keyUp"
            });
            release["event"]["buttons"] = json!(0);
            release["event"]["modifiers"] = json!(0);
            if let Some(event) = release["event"].as_object_mut() {
                event.remove("text");
                event.remove("unmodifiedText");
            }
            held.retain(|(id, _)| id != &identity);
            held.push((identity.clone(), release));
        }
    }
    let number = |key: &str| event[key].as_f64().unwrap_or(0.0);
    let accepted = match kind {
        "pointer" => {
            let right = event["button"] == "right";
            let action = match event["type"].as_str() {
                Some("mousePressed") => {
                    if right {
                        3
                    } else {
                        1
                    }
                }
                Some("mouseReleased") => {
                    if right {
                        4
                    } else {
                        2
                    }
                }
                _ => {
                    if event["buttons"].as_u64().unwrap_or(0) & 1 != 0 {
                        5
                    } else {
                        0
                    }
                }
            };
            unsafe { cn_pointer(view, action, number("x"), number("y"), flags(event)) }
        }
        "wheel" => unsafe {
            cn_wheel(
                view,
                number("x"),
                number("y"),
                number("deltaX"),
                number("deltaY"),
                flags(event),
            )
        },
        "keyboard" => {
            let value = CString::new(key(event["key"].as_str().unwrap_or("")))
                .map_err(|_| "Invalid native key")?;
            unsafe { cn_key(view, value.as_ptr(), flags(event), i32::from(down)) }
        }
        "insert-text" => {
            let value = CString::new(operation["text"].as_str().unwrap_or(""))
                .map_err(|_| "Native text contains a NUL character")?;
            unsafe { cn_text(view, value.as_ptr()) }
        }
        _ => return Err("Unsupported native input operation".into()),
    };
    if accepted == 0 {
        return Err("Native browser input was refused".into());
    }
    if up {
        held.lock()
            .map_err(|error| error.to_string())?
            .retain(|(id, _)| id != &identity);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn semantic_modifiers_and_keys_match_native_adapters() {
        for (cdp, native) in [(0, 0), (1, 4), (2, 2), (4, 8), (8, 1), (15, 15)] {
            assert_eq!(flags(&json!({"modifiers":cdp})), native);
        }
        assert_eq!(key("Enter"), "Return");
        assert_eq!(key("Meta"), "Meta_L");
        assert_eq!(key("ArrowDown"), "Down");
    }
}
