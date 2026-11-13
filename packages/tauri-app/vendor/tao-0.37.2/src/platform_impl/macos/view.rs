// Copyright 2014-2021 The winit contributors
// Copyright 2021-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
#![allow(unused_unsafe)]

use std::{
  cell::{Cell, RefCell},
  collections::{HashSet, VecDeque},
  os::raw::*,
  ptr,
  sync::{Arc, Mutex, Weak},
};

use objc2::{
  define_class, msg_send,
  rc::Retained,
  runtime::{AnyObject, Sel},
  AllocAnyThread, DefinedClass, MainThreadOnly,
};
use objc2_app_kit::{
  NSApp, NSEvent, NSEventModifierFlags, NSEventPhase, NSResponder, NSTextInputClient, NSView,
  NSWindow, NSWindowButton,
};
use objc2_foundation::{
  ns_string, MainThreadMarker, NSArray, NSAttributedString, NSAttributedStringKey, NSInteger,
  NSMutableAttributedString, NSNotificationCenter, NSObject, NSPoint, NSRange, NSRect, NSSize,
  NSString, NSUInteger,
};

use crate::{
  dpi::LogicalPosition,
  event::{
    DeviceEvent, ElementState, Event, MouseButton, MouseScrollDelta, TouchPhase, WindowEvent,
  },
  keyboard::{KeyCode, ModifiersState},
  platform_impl::platform::{
    app_state::AppState,
    event::{code_to_key, create_key_event, event_mods, get_scancode, EventWrapper},
    ffi::*,
    util::{self},
    window::get_window_id,
    DEVICE_ID,
  },
  window::WindowId,
};

pub struct CursorState {
  pub visible: bool,
  pub cursor: util::Cursor,
}

impl Default for CursorState {
  fn default() -> Self {
    Self {
      visible: true,
      cursor: Default::default(),
    }
  }
}

pub(super) struct ViewState {
  ns_window: objc2::rc::Weak<NSWindow>,
  marked_text: RefCell<Retained<NSMutableAttributedString>>,
  pub cursor_state: Arc<Mutex<CursorState>>,
  ime_spot: Cell<Option<(f64, f64)>>,

  /// This is true when we are currently modifying a marked text
  /// using ime. When the text gets commited, this is set to false.
  in_ime_preedit: Cell<bool>,

  /// This is used to detect if a key-press causes an ime event.
  /// If a key-press does not cause an ime event, that means
  /// that the key-press cancelled the ime session. (Except arrow keys)
  key_triggered_ime: Cell<bool>,
  // Not Needed Anymore
  //raw_characters: Option<String>,
  is_key_down: Cell<bool>,
  pub(super) modifiers: Cell<ModifiersState>,
  phys_modifiers: RefCell<HashSet<KeyCode>>,
  tracking_rect: Cell<Option<NSInteger>>,
  pub(super) traffic_light_inset: Cell<Option<LogicalPosition<f64>>>,
}

impl ViewState {
  fn get_scale_factor(&self) -> f64 {
    unsafe { NSWindow::backingScaleFactor(&self.ns_window.load().unwrap()) }
  }
}

pub(super) fn new_view(ns_window: &NSWindow) -> (Retained<TaoView>, Weak<Mutex<CursorState>>) {
  let cursor_state = Default::default();
  let cursor_access = Arc::downgrade(&cursor_state);
  let state = ViewState {
    ns_window: objc2::rc::Weak::from(ns_window),
    marked_text: RefCell::new(NSMutableAttributedString::new()),
    cursor_state,
    ime_spot: Cell::new(None),
    in_ime_preedit: Cell::new(false),
    key_triggered_ime: Cell::new(false),
    is_key_down: Cell::new(false),
    modifiers: Cell::new(Default::default()),
    phys_modifiers: Default::default(),
    tracking_rect: Cell::new(None),
    traffic_light_inset: Cell::new(None),
  };
  unsafe {
    let mtm = MainThreadMarker::from(ns_window);
    let this = TaoView::alloc(mtm).set_ivars(state);
    let this: Retained<TaoView> = msg_send![super(this), init];
    this.setPostsFrameChangedNotifications(true);
    NSNotificationCenter::defaultCenter().addObserver_selector_name_object(
      &this,
      sel!(frameDidChange:),
      Some(ns_string!("NSViewFrameDidChangeNotification")),
      Some(&this),
    );
    (this, cursor_access)
  }
}

