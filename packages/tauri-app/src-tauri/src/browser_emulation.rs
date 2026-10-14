use super::*;

impl BrowserController {
    pub(super) fn emulate(
        &self,
        app: &AppHandle,
        owner: &str,
        input: &BrowserTargetAction,
    ) -> Result<(), String> {
        let preset = input.preset.as_deref().unwrap_or("");
        profile(preset)?;
        // Never hold the controller state mutex while waiting for WebView2.
        let _admission = self
            .emulation_lock
            .try_lock()
            .map_err(|_| "Browser emulation is already changing".to_string())?;
        let registration = self.owned_registration(owner, &input.registration_id)?;
        let webview = app
            .get_webview(&registration.webview_label)
            .ok_or_else(|| "Browser preview is no longer available".to_string())?;
        let previous = self
            .inner
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .emulation_profiles
            .get(&input.registration_id)
            .cloned()
            .unwrap_or_else(|| "none".into());
        if previous == preset {
            return Ok(());
        }
        if let Err(error) = apply(&webview, preset) {
            apply(&webview, &previous)?;
            return Err(error);
        }
        let current = self.owned_registration(owner, &input.registration_id)?;
        if current.generation != registration.generation {
            return Err("Browser target changed before emulation".into());
        }
        self.inner
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .emulation_profiles
            .insert(input.registration_id.clone(), preset.into());
        webview.reload().map_err(|e| e.to_string())
    }
}

fn apply(webview: &tauri::Webview, preset: &str) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    let send = |method, params| cdp(webview, method, params, deadline).map(|_| ());
    if preset == "none" {
        send("Emulation.clearDeviceMetricsOverride", json!({}))?;
        send(
            "Emulation.setTouchEmulationEnabled",
            json!({ "enabled": false }),
        )?;
        send(
            "Emulation.setEmitTouchEventsForMouse",
            json!({ "enabled": false }),
        )?;
        return send("Emulation.setUserAgentOverride", json!({ "userAgent": "" }));
    }
    let profiles: Value = serde_json::from_str(include_str!(
        "../../../ui/src/lib/native/browser-emulation.json"
    ))
    .map_err(|e| e.to_string())?;
    let (size, landscape) = profile(preset)?.unwrap();
    let dimensions = &profiles[size];
    let width = &dimensions[if landscape { "height" } else { "width" }];
    let height = &dimensions[if landscape { "width" } else { "height" }];
    let version = cdp(webview, "Browser.getVersion", json!({}), deadline)?;
    let full_version = version["product"]
        .as_str()
        .and_then(|v| v.rsplit('/').next())
        .ok_or_else(|| "Chromium version is unavailable".to_string())?;
    send(
        "Emulation.setDeviceMetricsOverride",
        json!({
            "width": width, "height": height, "deviceScaleFactor": profiles["deviceScaleFactor"],
            "mobile": true, "screenWidth": width, "screenHeight": height,
            "screenOrientation": { "type": if landscape { "landscapePrimary" } else { "portraitPrimary" }, "angle": if landscape { 90 } else { 0 } }
        }),
    )?;
    send(
        "Emulation.setTouchEmulationEnabled",
        json!({ "enabled": true, "maxTouchPoints": 5 }),
    )?;
    send(
        "Emulation.setEmitTouchEventsForMouse",
        json!({ "enabled": true, "configuration": "mobile" }),
    )?;
    send(
        "Emulation.setUserAgentOverride",
        json!({
            "userAgent": profiles["userAgent"].as_str().unwrap().replace("{version}", full_version),
            "platform": "Linux armv8l",
            "userAgentMetadata": { "brands": [{ "brand": "Chromium", "version": full_version.split('.').next().unwrap() }],
                "fullVersion": full_version, "platform": "Android", "platformVersion": "11.0.0",
                "architecture": "", "model": "", "mobile": true }
        }),
    )
}

fn profile(preset: &str) -> Result<Option<(&str, bool)>, String> {
    if preset == "none" { return Ok(None); }
    let size = preset.strip_suffix("Landscape").unwrap_or(preset);
    if size != "mobile" {
        return Err("Invalid browser emulation profile".into());
    }
    Ok(Some((size, size != preset)))
}
