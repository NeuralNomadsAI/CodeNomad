use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[tauri::command]
pub async fn install_stable_update(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    crate::require_preferences_or_local_app_window(&window, &state)?;
    install_stable_update_impl().await
}

pub(crate) async fn install_stable_update_impl() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
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

        let status = command
            .status()
            .map_err(|err| format!("Unable to start the WinGet update: {err}"))?;

        if status.success() {
            Ok(())
        } else {
            Err(format!("WinGet update failed with status {status}"))
        }
    })
    .await
    .map_err(|err| format!("Unable to monitor the WinGet update: {err}"))?
}
