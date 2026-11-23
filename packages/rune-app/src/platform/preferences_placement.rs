use super::storage::Store;
use rune::{WindowHandle, WindowSpec};
use serde_json::{Value, json};
use std::sync::Mutex;

static LIVE: Mutex<Option<(WindowHandle, Store)>> = Mutex::new(None);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Frame {
    position: (i32, i32),
    dimensions: (u32, u32),
    maximized: bool,
}

impl Frame {
    fn decode(bytes: &[u8]) -> Option<Self> {
        let value: Value = serde_json::from_slice(bytes).ok()?;
        if value["version"].as_u64() != Some(1) {
            return None;
        }
        let [x, y] = value["position"].as_array()?.as_slice() else {
            return None;
        };
        let [w, h] = value["contentSize"].as_array()?.as_slice() else {
            return None;
        };
        let dimension = |raw: &Value| {
            let value = u32::try_from(raw.as_u64()?).ok()?;
            (1..=16_384).contains(&value).then_some(value)
        };
        Some(Self {
            position: (x.as_i64()?.try_into().ok()?, y.as_i64()?.try_into().ok()?),
            dimensions: (dimension(w)?, dimension(h)?),
            maximized: value["maximized"].as_bool()?,
        })
    }

    fn encode(self) -> Vec<u8> {
        json!({
            "version": 1,
            "position": self.position,
            "contentSize": self.dimensions,
            "maximized": self.maximized,
        })
        .to_string()
        .into_bytes()
    }
}

pub(super) fn open<S: 'static>(spec: WindowSpec<S>, store: Option<Store>) -> WindowHandle {
    let frame = store
        .as_ref()
        .and_then(Store::preferences_frame)
        .as_deref()
        .and_then(Frame::decode);
    let spec = match frame {
        Some(frame) => rune_theme_codenomad::settings::placed_window(
            spec,
            frame.position,
            frame.dimensions,
            frame.maximized,
        ),
        None => spec,
    };
    let window = rune::open_window(spec);
    if let Ok(mut live) = LIVE.lock() {
        *live = store.map(|store| (window.clone(), store));
    }
    window
}

pub(crate) fn closed() {
    let Some((window, store)) = LIVE.lock().ok().and_then(|mut live| live.take()) else {
        return;
    };
    let Some(placement) = window.placement() else {
        return;
    };
    if placement.full_screen || placement.minimized && placement.restore.is_none() {
        return;
    }
    let (position, dimensions) = placement
        .restore
        .unwrap_or((placement.position, placement.content_size));
    let bytes = Frame {
        position,
        dimensions,
        maximized: placement.maximized,
    }
    .encode();
    if Frame::decode(&bytes).is_some() {
        let _ = store.save_preferences_frame(&bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::Frame;

    #[test]
    fn validates_dimensions_and_keeps_negative_monitor_offsets() {
        let frame = Frame {
            position: (-1280, 32),
            dimensions: (960, 700),
            maximized: true,
        };
        assert_eq!(Frame::decode(&frame.encode()), Some(frame));
        assert!(Frame::decode(br#"{"version":2}"#).is_none());
        assert!(
            Frame::decode(
                br#"{"version":1,"position":[0,0],"contentSize":[0,760],"maximized":false}"#
            )
            .is_none()
        );
    }
}
