//! One boolean of an owner in the reference's `config.yaml` (`yaml-doc-store.ts`), read and changed
//! in place: every other line, comment and owner stays byte for byte. Only the block style the
//! reference writes is understood (`owner:` then indented `key: value` lines, or `owner: {}`);
//! anything else is refused rather than rewritten.
use std::{fs, io, path::Path};

/// YAML 1.2 core booleans, as `yaml` reads them.
fn boolean(text: &str) -> Option<bool> {
    match text {
        "true" | "True" | "TRUE" => Some(true),
        "false" | "False" | "FALSE" => Some(false),
        _ => None,
    }
}

/// A `name: rest` line at `indent`, with its trailing comment removed.
fn entry(line: &str, indent: usize) -> Option<(&str, &str)> {
    let body = line.strip_prefix(&" ".repeat(indent))?;
    let (name, rest) = body.split_once(':')?;
    if name.is_empty() || name.starts_with([' ', '#', '-']) || !(rest.is_empty() || rest.starts_with(' ')) {
        return None;
    }
    let value = rest.split(" #").next().unwrap_or("").trim();
    Some((name, value))
}

struct Located {
    /// Line of `owner:`, if any, and whether it is the empty flow map `{}`.
    owner: Option<(usize, bool)>,
    /// Line, value and child indent of `key:` inside the owner block.
    key: Option<(usize, String)>,
    indent: usize,
}

fn locate(lines: &[&str], owner: &str, key: &str) -> Result<Located, ()> {
    let mut found = Located { owner: None, key: None, indent: 2 };
    let top = |l: &str| !l.trim().is_empty() && !l.starts_with([' ', '#']);
    for (i, line) in lines.iter().enumerate() {
        let Some((name, value)) = entry(line, 0).filter(|_| top(line)) else { continue };
        if name != owner {
            continue;
        }
        if found.owner.is_some() || !(value.is_empty() || value == "{}") {
            return Err(());
        }
        found.owner = Some((i, value == "{}"));
        let block = lines[i + 1..].iter().take_while(|l| !top(l)).collect::<Vec<_>>();
        if let Some(first) = block.iter().find(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#')) {
            found.indent = first.len() - first.trim_start().len();
            if value == "{}" || found.indent == 0 {
                return Err(());
            }
        }
        for (j, line) in block.iter().enumerate() {
            if let Some((_, value)) = entry(line, found.indent).filter(|(n, _)| *n == key) {
                if found.key.is_some() {
                    return Err(());
                }
                found.key = Some((i + 1 + j, value.to_owned()));
            }
        }
    }
    Ok(found)
}

/// `owner.key`: `None` when the file, the owner or the key is absent; refused when not a boolean.
pub fn read_bool(file: &Path, owner: &str, key: &str) -> Result<Option<bool>, ()> {
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    let lines: Vec<_> = text.lines().collect();
    match locate(&lines, owner, key)?.key {
        Some((_, value)) => boolean(&value).map(Some).ok_or(()),
        None => Ok(None),
    }
}

/// Sets `owner.key`, adding the owner or the key in the reference's layout when absent.
pub fn write_bool(file: &Path, owner: &str, key: &str, value: bool) -> io::Result<()> {
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = text.lines().map(str::to_owned).collect();
    let borrowed: Vec<&str> = lines.iter().map(String::as_str).collect();
    let refused = || io::Error::new(io::ErrorKind::InvalidData, "Unsupported config.yaml layout");
    let found = locate(&borrowed, owner, key).map_err(|_| refused())?;
    let child = format!("{}{key}: {value}", " ".repeat(found.indent));
    match (found.owner, found.key) {
        (_, Some((line, _))) => lines[line] = child,
        (Some((line, empty)), None) => {
            if empty {
                lines[line] = format!("{owner}:");
            }
            lines.insert(line + 1, child);
        }
        (None, None) => {
            lines.push(format!("{owner}:"));
            lines.push(child);
        }
    }
    let mut out = lines.join(newline);
    out.push_str(newline);
    crate::auth::tls::write_private(file, out.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edits_one_line_and_refuses_other_layouts() {
        let dir = std::env::temp_dir().join(format!("cnrs-config-yaml-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("config.yaml");
        let set = |text: &str, value| {
            fs::write(&file, text).unwrap();
            write_bool(&file, "server", "memoryEnabled", value).map(|_| fs::read_to_string(&file).unwrap())
        };
        assert_eq!(read_bool(&file, "server", "memoryEnabled"), Ok(None));
        let reference = "# kept\nserver:\n  opencodeBinary: \"C:\\\\x\\\\opencode.exe\"\n  sidecars:\n    - id: a\n      memoryEnabled: nope\nui:\n  settings:\n    locale: en # mine\n";
        let added = set(reference, true).unwrap();
        assert_eq!(added, reference.replace("server:\n", "server:\n  memoryEnabled: true\n"));
        assert_eq!(read_bool(&file, "server", "memoryEnabled"), Ok(Some(true)));
        assert_eq!(set(&added, false).unwrap(), added.replace("memoryEnabled: true", "memoryEnabled: false"));
        assert_eq!(set("ui:\r\n  a: 1\r\n", true).unwrap(), "ui:\r\n  a: 1\r\nserver:\r\n  memoryEnabled: true\r\n");
        assert_eq!(set("server: {}\nui: {}\n", true).unwrap(), "server:\n  memoryEnabled: true\nui: {}\n");
        assert_eq!(set("", true).unwrap(), "server:\n  memoryEnabled: true\n");
        fs::write(&file, "server:\n    memoryEnabled: TRUE # on\n").unwrap();
        assert_eq!(read_bool(&file, "server", "memoryEnabled"), Ok(Some(true)));
        for bad in [
            "server: {memoryEnabled: true}\n",
            "server:\n  memoryEnabled: yes\n",
            "server:\n  memoryEnabled: true\n  memoryEnabled: false\n",
            "server:\nserver:\n",
        ] {
            fs::write(&file, bad).unwrap();
            let read = read_bool(&file, "server", "memoryEnabled");
            let written = write_bool(&file, "server", "memoryEnabled", true);
            assert!(read.is_err() || written.is_err(), "{bad}");
            if written.is_err() {
                assert_eq!(fs::read_to_string(&file).unwrap(), bad);
            }
        }
        let _ = fs::remove_dir_all(dir);
    }
}
