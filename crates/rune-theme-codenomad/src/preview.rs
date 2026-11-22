use crate::{Space, layout::Layout};
pub use rune::NativeSurface as PreviewSurface;
#[cfg(all(windows, feature = "ladybird-preview"))]
pub use rune::native_surface::windows::LoanedTexture;
use rune::{El, SurfaceFit, col, el};

#[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
pub struct OffscreenTrial {
    gpu: rune::render::Gpu,
    renderer: rune::render::Renderer,
    target: rune::render::Offscreen,
}

#[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
impl OffscreenTrial {
    pub fn new(w: u32, h: u32) -> Self {
        use rune::render::{Gpu, OFFSCREEN_FORMAT, Offscreen, Renderer};
        let gpu = Gpu::headless();
        rune::native_surface::note_device(&gpu.device, true);
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
        self.renderer.submit(q, ops);
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
    closing: fn(&mut S, &mut rune::Tx),
) {
    rune::App::new(spec)
        .on_ime(ime)
        .on_focus(focus)
        .on_visibility(visibility)
        .on_close(closing)
        .on_quit(closing)
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
