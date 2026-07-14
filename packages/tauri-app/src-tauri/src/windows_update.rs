use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[tauri::command]
pub fn install_stable_update() -> Result<(), String> {
    let mut command = Command::new("winget");
    command.args([
        "upgrade",
        "--exact",
        "--id",
        "NeuralNomadsAI.CodeNomad",
        "--source",
        "winget",
        "--silent",
        "--accept-source-agreements",
        "--accept-package-agreements",
        "--disable-interactivity",
    ]);

    #[cfg(windows)]
    command.creation_flags(0x08000000);

    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Unable to start the WinGet update: {err}"))
}
