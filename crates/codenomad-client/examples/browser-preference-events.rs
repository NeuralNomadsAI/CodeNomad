//! Browser regression probe: exercise the real EventSource and stream dispatch.
fn main() {}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub async fn observe(base: String) -> Result<(), wasm_bindgen::JsValue> {
    use codenomad_client::{
        backend::Backend, bounded, recovery::Input, runtime, settings::Owner, stream,
        transport::WorkspaceEvent,
    };
    use std::{sync::Arc, time::Duration};
    use wasm_bindgen::JsValue;

    let backend = Backend::connect(&base, "")
        .await
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let (out, inbox) = bounded(8);
    let wire = Arc::new(stream::State::default());
    stream::start(backend, 7, out, wire.clone());
    let result = async {
        for expected in ["open", "config", "git", "config", "git", "state", "closed"] {
            let input = runtime::recv_timeout(&inbox, Duration::from_secs(3)).await;
            let actual = match input {
                Some(Input::Opened(7)) => "open",
                Some(Input::Preferences(Owner::Config)) => "config",
                Some(Input::Workspace(7, WorkspaceEvent::UiPreferencesChanged)) => "git",
                Some(Input::Preferences(Owner::State)) => "state",
                Some(Input::Closed(7)) => "closed",
                Some(_) => "unexpected event",
                None => "timeout",
            };
            if actual != expected {
                return Err(JsValue::from_str(&format!(
                    "expected {expected}, got {actual}"
                )));
            }
        }
        Ok(())
    }
    .await;
    wire.cancel();
    result
}
