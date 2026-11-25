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

fn placement_store(
    s: &crate::State,
    direct_directory: impl FnOnce() -> Option<std::path::PathBuf>,
) -> Option<Store> {
    if s.workspace.is_some() {
        return crate::workspace::native_window_store(s);
    }
    let directory = direct_directory()?;
    let store = super::block_on(Store::open(directory)).ok()?;
    Some(store)
}

pub(super) fn open<S: 'static>(spec: WindowSpec<S>, s: &crate::State) -> WindowHandle {
    let store = placement_store(s, super::storage::configured_directory);
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
    use super::*;

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

    #[test]
    fn direct_conversation_uses_the_explicit_profile_without_a_workspace() {
        let dir = std::env::temp_dir().join(format!(
            "rune-preferences-{}",
            codenomad_client::http::client_id().unwrap()
        ));
        let mut s = crate::init();
        let frame = Frame {
            position: (-800, 25),
            dimensions: (850, 700),
            maximized: false,
        };
        {
            let store = placement_store(&s, || Some(dir.clone())).unwrap();
            store.save_preferences_frame(&frame.encode()).unwrap();
            assert!(super::super::block_on(store.load()).unwrap().is_none());
        }
        let store = placement_store(&s, || Some(dir.clone())).unwrap();
        assert_eq!(
            Frame::decode(&store.preferences_frame().unwrap()),
            Some(frame)
        );
        drop(store);
        s.workspace = Some(crate::workspace::Ui::new());
        assert!(placement_store(&s, || panic!("workspace owns the directory")).is_none());
        std::fs::remove_file(dir.join("preferences.json")).unwrap();
        std::fs::remove_file(dir.join("state.lock")).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