pub unsafe fn set_ime_position(ns_view: &NSView, input_context: id, x: f64, y: f64) {
  let state = ns_view.downcast_ref::<TaoView>().unwrap().ivars();
  let content_rect = NSWindow::contentRectForFrameRect(
    &state.ns_window.load().unwrap(),
    NSWindow::frame(&state.ns_window.load().unwrap()),
  );
  let base_x = content_rect.origin.x;
  let base_y = content_rect.origin.y + content_rect.size.height;
  state.ime_spot.set(Some((base_x + x, base_y - y)));
  let _: () = msg_send![input_context, invalidateCharacterCoordinates];
}

fn is_arrow_key(keycode: KeyCode) -> bool {
  matches!(
    keycode,
    KeyCode::ArrowUp | KeyCode::ArrowDown | KeyCode::ArrowLeft | KeyCode::ArrowRight
  )
}

define_class!(
  #[unsafe(super(NSView, NSResponder, NSObject))]
  #[thread_kind = MainThreadOnly]
  #[ivars = ViewState]
  #[name = "TaoView"]
  pub(super) struct TaoView;

  /// AppKit view and responder callbacks.
  impl TaoView {
    #[unsafe(method(viewDidMoveToWindow))]
    fn view_did_move_to_window(&self) {
      trace!("Triggered `viewDidMoveToWindow`");
      unsafe {
        let state = self.ivars();

        if let Some(tracking_rect) = state.tracking_rect.take() {
          self.removeTrackingRect(tracking_rect);
        }

        let rect = self.visibleRect();
        let tracking_rect = self.addTrackingRect_owner_userData_assumeInside(
          rect,
          self,
          ptr::null_mut::<c_void>(),
          false,
        );
        state.tracking_rect.set(Some(tracking_rect));
      }
      trace!("Completed `viewDidMoveToWindow`");
    }

    #[unsafe(method(frameDidChange:))]
    fn frame_did_change(&self, _event: Option<&AnyObject>) {
      unsafe {
        let state = self.ivars();

        if let Some(tracking_rect) = state.tracking_rect.take() {
          self.removeTrackingRect(tracking_rect);
        }

        let rect = self.visibleRect();
        let tracking_rect = self.addTrackingRect_owner_userData_assumeInside(
          rect,
          self,
          ptr::null_mut::<c_void>(),
          false,
        );

        state.tracking_rect.set(Some(tracking_rect));
      }
    }

    #[unsafe(method(drawRect:))]
    fn draw_rect(&self, rect: NSRect) {
      unsafe {
        let state = self.ivars();

        if let Some(position) = state.traffic_light_inset.get() {
          let window = state.ns_window.load().unwrap();
          inset_traffic_lights(&window, position);
        }

        AppState::handle_redraw(WindowId(get_window_id(&state.ns_window.load().unwrap())));

        // This is a direct subclass of NSView, no need to call superclass' drawRect:
      }
    }

    #[unsafe(method(acceptsFirstResponder))]
    fn accepts_first_responder(&self) -> bool {
      true
    }

    // This is necessary to prevent a beefy terminal error on MacBook Pros:
    // IMKInputSession [0x7fc573576ff0 presentFunctionRowItemTextInputViewWithEndpoint:completionHandler:] : [self textInputContext]=0x7fc573558e10 *NO* NSRemoteViewController to client, NSError=Error Domain=NSCocoaErrorDomain Code=4099 "The connection from pid 0 was invalidated from this process." UserInfo={NSDebugDescription=The connection from pid 0 was invalidated from this process.}, com.apple.inputmethod.EmojiFunctionRowItem
    // TODO: Add an API extension for using `NSTouchBar`
    #[unsafe(method_id(touchBar))]
    fn touch_bar(&self) -> Option<Retained<NSObject>> {
      None
    }

    #[unsafe(method(resetCursorRects))]
    fn reset_cursor_rects(&self) {
      unsafe {
        let state = self.ivars();

        let bounds = self.bounds();
        let cursor_state = state.cursor_state.lock().unwrap();
        let cursor = if cursor_state.visible {
          cursor_state.cursor.load()
        } else {
          Some(util::invisible_cursor())
        };

        if let Some(cursor) = cursor {
          self.addCursorRect_cursor(bounds, &cursor);
        }
      }
    }

    #[unsafe(method(keyDown:))]
    fn key_down(&self, event: &NSEvent) {
      trace!("Triggered `keyDown`");
      unsafe {
        let state = self.ivars();
        let window_id = WindowId(get_window_id(&state.ns_window.load().unwrap()));

        // keyboard refactor: don't seems to be needed anymore
        // let characters = get_characters(event, false);
        //state.raw_characters = Some(characters);

        let is_repeat = event.isARepeat();

        update_potentially_stale_modifiers(state, event);

        let pass_along = !is_repeat || !state.is_key_down.get();
        if pass_along {
          // See below for why we do self.
          *self.ivars().marked_text.borrow_mut() = NSMutableAttributedString::new();
          state.key_triggered_ime.set(false);

          // Some keys (and only *some*, with no known reason) don't trigger `insertText`, while others do...
          // So, we don't give repeats the opportunity to trigger that, since otherwise our hack will cause some
          // keys to generate twice as many characters.
          self.interpretKeyEvents(&NSArray::from_slice(&[event]));
        }
        // The `interpretKeyEvents` above, may invoke `set_marked_text` or `insert_text`,
        // if the event corresponds to an IME event.
        let in_ime = state.key_triggered_ime.get();
        let key_event = create_key_event(event, true, is_repeat, in_ime, None);
        let is_arrow_key = is_arrow_key(key_event.physical_key);
        if pass_along {
          // The `interpretKeyEvents` above, may invoke `set_marked_text` or `insert_text`,
          // if the event corresponds to an IME event.
          // If `set_marked_text` or `insert_text` were not invoked, then the IME was deactivated,
          // and we should cancel the IME session.
          // When using arrow keys in an IME window, the input context won't invoke the
          // IME related methods, so in that case we shouldn't cancel the IME session.
          let is_preediting: bool = state.in_ime_preedit.get();
          if is_preediting && !state.key_triggered_ime.get() && !is_arrow_key {
            // In self case we should cancel the IME session.
            self.unmarkText();
            state.in_ime_preedit.set(false);
          }
        }
        let window_event = Event::WindowEvent {
          window_id,
          event: WindowEvent::KeyboardInput {
            device_id: DEVICE_ID,
            event: key_event,
            is_synthetic: false,
          },
        };
        AppState::queue_event(EventWrapper::StaticEvent(window_event));
      }
      trace!("Completed `keyDown`");
    }

    #[unsafe(method(keyUp:))]
    fn key_up(&self, event: &NSEvent) {
      trace!("Triggered `keyUp`");
      unsafe {
        let state = self.ivars();

        state.is_key_down.set(false);

        update_potentially_stale_modifiers(state, event);

        let window_event = Event::WindowEvent {
          window_id: WindowId(get_window_id(&state.ns_window.load().unwrap())),
          event: WindowEvent::KeyboardInput {
            device_id: DEVICE_ID,
            event: create_key_event(event, false, false, false, None),
            is_synthetic: false,
          },
        };
        AppState::queue_event(EventWrapper::StaticEvent(window_event));
      }
      trace!("Completed `keyUp`");
    }

    #[unsafe(method(flagsChanged:))]
    fn flags_changed(&self, ns_event: &NSEvent) {
      use KeyCode::{
        AltLeft, AltRight, ControlLeft, ControlRight, ShiftLeft, ShiftRight, SuperLeft, SuperRight,
      };

      trace!("Triggered `flagsChanged`");
      unsafe {
        let state = self.ivars();

        let scancode = get_scancode(ns_event);

        // We'll correct the `is_press` and the `key_override` below.
        let event = create_key_event(ns_event, false, false, false, Some(KeyCode::SuperLeft));
        let mut events = VecDeque::with_capacity(4);

        macro_rules! process_event {
          ($tao_flag:expr, $ns_flag:expr, $target_key:expr) => {
            let ns_event_contains_keymask = NSEvent::modifierFlags(ns_event).contains($ns_flag);
            let mut actual_key = KeyCode::from_scancode(scancode as u32);
            let was_pressed = state.phys_modifiers.borrow().contains(&actual_key);
            let mut is_pressed = ns_event_contains_keymask;
            let matching_keys;
            if actual_key == KeyCode::KeyA {
              // When switching keyboard layout using Ctrl+Space, the Ctrl release event
              // has `KeyA` as its keycode which would produce an incorrect key event.
              // To avoid self, we detect self scenario and override the key with one
              // that should be reasonable
              actual_key = $target_key;
              matching_keys = true;
            } else {
              matching_keys = actual_key == $target_key;
              if matching_keys && is_pressed && was_pressed {
                // If we received a modifier flags changed event AND the key that triggered
                // it was already pressed then this must mean that this event indicates the
                // release of that key.
                is_pressed = false;
              }
            }
            if matching_keys {
              if is_pressed != was_pressed {
                let mut event = event.clone();
                event.state = if is_pressed {
                  ElementState::Pressed
                } else {
                  ElementState::Released
                };
                event.physical_key = actual_key;
                event.logical_key = code_to_key(event.physical_key, scancode);
                events.push_back(WindowEvent::KeyboardInput {
                  device_id: DEVICE_ID,
                  event,
                  is_synthetic: false,
                });
                if is_pressed {
                  state.phys_modifiers.borrow_mut().insert($target_key);
                } else {
                  state.phys_modifiers.borrow_mut().remove(&$target_key);
                }
                if ns_event_contains_keymask {
                  state.modifiers.set(state.modifiers.get() | $tao_flag);
                } else {
                  state.modifiers.set(state.modifiers.get() & !$tao_flag);
                }
              }
            }
          };
        }
        process_event!(
          ModifiersState::SHIFT,
          NSEventModifierFlags::Shift,
          ShiftLeft
        );
        process_event!(
          ModifiersState::SHIFT,
          NSEventModifierFlags::Shift,
          ShiftRight
        );
        process_event!(
          ModifiersState::CONTROL,
          NSEventModifierFlags::Control,
          ControlLeft
        );
        process_event!(
          ModifiersState::CONTROL,
          NSEventModifierFlags::Control,
          ControlRight
        );
        process_event!(ModifiersState::ALT, NSEventModifierFlags::Option, AltLeft);
        process_event!(ModifiersState::ALT, NSEventModifierFlags::Option, AltRight);
        process_event!(
          ModifiersState::SUPER,
          NSEventModifierFlags::Command,
          SuperLeft
        );
        process_event!(
          ModifiersState::SUPER,
          NSEventModifierFlags::Command,
          SuperRight
        );

        let window_id = WindowId(get_window_id(&state.ns_window.load().unwrap()));

        for event in events {
          AppState::queue_event(EventWrapper::StaticEvent(Event::WindowEvent {
            window_id,
            event,
          }));
        }

        AppState::queue_event(EventWrapper::StaticEvent(Event::WindowEvent {
          window_id,
          event: WindowEvent::ModifiersChanged(state.modifiers.get()),
        }));
      }
      trace!("Completed `flagsChanged`");
    }

    #[unsafe(method(insertTab:))]
    fn insert_tab(&self, _sender: Option<&AnyObject>) {
      let window = self.window();
      if let Some(first_responder) = window.firstResponder() {
        if *first_responder == ***self {
          window.selectNextKeyView(Some(self))
        }
      }
    }

    #[unsafe(method(insertBackTab:))]
    fn insert_back_tab(&self, _sender: Option<&AnyObject>) {
      let window = self.window();
      if let Some(first_responder) = window.firstResponder() {
        if *first_responder == ***self {
          window.selectPreviousKeyView(Some(self))
        }
      }
    }

    // Allows us to receive Cmd-. (the shortcut for closing a dialog)
    // https://bugs.eclipse.org/bugs/show_bug.cgi?id=300620#c6
    #[unsafe(method(cancelOperation:))]
    fn cancel_operation(&self, _sender: Option<&AnyObject>) {
      trace!("Triggered `cancelOperation`");
      unsafe {
        let mtm = MainThreadMarker::new_unchecked();
        let state = self.ivars();

        let event = NSApp(mtm).currentEvent().unwrap();
        update_potentially_stale_modifiers(state, &event);

        let scancode = 0x2f;
        let key = KeyCode::from_scancode(scancode);
        debug_assert_eq!(key, KeyCode::Period);

        let window_event = Event::WindowEvent {
          window_id: WindowId(get_window_id(&state.ns_window.load().unwrap())),
          event: WindowEvent::KeyboardInput {
            device_id: DEVICE_ID,
            event: create_key_event(&event, true, false, false, Some(key)),
            is_synthetic: false,
          },
        };
        AppState::queue_event(EventWrapper::StaticEvent(window_event));
      }
      trace!("Completed `cancelOperation`");
    }

    #[unsafe(method(mouseDown:))]
    fn mouse_down(&self, event: &NSEvent) {
      mouse_motion(self, event);
      mouse_click(self, event, MouseButton::Left, ElementState::Pressed);
    }

    #[unsafe(method(mouseUp:))]
    fn mouse_up(&self, event: &NSEvent) {
      mouse_motion(self, event);
      mouse_click(self, event, MouseButton::Left, ElementState::Released);
    }

    #[unsafe(method(rightMouseDown:))]
    fn right_mouse_down(&self, event: &NSEvent) {
      mouse_motion(self, event);
      mouse_click(self, event, MouseButton::Right, ElementState::Pressed);
    }

    #[unsafe(method(rightMouseUp:))]
    fn right_mouse_up(&self, event: &NSEvent) {
      mouse_motion(self, event);
      mouse_click(self, event, MouseButton::Right, ElementState::Released);
    }

    #[unsafe(method(otherMouseDown:))]
    fn other_mouse_down(&self, event: &NSEvent) {
      mouse_motion(self, event);
      mouse_click(self, event, MouseButton::Middle, ElementState::Pressed);
    }

    #[unsafe(method(otherMouseUp:))]
    fn other_mouse_up(&self, event: &NSEvent) {
      mouse_motion(self, event);
      mouse_click(self, event, MouseButton::Middle, ElementState::Released);
    }

    #[unsafe(method(mouseMoved:))]
    fn mouse_moved(&self, event: &NSEvent) {
      mouse_motion(self, event);
    }

    #[unsafe(method(mouseDragged:))]
    fn mouse_dragged(&self, event: &NSEvent) {
      mouse_motion(self, event);
    }

    #[unsafe(method(rightMouseDragged:))]
    fn right_mouse_dragged(&self, event: &NSEvent) {
      mouse_motion(self, event);
    }

    #[unsafe(method(otherMouseDragged:))]
    fn other_mouse_dragged(&self, event: &NSEvent) {
      mouse_motion(self, event);
    }

    #[unsafe(method(mouseEntered:))]
    fn mouse_entered(&self, _event: id) {
      trace!("Triggered `mouseEntered`");
      unsafe {
        let state = self.ivars();

        let enter_event = Event::WindowEvent {
          window_id: WindowId(get_window_id(&state.ns_window.load().unwrap())),
          event: WindowEvent::CursorEntered {
            device_id: DEVICE_ID,
          },
        };

        AppState::queue_event(EventWrapper::StaticEvent(enter_event));
      }
      trace!("Completed `mouseEntered`");
    }

    #[unsafe(method(mouseExited:))]
    fn mouse_exited(&self, _event: id) {
      trace!("Triggered `mouseExited`");
      unsafe {
        let state = self.ivars();

        let window_event = Event::WindowEvent {
          window_id: WindowId(get_window_id(&state.ns_window.load().unwrap())),
          event: WindowEvent::CursorLeft {
            device_id: DEVICE_ID,
          },
        };

        AppState::queue_event(EventWrapper::StaticEvent(window_event));
      }
      trace!("Completed `mouseExited`");
    }

    #[unsafe(method(scrollWheel:))]
    fn scroll_wheel(&self, event: &NSEvent) {
      trace!("Triggered `scrollWheel`");

      mouse_motion(self, event);

      unsafe {
        let state = self.ivars();

        let delta = {
          // macOS horizontal sign convention is the inverse of tao.
          let (x, y) = (-event.scrollingDeltaX(), event.scrollingDeltaY());
          if event.hasPreciseScrollingDeltas() {
            let delta = LogicalPosition::new(x, y).to_physical(state.get_scale_factor());
            MouseScrollDelta::PixelDelta(delta)
          } else {
            MouseScrollDelta::LineDelta(x as f32, y as f32)
          }
        };
        let phase = match event.phase() {
          NSEventPhase::MayBegin | NSEventPhase::Began => TouchPhase::Started,
          NSEventPhase::Ended => TouchPhase::Ended,
          _ => TouchPhase::Moved,
        };

        let device_event = Event::DeviceEvent {
          device_id: DEVICE_ID,
          event: DeviceEvent::MouseWheel { delta },
        };

        let state = self.ivars();

        update_potentially_stale_modifiers(state, event);

        let window_event = Event::WindowEvent {
          window_id: WindowId(get_window_id(&state.ns_window.load().unwrap())),
          event: WindowEvent::MouseWheel {
            device_id: DEVICE_ID,
            delta,
            phase,
            modifiers: event_mods(event),
          },
        };

        AppState::queue_event(EventWrapper::StaticEvent(device_event));
        AppState::queue_event(EventWrapper::StaticEvent(window_event));
      }
      trace!("Completed `scrollWheel`");
    }

    #[unsafe(method(pressureChangeWithEvent:))]
    fn pressure_change_with_event(&self, event: &NSEvent) {
      trace!("Triggered `pressureChangeWithEvent`");

      mouse_motion(self, event);

      unsafe {
        let state = self.ivars();

        let pressure = event.pressure();
        let stage = event.stage();

        let window_event = Event::WindowEvent {
          window_id: WindowId(get_window_id(&state.ns_window.load().unwrap())),
          event: WindowEvent::TouchpadPressure {
            device_id: DEVICE_ID,
            pressure,
            stage: stage as i64,
          },
        };

        AppState::queue_event(EventWrapper::StaticEvent(window_event));
      }
      trace!("Completed `pressureChangeWithEvent`");
    }

    // Allows us to receive Ctrl-Tab and Ctrl-Esc.
    // Note that this *doesn't* help with any missing Cmd inputs.
    // https://github.com/chromium/chromium/blob/a86a8a6bcfa438fa3ac2eba6f02b3ad1f8e0756f/ui/views/cocoa/bridged_content_view.mm#L816
    #[unsafe(method(_wantsKeyDownForEvent:))]
    fn wants_key_down_for_event(&self, _event: Option<&NSEvent>) -> bool {
      true
    }

    #[unsafe(method(acceptsFirstMouse:))]
    fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
      true
    }
  }

  unsafe impl NSTextInputClient for TaoView {
    #[unsafe(method(hasMarkedText))]
    fn has_marked_text(&self) -> bool {
      unsafe {
        trace!("Triggered `hasMarkedText`");
        let marked_text = self.ivars().marked_text.borrow();
        trace!("Completed `hasMarkedText`");
        marked_text.length() > 0
      }
    }

    #[unsafe(method(markedRange))]
    fn marked_range(&self) -> NSRange {
      unsafe {
        trace!("Triggered `markedRange`");
        let marked_text = self.ivars().marked_text.borrow();
        let length = marked_text.length();
        trace!("Completed `markedRange`");
        if length > 0 {
          NSRange::new(0, length - 1)
        } else {
          util::EMPTY_RANGE
        }
      }
    }

    #[unsafe(method(selectedRange))]
    fn selected_range(&self) -> NSRange {
      trace!("Triggered `selectedRange`");
      trace!("Completed `selectedRange`");
      util::EMPTY_RANGE
    }

    /// An IME pre-edit operation happened, changing the text that's
    /// currently being pre-edited. This more or less corresponds to
    /// the `compositionupdate` event on the web.
    #[unsafe(method(setMarkedText:selectedRange:replacementRange:))]
    fn set_marked_text(
      &self,
      string: &AnyObject,
      _selected_range: NSRange,
      _replacement_range: NSRange,
    ) {
      trace!("Triggered `setMarkedText`");
      unsafe {
        let marked_text = if let Some(string) = string.downcast_ref::<NSAttributedString>() {
          NSMutableAttributedString::initWithAttributedString(
            NSMutableAttributedString::alloc(),
            string,
          )
        } else {
          NSMutableAttributedString::initWithString(
            NSMutableAttributedString::alloc(),
            string
              .downcast_ref::<NSString>()
              .expect("expected NSString or NSAttributedString"),
          )
        };
        *self.ivars().marked_text.borrow_mut() = marked_text;

        let state = self.ivars();
        state.in_ime_preedit.set(true);
        state.key_triggered_ime.set(true);
      }
      trace!("Completed `setMarkedText`");
    }

    #[unsafe(method(unmarkText))]
    fn unmark_text(&self) {
      trace!("Triggered `unmarkText`");
      unsafe {
        *self.ivars().marked_text.borrow_mut() = NSMutableAttributedString::new();
        let input_context = self.inputContext().expect("input context");
        input_context.discardMarkedText();
      }
      trace!("Completed `unmarkText`");
    }

    #[unsafe(method_id(validAttributesForMarkedText))]
    fn valid_attributes_for_marked_text(&self) -> Retained<NSArray<NSAttributedStringKey>> {
      trace!("Triggered `validAttributesForMarkedText`");
      trace!("Completed `validAttributesForMarkedText`");
      NSArray::new()
    }

    #[unsafe(method_id(attributedSubstringForProposedRange:actualRange:))]
    fn attributed_substring_for_proposed_range(
      &self,
      _range: NSRange,
      _actual_range: *mut NSRange,
    ) -> Option<Retained<NSAttributedString>> {
      trace!("Triggered `attributedSubstringForProposedRange`");
      trace!("Completed `attributedSubstringForProposedRange`");
      None
    }

    #[unsafe(method(characterIndexForPoint:))]
    fn character_index_for_point(&self, _point: NSPoint) -> NSUInteger {
      trace!("Triggered `characterIndexForPoint`");
      trace!("Completed `characterIndexForPoint`");
      0
    }

    #[unsafe(method(firstRectForCharacterRange:actualRange:))]
    fn first_rect_for_character_range(
      &self,
      _range: NSRange,
      _actual_range: *mut NSRange,
    ) -> NSRect {
      unsafe {
        trace!("Triggered `firstRectForCharacterRange`");
        let state = self.ivars();
        let (x, y) = state.ime_spot.get().unwrap_or_else(|| {
          let content_rect = NSWindow::contentRectForFrameRect(
            &state.ns_window.load().unwrap(),
            NSWindow::frame(&state.ns_window.load().unwrap()),
          );
          let x = content_rect.origin.x;
          let y = util::bottom_left_to_top_left(content_rect);
          (x, y)
        });
        trace!("Completed `firstRectForCharacterRange`");
        NSRect::new(NSPoint::new(x as _, y as _), NSSize::new(0.0, 0.0))
      }
    }

    #[unsafe(method(insertText:replacementRange:))]
    fn insert_text(&self, string: &AnyObject, _replacement_range: NSRange) {
      trace!("Triggered `insertText`");
      unsafe {
        let state = self.ivars();

        let characters = if let Some(string) = string.downcast_ref::<NSAttributedString>() {
          // This is a *mut NSAttributedString
          string.string()
        } else {
          // This is already a *mut NSString
          Retained::from(
            string
              .downcast_ref::<NSString>()
              .expect("expected NSString or NSAttributedString"),
          )
        };

        let string: String = characters
          .to_string()
          .chars()
          .filter(|c| !is_corporate_character(*c))
          .collect();
        state.is_key_down.set(true);

        // We don't need this now, but it's here if that changes.
        //let event: id = msg_send![NSApp(), currentEvent];

        AppState::queue_event(EventWrapper::StaticEvent(Event::WindowEvent {
          window_id: WindowId(get_window_id(&state.ns_window.load().unwrap())),
          event: WindowEvent::ReceivedImeText(string),
        }));
        if state.in_ime_preedit.get() {
          state.in_ime_preedit.set(false);
          state.key_triggered_ime.set(true);
        }
      }
      trace!("Completed `insertText`");
    }

    #[unsafe(method(doCommandBySelector:))]
    fn do_command_by_selector(&self, _command: Sel) {
      trace!("Triggered `doCommandBySelector`");
      // TODO: (Artur) all these inputs seem to trigger a key event with the correct text
      // content so this is not needed anymore, it seems.

      // Basically, we're sent this message whenever a keyboard event that doesn't generate a "human readable" character
      // happens, i.e. newlines, tabs, and Ctrl+C.

      // unsafe {
      //     let state_ptr: *mut c_void = *this.get_ivar("taoState");
      //     let state = &mut *(state_ptr as *mut ViewState);

      //     let mut events = VecDeque::with_capacity(1);
      //     if command == sel!(insertNewline:) {
      //         // The `else` condition would emit the same character, but I'm keeping this here both...
      //         // 1) as a reminder for how `doCommandBySelector` works
      //         // 2) to make our use of carriage return explicit
      //         events.push_back(EventWrapper::StaticEvent(Event::WindowEvent {
      //             window_id: WindowId(get_window_id(&state.ns_window.load().unwrap())),
      //             event: WindowEvent::ReceivedCharacter('\r'),
      //         }));
      //     } else {
      //         let raw_characters = state.raw_characters.take();
      //         if let Some(raw_characters) = raw_characters {
      //             for character in raw_characters
      //                 .chars()
      //                 .filter(|c| !is_corporate_character(*c))
      //             {
      //                 events.push_back(EventWrapper::StaticEvent(Event::WindowEvent {
      //                     window_id: WindowId(get_window_id(&state.ns_window.load().unwrap())),
      //                     event: WindowEvent::ReceivedCharacter(character),
      //                 }));
      //             }
      //         }
      //     };
      //     AppState::queue_events(events);
      // }

      trace!("Completed `doCommandBySelector`");
    }
  }
);

