use super::{DESCRIPTION, Failure, Launch, command, install_file};
use base64::Engine;
use std::path::{Path, PathBuf};

const TASK: &str = "CodeNomad-OpenCode-Login";
const LAUNCHER: &str = "opencode-login-launcher.exe";

pub(super) fn wsl_launch(selection: &str) -> Result<Launch, Failure> {
    if super::super::launch::retired(selection) || selection.contains(['\0', '\n', '\r']) {
        return Err(Failure::Unsupported);
    }
    let normal = selection.trim().replace('/', "\\");
    let mut fields = normal.get(2..).ok_or(Failure::Unsupported)?.split('\\').filter(|s| !s.is_empty());
    fields.next().ok_or(Failure::Unsupported)?;
    let distro = fields.next().filter(|d| !d.starts_with('-')).ok_or(Failure::Unsupported)?;
    let path = fields.collect::<Vec<_>>().join("/");
    let system =
        std::env::var_os("SystemRoot").map(PathBuf::from).filter(|p| p.is_absolute()).ok_or(Failure::Unsupported)?;
    if path.is_empty() {
        return Err(Failure::Unsupported);
    }
    Ok(Launch {
        command: system.join(r"System32\wsl.exe").to_string_lossy().into_owned(),
        args: vec![
            "--distribution".into(),
            distro.into(),
            "--exec".into(),
            format!("/{path}"),
            "serve".into(),
            "--service".into(),
        ],
    })
}

pub(super) struct Owner {
    system: PathBuf,
    home: PathBuf,
    launcher: PathBuf,
}

impl Owner {
    pub fn host() -> Option<Self> {
        let system = PathBuf::from(std::env::var_os("SystemRoot")?);
        let home = PathBuf::from(std::env::var_os("USERPROFILE")?);
        let local = PathBuf::from(std::env::var_os("LOCALAPPDATA")?);
        if ![&system, &home, &local].iter().all(|p| p.is_absolute()) {
            return None;
        }
        Some(Self { system, home, launcher: local.join("CodeNomadOpenCodeLogin").join(LAUNCHER) })
    }

