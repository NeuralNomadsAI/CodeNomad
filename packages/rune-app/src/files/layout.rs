#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Drawer {
    pub pinned: bool,
    pub width: f32,
    pub room: bool,
}
pub fn resolve(host: f32, wanted: bool) -> Drawer {
    let [desired, minimum, center] = rune_theme_codenomad::document_reader::drawer_geometry();
    let available = (host - center).max(0.0);
    let desired = desired.max(minimum);
    let room = available >= minimum;
    Drawer {
        room,
        pinned: wanted && room,
        width: if wanted && room {
            desired.min(available)
        } else {
            desired
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn right_only_source_layout_compresses_hides_and_redocks_without_changing_intent() {
        let source: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/reader-content.json")).unwrap();
        for case in source["layouts"].as_array().unwrap() {
            let actual = resolve(
                case["hostWidth"].as_f64().unwrap() as f32,
                case["wanted"].as_bool().unwrap(),
            );
            assert_eq!(actual.pinned, case["pinned"].as_bool().unwrap());
            assert_eq!(actual.width, case["width"].as_f64().unwrap() as f32);
        }
    }
}
