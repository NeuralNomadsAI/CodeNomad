use rune::render::{
    Kind,
    cpu_boot::{CpuPainter, Scene, Target, attach_text},
};
use rune::{
    Env, Key, KeyEvent, Mods, Runtime,
    accesskit::{Node, NodeId, Role},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    io::{self, BufRead, Read, Write},
    sync::mpsc,
    time::{Duration, Instant},
};

const SIZE: (u32, u32) = (960, 760);
const COMMAND_LIMIT: u64 = 4096;
const KEYS: &str = "жщфывапролдэюбь";
type Rect = [f64; 4]; // x0, y0, x1, y1, at scale 1.

struct Cpu {
    painter: CpuPainter,
    background_painter: CpuPainter,
    pixels: Vec<u8>,
    background: Vec<u8>,
    glyphs: Vec<(Rect, Rect)>,
    size: (u32, u32),
    frames: u64,
}
impl Cpu {
    fn new(size: (u32, u32)) -> Self {
        let bytes = size.0 as usize * size.1 as usize * 4;
        Self {
            painter: CpuPainter::new(
                std::thread::available_parallelism()
                    .map_or(4, |n| n.get())
                    .clamp(1, 6),
            ),
            background_painter: CpuPainter::new(1),
            pixels: vec![0; bytes],
            background: vec![0; bytes],
            glyphs: vec![],
            size,
            frames: 0,
        }
    }
    fn paint<S: 'static>(&mut self, rt: &mut Runtime<S>) -> Result<(), String> {
        self.glyphs = rt
            .instances
            .iter()
            .filter(|i| i.kind() == Some(Kind::Glyph))
            .map(|i| {
                let [x, y, w, h] = i.rect.map(f64::from);
                ([x, y, x + w, y + h], i.clip.map(f64::from))
            })
            .collect();
        self.painter.fill_masks(&mut rt.text.atlas);
        let scene = Scene::new(
            &rt.instances,
            &rt.text.atlas,
            &rt.images,
            self.size,
            rt.clear_color(),
        )
        .srgb_blend(rt.srgb_blend())
        .native_surfaces(!rt.surfaces.is_empty())
        .font_smoothing(rt.font_smoothing());
        self.painter
            .paint(
                &scene,
                &mut Target::new(&mut self.pixels, self.size.0, self.size.1),
            )
            .map_err(|why| format!("NeedsGpu:{why:?}"))?;
        // A second retained buffer removes only glyphs. Pixel differences therefore
        // prove ink was painted, rather than accepting a background or caret rectangle.
        let without_glyphs: Vec<_> = rt
            .instances
            .iter()
            .copied()
            .filter(|i| i.kind() != Some(Kind::Glyph))
            .collect();
        let scene = Scene::new(
            &without_glyphs,
            &rt.text.atlas,
            &rt.images,
            self.size,
            rt.clear_color(),
        )
        .srgb_blend(rt.srgb_blend())
        .native_surfaces(!rt.surfaces.is_empty())
        .font_smoothing(rt.font_smoothing());
        self.background_painter
            .paint(
                &scene,
                &mut Target::new(&mut self.background, self.size.0, self.size.1),
            )
            .map_err(|why| format!("NeedsGpu:{why:?}"))?;
        self.frames += 1;
        Ok(())
    }
    fn ink(&self, rect: Rect) -> bool {
        if !self.glyphs.iter().any(|(bounds, clip)| {
            let overlap = intersection(rect, *bounds);
            intersection(rect, *clip) == rect && overlap[2] > overlap[0] && overlap[3] > overlap[1]
        }) {
            return false;
        }
        let x0 = rect[0].ceil().max(0.0) as u32;
        let y0 = rect[1].ceil().max(0.0) as u32;
        let x1 = rect[2].floor().min(f64::from(self.size.0)).max(0.0) as u32;
        let y1 = rect[3].floor().min(f64::from(self.size.1)).max(0.0) as u32;
        (y0..y1).any(|y| {
            (x0..x1).any(|x| {
                let i = (y as usize * self.size.0 as usize + x as usize) * 4;
                self.pixels[i..i + 3] != self.background[i..i + 3]
            })
        })
    }
}
fn intersection(a: Rect, b: Rect) -> Rect {
    [
        a[0].max(b[0]),
        a[1].max(b[1]),
        a[2].min(b[2]),
        a[3].min(b[3]),
    ]
}
#[derive(Debug, Default)]
struct Text {
    value: String,
    chars: Vec<(std::ops::Range<usize>, Rect, Rect)>,
}
impl Text {
    fn painted(&self, needle: &str, cpu: &Cpu) -> bool {
        self.value.match_indices(needle).any(|(start, _)| {
            let end = start + needle.len();
            let mut covered = start;
            for (bytes, rect, clip) in &self.chars {
                if bytes.end <= start || bytes.start >= end {
                    continue;
                }
                if bytes.start > covered
                    || rect[2] <= rect[0]
                    || rect[3] <= rect[1]
                    || intersection(*rect, *clip) != *rect
                    || !cpu.ink(*rect)
                {
                    return false;
                }
                covered = bytes.end;
            }
            covered >= end
        })
    }
}
fn transcript_text_owner(key: &str) -> bool {
    key.starts_with("body-")
        || key.strip_prefix("fragment-").is_some_and(|part| {
            part.rsplit_once(':').is_some_and(|(_, ordinal)| {
                !ordinal.is_empty() && ordinal.bytes().all(|c| c.is_ascii_digit())
            })
        })
}

