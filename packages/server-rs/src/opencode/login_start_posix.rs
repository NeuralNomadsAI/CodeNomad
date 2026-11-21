use super::{DESCRIPTION, Failure, Launch, command, install_file};
use std::{io::ErrorKind, path::PathBuf};

const LABEL: &str = "org.codenomad.opencode-login";
const UNIT: &str = "codenomad-opencode-login.service";
const SYSTEMCTL: &str = "/usr/bin/systemctl";

pub(super) struct Owner {
    file: PathBuf,
    wanted: Option<PathBuf>,
}

impl Owner {
    pub fn host() -> Option<Self> {
        let home = PathBuf::from(std::env::var_os("HOME")?);
        if !home.is_absolute() {
            return None;
        }
        if cfg!(target_os = "macos") {
            return Some(Self { file: home.join("Library/LaunchAgents").join(format!("{LABEL}.plist")), wanted: None });
        }
        if cfg!(target_os = "linux")
            && std::path::Path::new(SYSTEMCTL).is_file()
            && std::env::var_os("WSL_DISTRO_NAME").is_none()
            && std::fs::read_to_string("/proc/sys/kernel/osrelease")
                .ok()
                .is_some_and(|release| !release.to_ascii_lowercase().contains("microsoft"))
        {
            let units = home.join(".config/systemd/user");
            return Some(Self { file: units.join(UNIT), wanted: Some(units.join("default.target.wants").join(UNIT)) });
        }
        None
    }

    fn content(&self) -> Result<Option<String>, Failure> {
        match std::fs::symlink_metadata(&self.file) {
            Ok(info) if info.is_file() && info.len() < 64 * 1024 => {
                std::fs::read_to_string(&self.file).map(Some).map_err(|_| Failure::Failed)
            }
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
            _ => Err(Failure::Failed),
        }
    }

    fn owns(&self, text: &str) -> bool {
        if self.wanted.is_some() {
            text.contains(&format!("Description={DESCRIPTION}\n"))
        } else {
            text.contains(&format!("<string>{LABEL}</string>"))
        }
    }

    fn linked(&self) -> bool {
        self.wanted.as_ref().is_none_or(|path| {
            std::fs::symlink_metadata(path).is_ok_and(|m| m.is_symlink())
                && dunce::canonicalize(path).ok().zip(dunce::canonicalize(&self.file).ok()).is_some_and(|(a, b)| a == b)
        })
    }

    pub async fn installed(&self) -> Result<bool, Failure> {
        Ok(self.content()?.is_some_and(|value| self.owns(&value)) && self.linked())
    }

    pub async fn install(&self, launch: &Launch) -> Result<(), Failure> {
        let existing = self.content()?;
        if existing.as_deref().is_some_and(|text| !self.owns(text)) {
            return Err(Failure::Failed);
        }
        let path = std::env::var("PATH").ok().filter(|p| !p.is_empty());
        let content =
            if self.wanted.is_some() { unit(launch, path.as_deref())? } else { plist(launch, path.as_deref())? };
        if existing.as_ref() != Some(&content) {
            install_file(&self.file, content.as_bytes())?;
        }
        if self.wanted.is_some() {
            systemctl(&["daemon-reload"]).await?;
            systemctl(&["enable", UNIT]).await?;
            if !self.linked() {
                return Err(Failure::Failed);
            }
        }
        Ok(())
    }

    pub async fn remove(&self) -> Result<(), Failure> {
        if !self.content()?.is_some_and(|text| self.owns(&text)) {
            return Ok(());
        }
        if let Some(wanted) = &self.wanted {
            let _ = systemctl(&["disable", UNIT]).await;
            if self.linked() {
                std::fs::remove_file(wanted).map_err(|_| Failure::Failed)?;
            }
        }
        std::fs::remove_file(&self.file).map_err(|_| Failure::Failed)?;
        if self.wanted.is_some() {
            let _ = systemctl(&["daemon-reload"]).await;
        }
        Ok(())
    }
}

async fn systemctl(args: &[&str]) -> Result<String, Failure> {
    let mut cmd = tokio::process::Command::new(SYSTEMCTL);
    cmd.arg("--user").args(args);
    command(cmd, 15).await
}

fn launch_words(launch: &Launch) -> impl Iterator<Item = &str> {
    std::iter::once(launch.command.as_str()).chain(launch.args.iter().map(String::as_str))
}

fn plist(launch: &Launch, path: Option<&str>) -> Result<String, Failure> {
    if launch_words(launch)
        .chain(path)
        .any(|s| s.chars().any(|c| matches!(c, '\u{0}'..='\u{8}' | '\u{b}'..='\u{1f}' | '\u{fffe}' | '\u{ffff}')))
    {
        return Err(Failure::Failed);
    }
    let xml = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let argv: String = launch_words(launch).map(|word| format!("<string>{}</string>", xml(word))).collect();
    let path = path
        .map(|path| {
            format!("\n  <key>EnvironmentVariables</key><dict><key>PATH</key><string>{}</string></dict>", xml(path))
        })
        .unwrap_or_default();
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key><array>{argv}</array>{path}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>Crashed</key><true/></dict>
</dict>
</plist>
"#
    ))
}

fn unit(launch: &Launch, path: Option<&str>) -> Result<String, Failure> {
    if launch_words(launch).chain(path).any(|s| s.contains(['\r', '\n', '\0'])) {
        return Err(Failure::Failed);
    }
    let escape = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"").replace('%', "%%");
    let argv =
        launch_words(launch).map(|s| format!("\"{}\"", escape(s).replace('$', "$$"))).collect::<Vec<_>>().join(" ");
    let path = path.map(|s| format!("Environment=\"PATH={}\"\n", escape(s))).unwrap_or_default();
    Ok(format!(
        "[Unit]\nDescription={DESCRIPTION}\n\n[Service]\nType=simple\n{path}ExecStart={argv}\nRestart=on-abnormal\nRestartPreventExitStatus=SIGKILL\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n"
    ))
}

#[test]
fn artifacts_quote_the_selected_image_and_only_keep_path() {
    let launch =
        Launch { command: "/home/u/Code & $files%/opencode".into(), args: vec!["serve".into(), "--service".into()] };
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("../../tests/fixtures/login-start.json")).unwrap();
    assert_eq!(unit(&launch, Some("/opt/code:/bin")).unwrap(), expected["linux"].as_str().unwrap());
    assert_eq!(plist(&launch, Some("/opt/code:/bin")).unwrap(), expected["macos"].as_str().unwrap());
    assert!(unit(&launch, Some("a\nb")).is_err());
}

#[tokio::test]
async fn launch_agent_changes_only_its_owned_file() {
    let root = crate::shared::test_dir("login-agent-fixture");
    let file = root.join("login.plist");
    let owner = Owner { file: file.clone(), wanted: None };
    let launch = Launch { command: "/fixture/opencode".into(), args: vec!["serve".into(), "--service".into()] };
    assert!(!owner.installed().await.unwrap());
    std::fs::write(&file, "<string>different.owner</string>").unwrap();
    assert_eq!(owner.install(&launch).await, Err(Failure::Failed));
    owner.remove().await.unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "<string>different.owner</string>");
    std::fs::remove_file(&file).unwrap();
    owner.install(&launch).await.unwrap();
    owner.install(&launch).await.unwrap();
    assert!(owner.installed().await.unwrap());
    owner.remove().await.unwrap();
    owner.remove().await.unwrap();
    assert!(!owner.installed().await.unwrap());
    std::fs::remove_dir(&root).unwrap();
}
