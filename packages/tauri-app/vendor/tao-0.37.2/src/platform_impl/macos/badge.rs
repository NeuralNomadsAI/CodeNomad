use objc2_app_kit::NSApp;
use objc2_foundation::{MainThreadMarker, NSString};

pub fn set_badge_label(label: Option<String>) {
  // SAFETY: TODO
  let mtm = unsafe { MainThreadMarker::new_unchecked() };
  let label = label.map(|label| NSString::from_str(&label));
  unsafe { NSApp(mtm).dockTile().setBadgeLabel(label.as_deref()) };
}
