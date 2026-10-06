use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(mobile)]
struct Recovery<R: Runtime>(tauri::plugin::PluginHandle<R>);

// Side-effect-free snapshot. Tokens are opaque platform document generations.
pub fn readiness<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<String, &'static str> {
    #[cfg(mobile)]
    {
        use tauri::Manager;
        let result: serde_json::Value = app
            .state::<Recovery<R>>()
            .0
            .run_mobile_plugin("readiness", ())
            .map_err(|_| "unsupported")?;
        if result.get("ready").and_then(|value| value.as_bool()) != Some(true) {
            return Err("unsupported");
        }
        result
            .get("generation")
            .and_then(|value| value.as_str())
            .map(str::to_owned)
            .ok_or("unsupported")
    }
    #[cfg(desktop)]
    {
        // Desktop compilation is a validation fixture, not a supported client.
        // Do not permit a hosted page without independent native recovery.
        let _ = app;
        Err("unsupported")
    }
}

// Only Rust invokes this; there are still no frontend plugin permissions.
pub fn connect<R: Runtime>(
    app: &tauri::AppHandle<R>,
    generation: &str,
    endpoint: &str,
) -> Result<(), &'static str> {
    #[cfg(mobile)]
    {
        use tauri::Manager;
        let result: serde_json::Value = app
            .state::<Recovery<R>>()
            .0
            .run_mobile_plugin(
                "connect",
                serde_json::json!({ "generation": generation, "endpoint": endpoint }),
            )
            .map_err(|_| "unavailable")?;
        if result.get("connected").and_then(|value| value.as_bool()) == Some(true) {
            Ok(())
        } else {
            Err("unavailable")
        }
    }
    #[cfg(desktop)]
    {
        let _ = (app, generation, endpoint);
        Err("unsupported")
    }
}

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_mobile_recovery);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mobile-recovery")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            let handle = _api
                .register_android_plugin("ai.neuralnomads.codenomad.recovery", "RecoveryPlugin")?;
            #[cfg(target_os = "ios")]
            let handle = _api.register_ios_plugin(init_plugin_mobile_recovery)?;
            #[cfg(mobile)]
            {
                use tauri::Manager;
                _app.manage(Recovery(handle));
            }
            Ok(())
        })
        .build()
}
