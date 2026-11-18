use super::*;

impl EmbeddedViews {
    pub(super) fn install_fullscreen_window<R: Runtime>(&self, window: &tauri::Window<R>) {
        let Ok(mut inner) = self.0.lock() else { return };
        if !inner.fullscreen_windows.insert(window.label().into()) {
            return;
        }
        drop(inner);
        let views = self.clone();
        let app = window.app_handle().clone();
        let label = window.label().to_string();
        window.on_window_event(move |event| match event {
            tauri::WindowEvent::Resized(size) => views.fit_fullscreen(&app, &label, *size),
            tauri::WindowEvent::Destroyed => {
                if let Ok(mut inner) = views.0.lock() {
                    inner.fullscreen_windows.remove(&label);
                }
            }
            _ => {}
        });
    }

    fn fit_fullscreen<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        window: &str,
        size: PhysicalSize<u32>,
    ) {
        let labels = self
            .0
            .lock()
            .map(|inner| {
                inner
                    .records
                    .iter()
                    .filter(|(_, record)| record.fullscreen.is_some())
                    .map(|(label, _)| label.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for label in labels {
            if let Some(view) = app
                .get_webview(&label)
                .filter(|view| view.window().label() == window)
            {
                let _ = view.set_position(PhysicalPosition::new(0, 0));
                let _ = view.set_size(size);
            }
        }
    }

    pub(super) fn set_fullscreen<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        label: &str,
        active: bool,
    ) -> Result<(), String> {
        let record = self
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .records
            .get(label)
            .cloned()
            .ok_or("Browser view unavailable")?;
        if !label.starts_with("browser-") || active == record.fullscreen.is_some() {
            return Ok(());
        }
        let view = app.get_webview(label).ok_or("Browser view unavailable")?;
        let window = view.window();
        let before = if active {
            window.is_fullscreen().map_err(|error| error.to_string())?
        } else {
            record.fullscreen.unwrap()
        };
        let normal = if active {
            view.position()
                .ok()
                .zip(view.size().ok())
                .filter(|(_, size)| size.width > 0 && size.height > 0)
                .map(|(position, size)| Bounds {
                    x: position.x,
                    y: position.y,
                    width: size.width,
                    height: size.height,
                })
        } else {
            None
        };
        {
            let mut inner = self.0.lock().map_err(|error| error.to_string())?;
            let current = inner
                .records
                .get_mut(label)
                .filter(|current| current.token == record.token)
                .ok_or("Browser view changed")?;
            current.fullscreen = active.then_some(before);
            if active {
                current.bounds = normal.or(record.bounds);
            }
        }
        if let Err(error) = window.set_fullscreen(active || before) {
            if let Ok(mut inner) = self.0.lock() {
                if let Some(current) = inner
                    .records
                    .get_mut(label)
                    .filter(|current| current.token == record.token)
                {
                    current.fullscreen = record.fullscreen;
                }
            }
            return Err(error.to_string());
        }
        if active {
            if let Ok(size) = window.inner_size() {
                self.fit_fullscreen(app, window.label(), size);
            }
        } else {
            // Host hide/close can end fullscreen before the engine's exit event.
            let _ =
                view.eval("if(document.fullscreenElement)document.exitFullscreen().catch(()=>{})");
            if let Some(bounds) = record.bounds {
                let _ = view.set_position(PhysicalPosition::new(bounds.x, bounds.y));
                let _ = view.set_size(PhysicalSize::new(bounds.width, bounds.height));
            }
        }
        Ok(())
    }
}
