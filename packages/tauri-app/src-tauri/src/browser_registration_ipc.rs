use crate::browser_controller::{
    BrowserController, BrowserTargetRegistration, ATTACHMENT_CONFLICT,
};
use crate::{embedded_view::diagnostics::preview_error, require_local_app_webview, AppState};
use serde::Deserialize;
use tauri::ipc::{Invoke, InvokeBody, InvokeResolver};
use tauri::{Manager, Runtime, Webview, Window};

#[derive(Deserialize)]
struct Arguments {
    payload: BrowserTargetRegistration,
}

pub(super) struct RegistrationRequest<R: Runtime> {
    pub(super) controller: BrowserController,
    pub(super) window: Window<R>,
    pub(super) payload: BrowserTargetRegistration,
    pub(super) renderer_version: u64,
}

pub(crate) fn with_registration(generated: impl Fn(Invoke) -> bool) -> impl Fn(Invoke) -> bool {
    route(
        generated,
        |webview| webview.state::<AppState>().browser_controller.clone(),
        |webview| require_local_app_webview(webview, &webview.state::<AppState>()).map(|_| ()),
        |resolver, request| {
            resolver.respond_async(async move {
                let result = tauri::async_runtime::spawn_blocking(move || {
                    request.controller.register(
                        &request.window,
                        request.payload,
                        request.renderer_version,
                    )
                })
                .await
                .map_err(|error| preview_error("dispatch registration", error))?;
                match result {
                    Ok(()) => Ok(true),
                    Err(error) if error == ATTACHMENT_CONFLICT => Ok(false),
                    Err(error) => Err(preview_error("register target", error).into()),
                }
            });
        },
    )
}

pub(super) fn route<R: Runtime>(
    generated: impl Fn(Invoke<R>) -> bool,
    controller: impl Fn(&Webview<R>) -> BrowserController,
    authorize: impl Fn(&Webview<R>) -> Result<(), String>,
    enqueue: impl Fn(InvokeResolver<R>, RegistrationRequest<R>),
) -> impl Fn(Invoke<R>) -> bool {
    move |invoke| {
        if invoke.message.command() != "browser_target_register" {
            return generated(invoke);
        }
        let webview = invoke.message.webview_ref();
        let request = (|| {
            let window = webview.window();
            if window.label() != webview.label() {
                return Err("Browser registration requires a primary renderer".into());
            }
            let controller = controller(webview);
            // Bind the request before sending any work to the async pool.
            let renderer_version = controller.renderer_version(webview.label())?;
            authorize(webview)?;
            let InvokeBody::Json(body) = invoke.message.payload() else {
                return Err("Expected a browser registration payload".into());
            };
            let Arguments { payload } =
                Arguments::deserialize(body).map_err(|error| error.to_string())?;
            Ok::<_, String>(RegistrationRequest {
                controller,
                window,
                payload,
                renderer_version,
            })
        })();
        match request {
            Ok(request) => enqueue(invoke.resolver, request),
            Err(error) => invoke.resolver.reject(error),
        }
        true
    }
}
