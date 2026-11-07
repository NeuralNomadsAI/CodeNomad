// Copyright 2014-2021 The winit contributors
// Copyright 2021-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0

use std::{
  cell::Cell,
  ffi::CStr,
  path::PathBuf,
  sync::{Arc, Weak},
};

use objc2::{
  define_class, msg_send,
  rc::{autoreleasepool, Retained},
  runtime::{AnyObject, ProtocolObject},
  DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{
  self as appkit, NSApplicationPresentationOptions, NSDragOperation, NSDraggingDestination,
  NSDraggingInfo, NSPasteboard, NSView, NSWindow, NSWindowDelegate,
};
use objc2_foundation::{
  ns_string, NSArray, NSDistributedNotificationCenter, NSObject, NSObjectNSDelayedPerforming,
  NSObjectNSThreadPerformAdditions, NSObjectProtocol, NSString,
};

use crate::{
  dpi::{LogicalPosition, LogicalSize},
  event::{Event, WindowEvent},
  keyboard::ModifiersState,
  platform_impl::platform::{
    app_state::AppState,
    event::{EventProxy, EventWrapper},
    util,
    view::{reapply_traffic_light_inset, TaoView},
    window::{get_ns_theme, get_window_id, TaoWindow, UnownedWindow},
  },
  window::{Fullscreen, WindowId},
};

pub(super) struct WindowDelegateState {
  ns_window: Retained<TaoWindow>, // never changes
  view: Retained<TaoView>,        // never changes

  window: Weak<UnownedWindow>,

  // This is set when WindowBuilder::with_fullscreen was set,
  // see comments of `window_did_fail_to_enter_fullscreen`
  initial_fullscreen: Cell<bool>,

  // During `windowDidResize`, we use this to only send Moved if the position changed.
  previous_position: Cell<Option<(f64, f64)>>,

  // Used to prevent redundant events.
  previous_scale_factor: Cell<f64>,

  // Used to prevent resized events from being fired
  // when we are using our workaround in the `is_zoomed` function.
  is_checking_zoomed_in: Cell<bool>,
}

impl WindowDelegateState {
  pub fn new(window: &Arc<UnownedWindow>, initial_fullscreen: bool) -> Self {
    let scale_factor = window.scale_factor();
    let delegate_state = WindowDelegateState {
      ns_window: window.ns_window.clone(),
      view: window.ns_view.clone(),
      window: Arc::downgrade(window),
      initial_fullscreen: Cell::new(initial_fullscreen),
      previous_position: Cell::new(None),
      previous_scale_factor: Cell::new(scale_factor),
      is_checking_zoomed_in: Cell::new(false),
    };
    if (scale_factor - 1.0).abs() > f64::EPSILON {
      delegate_state.emit_static_scale_factor_changed_event();
    }

    delegate_state
  }

  fn ns_view(&self) -> Retained<NSView> {
    self.ns_window.contentView().unwrap()
  }

  fn with_window<F, T>(&self, callback: F) -> Option<T>
  where
    F: FnOnce(&UnownedWindow) -> T,
  {
    self.window.upgrade().map(|ref window| callback(window))
  }

  pub fn emit_event(&self, event: WindowEvent<'static>) {
    let event = Event::WindowEvent {
      window_id: WindowId(get_window_id(&self.ns_window)),
      event,
    };
    AppState::queue_event(EventWrapper::StaticEvent(event));
  }

  pub fn emit_static_scale_factor_changed_event(&self) {
    let scale_factor = self.get_scale_factor();
    if (scale_factor - self.previous_scale_factor.get()).abs() < f64::EPSILON {
      return;
    };

    self.previous_scale_factor.set(scale_factor);
    let wrapper = EventWrapper::EventProxy(EventProxy::DpiChangedProxy {
      ns_window: self.ns_window.clone().into_super(),
      suggested_size: self.view_size(),
      scale_factor,
    });
    AppState::queue_event(wrapper);
  }

  pub fn emit_resize_event(&self) {
    let rect = NSView::frame(&self.ns_view());
    let scale_factor = self.get_scale_factor();
    let logical_size = LogicalSize::new(rect.size.width, rect.size.height);
    let size = logical_size.to_physical(scale_factor);
    self.emit_event(WindowEvent::Resized(size));
  }

  fn emit_move_event(&self) {
    let rect = NSWindow::frame(&self.ns_window);
    let x = rect.origin.x;
    let y = util::bottom_left_to_top_left(rect);
    let moved = self.previous_position.get() != Some((x, y));
    if moved {
      self.previous_position.set(Some((x, y)));
      let scale_factor = self.get_scale_factor();
      let physical_pos = LogicalPosition::<f64>::from((x, y)).to_physical(scale_factor);
      self.emit_event(WindowEvent::Moved(physical_pos));
    }
  }

  fn get_scale_factor(&self) -> f64 {
    NSWindow::backingScaleFactor(&self.ns_window)
  }

  fn view_size(&self) -> LogicalSize<f64> {
    let ns_size = NSView::frame(&self.ns_view()).size;
    LogicalSize::new(ns_size.width, ns_size.height)
  }
}

pub(super) fn new_delegate(
  window: &Arc<UnownedWindow>,
  initial_fullscreen: bool,
) -> Retained<WindowDelegate> {
  let state = WindowDelegateState::new(window, initial_fullscreen);
  let mtm = MainThreadMarker::from(&*window.ns_window);
  let delegate = WindowDelegate::alloc(mtm).set_ivars(state);
  let delegate: Retained<WindowDelegate> = unsafe { msg_send![super(delegate), init] };
  window
    .ns_window
    .setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
  unsafe {
    let notification_center = NSDistributedNotificationCenter::defaultCenter();
    let notification_name = ns_string!("AppleInterfaceThemeChangedNotification");
    notification_center.addObserver_selector_name_object(
      &delegate,
      sel!(effectiveAppearanceDidChange:),
      Some(notification_name),
      None,
    );
  }
  delegate
}

/// Collects the file paths of a dragging pasteboard, empty if it carries none.
unsafe fn collect_paths(sender: &ProtocolObject<dyn NSDraggingInfo>) -> Vec<PathBuf> {
  let pb = sender.draggingPasteboard();
  let Some(filenames) = NSPasteboard::propertyListForType(&pb, appkit::NSFilenamesPboardType)
  else {
    return Vec::new();
  };
  let Ok(filenames) = filenames.downcast::<NSArray>() else {
    return Vec::new();
  };

  filenames
    .iter()
    .filter_map(|file| file.downcast::<NSString>().ok())
    .map(|file| {
      let path = CStr::from_ptr(NSString::UTF8String(&file))
        .to_string_lossy()
        .into_owned();
      PathBuf::from(path)
    })
    .collect()
}

define_class!(
  #[unsafe(super(NSObject))]
  #[thread_kind = MainThreadOnly]
  #[name = "TaoWindowDelegate"]
  #[ivars = WindowDelegateState]
  pub(super) struct WindowDelegate;

  unsafe impl NSObjectProtocol for WindowDelegate {}

  unsafe impl NSWindowDelegate for WindowDelegate {
    #[unsafe(method(windowShouldClose:))]
    fn window_should_close(&self, _: Option<&AnyObject>) -> bool {
      trace!("Triggered `windowShouldClose:`");
      self.ivars().emit_event(WindowEvent::CloseRequested);
      trace!("Completed `windowShouldClose:`");
      false
    }

    #[unsafe(method(windowWillClose:))]
    fn window_will_close(&self, _: Option<&AnyObject>) {
      trace!("Triggered `windowWillClose:`");
      let state = self.ivars();
      // `setDelegate:` retains the previous value and then autoreleases it.
      // Since El Capitan, prevent delegate callbacks after the window closes.
      autoreleasepool(|_| state.ns_window.setDelegate(None));
      state.emit_event(WindowEvent::Destroyed);
      trace!("Completed `windowWillClose:`");
    }

    #[unsafe(method(windowDidResize:))]
    fn window_did_resize(&self, _: Option<&AnyObject>) {
      trace!("Triggered `windowDidResize:`");
      let state = self.ivars();
      if !state.is_checking_zoomed_in.get() {
        state.emit_resize_event();
        state.emit_move_event();
      }
      trace!("Completed `windowDidResize:`");
    }

    // This won't be triggered if the move was part of a resize.
    #[unsafe(method(windowDidMove:))]
    fn window_did_move(&self, _: Option<&AnyObject>) {
      trace!("Triggered `windowDidMove:`");
      let state = self.ivars();
      state.emit_move_event();
      trace!("Completed `windowDidMove:`");
    }

    #[unsafe(method(windowDidChangeBackingProperties:))]
    fn window_did_change_backing_properties(&self, _: Option<&AnyObject>) {
      trace!("Triggered `windowDidChangeBackingProperties:`");
      let state = self.ivars();
      state.emit_static_scale_factor_changed_event();
      trace!("Completed `windowDidChangeBackingProperties:`");
    }

    #[unsafe(method(windowDidBecomeKey:))]
    fn window_did_become_key(&self, _: Option<&AnyObject>) {
      trace!("Triggered `windowDidBecomeKey:`");
      let state = self.ivars();
      // TODO: center the cursor if the window had mouse grab when it
      // lost focus
      state.emit_event(WindowEvent::Focused(true));
      trace!("Completed `windowDidBecomeKey:`");
    }

    #[unsafe(method(windowDidResignKey:))]
    fn window_did_resign_key(&self, _: Option<&AnyObject>) {
      trace!("Triggered `windowDidResignKey:`");
      let state = self.ivars();
      // It happens rather often, e.g. when the user is Cmd+Tabbing, that the
      // NSWindowDelegate will receive a didResignKey event despite no event
      // being received when the modifiers are released.  This is because
      // flagsChanged events are received by the NSView instead of the
      // NSWindowDelegate, and as a result a tracked modifiers state can quite
      // easily fall out of synchrony with reality.  This requires us to emit
      // a synthetic ModifiersChanged event when we lose focus.
      //
      let view_state = state.view.ivars();

      // Both update the state and emit a ModifiersChanged event.
      if !view_state.modifiers.get().is_empty() {
        view_state.modifiers.set(ModifiersState::empty());
        state.emit_event(WindowEvent::ModifiersChanged(view_state.modifiers.get()));
      }

      state.emit_event(WindowEvent::Focused(false));
      trace!("Completed `windowDidResignKey:`");
    }

    /// Invoked before entering fullscreen.
    #[unsafe(method(windowWillEnterFullScreen:))]
    fn window_will_enter_fullscreen(&self, _: Option<&AnyObject>) {
      trace!("Triggered `windowWillEnterFullscreen:`");

      let state = self.ivars();
      state.with_window(|window| {
        trace!("Locked shared state in `window_will_enter_fullscreen`");
        let mut shared_state = window.shared_state.lock().unwrap();
        shared_state.maximized = window.is_zoomed();
        match shared_state.fullscreen {
          // Exclusive mode sets the state in `set_fullscreen` as the user
          // can't enter exclusive mode by other means (like the
          // fullscreen button on the window decorations)
          Some(Fullscreen::Exclusive(_)) => (),
          // `window_will_enter_fullscreen` was triggered and we're already
          // in fullscreen, so we must've reached here by `set_fullscreen`
          // as it updates the state
          Some(Fullscreen::Borderless(_)) => (),
          // Otherwise, we must've reached fullscreen by the user clicking
          // on the green fullscreen button. Update state!
          None => {
            let current_monitor = window.current_monitor_inner();
            shared_state.fullscreen = Some(Fullscreen::Borderless(current_monitor))
          }
        }
        shared_state.in_fullscreen_transition = true;
        trace!("Unlocked shared state in `window_will_enter_fullscreen`");
      });
      trace!("Completed `windowWillEnterFullscreen:`");
    }

    /// Invoked before exiting fullscreen.
    #[unsafe(method(windowWillExitFullScreen:))]
    fn window_will_exit_fullscreen(&self, _: Option<&AnyObject>) {
      trace!("Triggered `windowWillExitFullScreen:`");

      let state = self.ivars();
      state.with_window(|window| {
        trace!("Locked shared state in `window_will_exit_fullscreen`");
        let mut shared_state = window.shared_state.lock().unwrap();
        shared_state.in_fullscreen_transition = true;
        trace!("Unlocked shared state in `window_will_exit_fullscreen`");
      });
      trace!("Completed `windowWillExitFullScreen:`");
    }

    #[unsafe(method(window:willUseFullScreenPresentationOptions:))]
    fn window_will_use_fullscreen_presentation_options(
      &self,
      _: Option<&AnyObject>,
      proposed_options: NSApplicationPresentationOptions,
    ) -> NSApplicationPresentationOptions {
      // Generally, games will want to disable the menu bar and the dock. Ideally,
      // this would be configurable by the user. Unfortunately because of our
      // `CGShieldingWindowLevel() + 1` hack (see `set_fullscreen`), our window is
      // placed on top of the menu bar in exclusive fullscreen mode. This looks
      // broken so we always disable the menu bar in exclusive fullscreen. We may
      // still want to make this configurable for borderless fullscreen. Right now
      // we don't, for consistency. If we do, it should be documented that the
      // user-provided options are ignored in exclusive fullscreen.
      let mut options = proposed_options;
      let state = self.ivars();
      state.with_window(|window| {
        trace!("Locked shared state in `window_will_use_fullscreen_presentation_options`");
        let shared_state = window.shared_state.lock().unwrap();
        if let Some(Fullscreen::Exclusive(_)) = shared_state.fullscreen {
          options = NSApplicationPresentationOptions::FullScreen
            | NSApplicationPresentationOptions::HideDock
            | NSApplicationPresentationOptions::HideMenuBar;
        }
        trace!("Unlocked shared state in `window_will_use_fullscreen_presentation_options`");
      });

      options
    }

    /// Invoked after entering fullscreen.
    #[unsafe(method(windowDidEnterFullScreen:))]
    fn window_did_enter_fullscreen(&self, _: Option<&AnyObject>) {
      trace!("Triggered `windowDidEnterFullscreen:`");
      let state = self.ivars();
      state.initial_fullscreen.set(false);
      state.with_window(|window| {
        trace!("Locked shared state in `window_did_enter_fullscreen`");
        let mut shared_state = window.shared_state.lock().unwrap();
        shared_state.in_fullscreen_transition = false;
        let target_fullscreen = shared_state.target_fullscreen.take();
        trace!("Unlocked shared state in `window_did_enter_fullscreen`");
        drop(shared_state);
        if let Some(target_fullscreen) = target_fullscreen {
          window.set_fullscreen(target_fullscreen);
        }
      });
      state.emit_resize_event();
      state.emit_move_event();
      trace!("Completed `windowDidEnterFullscreen:`");
    }

    /// Invoked after exiting fullscreen.
    #[unsafe(method(windowDidExitFullScreen:))]
    fn window_did_exit_fullscreen(&self, _: Option<&AnyObject>) {
      trace!("Triggered `windowDidExitFullscreen:`");
      let state = self.ivars();
      state.with_window(|window| {
        window.restore_state_from_fullscreen();
        trace!("Locked shared state in `window_did_exit_fullscreen`");
        let mut shared_state = window.shared_state.lock().unwrap();
        shared_state.in_fullscreen_transition = false;
        let target_fullscreen = shared_state.target_fullscreen.take();
        trace!("Unlocked shared state in `window_did_exit_fullscreen`");
        drop(shared_state);
        if let Some(target_fullscreen) = target_fullscreen {
          window.set_fullscreen(target_fullscreen);
        }
        // Leaving fullscreen resets the traffic light buttons to their default
        // position without a `drawRect:`, so re-apply the custom inset (#15451).
        unsafe { reapply_traffic_light_inset(&window.ns_window, &window.ns_view) };
      });
      state.emit_resize_event();
      state.emit_move_event();
      trace!("Completed `windowDidExitFullscreen:`");
    }

    /// Invoked when entering fullscreen fails.
    ///
    /// When this window launch from a fullscreen app (e.g. launch from VS Code
    /// terminal), it creates a new virtual destkop and a transition animation.
    /// This animation takes one second and cannot be disable without
    /// elevated privileges. In this animation time, all toggleFullscreen events
    /// will be failed. In this implementation, we will try again by using
    /// performSelector:withObject:afterDelay: until window_did_enter_fullscreen.
    /// It should be fine as we only do this at initialzation (i.e with_fullscreen
    /// was set).
    ///
    /// From Apple doc:
    /// In some cases, the transition to enter full-screen mode can fail,
    /// due to being in the midst of handling some other animation or user gesture.
    /// This method indicates that there was an error, and you should clean up any
    /// work you may have done to prepare to enter full-screen mode.

    #[unsafe(method(windowDidFailToEnterFullScreen:))]
    fn window_did_fail_to_enter_fullscreen(&self, _: Option<&AnyObject>) {
      trace!("Triggered `windowDidFailToEnterFullscreen:`");
      let state = self.ivars();
      state.with_window(|window| {
        trace!("Locked shared state in `window_did_fail_to_enter_fullscreen`");
        let mut shared_state = window.shared_state.lock().unwrap();
        shared_state.in_fullscreen_transition = false;
        shared_state.target_fullscreen = None;
        trace!("Unlocked shared state in `window_did_fail_to_enter_fullscreen`");
      });
      if state.initial_fullscreen.get() {
          unsafe {
            state.ns_window.performSelector_withObject_afterDelay(
              sel!(toggleFullScreen:),
              None,
              0.5,
            )
          }
      } else {
        state.with_window(|window| window.restore_state_from_fullscreen());
      }
      trace!("Completed `windowDidFailToEnterFullscreen:`");
    }
  }

  unsafe impl NSDraggingDestination for WindowDelegate {
    /// Invoked when the dragged image enters destination bounds or frame.
    #[unsafe(method(draggingEntered:))]
    fn dragging_entered(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> NSDragOperation {
      trace!("Triggered `draggingEntered:`");

      for path in unsafe { collect_paths(sender) } {
        self.ivars().emit_event(WindowEvent::HoveredFile(path));
      }

      trace!("Completed `draggingEntered:`");
      NSDragOperation::Copy
    }

    /// Invoked when the image is released.
    #[unsafe(method(prepareForDragOperation:))]
    fn prepare_for_drag_operation(&self, _: &ProtocolObject<dyn NSDraggingInfo>) -> bool {
      trace!("Triggered `prepareForDragOperation:`");
      trace!("Completed `prepareForDragOperation:`");
      true
    }

    /// Invoked after the released image has been removed from the screen.
    #[unsafe(method(performDragOperation:))]
    fn perform_drag_operation(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> bool {
      trace!("Triggered `performDragOperation:`");

      for path in unsafe { collect_paths(sender) } {
        self.ivars().emit_event(WindowEvent::DroppedFile(path));
      }

      trace!("Completed `performDragOperation:`");
      true
    }

    /// Invoked when the dragging operation is complete.
    #[unsafe(method(concludeDragOperation:))]
    fn conclude_drag_operation(&self, _: Option<&ProtocolObject<dyn NSDraggingInfo>>) {
      trace!("Triggered `concludeDragOperation:`");
      trace!("Completed `concludeDragOperation:`");
    }

    /// Invoked when the dragging operation is cancelled.
    #[unsafe(method(draggingExited:))]
    fn dragging_exited(&self, _: Option<&ProtocolObject<dyn NSDraggingInfo>>) {
      trace!("Triggered `draggingExited:`");
      let state = self.ivars();
      state.emit_event(WindowEvent::HoveredFileCancelled);
      trace!("Completed `draggingExited:`");
    }
  }

  impl WindowDelegate {
    #[unsafe(method(markIsCheckingZoomedIn))]
    fn mark_is_checking_zoomed_in(&self) {
      let state = self.ivars();
      state.is_checking_zoomed_in.set(true);
    }

    #[unsafe(method(clearIsCheckingZoomedIn))]
    fn clear_is_checking_zoomed_in(&self) {
      let state = self.ivars();
      state.is_checking_zoomed_in.set(false);
    }

    // Observe theme changes.
    #[unsafe(method(effectiveAppearanceDidChange:))]
    fn effective_appearance_did_change(&self, _: Option<&AnyObject>) {
      trace!("Triggered `effectiveAppearDidChange:`");
      unsafe { self.performSelectorOnMainThread_withObject_waitUntilDone(sel!(effectiveAppearanceDidChangedOnMainThread:), None, false) };
    }

    #[unsafe(method(effectiveAppearanceDidChangedOnMainThread:))]
    fn effective_appearance_did_changed_on_main_thread(&self, _: Option<&AnyObject>) {
      let state = self.ivars();
      let theme = get_ns_theme();
      let current_theme = state.window.upgrade().map(|w| {
        let mut state = w.shared_state.lock().unwrap();
        let current_theme = state.current_theme;
        state.current_theme = theme;
        current_theme
      });
      if current_theme != Some(theme) {
        state.emit_event(WindowEvent::ThemeChanged(theme));
      }
      trace!("Completed `effectiveAppearDidChange:`");
    }
  }
);