    async fn powershell(&self, script: &str) -> Result<String, Failure> {
        let root = self.system.join(r"System32\WindowsPowerShell\v1.0");
        let modules = root.join("Modules");
        let module = literal(&modules.join(r"ScheduledTasks\ScheduledTasks.psd1").to_string_lossy());
        let script = format!(
            "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';Import-Module {module};{script}"
        );
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(script.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>());
        let mut cmd = tokio::process::Command::new(root.join("powershell.exe"));
        cmd.env("PSModulePath", modules).args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded,
        ]);
        command(cmd, 30).await
    }

    async fn state(&self, effect: &str) -> Result<&'static str, Failure> {
        let script = format!(
            "function State {{ try {{ $t=Get-ScheduledTask -TaskPath '\\' -TaskName '{TASK}' -ErrorAction Stop }} catch {{ if ($_.CategoryInfo.Category -ne 'ObjectNotFound') {{ throw }}; return 'absent' }}; if ($t.Description -ceq '{DESCRIPTION}') {{ 'owned' }} else {{ 'foreign' }} }};{effect}State"
        );
        match self.powershell(&script).await?.as_str() {
            "owned" => Ok("owned"),
            "absent" => Ok("absent"),
            "foreign" => Ok("foreign"),
            _ => Err(Failure::Failed),
        }
    }

    pub async fn installed(&self) -> Result<bool, Failure> {
        Ok(self.state("").await? == "owned")
    }

    pub async fn install(&self, launch: &Launch) -> Result<(), Failure> {
        if self.state("").await? == "foreign" {
            return Err(Failure::Failed);
        }
        let sid = self.powershell("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value").await?;
        let xml = task(&sid, &self.launcher, &self.home, launch)?;
        let here = std::env::current_exe().map_err(|_| Failure::Failed)?;
        let dist = here.parent().ok_or(Failure::Failed)?.join("dist");
        let source = crate::config::plugin_assets()
            .map(PathBuf::from)
            .and_then(|assets| assets.parent().map(Path::to_path_buf))
            .unwrap_or(dist)
            .join("host-lifetime")
            .join(LAUNCHER);
        let bytes = std::fs::read(source).map_err(|_| Failure::Unavailable)?;
        if !std::fs::read(&self.launcher).is_ok_and(|old| old == bytes) {
            install_file(&self.launcher, &bytes)?;
        }
        let effect = format!(
            "if ((State) -eq 'foreign') {{ 'foreign'; exit 0 }};Register-ScheduledTask -TaskPath '\\' -TaskName '{TASK}' -Xml {} -Force | Out-Null;",
            literal(&xml)
        );
        if self.state(&effect).await? != "owned" {
            return Err(Failure::Failed);
        }
        Ok(())
    }

    pub async fn remove(&self) -> Result<(), Failure> {
        let effect = format!(
            "if ((State) -eq 'owned') {{ Unregister-ScheduledTask -TaskPath '\\' -TaskName '{TASK}' -Confirm:$false }};"
        );
        match self.state(&effect).await? {
            "owned" => Err(Failure::Failed),
            "absent" => {
                let _ = std::fs::remove_file(&self.launcher);
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

fn literal(text: &str) -> String {
    let mut output = String::from("'");
    for c in text.chars() {
        output.push(c);
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{201b}') {
            output.push(c);
        }
    }
    output.push('\'');
    output
}

fn argument(value: &str) -> String {
    if !value.is_empty() && !value.chars().any(|c| c.is_whitespace() || c == '"') {
        return value.to_owned();
    }
    let mut output = String::from("\"");
    let mut slash = 0;
    for c in value.chars() {
        if c == '\\' {
            slash += 1;
            continue;
        }
        output.extend(std::iter::repeat_n('\\', if c == '"' { 2 * slash + 1 } else { slash }));
        output.push(c);
        slash = 0;
    }
    output.extend(std::iter::repeat_n('\\', 2 * slash));
    output.push('"');
    output
}

fn task(sid: &str, launcher: &Path, home: &Path, launch: &Launch) -> Result<String, Failure> {
    let sid_pattern = regex::Regex::new(r"^S-1-\d+(?:-\d+)+$").unwrap();
    if !sid_pattern.is_match(sid) || !sid.is_ascii() {
        return Err(Failure::Failed);
    }
    let xml = |text: &str| text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
    let args = std::iter::once("--")
        .chain(std::iter::once(launch.command.as_str()))
        .chain(launch.args.iter().map(String::as_str))
        .map(argument)
        .collect::<Vec<_>>()
        .join(" ");
    let launcher = xml(&launcher.to_string_lossy());
    let home = xml(&home.to_string_lossy());
    let args = xml(&args);
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>{DESCRIPTION}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{sid}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>{sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>4</Priority></Settings>
  <Actions Context="Author"><Exec><Command>{launcher}</Command><Arguments>{args}</Arguments><WorkingDirectory>{home}</WorkingDirectory></Exec></Actions>
</Task>
"#
    ))
}

#[test]
fn task_is_user_scoped_and_does_not_interpret_the_command() {
    let launch =
        Launch { command: r"C:\Code & Files\opencode.exe".into(), args: vec!["serve".into(), "--service".into()] };
    let artifact =
        task("S-1-5-21-1234", Path::new(r"C:\Users\fixture\launcher.exe"), Path::new(r"C:\Users\fixture"), &launch)
            .unwrap();
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("../../tests/fixtures/login-start.json")).unwrap();
    assert_eq!(
        regex::Regex::new(r">\s+<").unwrap().replace_all(artifact.trim(), "><"),
        expected["windows"].as_str().unwrap()
    );
    assert!(task("not-a-sid", Path::new("x"), Path::new("y"), &launch).is_err());
    assert_eq!(literal("a'’b"), "'a''’’b'");
}

#[test]
fn wsl_uses_an_explicit_distro_and_executable_without_a_shell() {
    let launch = wsl_launch(r"\\wsl.localhost\Fixture distro\home\user\opencode").unwrap();
    assert!(launch.command.ends_with(r"System32\wsl.exe"));
    assert_eq!(
        launch.args,
        ["--distribution", "Fixture distro", "--exec", "/home/user/opencode", "serve", "--service"]
    );
    assert_eq!(wsl_launch(r"\\wsl.localhost\Fixture distro").err(), Some(Failure::Unsupported));
}
