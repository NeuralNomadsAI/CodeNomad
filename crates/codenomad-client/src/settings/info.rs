use crate::{
    backend::{Backend, read_json_limited},
    history::Result,
};
use serde_json::Value;

pub async fn metadata(backend: &Backend) -> Result<Value> {
    let request = backend.client.get(format!("{}api/meta", backend.base));
    #[cfg(target_arch = "wasm32")]
    let request = request.fetch_cache_no_store();
    let response = request.send().await?.error_for_status()?;
    let meta = read_json_limited(response, 65536).await?;
    if !meta.is_object()
        || backend
            .client
            .server_identity()
            .is_some_and(|id| meta["serverId"] != id)
    {
        return Err("Host information belongs to another server".into());
    }
    Ok(meta)
}