impl TaoView {
  fn window(&self) -> Retained<NSWindow> {
    (**self)
      .window()
      .expect("view must be installed in a window")
  }
}

// Get characters
// fn get_characters(event: id, ignore_modifiers: bool) -> String {
//   unsafe {
//     let characters: id = if ignore_modifiers {
//       msg_send![event, charactersIgnoringModifiers]
//     } else {
//       msg_send![event, characters]
//     };

//     assert_ne!(characters, nil);
//     let slice = slice::from_raw_parts(characters.UTF8String() as *const c_uchar, characters.len());

//     let string = str::from_utf8_unchecked(slice);
//     string.to_owned()
//   }
// }

// As defined in: https://www.unicode.org/Public/MAPPINGS/VENDORS/APPLE/CORPCHAR.TXT
fn is_corporate_character(c: char) -> bool {
  #[allow(clippy::match_like_matches_macro)]
  match c {
    '\u{F700}'..='\u{F747}'
    | '\u{F802}'..='\u{F84F}'
    | '\u{F850}'
    | '\u{F85C}'
    | '\u{F85D}'
    | '\u{F85F}'
    | '\u{F860}'..='\u{F86B}'
    | '\u{F870}'..='\u{F8FF}' => true,
    _ => false,
  }
}

// // Retrieves a layout-independent keycode given an event.
// fn retrieve_keycode(event: id) -> Option<VirtualKeyCode> {
//     #[inline]
//     fn get_code(ev: id, raw: bool) -> Option<VirtualKeyCode> {
//         let characters = get_characters(ev, raw);
//         characters.chars().next().and_then(|c| char_to_keycode(c))
//     }

