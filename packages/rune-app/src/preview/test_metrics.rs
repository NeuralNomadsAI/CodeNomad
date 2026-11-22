use serde_json::{Value, json};
use std::cell::RefCell;

#[derive(Default)]
pub struct Samples {
    pub read_us: Vec<u64>,
    pub receive_us: Vec<u64>,
}

static SAMPLES: std::sync::Mutex<RefCell<Samples>> = std::sync::Mutex::new(RefCell::new(Samples {
    read_us: Vec::new(), receive_us: Vec::new(),
}));

pub fn receive(frame: Value) {
    let (Some(at), Some(read)) = (frame["at"].as_u64(), frame["read_us"].as_u64()) else { return; };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d|d.as_micros() as u64);
    if let Ok(mut lock) = SAMPLES.lock() {
        let s = lock.get_mut();
        if s.read_us.len() < 18_000 {
            s.read_us.push(read);
            s.receive_us.push(now.saturating_sub(at));
        }
    }
}

pub fn take() -> Value {
    let mut lock = SAMPLES.lock().unwrap();
    let mut s = std::mem::take(lock.get_mut());
    let p95 = |v: &mut Vec<u64>| {
        v.sort_unstable();
        v.get((v.len() * 95).div_ceil(100).saturating_sub(1)).copied()
    };
    json!({"frames":s.read_us.len(),"read_p95_us":p95(&mut s.read_us),"receive_p95_us":p95(&mut s.receive_us)})
}
