use crate::{Error, Result};
use std::path::PathBuf;

/// Explicit execution-host environment; no profile/configuration or secrets in argv.
/// This value is a launch request, never a containment or authentication assertion.
#[derive(Clone)]
pub struct Command {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub directory: PathBuf,
    pub environment: Vec<(String, String)>,
}

fn wide(value: &str) -> Result<Vec<u16>> {
    if value.contains('\0') {
        return Err(Error("invalid-native-command"));
    }
    let mut result: Vec<u16> = value.encode_utf16().collect();
    result.push(0);
    Ok(result)
}

// CRT/CommandLineToArgvW quoting. Never a shell or verbatim command-string API.
fn quote(value: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        result.push_str(&"\\".repeat(if ch == '"' { slashes * 2 + 1 } else { slashes }));
        slashes = 0;
        result.push(ch);
    }
    result.push_str(&"\\".repeat(slashes * 2));
    result.push('"');
    result
}

pub(crate) struct Prepared {
    pub executable: Vec<u16>,
    pub line: Vec<u16>,
    pub directory: Vec<u16>,
    pub env: Vec<u16>,
}
impl Command {
    pub(crate) fn prepare(&self) -> Result<Prepared> {
        self.prepare_mode(false)
    }
    pub(crate) fn prepare_mode(&self, verbatim: bool) -> Result<Prepared> {
        let executable = self
            .executable
            .to_str()
            .ok_or(Error("invalid-native-command"))?;
        let directory = self
            .directory
            .to_str()
            .ok_or(Error("invalid-native-command"))?;
        if !self.executable.is_absolute()
            || !self.directory.is_absolute()
            || self.args.len() > 128
            || self.environment.len() > 512
            || executable.len() > 4096
            || directory.len() > 4096
        {
            return Err(Error("invalid-native-command"));
        }
        let mut line = if verbatim {
            executable.to_owned()
        } else {
            quote(executable)
        };
        for arg in &self.args {
            if arg.len() > 16384 {
                return Err(Error("native-command-too-large"));
            }
            line.push(' ');
            line.push_str(&if verbatim { arg.clone() } else { quote(arg) });
        }
        let line = wide(&line)?;
        if line.len() > 30000 {
            return Err(Error("native-command-too-large"));
        }
        let mut bytes = 0usize;
        for (key, value) in &self.environment {
            if key.len() > 32767 || value.len() > 131072 {
                return Err(Error("native-environment-too-large"));
            }
            bytes += key.len() + value.len();
            if bytes > 262144 {
                return Err(Error("native-environment-too-large"));
            }
        }
        let mut environment = self.environment.clone();
        environment.sort_by_key(|(key, _)| key.to_uppercase());
        let mut previous = None;
        let mut env = Vec::new();
        for (key, value) in environment {
            let folded = key.to_uppercase();
            if key.is_empty() || key.contains(['=', '\0']) || previous.as_ref() == Some(&folded) {
                return Err(Error("invalid-native-environment"));
            }
            previous = Some(folded);
            env.extend(wide(&format!("{key}={value}"))?);
            if env.len() > 131072 {
                return Err(Error("native-environment-too-large"));
            }
        }
        env.push(0);
        if env.len() == 1 {
            env.push(0);
        }
        Ok(Prepared {
            executable: wide(executable)?,
            directory: wide(directory)?,
            line,
            env,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quoting_is_not_shell_interpolation() {
        assert_eq!(quote(""), "\"\"");
        assert_eq!(quote("a\\"), "\"a\\\\\"");
        assert_eq!(quote("a\\\"b"), "\"a\\\\\\\"b\"");
        assert_eq!(quote("$(); & echo"), "\"$(); & echo\"");
    }
    #[test]
    fn rejects_nul_relative_overflow_and_duplicate_environment() {
        let mut command = Command {
            executable: "C:/Windows/System32/where.exe".into(),
            args: vec![],
            directory: "C:/Windows".into(),
            environment: vec![],
        };
        assert!(command.prepare().is_ok());
        command.args.push("bad\0arg".into());
        assert!(command.prepare().is_err());
        command.args = vec!["x".repeat(30001)];
        assert!(command.prepare().is_err());
        command.args.clear();
        command.executable = "relative".into();
        assert!(command.prepare().is_err());
        command.executable = "C:/Windows/System32/where.exe".into();
        command.environment = vec![("Path".into(), "one".into()), ("PATH".into(), "two".into())];
        assert!(command.prepare().is_err());
        command.environment = vec![("VALUE".into(), "x".repeat(131073))];
        assert_eq!(
            command.prepare().err(),
            Some(Error("native-environment-too-large"))
        );
    }
}
