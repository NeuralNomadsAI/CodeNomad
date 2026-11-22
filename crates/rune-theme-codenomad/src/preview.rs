use crate::{Space, layout::Layout};
use rune::{El, SurfaceFit, col, el, native_surface::{ByteFrame, ColorInfo, Format}};
pub use rune::NativeSurface as PreviewSurface;

pub fn dpi<S>(cx: &rune::Cx<S>) -> f32 {
    cx.env().scale
}

pub fn run<S: 'static>(
    spec: rune::AppSpec<S>,
    ime: fn(&mut S, &rune::Ime, &mut rune::Tx) -> bool,
    focus: fn(&mut S, bool, &mut rune::Tx),
    hidden: bool,
) {
    let mut app = rune::App::new(spec).on_ime(ime).on_focus(focus);
    if hidden { app = app.configured_options(rune::WindowOptions::launcher_panel()); }
    app.run();
}

pub fn panel() -> El {
    col().w_full().grow(1.0).min_h(0.0).pad(Space::Sm)
}

pub fn surface(surface: &PreviewSurface) -> El {
    el().w_full().grow(1.0).min_h(0.0).role("group").ime_cursor()
        .native_surface(surface, SurfaceFit::Fill)
}

pub fn push(surface: &PreviewSurface, width: u32, height: u32, bytes: Vec<u8>) -> Result<(), String> {
    static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    surface.push_bytes(
        ByteFrame { width, height, format: Format::Bgra, color: ColorInfo::default(), planes: [bytes, vec![]] },
        SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    )
}
