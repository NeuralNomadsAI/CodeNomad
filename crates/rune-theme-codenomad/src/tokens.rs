use crate::{document, theme};
use rune::{Color, TextStyle};

/// A generated visual quantity; callers cannot manufacture one from a number.
/// ```compile_fail
/// let invented = rune_theme_codenomad::Dimension(17.0);
/// ```
#[derive(Clone, Copy, Debug)]
pub struct Dimension(f32);
impl Dimension {
    pub fn px(self) -> f32 {
        self.0
    }
}
#[derive(Clone, Copy)]
pub enum Space {
    Xxs,
    Xs,
    Sm,
    Md,
    Lg,
    Xl,
}
#[derive(Clone, Copy)]
pub enum Length {
    Chrome,
    PanelHeader,
    ControlSmall,
    Control,
    Selector,
    TouchTarget,
    TouchCompact,
    Scrollbar,
    IconButton,
    Icon,
    ButtonPadX,
    ButtonPadY,
    ChipRadius,
}
#[derive(Clone, Copy)]
pub enum TextRole {
    Body,
    Button,
    SecondaryButton,
    Small,
    Label,
    Title,
    Heading,
    Mono,
}
#[derive(Clone, Copy)]
pub enum MotionRole {
    Control,
    Disclosure,
}
pub struct Tokens {
    dark: bool,
}
pub fn tokens(dark: bool) -> &'static Tokens {
    static LIGHT: Tokens = Tokens { dark: false };
    static DARK: Tokens = Tokens { dark: true };
    if dark { &DARK } else { &LIGHT }
}
impl Tokens {
    pub(crate) fn mode(&self) -> &'static str {
        if self.dark { "dark" } else { "light" }
    }
    pub fn color(&self, name: &str) -> Color {
        theme(self.dark).color(name)
    }
    pub fn number(&self, name: &str) -> Dimension {
        Dimension(
            document()["numbers"][self.mode()][name]
                .as_f64()
                .unwrap_or_else(|| panic!("No generated numerical token {name}"))
                as f32,
        )
    }
    pub fn string(&self, name: &str) -> &'static str {
        document()["strings"][self.mode()][name]
            .as_str()
            .unwrap_or_else(|| panic!("No generated CSS token {name}"))
    }
    pub fn metric(&self, component: &str, property: &str) -> Dimension {
        Dimension(
            document()["metrics"][self.mode()][component][property]
                .as_f64()
                .unwrap_or_else(|| panic!("No numerical CSS metric {component}.{property}"))
                as f32,
        )
    }
    pub fn metric_string(&self, component: &str, property: &str) -> &'static str {
        document()["metrics"][self.mode()][component][property]
            .as_str()
            .unwrap_or_else(|| panic!("No CSS metric {component}.{property}"))
    }
    pub fn space(&self, value: Space) -> Dimension {
        self.number(match value {
            Space::Xxs => "space-2xs",
            Space::Xs => "space-xs",
            Space::Sm => "space-sm",
            Space::Md => "space-md",
            Space::Lg => "space-lg",
            Space::Xl => "space-xl",
        })
    }
    pub fn length(&self, value: Length) -> Dimension {
        self.number(match value {
            Length::Chrome => "chrome-height",
            Length::PanelHeader => "panel-header-height",
            Length::ControlSmall => "control-height-sm",
            Length::Control => "control-height",
            Length::Selector => "selector-height",
            Length::TouchTarget => "touch-target-size",
            Length::TouchCompact => "touch-target-size-compact",
            Length::Scrollbar => "scrollbar-size",
            Length::IconButton => "icon-button-size",
            Length::Icon => "icon-size",
            Length::ButtonPadX => "button-padding-x",
            Length::ButtonPadY => "button-padding-y",
            Length::ChipRadius => "chip-radius",
        })
    }
    pub fn text(&self, role: TextRole) -> TextStyle {
        let named = match role {
            TextRole::Body => Some("body"),
            TextRole::Button => Some("button"),
            TextRole::SecondaryButton => Some("secondary"),
            TextRole::Label => Some("input"),
            TextRole::Title => Some("title"),
            _ => None,
        };
        if let Some(component) = named {
            return TextStyle::new(
                self.metric(component, "fontSize").px(),
                self.metric(component, "fontWeight").px(),
            )
            .lh(self.metric(component, "lineHeight").px())
            .tracking(self.metric(component, "letterSpacing").px());
        }
        let size = self
            .number(match role {
                TextRole::Small => "font-size-xs",
                TextRole::Heading => "font-size-lg",
                _ => "font-size-base",
            })
            .px();
        let weight = self.number("font-weight-regular").px();
        let line = self
            .number(if matches!(role, TextRole::Heading) {
                "line-height-tight"
            } else {
                "line-height-normal"
            })
            .px();
        let style = TextStyle::new(size, weight).lh(size * line).tracking(
            if matches!(role, TextRole::Mono) {
                0.0
            } else {
                self.metric("body", "letterSpacing").px()
            },
        );
        if matches!(role, TextRole::Mono) {
            style.mono()
        } else {
            style
        }
    }
    pub fn duration_seconds(&self, role: MotionRole) -> f32 {
        let raw = self.metric_string(
            match role {
                MotionRole::Control => "transition",
                MotionRole::Disclosure => "disclosure",
            },
            "transitionDuration",
        );
        let first = raw.split(',').next().unwrap().trim();
        if let Some(value) = first.strip_suffix("ms") {
            value.parse::<f32>().expect("CSS duration") / 1000.0
        } else {
            first
                .strip_suffix('s')
                .expect("CSS seconds")
                .parse()
                .expect("CSS duration")
        }
    }
}
