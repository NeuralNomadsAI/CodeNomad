use super::viewport::{Canvas, Presentation, Viewport};
use super::*;
const MOBILE_UA: &str =
    "Mozilla/5.0 (Mobile) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile Safari/605.1.15";
fn profile(preset: &str) -> Result<(Option<Viewport>, f64), String> {
    if preset == "none" {
        return Ok((None, 0.0));
    }
    if !matches!(preset, "mobile" | "mobileLandscape") {
        return Err("Invalid browser emulation profile".into());
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Profiles {
        mobile: Viewport,
        device_scale_factor: f64,
    }
    let data: Profiles = serde_json::from_str(include_str!(
        "../../../ui/src/lib/native/browser-emulation.json"
    ))
    .map_err(|e| e.to_string())?;
    let size = if preset == "mobileLandscape" {
        Viewport {
            width: data.mobile.height,
            height: data.mobile.width,
        }
    } else {
        data.mobile
    };
    Ok((Some(size), data.device_scale_factor))
}
impl BrowserController {
    fn configure_webkit<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        registration: &Registration,
        canvas: Canvas,
        preset: &str,
    ) -> Result<(), String> {
        let primary = app
            .get_webview(&registration.window_label)
            .ok_or("Browser renderer is unavailable")?;
        let (scale, device) = crate::embedded_view::mobile::scale(&primary)?;
        let (target, density) = profile(preset)?;
        let layout = viewport::layout(canvas, scale, device, target)?;
        validate_bounds(layout.bounds)?;
        let view = app
            .get_webview(&registration.webview_label)
            .ok_or("Browser preview is unavailable")?;
        if self.owned_registration(&registration.window_label, &registration.registration_id)?
            != *registration
        {
            return Err("Browser target changed before emulation".into());
        }
        self.inner
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .page_leases
            .retain(|_, lease| lease.registration.registration_id != registration.registration_id);
        self.invalidate_page_for_generation(&registration.registration_id, registration.generation);
        crate::embedded_view::mobile::profile(
            &view,
            if preset == "none" { "" } else { MOBILE_UA },
            layout.zoom,
            density,
        )?;
        self.embedded_views.set_bounds(
            app,
            &registration.window_label,
            &registration.webview_label,
            layout.bounds,
        )?;
        if self.owned_registration(&registration.window_label, &registration.registration_id)?
            != *registration
        {
            return Err("Browser target changed during emulation".into());
        }
        Ok(())
    }
    pub(super) fn resize_webkit<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        registration: &Registration,
        bounds: BrowserTargetBounds,
        presentation: Option<Presentation>,
    ) -> Result<(), String> {
        let _lock = self.emulation_lock.lock().map_err(|e| e.to_string())?;
        let canvas = Canvas {
            bounds,
            presentation: presentation.unwrap_or_default(),
        };
        let (preset, previous) = {
            let inner = self.inner.0.lock().map_err(|e| e.to_string())?;
            (
                inner
                    .emulation_profiles
                    .get(&registration.registration_id)
                    .cloned()
                    .unwrap_or_else(|| "none".into()),
                inner.canvases.get(&registration.registration_id).copied(),
            )
        };
        if let Err(error) = self.configure_webkit(app, registration, canvas, &preset) {
            if let Some(previous) = previous {
                let _ = self.configure_webkit(app, registration, previous, &preset);
            }
            return Err(error);
        }
        let mut inner = self.inner.0.lock().map_err(|e| e.to_string())?;
        if inner.registrations.get(&registration.registration_id) != Some(registration) {
            return Err("Browser target changed before viewport publication".into());
        }
        inner
            .canvases
            .insert(registration.registration_id.clone(), canvas);
        Ok(())
    }
    pub(super) fn emulate(
        &self,
        app: &AppHandle,
        owner: &str,
        input: &BrowserTargetAction,
    ) -> Result<(), String> {
        let preset = input.preset.as_deref().unwrap_or("");
        profile(preset)?;
        if let Some(size) = input.viewport {
            viewport::validate(size)?;
        }
        let _lock = self.emulation_lock.lock().map_err(|e| e.to_string())?;
        let registration = self.owned_registration(owner, &input.registration_id)?;
        let (previous, canvas) = {
            let inner = self.inner.0.lock().map_err(|e| e.to_string())?;
            (
                inner
                    .emulation_profiles
                    .get(&input.registration_id)
                    .cloned()
                    .unwrap_or_else(|| "none".into()),
                *inner
                    .canvases
                    .get(&input.registration_id)
                    .ok_or("Browser viewport is unavailable")?,
            )
        };
        let mut next = canvas;
        next.presentation.viewport = input.viewport;
        if previous == preset && canvas.presentation == next.presentation {
            return Ok(());
        }
        if let Err(error) = self.configure_webkit(app, &registration, next, preset) {
            let _ = self.configure_webkit(app, &registration, canvas, &previous);
            return Err(error);
        }
        let view = app
            .get_webview(&registration.webview_label)
            .ok_or("Browser preview is unavailable")?;
        if let Err(error) = view.reload() {
            let _ = self.configure_webkit(app, &registration, canvas, &previous);
            return Err(error.to_string());
        }
        let mut inner = self.inner.0.lock().map_err(|e| e.to_string())?;
        if inner.registrations.get(&input.registration_id) != Some(&registration) {
            return Err("Browser target changed before emulation publication".into());
        }
        inner
            .emulation_profiles
            .insert(input.registration_id.clone(), preset.into());
        inner.canvases.insert(input.registration_id.clone(), next);
        Ok(())
    }
}
