//! A handler panic answers 500 and leaves the server usable, as an exception
//! does in the reference (audit I3). `Lock` keeps the shared inventories usable
//! after a panic while one was held; its `lock()` returns `Result<_, Infallible>`
//! so existing `lock().unwrap()` call sites stay unchanged.
use axum::{
    Json,
    extract::Request,
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use futures_util::FutureExt;
use std::{
    convert::Infallible,
    panic::AssertUnwindSafe,
    sync::{Mutex, MutexGuard, PoisonError},
};

#[derive(Default)]
pub struct Lock<T>(Mutex<T>);
impl<T> Lock<T> {
    pub fn new(value: T) -> Self {
        Self(Mutex::new(value))
    }
    pub fn lock(&self) -> Result<MutexGuard<'_, T>, Infallible> {
        Ok(self.0.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

pub async fn catch(request: Request, next: Next) -> Response {
    match AssertUnwindSafe(next.run(request)).catch_unwind().await {
        Ok(response) => response,
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error":"Internal server error"})))
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, extract::State, middleware, routing::get};
    use std::sync::Arc;

    #[tokio::test]
    async fn a_panic_under_the_inventory_lock_blocks_nothing() {
        let state = Arc::new(Lock::new(0u32));
        let app = Router::new()
            .route(
                "/panic",
                get(|State(s): State<Arc<Lock<u32>>>| async move {
                    let held = s.lock().unwrap();
                    if *held < u32::MAX {
                        panic!("expected test panic while holding the inventory");
                    }
                    "unreachable"
                }),
            )
            .route(
                "/count",
                get(|State(s): State<Arc<Lock<u32>>>| async move {
                    let mut n = s.lock().unwrap();
                    *n += 1;
                    n.to_string()
                }),
            )
            .layer(middleware::from_fn(catch))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let failed = client.get(format!("{base}/panic")).send().await.unwrap();
        assert_eq!(failed.status(), 500);
        assert!(state.0.is_poisoned());
        let next = client.get(format!("{base}/count")).send().await.unwrap();
        assert_eq!(next.status(), 200);
        assert_eq!(next.text().await.unwrap(), "1");
    }
}
