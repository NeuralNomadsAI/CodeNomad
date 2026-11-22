use std::future::Future;
use tauri::async_runtime::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Permission {
    Undetermined,
    Denied,
    Granted,
}

pub(super) trait Center {
    fn status(&self) -> impl Future<Output = Result<Permission, String>> + Send;
    fn request(&self) -> impl Future<Output = Result<Permission, String>> + Send;
}

#[derive(Default)]
pub(super) struct Authorization(Mutex<bool>);

impl Authorization {
    pub(super) async fn deliver(
        &self,
        center: &impl Center,
        send: impl FnOnce(),
    ) -> Result<bool, String> {
        let granted = self.permission(center, true).await? == Permission::Granted;
        if granted {
            send();
        }
        Ok(granted)
    }

    pub(super) async fn permission(
        &self,
        center: &impl Center,
        request: bool,
    ) -> Result<Permission, String> {
        if !request {
            return center.status().await;
        }
        // Settings and delivery share one prompt. After it closes, waiters read the OS decision.
        let mut attempted = self.0.lock().await;
        let status = center.status().await?;
        if status == Permission::Denied {
            *attempted = true;
        }
        if status != Permission::Undetermined || *attempted {
            return Ok(status);
        }
        *attempted = true;
        center.request().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::poll_fn,
        pin::{pin, Pin},
        sync::atomic::{AtomicUsize, Ordering},
        task::Poll,
    };
    use tauri::async_runtime::{block_on, channel, Receiver, Sender};

    struct StubCenter {
        status: std::sync::Mutex<Permission>,
        requests: AtomicUsize,
        started: Sender<()>,
        answer: Mutex<Receiver<Permission>>,
    }

    impl Center for StubCenter {
        async fn status(&self) -> Result<Permission, String> {
            Ok(*self.status.lock().unwrap())
        }

        async fn request(&self) -> Result<Permission, String> {
            self.requests.fetch_add(1, Ordering::Relaxed);
            self.started.try_send(()).unwrap();
            let decision = self.answer.lock().await.recv().await.unwrap();
            *self.status.lock().unwrap() = decision;
            Ok(decision)
        }
    }

    async fn assert_pending(mut future: Pin<&mut impl Future>) {
        poll_fn(|cx| {
            assert!(future.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
    }

    #[test]
    fn notification_first_use_coalesces_the_prompt_and_only_grants_delivery_on_consent() {
        block_on(async {
            for decision in [Permission::Granted, Permission::Denied] {
                let (started, mut seen) = channel(1);
                let (tx, answer) = channel(1);
                let center = StubCenter {
                    status: std::sync::Mutex::new(Permission::Undetermined),
                    requests: AtomicUsize::new(0),
                    started,
                    answer: Mutex::new(answer),
                };
                let auth = Authorization::default();
                assert_eq!(
                    auth.permission(&center, false).await.unwrap(),
                    Permission::Undetermined
                );
                assert_eq!(center.requests.load(Ordering::Relaxed), 0);
                let delivered = std::cell::Cell::new(0);
                let send = || delivered.set(delivered.get() + 1);
                let mut first = pin!(auth.deliver(&center, send));
                let mut second = pin!(auth.deliver(&center, send));
                let mut settings = pin!(auth.permission(&center, true));
                assert_pending(first.as_mut()).await;
                assert_eq!(seen.try_recv(), Ok(()));
                assert_pending(second.as_mut()).await;
                assert_pending(settings.as_mut()).await;
                assert_eq!(delivered.get(), 0);
                assert_eq!(center.requests.load(Ordering::Relaxed), 1);
                tx.try_send(decision).unwrap();
                drop(tx);
                let granted = decision == Permission::Granted;
                assert_eq!(first.await.unwrap(), granted);
                assert_eq!(second.await.unwrap(), granted);
                assert_eq!(settings.await.unwrap(), decision);
                assert_eq!(
                    Authorization::default()
                        .deliver(&center, send)
                        .await
                        .unwrap(),
                    granted
                );
                if !granted {
                    *center.status.lock().unwrap() = Permission::Undetermined;
                    assert!(!auth.deliver(&center, send).await.unwrap());
                }
                assert_eq!(delivered.get(), if granted { 3 } else { 0 });
                assert_eq!(center.requests.load(Ordering::Relaxed), 1);
            }
        });
    }
}
