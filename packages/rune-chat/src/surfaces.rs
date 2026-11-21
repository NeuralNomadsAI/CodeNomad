//! Native projection of the existing dark CSS tokens, resolved once without runtime file I/O.
use rune::Color;
pub struct Surfaces {
    pub canvas: Color,
    pub field: Color,
    pub control: Color,
    pub text: Color,
}
pub fn get() -> &'static Surfaces {
    static VALUE: std::sync::OnceLock<Surfaces> = std::sync::OnceLock::new();
    VALUE.get_or_init(|| {
        let css = include_str!("../../ui/src/styles/tokens.css");
        let dark = css
            .split("[data-theme=\"dark\"] {")
            .nth(1)
            .expect("dark palette");
        let token = |name: &str| {
            let value = dark
                .split(&format!("{name}:"))
                .nth(1)
                .expect("surface token")
                .split(';')
                .next()
                .unwrap()
                .trim();
            rune::color::hex(value).expect("concrete dark token")
        };
        let base = token("--surface-base");
        let secondary = token("--surface-secondary");
        let mix = |fraction: f32| {
            let a = base.to_oklab();
            let b = secondary.to_oklab();
            Color::from_oklab(std::array::from_fn(|i| a[i] + (b[i] - a[i]) * fraction))
        };
        Surfaces {
            canvas: mix(0.25),
            field: base,
            control: mix(0.72),
            text: token("--text-primary"),
        }
    })
}
