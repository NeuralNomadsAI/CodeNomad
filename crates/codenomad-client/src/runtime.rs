//! Executor and monotonic timer adapters; shared client tasks always yield.
use std::{future::Future, time::Duration};
pub use web_time::Instant;

#[cfg(not(target_arch = "wasm32"))]
pub fn spawn(task: impl Future<Output = ()> + Send + 'static) {
    tokio::spawn(task);
}
#[cfg(target_arch = "wasm32")]
pub fn spawn(task: impl Future<Output = ()> + 'static) {
    wasm_bindgen_futures::spawn_local(task);
}

#[cfg(not(target_arch = "wasm32"))]
pub async fn sleep(duration: Duration) {
    tokio::time::sleep(duration).await;
}
#[cfg(target_arch = "wasm32")]
pub async fn sleep(duration: Duration) {
    use wasm_bindgen::{JsCast, closure::Closure};
    struct Timer {
        window: web_sys::Window,
        id: i32,
        _callback: Closure<dyn FnMut()>,
    }
    impl Drop for Timer {
        fn drop(&mut self) {
            self.window.clear_timeout_with_handle(self.id);
        }
    }
    let window = web_sys::window().expect("browser window");
    let mut pending = None;
    let promise = js_sys::Promise::new(&mut |resolve, _reject| {
        let done: Closure<dyn FnMut()> = Closure::new(move || {
            let _ = resolve.call0(&wasm_bindgen::JsValue::NULL);
        });
        let id = window
            .set_timeout_with_callback_and_timeout_and_arguments_0(
                done.as_ref().unchecked_ref(),
                duration.as_millis().min(i32::MAX as u128) as i32,
            )
            .expect("browser timer");
        pending = Some(Timer {
            window: window.clone(),
            id,
            _callback: done,
        });
    });
    let _timer = pending;
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
}

pub async fn recv_timeout<T>(
    receiver: &async_channel::Receiver<T>,
    duration: Duration,
) -> Option<T> {
    futures_lite::future::race(async { receiver.recv().await.ok() }, async {
        sleep(duration).await;
        None
    })
    .await
}

pub async fn until_closed<T, U>(
    sender: &async_channel::Sender<T>,
    task: impl Future<Output = U>,
) -> Option<U> {
    futures_lite::future::race(async { Some(task.await) }, async {
        sender.closed().await;
        None
    })
    .await
}
