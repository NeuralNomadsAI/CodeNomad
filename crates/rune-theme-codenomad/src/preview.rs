use crate::{Space, layout::Layout};
pub use rune::NativeSurface as PreviewSurface;
use rune::{
    El, SurfaceFit, col, el,
    native_surface::{ByteFrame, ColorInfo, Format},
};

#[cfg(all(feature = "preview-probe", not(target_arch = "wasm32")))]
pub struct OffscreenTrial {
    gpu: rune::render::Gpu,
    renderer: rune::render::Renderer,
    target: rune::render::Offscreen,
}

#[cfg(all(feature = "preview-probe", not(target_arch = "wasm32")))]
impl OffscreenTrial {
    pub fn new(w: u32, h: u32) -> Self {
        use rune::render::{Gpu, OFFSCREEN_FORMAT, Offscreen, Renderer};
        let gpu = Gpu::headless();
        Self {
            renderer: Renderer::new(&gpu.device, OFFSCREEN_FORMAT),
            target: Offscreen::new(&gpu.device, w, h),
            gpu,
        }
    }

    pub fn submit<S: 'static>(&mut self, rt: &mut rune::Runtime<S>) {
        let d = &self.gpu.device;
        let q = &self.gpu.queue;
        let dims = (self.target.width, self.target.height);
        self.renderer
            .prepare(d, q, &mut rt.text.atlas, &rt.instances, dims);
        self.renderer.prepare_surfaces(d, q, &rt.surfaces, dims);
        let mut ops = d.create_command_encoder(&Default::default());
        self.renderer.draw(&mut ops, &self.target.view, [1.0; 4]);
        q.submit([ops.finish()]);
    }

    pub fn resize(&mut self, w: u32, h: u32) {
        self.target = rune::render::Offscreen::new(&self.gpu.device, w, h);
    }

    pub fn save(&self, path: &std::path::Path) -> std::io::Result<()> {
        let mut ops = self.gpu.device.create_command_encoder(&Default::default());
        self.target.copy(&mut ops);
        self.gpu.queue.submit([ops.finish()]);
        let bytes = self.target.read(&self.gpu.device);
        rune::render::write_png(path, self.target.width, self.target.height, &bytes)
    }
}

pub fn dpi<S>(cx: &rune::Cx<S>) -> f32 {
    cx.env().scale
}

pub fn run<S: 'static>(
    spec: rune::AppSpec<S>,
    ime: fn(&mut S, &rune::Ime, &mut rune::Tx) -> bool,
    focus: fn(&mut S, bool, &mut rune::Tx),
    visibility: fn(&mut S, bool, &mut rune::Tx),
) {
    rune::App::new(spec)
        .on_ime(ime)
        .on_focus(focus)
        .on_visibility(visibility)
        .run();
}

pub fn panel() -> El {
    col().w_full().grow(1.0).min_h(0.0).pad(Space::Sm)
}

pub fn surface(surface: &PreviewSurface) -> El {
    el().w_full()
        .grow(1.0)
        .min_h(0.0)
        .role("group")
        .ime_cursor()
        .native_surface(surface, SurfaceFit::Fill)
}

pub fn push(
    surface: &PreviewSurface,
    width: u32,
    height: u32,
    bytes: Vec<u8>,
) -> Result<(), String> {
    static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    surface.push_bytes(
        ByteFrame {
            width,
            height,
            format: Format::Bgra,
            color: ColorInfo::default(),
            planes: [bytes, vec![]],
        },
        SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    )
}
