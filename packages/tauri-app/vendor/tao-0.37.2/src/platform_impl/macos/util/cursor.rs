// Copyright 2014-2021 The winit contributors
// Copyright 2021-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0

use objc2::{msg_send, rc::Retained, runtime::Sel, AllocAnyThread, ClassType};
use objc2_app_kit::{NSCursor, NSImage};
use objc2_foundation::{ns_string, NSData, NSDictionary, NSNumber, NSObject, NSPoint, NSString};
use std::{ffi::CString, sync::OnceLock};

use crate::window::CursorIcon;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct CustomCursor(pub(crate) Retained<NSCursor>);

// SAFETY: NSCursor is immutable and thread-safe
// TODO(madsmtm): Put this logic in objc2-app-kit itself
unsafe impl Send for CustomCursor {}
unsafe impl Sync for CustomCursor {}

#[derive(Default)]
pub enum Cursor {
  #[default]
  Default,
  Native(&'static str),
  Undocumented(&'static str),
  WebKit(&'static str),
}

impl From<CursorIcon> for Cursor {
  fn from(cursor: CursorIcon) -> Self {
    // See native cursors at https://developer.apple.com/documentation/appkit/nscursor?language=objc.
    match cursor {
      CursorIcon::Default => Cursor::Default,
      CursorIcon::Arrow => Cursor::Native("arrowCursor"),
      CursorIcon::Hand => Cursor::Native("pointingHandCursor"),
      CursorIcon::Grab => Cursor::Native("openHandCursor"),
      CursorIcon::Grabbing => Cursor::Native("closedHandCursor"),
      CursorIcon::Text => Cursor::Native("IBeamCursor"),
      CursorIcon::VerticalText => Cursor::Native("IBeamCursorForVerticalLayout"),
      CursorIcon::Copy => Cursor::Native("dragCopyCursor"),
      CursorIcon::Alias => Cursor::Native("dragLinkCursor"),
      CursorIcon::NotAllowed | CursorIcon::NoDrop => Cursor::Native("operationNotAllowedCursor"),
      CursorIcon::ContextMenu => Cursor::Native("contextualMenuCursor"),
      CursorIcon::Crosshair => Cursor::Native("crosshairCursor"),
      CursorIcon::EResize => Cursor::Native("resizeRightCursor"),
      CursorIcon::NResize => Cursor::Native("resizeUpCursor"),
      CursorIcon::WResize => Cursor::Native("resizeLeftCursor"),
      CursorIcon::SResize => Cursor::Native("resizeDownCursor"),
      CursorIcon::EwResize | CursorIcon::ColResize => Cursor::Native("resizeLeftRightCursor"),
      CursorIcon::NsResize | CursorIcon::RowResize => Cursor::Native("resizeUpDownCursor"),

      // Undocumented cursors: https://stackoverflow.com/a/46635398/5435443
      CursorIcon::Help => Cursor::Undocumented("_helpCursor"),
      CursorIcon::ZoomIn => Cursor::Undocumented("_zoomInCursor"),
      CursorIcon::ZoomOut => Cursor::Undocumented("_zoomOutCursor"),
      CursorIcon::NeResize => Cursor::Undocumented("_windowResizeNorthEastCursor"),
      CursorIcon::NwResize => Cursor::Undocumented("_windowResizeNorthWestCursor"),
      CursorIcon::SeResize => Cursor::Undocumented("_windowResizeSouthEastCursor"),
      CursorIcon::SwResize => Cursor::Undocumented("_windowResizeSouthWestCursor"),
      CursorIcon::NeswResize => Cursor::Undocumented("_windowResizeNorthEastSouthWestCursor"),
      CursorIcon::NwseResize => Cursor::Undocumented("_windowResizeNorthWestSouthEastCursor"),

      // While these are available, the former just loads a white arrow,
      // and the latter loads an ugly deflated beachball!
      // CursorIcon::Move => Cursor::Undocumented("_moveCursor"),
      // CursorIcon::Wait => Cursor::Undocumented("_waitCursor"),

      // An even more undocumented cursor...
      // https://bugs.eclipse.org/bugs/show_bug.cgi?id=522349
      // This is the wrong semantics for `Wait`, but it's the same as
      // what's used in Safari and Chrome.
      CursorIcon::Wait | CursorIcon::Progress => Cursor::Undocumented("busyButClickableCursor"),

      // For the rest, we can just snatch the cursors from WebKit...
      // They fit the style of the native cursors, and will seem
      // completely standard to macOS users.
      // https://stackoverflow.com/a/21786835/5435443
      CursorIcon::Move | CursorIcon::AllScroll => Cursor::WebKit("move"),
      CursorIcon::Cell => Cursor::WebKit("cell"),
    }
  }
}

impl Cursor {
  pub unsafe fn load(&self) -> Option<Retained<NSCursor>> {
    match self {
      Cursor::Default => None,
      Cursor::Native(cursor_name) => {
        let sel = Sel::register(&CString::new(*cursor_name).unwrap());
        let cursor: Retained<NSCursor> = msg_send![class!(NSCursor), performSelector: sel];
        Some(cursor)
      }
      Cursor::Undocumented(cursor_name) => {
        let class = NSCursor::class();
        let sel = Sel::register(&CString::new(*cursor_name).unwrap());
        let sel = if msg_send![class, respondsToSelector: sel] {
          sel
        } else {
          warn!("Cursor `{cursor_name}` appears to be invalid");
          sel!(arrowCursor)
        };
        let cursor: Retained<NSCursor> = msg_send![class, performSelector: sel];
        Some(cursor)
      }
      Cursor::WebKit(cursor_name) => Some(load_webkit_cursor(&NSString::from_str(cursor_name))),
    }
  }
}

// Note that loading `busybutclickable` with this code won't animate
// the frames; instead you'll just get them all in a column.
unsafe fn load_webkit_cursor(name: &NSString) -> Retained<NSCursor> {
  // Snatch a cursor from WebKit; They fit the style of the native
  // cursors, and will seem completely standard to macOS users.
  //
  // https://stackoverflow.com/a/21786835/5435443
  let root = ns_string!(
    "/System/Library/Frameworks/ApplicationServices.framework/Versions/A/Frameworks/\
         HIServices.framework/Versions/A/Resources/cursors"
  );
  let cursor_path = root.stringByAppendingPathComponent(name);

  let pdf_path = cursor_path.stringByAppendingPathComponent(ns_string!("cursor.pdf"));
  let image = NSImage::initByReferencingFile(NSImage::alloc(), &pdf_path).unwrap();

  // TODO: Handle PLists better
  let info_path = cursor_path.stringByAppendingPathComponent(ns_string!("info.plist"));
  #[allow(deprecated)]
  let info: Retained<NSDictionary<NSObject, NSObject>> =
    unsafe { NSDictionary::dictionaryWithContentsOfFile(&info_path) }.unwrap();
  let mut x = 0.0;
  if let Some(n) = info.objectForKey(ns_string!("hotx")) {
    if let Ok(n) = n.downcast::<NSNumber>() {
      x = n.as_cgfloat();
    }
  }
  let mut y = 0.0;
  if let Some(n) = info.objectForKey(ns_string!("hoty")) {
    if let Ok(n) = n.downcast::<NSNumber>() {
      y = n.as_cgfloat();
    }
  }

  let hotspot = NSPoint::new(x, y);
  NSCursor::initWithImage_hotSpot(NSCursor::alloc(), &image, hotspot)
}

pub(crate) fn invisible_cursor() -> Retained<NSCursor> {
  // 16x16 GIF data for invisible cursor
  // You can reproduce this via ImageMagick.
  // $ convert -size 16x16 xc:none cursor.gif
  static CURSOR_BYTES: &[u8] = &[
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x10, 0x00, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
    0x10, 0x00, 0x10, 0x00, 0x00, 0x02, 0x0e, 0x84, 0x8f, 0xa9, 0xcb, 0xed, 0x0f, 0xa3, 0x9c, 0xb4,
    0xda, 0x8b, 0xb3, 0x3e, 0x05, 0x00, 0x3b,
  ];

  fn new_invisible() -> Retained<NSCursor> {
    // TODO: Consider using `dataWithBytesNoCopy:`
    let data = NSData::with_bytes(CURSOR_BYTES);
    let image = NSImage::initWithData(NSImage::alloc(), &data).unwrap();
    let hotspot = NSPoint::new(0.0, 0.0);
    NSCursor::initWithImage_hotSpot(NSCursor::alloc(), &image, hotspot)
  }

  // Cache this for efficiency
  static CURSOR: OnceLock<CustomCursor> = OnceLock::new();
  CURSOR
    .get_or_init(|| CustomCursor(new_invisible()))
    .0
    .clone()
}
