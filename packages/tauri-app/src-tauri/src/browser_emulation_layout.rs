use super::{validate_bounds, BrowserTargetBounds};
use serde::Deserialize;
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub(crate) struct Viewport {
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Presentation {
    #[serde(default)]
    pub css: bool,
    pub viewport: Option<Viewport>,
}
#[derive(Clone, Copy, Debug)]
pub(super) struct Canvas {
    pub bounds: BrowserTargetBounds,
    pub presentation: Presentation,
}
pub(super) struct Layout {
    pub bounds: BrowserTargetBounds,
    pub zoom: f64,
}
pub(super) fn validate(size: Viewport) -> Result<(), String> {
    if size.width == 0 || size.height == 0 || size.width > 16384 || size.height > 16384 {
        Err("Invalid browser CSS viewport".into())
    } else {
        Ok(())
    }
}
pub(super) fn layout(
    canvas: Canvas,
    pixel_scale: f64,
    device_scale: f64,
    target: Option<Viewport>,
) -> Result<Layout, String> {
    validate_bounds(canvas.bounds)?;
    if !pixel_scale.is_finite()
        || !device_scale.is_finite()
        || pixel_scale <= 0.0
        || device_scale <= 0.0
    {
        return Err("Invalid native preview scale".into());
    }
    let mut area = canvas.bounds;
    if canvas.presentation.css {
        area = BrowserTargetBounds {
            x: (area.x as f64 * pixel_scale).round() as i32,
            y: (area.y as f64 * pixel_scale).round() as i32,
            width: (area.width as f64 * pixel_scale).round() as u32,
            height: (area.height as f64 * pixel_scale).round() as u32,
        };
    }
    validate_bounds(area)?;
    let target = target.or(canvas.presentation.viewport).or_else(|| {
        canvas.presentation.css.then_some(Viewport {
            width: canvas.bounds.width,
            height: canvas.bounds.height,
        })
    });
    let Some(size) = target else {
        return Ok(Layout {
            bounds: area,
            zoom: 1.0,
        });
    };
    validate(size)?;
    let aw = (area.width as f64 / device_scale).floor() as u32;
    let ah = (area.height as f64 / device_scale).floor() as u32;
    // Native GTK allocations are integer DIPs. Find a nearby aspect ratio whose
    // zoom interval gives the exact integer CSS dimensions on both axes.
    let max_width = aw.min((ah as f64 * size.width as f64 / size.height as f64).ceil() as u32 + 1);
    for width in (1..=max_width).rev() {
        let height = width as f64 * size.height as f64 / size.width as f64;
        for height in [height.floor() as u32, height.ceil() as u32] {
            if height == 0 || height > ah {
                continue;
            }
            let lower = (width as f64 / (size.width + 1) as f64)
                .max(height as f64 / (size.height + 1) as f64);
            let upper = (width as f64 / size.width as f64).min(height as f64 / size.height as f64);
            if lower >= upper {
                continue;
            }
            let exact = width as f64 == size.width as f64 * upper
                && height as f64 == size.height as f64 * upper
                && (upper * 64.0).fract() == 0.0;
            let zoom = if exact { upper } else { (lower + upper) / 2.0 };
            let w = (width as f64 * device_scale).round() as u32;
            let h = (height as f64 * device_scale).round() as u32;
            return Ok(Layout {
                bounds: BrowserTargetBounds {
                    x: area
                        .x
                        .checked_add(((area.width - w) / 2) as i32)
                        .ok_or("Invalid browser target bounds")?,
                    y: area.y,
                    width: w,
                    height: h,
                },
                zoom,
            });
        }
    }
    Err("Browser preview is too small for this viewport".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn css_viewports_survive_native_scale_and_clipping() {
        for size in [
            Viewport {
                width: 1440,
                height: 900,
            },
            Viewport {
                width: 768,
                height: 1024,
            },
            Viewport {
                width: 1024,
                height: 768,
            },
            Viewport {
                width: 390,
                height: 844,
            },
            Viewport {
                width: 844,
                height: 390,
            },
        ] {
            for (width, height, scale) in [
                (500, 600, 1.0),
                (750, 900, 1.0),
                (1000, 1200, 2.0),
                (585, 1266, 1.0),
            ] {
                let result = layout(
                    Canvas {
                        bounds: BrowserTargetBounds {
                            x: 10,
                            y: 60,
                            width,
                            height,
                        },
                        presentation: Presentation::default(),
                    },
                    1.0,
                    scale,
                    Some(size),
                )
                .unwrap();
                let zoom = result.zoom as f32 as f64;
                assert_eq!(
                    (result.bounds.width as f64 / scale / zoom).floor() as u32,
                    size.width
                );
                assert_eq!(
                    (result.bounds.height as f64 / scale / zoom).floor() as u32,
                    size.height
                );
                assert!(result.bounds.width <= width && result.bounds.height <= height);
            }
        }
        for device in [1.0, 2.0] {
            for app_zoom in [0.8, 1.0, 1.25, 1.5] {
                let result = layout(
                    Canvas {
                        bounds: BrowserTargetBounds {
                            x: 10,
                            y: 60,
                            width: 500,
                            height: 400,
                        },
                        presentation: Presentation {
                            css: true,
                            viewport: None,
                        },
                    },
                    device * app_zoom,
                    device,
                    None,
                )
                .unwrap();
                let zoom = result.zoom as f32 as f64;
                assert_eq!(
                    (result.bounds.width as f64 / device / zoom).floor() as u32,
                    500
                );
                assert_eq!(
                    (result.bounds.height as f64 / device / zoom).floor() as u32,
                    400
                );
            }
        }
        for (x, width) in [(0, u32::MAX), (i32::MAX, 500)] {
            assert!(layout(
                Canvas {
                    bounds: BrowserTargetBounds {
                        x,
                        y: 0,
                        width,
                        height: 400
                    },
                    presentation: Presentation::default(),
                },
                1.0,
                1.0,
                Some(Viewport {
                    width: 390,
                    height: 844
                })
            )
            .is_err());
        }
        assert!(validate(Viewport {
            width: 0,
            height: 844
        })
        .is_err());
        assert!(validate(Viewport {
            width: 390,
            height: 16385
        })
        .is_err());
    }
}