fn texts<S: 'static>(rt: &Runtime<S>) -> Result<BTreeMap<String, Text>, String> {
    let tree = rt.accessibility_tree();
    let nodes: HashMap<_, _> = tree.nodes.iter().map(|(id, n)| (*id, n)).collect();
    let elements = rt.elements();
    let owners: HashMap<_, _> = elements
        .iter()
        .filter_map(|e| e.key.as_deref().map(|key| (key, e)))
        .collect();
    let mut result = BTreeMap::<String, Text>::new();
    fn walk(
        id: NodeId,
        nodes: &HashMap<NodeId, &Node>,
        owners: &HashMap<&str, &rune::ElementInfo>,
        origin: [f64; 2],
        owner: Option<String>,
        clip: Rect,
        root: bool,
        out: &mut BTreeMap<String, Text>,
    ) -> Result<(), String> {
        let node = nodes.get(&id).ok_or("IncompleteAccessibilityTree")?;
        let mut origin = origin;
        if let Some(t) = node.transform() {
            let c = t.as_coeffs();
            if c[..4] != [1.0, 0.0, 0.0, 1.0] {
                return Err("UnsupportedTextTransform".into());
            }
            if !root {
                origin[0] += c[4];
                origin[1] += c[5];
            }
        }
        let owner = node
            .author_id()
            .filter(|key| {
                owners.contains_key(*key) && (*key == "composer" || transcript_text_owner(key))
            })
            .map(str::to_owned)
            .or(owner);
        let mut clip = clip;
        // Text bounds include rounded advance geometry, not a clipping surface.
        // The final ink check uses each painted glyph instance's actual shader clip.
        let bounds = node.bounds().map(|r| {
            [
                r.x0 + origin[0],
                r.y0 + origin[1],
                r.x1 + origin[0],
                r.y1 + origin[1],
            ]
        });
        if node.clips_children() {
            if let Some(bounds) = bounds {
                clip = intersection(clip, bounds);
            }
        }
        if node.role() == Role::TextRun {
            if let (Some(owner), Some(rect), Some(value)) = (owner.as_ref(), bounds, node.value()) {
                let lengths = node.character_lengths();
                let positions = node
                    .character_positions()
                    .ok_or("MissingCharacterPositions")?;
                let widths = node.character_widths().ok_or("MissingCharacterWidths")?;
                if lengths.len() != positions.len() || lengths.len() != widths.len() {
                    return Err("InvalidCharacterGeometry".into());
                }
                let text = out.entry(owner.clone()).or_default();
                let base = text.value.len();
                let mut offset = 0;
                for ((length, position), width) in lengths.iter().zip(positions).zip(widths) {
                    let next = offset + usize::from(*length);
                    if next > value.len() || !value.is_char_boundary(next) {
                        return Err("InvalidCharacterBytes".into());
                    }
                    let x = if node.text_direction()
                        == Some(rune::accesskit::TextDirection::RightToLeft)
                    {
                        rect[2] - f64::from(*position) - f64::from(*width)
                    } else {
                        rect[0] + f64::from(*position)
                    };
                    text.chars.push((
                        base + offset..base + next,
                        [x, rect[1], x + f64::from(*width), rect[3]],
                        clip,
                    ));
                    offset = next;
                }
                if offset != value.len() {
                    return Err("IncompleteCharacterGeometry".into());
                }
                text.value.push_str(value);
            }
        }
        for child in node.children() {
            walk(
                *child,
                nodes,
                owners,
                origin,
                owner.clone(),
                clip,
                false,
                out,
            )?;
        }
        Ok(())
    }
    let root = tree.tree.as_ref().ok_or("MissingAccessibilityRoot")?.root;
    walk(
        root,
        &nodes,
        &owners,
        [0.0, 0.0],
        None,
        [0.0, 0.0, f64::from(rt.viewport.0), f64::from(rt.viewport.1)],
        true,
        &mut result,
    )?;
    Ok(result)
}
fn markers(value: &str) -> impl Iterator<Item = &str> {
    value
        .as_bytes()
        .windows(11)
        .enumerate()
        .filter_map(move |(i, b)| {
            (b[..2] == *b"MK"
                && b[2..4].iter().all(u8::is_ascii_uppercase)
                && b[4..10].iter().all(u8::is_ascii_digit)
                && b[10] == b'K')
                .then(|| &value[i..i + 11])
        })
}
enum Waiting {
    Arm,
    Key(String),
    Clear,
}
struct Pending {
    id: u64,
    until: Instant,
    kind: Waiting,
}
fn reply(id: u64, value: Value) -> Result<(), String> {
    let mut value = value.as_object().ok_or("InvalidReply")?.clone();
    value.insert("id".into(), id.into());
    value.insert("ok".into(), true.into());
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, &value).map_err(|_| "OutputClosed")?;
    writeln!(out)
        .and_then(|_| out.flush())
        .map_err(|_| "OutputClosed".into())
}
fn key(rt: &mut Runtime<crate::State>, key: Key, mods: Mods) {
    rt.key(KeyEvent { key, mods });
}
pub fn run() {
    if let Err(error) = measure() {
        eprintln!("RuneLatency:{error}");
        std::process::exit(1);
    }
}
fn measure() -> Result<(), String> {
    for name in ["RUNE_BACKEND", "RUNE_WORKSPACE", "RUNE_SESSION"] {
        if crate::platform::setting(name).is_none() {
            return Err("ExplicitScopedBackendRequired".into());
        }
    }
    let epoch = Instant::now();
    let thread = std::thread::current();
    let wake = std::sync::Arc::new(move || thread.unpark());
    let (out, commands) = mpsc::sync_channel::<Result<Value, &'static str>>(4);
    let input_thread = std::thread::current();
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            let mut line = Vec::new();
            let read = (&mut input)
                .take(COMMAND_LIMIT + 1)
                .read_until(b'\n', &mut line);
            let value = match read {
                Ok(0) => return,
                Ok(_) if line.len() <= COMMAND_LIMIT as usize && line.last() == Some(&b'\n') => {
                    serde_json::from_slice(&line).map_err(|_| "InvalidJsonLine")
                }
                _ => Err("InputLimitOrReadFailure"),
            };
            let failed = value.is_err();
            if out.send(value).is_err() {
                return;
            }
            input_thread.unpark();
            if failed {
                return;
            }
        }
    });
    let mut state = crate::init();
    crate::setup(&mut state, wake);
    let mut rt = Runtime::new(
        state,
        crate::view,
        (SIZE.0 as f32, SIZE.1 as f32),
        Env::new(false, 1.0),
    );
    let (sans, mono) = rune_theme_codenomad::layout::font_families();
    rt.set_font_families(sans, mono);
    // App RuntimeConfig defaults to sRGB; bare Runtime defaults to linear blending.
    rt.set_srgb_blend(true);
    rt.poll = Some(crate::poll);
    attach_text(&mut rt.text.atlas);
    let mut cpu = Cpu::new(SIZE);
    let mut last = Instant::now();
    let mut pending: Option<Pending> = None;
    let mut shown = BTreeMap::<String, f64>::new();
    let mut armed = false;
    let mut typed = String::new();
    let mut last_input = Instant::now();
    loop {
        if last_input.elapsed() > Duration::from_secs(240) {
            return Err("CommandIdleTimeout".into());
        }
        let now = Instant::now();
        rt.frame(now.duration_since(last).as_secs_f64());
        last = now;
        cpu.paint(&mut rt)?;
        let text = texts(&rt)?;
        let mut visible = Vec::new();
        if armed {
            for (owner, text) in &text {
                if !transcript_text_owner(owner) {
                    continue;
                }
                for marker in markers(&text.value) {
                    if !shown.contains_key(marker) && text.painted(marker, &cpu) {
                        visible.push(marker.to_owned());
                    }
                }
            }
        }
        let key_visible = pending.as_ref().is_some_and(|p| match &p.kind {
            Waiting::Key(expected) => text
                .get("composer")
                .is_some_and(|t| t.painted(expected, &cpu)),
            _ => false,
        });
        let painted_at = epoch.elapsed().as_secs_f64() * 1000.0;
        for marker in visible {
            if shown.len() >= 4096 {
                return Err("MarkerObservationLimit".into());
            }
            shown.entry(marker).or_insert(painted_at);
        }
        if let Some(p) = &pending {
            if Instant::now() >= p.until {
                return Err("ObservationTimeout".into());
            }
            let ready = match &p.kind {
                Waiting::Arm => {
                    rt.state.phase == crate::Phase::Ready && !rt.state.messages.is_empty()
                }
                Waiting::Key(_) => key_visible,
                Waiting::Clear => {
                    rt.state.draft.text.is_empty()
                        && text.get("composer").is_none_or(|t| t.value.is_empty())
                }
            };
            if ready {
                let p = pending.take().unwrap();
                if matches!(p.kind, Waiting::Arm) {
                    let (x, y) = rt.find("composer").ok_or("ComposerNotMounted")?;
                    rt.pointer_down(x, y);
                    rt.pointer_up(x, y);
                    rt.update(|_, tx| tx.scroll_to_bottom_instant("history"));
                    armed = true;
                    shown.clear();
                }
                reply(
                    p.id,
                    if matches!(p.kind, Waiting::Key(_)) {
                        json!({"shownAtMs":painted_at})
                    } else {
                        json!({})
                    },
                )?;
            }
        }
        if pending.is_none() {
            match commands.try_recv() {
                Ok(command) => {
                    last_input = Instant::now();
                    let command = command.map_err(str::to_owned)?;
                    let id = command["id"].as_u64().ok_or("RequestIdRequired")?;
                    let op = command["op"].as_str().ok_or("OperationRequired")?;
                    let until = Instant::now() + Duration::from_secs(45);
                    match op {
                        "clock" => reply(
                            id,
                            json!({"nowMs":epoch.elapsed().as_secs_f64()*1000.0,"clock":"monotonic-ms","stage":"cpu-buffer"}),
                        )?,
                        "arm" => {
                            armed = false;
                            pending = Some(Pending {
                                id,
                                until,
                                kind: Waiting::Arm,
                            });
                        }
                        "collect" => {
                            let candidates: Vec<_> = text.iter().flat_map(|(owner,t)| markers(&t.value).map(move |m| (owner,t,m)))
                                .take(64).map(|(owner,t,m)| { let start=t.value.find(m).unwrap(); json!({"owner":owner,"marker":m,"painted":t.painted(m,&cpu),
                                    "chars":t.chars.iter().filter(|(bytes,_,_)|bytes.start<start+m.len()&&bytes.end>start).take(32).map(|(_,rect,clip)|json!({"rect":rect,"clip":clip,"ink":cpu.ink(*rect)})).collect::<Vec<_>>() }) }).collect();
                            reply(
                                id,
                                json!({"shown":shown,"paintedFrames":cpu.frames,"diagnostic":{
                                "messages":rt.state.messages.len(),"tailMarkers":rt.state.messages.last().map(|m|markers(&m.body).map(str::to_owned).collect::<Vec<_>>()),"candidates":candidates}}),
                            )?;
                        }
                        "typeKey" => {
                            if !armed {
                                return Err("NotArmed".into());
                            }
                            let index = command["index"]
                                .as_u64()
                                .filter(|i| *i < 1024)
                                .ok_or("InvalidKeyIndex")?
                                as usize;
                            let c = KEYS.chars().nth(index % 14).unwrap();
                            if typed.len() >= 256 {
                                return Err("KeyBufferLimit".into());
                            }
                            typed.push(c);
                            key(&mut rt, Key::Text(c.to_string()), Mods::default());
                            pending = Some(Pending {
                                id,
                                until,
                                kind: Waiting::Key(typed.clone()),
                            });
                        }
                        "clear" => {
                            for _ in typed.chars() {
                                key(&mut rt, Key::Backspace, Mods::default());
                            }
                            typed.clear();
                            pending = Some(Pending {
                                id,
                                until,
                                kind: Waiting::Clear,
                            });
                        }
                        "stop" => return reply(id, json!({})),
                        _ => return Err("UnknownOperation".into()),
                    }
                }
                Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        std::thread::park_timeout(Duration::from_millis(8));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn view(mode: &u8, cx: &mut rune::Cx<u8>) -> rune::El {
        let height = if *mode == 0 { 20.0 } else { 100.0 };
        let width = if *mode == 2 { 90.0 } else { 300.0 };
        rune_theme_codenomad::layout::render(cx, |_| {
            rune::col()
                .fill(rune_theme_codenomad::tokens(false).color("surface-canvas"))
                .child(
                    rune::col()
                        .key("clip-box")
                        .w(width)
                        .min_w(width)
                        .max_w(width)
                        .h(height)
                        .min_h(height)
                        .max_h(height)
                        .clip_soft(0.0)
                        .child(
                            rune::text("MKAA000000K")
                                .key("body-test")
                                .absolute(0.0, 40.0)
                                .selectable(true),
                        ),
                )
        })
    }
    #[test]
    fn only_character_ink_inside_the_real_clip_qualifies() {
        let mut rt = Runtime::new(0, view, (300.0, 100.0), Env::new(false, 1.0));
        rt.set_srgb_blend(true);
        attach_text(&mut rt.text.atlas);
        let mut cpu = Cpu::new((300, 100));
        let since = Instant::now();
        rt.frame(since.elapsed().as_secs_f64());
        cpu.paint(&mut rt).unwrap();
        let geometry = rt.elements();
        let clip = geometry
            .iter()
            .find(|e| e.key.as_deref() == Some("clip-box"))
            .unwrap();
        let marker = geometry
            .iter()
            .find(|e| e.key.as_deref() == Some("body-test"))
            .unwrap();
        assert_eq!(clip.rect[3], 20.0, "clip geometry: {:?}", clip.rect);
        assert!(
            marker.rect[1] >= clip.rect[1] + 40.0,
            "marker geometry: {:?}",
            marker.rect
        );
        assert_eq!(
            marker.visible[3], 0.0,
            "marker actual clip: {:?}",
            marker.visible
        );
        assert!(
            rt.elements()
                .iter()
                .any(|e| e.key.as_deref() == Some("body-test")
                    && e.text.as_deref().is_some_and(|t| t.contains("MKAA000000K")))
        );
        let clipped = texts(&rt).unwrap();
        assert!(
            !clipped
                .get("body-test")
                .is_some_and(|t| t.painted("MKAA000000K", &cpu)),
            "clipped character geometry: {clipped:?}"
        );
        rt.update(|mode, tx| {
            *mode = 2;
            tx.instant();
        });
        rt.frame(since.elapsed().as_secs_f64());
        cpu.paint(&mut rt).unwrap();
        let partial = texts(&rt).unwrap();
        assert!(
            cpu.pixels
                .chunks_exact(4)
                .zip(cpu.background.chunks_exact(4))
                .any(|(a, b)| a[..3] != b[..3]),
            "partially clipped marker must have real ink"
        );
        assert!(
            !partial["body-test"].painted("MKAA000000K", &cpu),
            "partially clipped chars: {partial:?}"
        );
        rt.update(|mode, tx| {
            *mode = 1;
            tx.instant();
        });
        rt.frame(since.elapsed().as_secs_f64());
        cpu.paint(&mut rt).unwrap();
        let geometry = rt.elements();
        let clip = geometry
            .iter()
            .find(|e| e.key.as_deref() == Some("clip-box"))
            .unwrap();
        let marker = geometry
            .iter()
            .find(|e| e.key.as_deref() == Some("body-test"))
            .unwrap();
        assert_eq!(
            clip.rect[3], 100.0,
            "positive clip geometry: {:?}",
            clip.rect
        );
        assert!(
            marker.visible[3] > 0.0,
            "positive marker geometry: {:?}",
            marker.visible
        );
        let text = texts(&rt).unwrap();
        let ink = cpu
            .pixels
            .chunks_exact(4)
            .zip(cpu.background.chunks_exact(4))
            .filter(|(a, b)| a[..3] != b[..3])
            .count();
        assert!(
            text["body-test"].painted("MKAA000000K", &cpu),
            "positive chars={text:?}; ink pixels={ink}; glyphs={}",
            rt.instances
                .iter()
                .filter(|i| i.kind() == Some(Kind::Glyph))
                .count()
        );
        cpu.pixels.copy_from_slice(&cpu.background);
        assert!(!text["body-test"].painted("MKAA000000K", &cpu));
    }
}