//     // Cmd switches Roman letters for Dvorak-QWERTY layout, so we try modified characters first.
//     // If we don't get a match, then we fall back to unmodified characters.
//     let code = get_code(event, false).or_else(|| get_code(event, true));

//     // We've checked all layout related keys, so fall through to scancode.
//     // Reaching this code means that the key is layout-independent (e.g. Backspace, Return).
//     //
//     // We're additionally checking here for F21-F24 keys, since their keycode
//     // can vary, but we know that they are encoded
//     // in characters property.
//     code.or_else(|| {
//         let scancode = get_scancode(event);
//         scancode_to_keycode(scancode).or_else(|| check_function_keys(&get_characters(event, true)))
//     })
// }

// Update `state.modifiers` if `event` has something different
fn update_potentially_stale_modifiers(state: &ViewState, event: &NSEvent) {
  let event_modifiers = event_mods(event);
  if state.modifiers.get() != event_modifiers {
    state.modifiers.set(event_modifiers);

    AppState::queue_event(EventWrapper::StaticEvent(Event::WindowEvent {
      window_id: WindowId(get_window_id(&state.ns_window.load().unwrap())),
      event: WindowEvent::ModifiersChanged(state.modifiers.get()),
    }));
  }
}

fn mouse_click(this: &TaoView, event: &NSEvent, button: MouseButton, button_state: ElementState) {
  unsafe {
    let state = this.ivars();

    update_potentially_stale_modifiers(state, event);

    let window_event = Event::WindowEvent {
      window_id: WindowId(get_window_id(&state.ns_window.load().unwrap())),
      event: WindowEvent::MouseInput {
        device_id: DEVICE_ID,
        state: button_state,
        button,
        modifiers: event_mods(event),
      },
    };

    AppState::queue_event(EventWrapper::StaticEvent(window_event));
  }
}

