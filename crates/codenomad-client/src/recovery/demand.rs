use crate::{Receiver, Sender, bounded};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Target {
    #[default]
    Latest,
    Around(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reading {
    pub generation: u64,
    pub target: Option<Target>,
}

pub struct Demand {
    reading: Arc<Mutex<Reading>>,
    wake: Sender<()>,
}

pub struct Observer {
    reading: Arc<Mutex<Reading>>,
    wake: Receiver<()>,
}

pub fn open() -> (Demand, Observer) {
    let (send, receive) = bounded(1);
    let reading = Arc::new(Mutex::new(Reading {
        generation: 0,
        target: Some(Target::Latest),
    }));
    (
        Demand {
            reading: reading.clone(),
            wake: send,
        },
        Observer {
            reading,
            wake: receive,
        },
    )
}

impl Demand {
    pub fn publish(&self, target: Option<Target>) -> u64 {
        let generation = {
            let mut reading = self.reading.lock().unwrap();
            reading.generation = reading.generation.wrapping_add(1);
            reading.target = target;
            reading.generation
        };
        let _ = self.wake.try_send(());
        generation
    }
}

impl Observer {
    pub fn current(&self) -> Reading {
        self.reading.lock().unwrap().clone()
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.wake.is_closed()
    }

    /// A bounded wake channel carries demand, never content or mutations. Even a rapid
    /// hide/show invalidates any read issued by the older observation.
    pub async fn changed_after(&self, generation: u64) -> Option<Reading> {
        loop {
            let reading = self.current();
            if reading.generation != generation {
                return Some(reading);
            }
            self.wake.recv().await.ok()?;
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn rapid_suspend_and_resume_invalidates_a_read_even_with_a_full_wake_slot() {
    let (demand, observer) = open();
    let in_flight = observer.current();
    demand.publish(None);
    let resumed = demand.publish(Some(Target::Around("message-42".into())));
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let result = observer.changed_after(in_flight.generation).await.unwrap();
            assert_eq!(result.generation, resumed);
            assert_eq!(result.target, Some(Target::Around("message-42".into())));
            drop(demand);
            assert_eq!(observer.changed_after(resumed).await, None);
        });
}