fn mouse_motion(this: &TaoView, event: &NSEvent) {
  unsafe {
    let state = this.ivars();

    let window_point = event.locationInWindow();
    let view_point = this.convertPoint_fromView(window_point, None);
    let view_rect = NSView::frame(this);

    if view_point.x.is_sign_negative()
      || view_point.y.is_sign_negative()
      || view_point.x > view_rect.size.width
      || view_point.y > view_rect.size.height
    {
      let mouse_buttons_down = NSEvent::pressedMouseButtons();
      if mouse_buttons_down == 0 {
        // Point is outside of the client area (view) and no buttons are pressed
        return;
      }
    }

    let x = view_point.x;
    let y = view_rect.size.height - view_point.y;
    let logical_position = LogicalPosition::new(x, y);

    update_potentially_stale_modifiers(state, event);

    let window_event = Event::WindowEvent {
      window_id: WindowId(get_window_id(&state.ns_window.load().unwrap())),
      event: WindowEvent::CursorMoved {
        device_id: DEVICE_ID,
        position: logical_position.to_physical(state.get_scale_factor()),
        modifiers: event_mods(event),
      },
    };

    AppState::queue_event(EventWrapper::StaticEvent(window_event));
  }
}

pub unsafe fn inset_traffic_lights(window: &NSWindow, position: LogicalPosition<f64>) {
  let (x, y) = (position.x, position.y);

  let close = window
    .standardWindowButton(NSWindowButton::CloseButton)
    .unwrap();
  let miniaturize = window
    .standardWindowButton(NSWindowButton::MiniaturizeButton)
    .unwrap();
  let zoom = window
    .standardWindowButton(NSWindowButton::ZoomButton)
    .unwrap();

  let title_bar_container_view = close.superview().unwrap().superview().unwrap();

  let close_rect = NSView::frame(&close);
  let title_bar_frame_height = close_rect.size.height + y;
  let mut title_bar_rect = NSView::frame(&title_bar_container_view);
  title_bar_rect.size.height = title_bar_frame_height;
  title_bar_rect.origin.y = window.frame().size.height - title_bar_frame_height;
  title_bar_container_view.setFrame(title_bar_rect);

  let window_buttons = vec![close, miniaturize.clone(), zoom];
  let space_between = NSView::frame(&miniaturize).origin.x - close_rect.origin.x;

  for (i, button) in window_buttons.into_iter().enumerate() {
    let mut rect = NSView::frame(&button);
    rect.origin.x = x + (i as f64 * space_between);
    button.setFrameOrigin(rect.origin);
  }
}

// Re-apply the custom traffic light inset stored on the view, if one was set.
// AppKit resets the buttons to their default position on some events (title
// change, leaving fullscreen) without triggering a `drawRect:`, so callers use
// this to restore the configured position afterwards (#13044, #15451).
pub unsafe fn reapply_traffic_light_inset(ns_window: &NSWindow, ns_view: &NSView) {
  let Some(view) = ns_view.downcast_ref::<TaoView>() else {
    return;
  };
  let state = view.ivars();
  if let Some(position) = state.traffic_light_inset.get() {
    inset_traffic_lights(ns_window, position);
  }
}
