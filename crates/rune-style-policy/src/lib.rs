//! Conservative AST boundary: application code composes semantic theme components.
//! Raw style APIs are forbidden independently of the expression supplying their values.
use proc_macro2::Span;
use syn::{
    visit::{self, Visit},
    *,
};

const METHODS: &str = "w set_w h set_h size set_size aspect_ratio aspect_fit w_full set_w_full w_fit set_w_fit w_frac set_w_frac h_full set_h_full h_fit set_h_fit h_frac set_h_frac grow set_grow padding set_padding px set_px py set_py pt set_pt pb set_pb pl set_pl pr set_pr gap set_gap gaps set_gaps center_y set_center_y center set_center justify_between set_justify_between justify_end set_justify_end flex_wrap set_flex_wrap items_start items_end items_center items_stretch self_auto self_start self_center self_end self_stretch justify_start justify_center justify_around justify_evenly min_w max_w min_h max_h set_min_w set_max_w set_min_h set_max_h mx my mt mb ml mr set_mx set_my set_mt set_mb set_ml set_mr shrink set_shrink equal_columns grid_cell absolute set_absolute pin set_pin fill set_fill radius set_radius continuous_corners corners border set_border border_sides border_layout border_gradient border_dash border_dash_phase shadow box_shadow gradient radial_gradient linear_gradient shape pixels pixels_fit outline opacity set_opacity blur blur_motion dim layer_opacity dissolve hover set_hover press font set_font color set_color alpha from_oklab from_rgba rgb rgba hex hsl hsla growth virtual_rows auto_grow text_input placeholder motion transition spring animate live_opacity live_blur live_offset live_scale live_rotation live_trim live_fill live_rect live_text_color live_border live_shadow live_gradient";
const PINNED_BUILDERS: &str = "above absolute advance_in align anchor_rect anchored anchored_fit anchored_round anchored_unscaled animate_edit_layout animate_layout animated_changes arrives_whole aspect_fit aspect_ratio backdrop_blur blur blur_motion border border_dash border_dash_phase border_gradient border_layout border_sides box_shadow cache cache_key caret center center_y chain_hover_change_any child_exit chromium clip_corners clip_fade clip_fade_linear clip_rounded clip_soft color continuous_corners core_animation corners cursor cutout_circle cycle decorations dim dir dissolve enter_delay equal_columns exact_lines fill flex_wrap fold_feather fold_glide font gap gaps gradient grid_cell group_color group_opacity grow growth h h_full hairline hit hold_landing_width hover hover_alone hover_delays hover_group hover_group_focus hover_group_shared hover_motion hover_motion_within hover_within_curves icon_one_color icon_rotation ime_cursor ime_option_as_alt instant_changes items_center items_end items_start items_stretch joined_row_face justify justify_around justify_between justify_center justify_end justify_evenly justify_start layer_opacity lead linear_gradient live_border live_gradient live_shadow live_text live_text_color looping mark matched matched_crop max_h max_lines max_w mb min_h min_w mirror_in_rtl ml motion motion_intent motion_snaps mr mt mx my native_surface no_window_drag offset offset_motion opacity opacity_motion origin outline outside_list_disc padding paint_contained paint_order pb pill_colors pill_icon pill_style pin pixel_snap pixels pixels_fit pl placeholder placeholder_font pr press press_color press_scale pt px py radial_gradient radius raise reveal rich_style rotate rotate_motion rounded_lines scale scale_motion selection_color selection_style self_center self_end self_start self_stretch sequence set_absolute set_align set_aspect_ratio set_border set_center set_center_y set_clip_soft set_color set_fill set_flex_wrap set_font set_gap set_gaps set_grow set_h set_h_full set_hover set_items_center set_items_end set_items_start set_items_stretch set_justify_between set_justify_center set_justify_end set_justify_start set_max_h set_max_w set_mb set_min_h set_min_w set_ml set_mr set_mt set_mx set_my set_opacity set_padding set_pb set_pin set_pl set_pr set_press set_pt set_px set_py set_radius set_self_center set_self_end set_self_start set_self_stretch set_shrink set_size set_truncate set_w set_w_frac set_w_full shadow shape shrink size span_radius span_ring span_rings spans sticky_bottom sticky_left sticky_top sticky_top_showing streaming strike strikes stuck_fade stuck_reveal stuck_shadow surface_anchor surface_unscaled system_material system_material_with text_case text_highlight text_highlights time_scale token_motion trace_name trace_namespace transition truncate truncate_fade truncate_fade_width truncate_head truncate_middle unmirrored video w w_frac w_full whole_rows width_leads window_drag wrap_scroll_area";
const TYPES: &str = "Color TextStyle Style Shadow Spring GrowthSpec Insets Edges Corners Gradient Border Kit Theme Dimension";
const ADDITIONAL_VISUAL: &str = "focus_ring focus_ring_for focus_within_ring focus_visible_within_ring focus_highlight focus_fill focus_border focus_within_flat no_focus_ring effect effect_bleed effect_backdrop effect_data grid_caret drag_threshold help_above help_side by_line dir_by_paragraph pill pills pill_with_image pill_image inline inline_icon inline_image bind_path ride_trailing scroll_edge_fade scroll_fade scroll_margin virtualize virtual_overscan svg load_mime anchored_in window_resize ime_option_as_alt_mode hover_tracks_bounds frame_motion transition_motion enter_in_instant matched_motion matched_in_place loop_times span_box span_boxes overline overlines line_fill line_fills elide_middle elide_head link_cursor align_y set_align_y text_indent set_text_indent pixels_wrap pixels_tile pixels_tint image_filter hover_fill press_fill hover_border press_border press_offset cutout_circles press_motion highlight_texts virtual_items hover_group_pointer group_focus_within group_motion on_edge_drag";
const FOCUS_VISUAL: &str = "focus_ring focus_ring_for focus_ring_radius focus_within_ring focus_visible_within_ring no_focus_ring";
fn forbidden(name: &str) -> bool {
    METHODS
        .split_whitespace()
        .chain(PINNED_BUILDERS.split_whitespace())
        .chain(TYPES.split_whitespace())
        .chain(ADDITIONAL_VISUAL.split_whitespace())
        .chain(FOCUS_VISUAL.split_whitespace())
        .any(|n| n == name)
        || ["foreground", "caption_color", "help_look"].contains(&name)
        || name.starts_with("set_items_")
        || name.starts_with("set_justify_")
        || name.starts_with("set_self_")
        || [
            "foreground",
            "caption_color",
            "help_look",
            "force_focus_rings",
            "titlebar_height",
            "set_titlebar",
            "reduced_motion",
            "zoom",
            "set_emoji_family",
            "add_font",
            "window_backdrop",
            "set_window_backdrop",
            "set_window_backdrop_supported",
            "set_window_manager_state",
            "set_renderer_kind",
            "set_safe_area",
        ]
        .contains(&name)
}
#[derive(Debug, PartialEq, Eq)]
pub struct Violation {
    pub line: usize,
    pub message: String,
}
#[derive(Default)]
struct Policy {
    errors: Vec<Violation>,
}
impl Policy {
    fn reject(&mut self, span: Span, name: &str) {
        self.errors.push(Violation {
            line: span.start().line,
            message: format!(
                "raw style API `{name}`: use rune-theme-codenomad semantic components"
            ),
        });
    }
    fn check_external_path(&mut self, names: &[String], span: Span) {
        if names.first().is_some_and(|n| n == "rune_kit") {
            self.reject(span, "rune-kit is adapted inside the shared theme crate");
        }
        if names.first().is_some_and(|n| n == "rune") {
            let allowed = [
                "AppSpec",
                "Cx",
                "El",
                "ScrollSpec",
                "Tx",
                "col",
                "row",
                "text",
                "el",
                "run",
                "Waker",
                "WindowHandle",
                "WindowSpec",
                "open_window",
                "Env",
                "Runtime",
                "Image",
                "ImageCache",
                "Live",
                "TextEdit",
                "Key",
                "KeyEvent",
                "Ime",
                "WheelEvent",
                "KeyPlatform",
                "Keybind",
                "Chord",
                "ChordKey",
                "ChordMod",
                "HasPopup",
                "Orientation",
                "AutoComplete",
                "PhysicalInput",
                "PhysicalKeyCode",
                "Mods",
                "TouchPhase",
                "edit",
                "file_dialog",
                "clipboard",
            ];
            if names.len() < 2 || !allowed.contains(&names[1].as_str()) {
                self.reject(span, "unreviewed Rune API or module alias");
            }
        }
    }
    fn check_import(&mut self, tree: &UseTree, prefix: &mut Vec<String>) {
        match tree {
            UseTree::Path(p) => {
                prefix.push(p.ident.to_string());
                self.check_import(&p.tree, prefix);
                prefix.pop();
            }
            UseTree::Group(g) => {
                for item in &g.items {
                    self.check_import(item, prefix);
                }
            }
            UseTree::Name(n) => {
                prefix.push(n.ident.to_string());
                self.check_external_path(prefix, n.ident.span());
                prefix.pop();
            }
            UseTree::Rename(n) => {
                prefix.push(n.ident.to_string());
                self.check_external_path(prefix, n.ident.span());
                prefix.pop();
            }
            UseTree::Glob(n) => {
                if !prefix.first().is_some_and(|root| {
                    ["codenomad_client", "super", "self", "crate"].contains(&root.as_str())
                }) {
                    self.reject(n.star_token.span, "glob import");
                }
            }
        }
    }
}
impl<'ast> Visit<'ast> for Policy {
    fn visit_expr_field(&mut self, node: &'ast ExprField) {
        if let Member::Named(member) = &node.member {
            if ["size", "min_size", "families", "fonts"].contains(&member.to_string().as_str()) {
                self.reject(member.span(), "application visual configuration access");
            }
        }
        visit::visit_expr_field(self, node);
    }
    fn visit_pat_struct(&mut self, node: &'ast PatStruct) {
        if node
            .path
            .segments
            .iter()
            .any(|segment| segment.ident == "AppSpec")
        {
            self.reject(
                node.path.segments[0].ident.span(),
                "application visual configuration pattern",
            );
        }
        visit::visit_pat_struct(self, node);
    }
    fn visit_path(&mut self, node: &'ast Path) {
        let names: Vec<_> = node.segments.iter().map(|s| s.ident.to_string()).collect();
        if let Some(first) = node.segments.first() {
            self.check_external_path(&names, first.ident.span());
        }
        visit::visit_path(self, node);
    }
    fn visit_item_use(&mut self, node: &'ast ItemUse) {
        self.check_import(&node.tree, &mut Vec::new());
        visit::visit_item_use(self, node);
    }
    fn visit_item_extern_crate(&mut self, node: &'ast ItemExternCrate) {
        self.reject(node.ident.span(), "unreviewed extern crate alias");
    }
    fn visit_item_type(&mut self, node: &'ast ItemType) {
        if let Type::Path(path) = node.ty.as_ref() {
            if path.path.segments.iter().any(|s| s.ident == "AppSpec") {
                self.reject(node.ident.span(), "AppSpec type alias");
            }
        }
        visit::visit_item_type(self, node);
    }
    fn visit_expr_assign(&mut self, node: &'ast ExprAssign) {
        if let Expr::Field(field) = node.left.as_ref() {
            if let Member::Named(member) = &field.member {
                if ["size", "min_size", "families", "fonts"].contains(&member.to_string().as_str())
                {
                    self.reject(member.span(), "application visual configuration mutation");
                }
            }
        }
        visit::visit_expr_assign(self, node);
    }
    fn visit_item_mod(&mut self, node: &'ast ItemMod) {
        let qualification = node.ident == "probes" && node.content.is_none() && node.attrs.len() == 2
            && node.attrs.iter().any(|a| matches!(&a.meta, Meta::List(m)
                if m.path.is_ident("cfg") && m.tokens.to_string() == "all (feature = \"test-support\" , not (target_arch = \"wasm32\"))"))
            && node.attrs.iter().any(|a| matches!(&a.meta, Meta::NameValue(m)
                if m.path.is_ident("path") && matches!(&m.value, Expr::Lit(e)
                    if matches!(&e.lit, Lit::Str(s) if s.value() == "../tests/probes/mod.rs"))));
        if !qualification {
            visit::visit_item_mod(self, node);
        }
    }
    fn visit_attribute(&mut self, node: &'ast Attribute) {
        let name = node.path().segments.last().unwrap().ident.to_string();
        if name == "derive" {
            let _ = node.parse_nested_meta(|meta| {
                let n = meta.path.segments.last().unwrap().ident.to_string();
                if ![
                    "Clone",
                    "Copy",
                    "Debug",
                    "Default",
                    "PartialEq",
                    "Eq",
                    "Hash",
                    "Ord",
                    "PartialOrd",
                ]
                .contains(&n.as_str())
                {
                    self.reject(
                        meta.path.segments[0].ident.span(),
                        "unreviewed derive macro",
                    );
                }
                Ok(())
            });
        } else if !["cfg", "test", "ignore", "allow", "deny", "forbid", "doc"]
            .contains(&name.as_str())
        {
            self.reject(
                node.path().segments[0].ident.span(),
                "unreviewed attribute macro",
            );
        }
    }
    fn visit_expr_struct(&mut self, node: &'ast ExprStruct) {
        for field in &node.fields {
            if let Member::Named(member) = &field.member {
                if ["families", "fonts", "min_size"].contains(&member.to_string().as_str())
                    || (node.path.segments.last().unwrap().ident == "AppSpec" && member == "size")
                {
                    self.reject(member.span(), "application visual configuration field");
                }
            }
        }
        visit::visit_expr_struct(self, node);
    }
    fn visit_expr_path(&mut self, node: &'ast ExprPath) {
        let names: Vec<_> = node
            .path
            .segments
            .iter()
            .map(|s| s.ident.to_string())
            .collect();
        if names.windows(2).any(|pair| pair == ["AppSpec", "new"]) {
            self.reject(node.path.segments[0].ident.span(), "AppSpec::new");
        }
        if names.len() > 1 && names != ["web_sys", "Location", "origin"] {
            let last = node.path.segments.last().unwrap();
            if forbidden(&last.ident.to_string()) {
                self.reject(last.ident.span(), &last.ident.to_string());
            }
        }
        visit::visit_expr_path(self, node);
    }
    fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
        if forbidden(&node.method.to_string()) {
            self.reject(node.method.span(), &node.method.to_string());
        }
        visit::visit_expr_method_call(self, node);
    }
    fn visit_path_segment(&mut self, node: &'ast PathSegment) {
        // Type names remain reserved. Bare local values may share builder names
        // (pagination cursor, callback w); method calls and qualified paths are
        // checked by their own visitors.
        if TYPES
            .split_whitespace()
            .any(|name| name == node.ident.to_string())
        {
            self.reject(node.ident.span(), &node.ident.to_string());
        }
        visit::visit_path_segment(self, node);
    }
    fn visit_use_tree(&mut self, node: &'ast UseTree) {
        match node {
            UseTree::Name(n) if forbidden(&n.ident.to_string()) => {
                self.reject(n.ident.span(), &n.ident.to_string())
            }
            UseTree::Rename(n)
                if forbidden(&n.ident.to_string())
                    || ["rune", "rune_kit", "AppSpec"].contains(&n.ident.to_string().as_str()) =>
            {
                self.reject(n.ident.span(), &n.ident.to_string())
            }
            _ => {}
        }
        visit::visit_use_tree(self, node);
    }
    fn visit_macro(&mut self, node: &'ast Macro) {
        let name = node.path.segments.last().unwrap().ident.to_string();
        // Only macros whose expansion cannot construct application styles are admitted.
        // Token arguments are parsed as expressions, so nested style calls remain checked.
        let allowed = [
            "format",
            "format_args",
            "println",
            "eprintln",
            "panic",
            "assert",
            "assert_eq",
            "assert_ne",
            "debug_assert",
            "debug_assert_eq",
            "debug_assert_ne",
            "vec",
            "matches",
            "json",
            "env",
            "option_env",
            "include_str",
            "include_bytes",
            "concat",
            "stringify",
            "cfg",
        ];
        let path: Vec<_> = node
            .path
            .segments
            .iter()
            .map(|s| s.ident.to_string())
            .collect();
        let pin = path == ["std", "pin", "pin"] || path == ["core", "pin", "pin"];
        // The Android entry point: it exports a function that calls the named one.
        let entry = path == ["rune", "android_main"];
        if !allowed.contains(&name.as_str()) && !pin && !entry {
            self.reject(
                node.path.segments[0].ident.span(),
                &format!("unreviewed macro {name}"),
            );
        }
        if let Ok(args) =
            node.parse_body_with(syn::punctuated::Punctuated::<Expr, Token![,]>::parse_terminated)
        {
            for arg in &args {
                self.visit_expr(arg);
            }
        } else {
            inspect_tokens(self, node.tokens.clone());
        }
    }
}
fn inspect_tokens(policy: &mut Policy, stream: proc_macro2::TokenStream) {
    let mut access = false;
    let mut colon = false;
    for token in stream {
        let next_colon = matches!(&token, proc_macro2::TokenTree::Punct(p) if p.as_char() == ':');
        let next_access = matches!(&token, proc_macro2::TokenTree::Punct(p) if p.as_char() == '.')
            || (colon && next_colon);
        match token {
            proc_macro2::TokenTree::Ident(i)
                if (access && forbidden(&i.to_string()))
                    || TYPES.split_whitespace().any(|name| name == i.to_string())
                    || i == "AppSpec" =>
            {
                policy.reject(i.span(), &i.to_string())
            }
            proc_macro2::TokenTree::Group(g) => inspect_tokens(policy, g.stream()),
            _ => {}
        }
        access = next_access;
        colon = next_colon;
    }
}
pub fn check(source: &str) -> syn::Result<Vec<Violation>> {
    let file = syn::parse_file(source)?;
    let mut policy = Policy::default();
    policy.visit_file(&file);
    Ok(policy.errors)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_literals_aliases_calculations_ufcs_structs_and_macros() {
        for source in [
            "fn v() { el.padding(12.0); }",
            "fn v() { let p = token.px() * 2.; el.padding(p); }",
            "use rune::Color as Ink;",
            "use rune::color::hex as pigment;",
            "fn v() { rune::El::padding(el, computed()); }",
            "fn v() { let f = rune::El::fill; }",
            "fn v() { let x = rune::TextStyle { size: 12., ..Default::default() }; }",
            "macro_rules! paint { ($e:expr) => { $e.padding(2.) } }",
            "fn v(){ custom!(anything); }",
            "fn v(){ vec![el.fill(c)]; }",
            "use rune::*;",
            "use rune as r; fn v(){ r::color::hex(\"ffffff\"); }",
            "use rune::tok as x;",
            "use rune_kit::Button as B;",
            "use rune::AppSpec as Window;",
            "type Window<S> = rune::AppSpec<S>;",
            "fn v(){ let x = rune::AppSpec::new(title, dims, init, view); }",
            "fn v(){ spec.size = dims; }",
            "fn v(){ let x = rune::AppSpec { families: names, ..base }; }",
            "#[derive(make_style)] struct X;",
            "#[style(12)] fn v(){}",
            "#[path=\"outside.rs\"] mod bypass;",
            "fn v(){ el.rotate(angle).scale(factor).offset(point); }",
            "fn v(){ el.focus_ring(12., 7., shared_ink); }",
            "fn v(){ el.scroll_margin(123.); }",
            "fn v(){ spec.size.0 = 123.; }",
            "fn v(){ let dimensions = &mut spec.size; dimensions.0 = 123.; }",
            "fn v(){ cx.foreground(shared_ink); cx.titlebar_height(42.); cx.zoom(1.5); }",
            "fn v(spec: rune::AppSpec<()>) { matches!(0, _ if { let x = rune::AppSpec { size: (123., 456.), ..spec }; true }); }",
            "fn v(spec: rune::AppSpec<()>) { matches!(0, _ if { let x = rune::AppSpec::new(title, dims, init, view); true }); }",
            "fn v(spec: rune::AppSpec<()>) { let rune::AppSpec { size: ref mut dimensions, .. } = spec; dimensions.0 = 123.; }",
            "fn v(cx: &mut rune::Cx<()>) { cx.foreground(shared_ink); }",
            "fn v(spec: rune::AppSpec<()>) { let rune::AppSpec { size: ref mut dims, .. } = spec; dims.0 = 123.; }",
            "fn v(){ el.focus_ring(12., 7., ink); }",
            "fn v(){ el.focus_ring_for(key, 12., 7., ink); }",
            "fn v(){ el.bind_path(spec); }",
            "fn v(){ rune::El::bind_path(el, spec); }",
            "use rune::PathBind;",
            "fn v(spec: rune::WindowSpec) { spec.window_backdrop(backdrop); }",
            "fn v(tx: &mut rune::Tx) { tx.set_window_backdrop(backdrop); }",
            "fn v(rt: &mut rune::Runtime<()>) { rt.set_window_backdrop_supported(Default::default(), true); }",
            "fn v(rt: &mut rune::Runtime<()>) { rt.set_window_manager_state(Default::default()); }",
            "fn v(rt: &mut rune::Runtime<()>) { rt.set_renderer_kind(Default::default()); }",
            "fn v(rt: &mut rune::Runtime<()>) { rt.set_safe_area([1., 2., 3., 4.]); }",
            "fn v(){ el.on_edge_drag(edge, 24., handler); }",
        ] {
            assert!(!check(source).unwrap().is_empty(), "accepted {source}");
        }
    }
    #[test]
    fn allows_composition_and_nonvisual_numbers() {
        assert!(check("use rune_theme_codenomad::{Space, Layout}; fn v(){ let n = 600; column().pad(Space::Md).child(button(\"send\", false)); assert_eq!(n, 600); }").unwrap().is_empty());
        assert!(
            check("use rune::Live; fn v() { let viewport = Live::new([0.; 4]); viewport.get(); }")
                .unwrap()
                .is_empty()
        );
        assert!(!check("use rune::Live; fn v() { let value = Live::new(8.); rune::el().padding(value.get()); }").unwrap().is_empty());
    }
    #[test]
    fn image_handles_allow_decode_state_and_keep_visual_dimensions_in_theme() {
        assert!(check("use rune::{Image, ImageCache}; fn v(cache: &ImageCache, image: &Image) { let cache = ImageCache::new(wake); let image = cache.load(bytes); image.is_ready(); image.error(); }").unwrap().is_empty());
        for source in [
            "fn v(cache: &rune::ImageCache) { cache.svg(bytes, 64., scale); }",
            "fn v(cache: &rune::ImageCache) { cache.load_mime(bytes, mime, dimension, scale); }",
            "fn v(image: &rune::Image) { image.size(); }",
            "fn v(image: &rune::Image) { rune::el().pixels(image.pixels()); }",
        ] {
            assert!(!check(source).unwrap().is_empty(), "accepted {source}");
        }
    }
    #[test]
    fn standard_pinning_keeps_nested_arguments_inside_the_style_boundary() {
        for source in [
            "fn f(){ std::pin::pin!(future); }",
            "fn f(){ core::pin::pin!(future); }",
        ] {
            assert!(check(source).unwrap().is_empty(), "{source}");
        }
        for source in [
            "fn f(){ pin!(future); }",
            "fn f(){ other::pin::pin!(future); }",
            "fn f(){ std::pin::pin!(element.padding(8.)); }",
            "fn f(){ core::pin::pin!(rune::El::fill(element, colour)); }",
        ] {
            assert!(!check(source).unwrap().is_empty(), "accepted {source}");
        }
    }
    #[test]
    fn the_android_entry_is_admitted_by_its_exact_path_only() {
        let admitted = "rune::android_main!(main); fn main() {}";
        assert!(check(admitted).unwrap().is_empty(), "{admitted}");
        for source in [
            "android_main!(main); fn main() {}",
            "other::android_main!(main); fn main() {}",
        ] {
            assert!(!check(source).unwrap().is_empty(), "accepted {source}");
        }
    }
    #[test]
    fn qualification_path_requires_exact_native_feature_gate() {
        let source = "#[cfg(all(feature = \"test-support\", not(target_arch = \"wasm32\")))] #[path = \"../tests/probes/mod.rs\"] mod probes;";
        assert!(check(source).unwrap().is_empty());
        for invalid in [
            source.replace("test-support", "other"),
            source.replace("not(target_arch", "any(target_arch"),
            source.replace("tests/probes", "src/bypass"),
            source.replace("mod probes", "mod other"),
        ] {
            assert!(!check(&invalid).unwrap().is_empty(), "{invalid}");
        }
    }
    #[test]
    fn allows_local_values_named_like_builders() {
        assert!(
            check("fn endpoint(){ web_sys::Location::origin(&location); }")
                .unwrap()
                .is_empty()
        );
        assert!(
            !check("fn styled(){ rune::El::origin(el, point); }")
                .unwrap()
                .is_empty()
        );
        assert!(
            check("pub use codenomad_client::backend::*;")
                .unwrap()
                .is_empty()
        );
        assert!(!check("pub use rune::*;").unwrap().is_empty());
        assert!(check("fn v(){ let cursor = next(); let reveal = key(); let w = wake; w(); format!(\"{}\", reveal); json!({\"cursor\": cursor}); }").unwrap().is_empty());
        assert!(
            !check("fn v(){ matches!(x, Some(_) if el.padding(12.)); }")
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn pinned_visual_api_manifest_is_complete() {
        let host = std::process::Command::new("rustc")
            .args(["--print", "host-tuple"])
            .output()
            .unwrap();
        assert!(host.status.success());
        let host = String::from_utf8(host.stdout).unwrap();
        let metadata = std::process::Command::new(env!("CARGO"))
            .args([
                "metadata",
                "--locked",
                "--offline",
                "--format-version",
                "1",
                "--filter-platform",
                host.trim(),
            ])
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .output()
            .unwrap();
        assert!(
            metadata.status.success(),
            "{}",
            String::from_utf8_lossy(&metadata.stderr)
        );
        let metadata: serde_json::Value = serde_json::from_slice(&metadata.stdout).unwrap();
        let packages: Vec<_> = metadata["packages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|package| package["name"] == "rune")
            .collect();
        assert_eq!(packages.len(), 1);
        let base = std::path::Path::new(packages[0]["manifest_path"].as_str().unwrap())
            .parent()
            .unwrap()
            .join("src");
        let semantic = [
            "key",
            "set_key",
            "data",
            "child",
            "push_child",
            "children",
            "extend_children",
            "pointer_buttons",
            "keeps_text_selection",
            "wrap",
            "set_wrap",
            "wrap_anywhere",
            "wrap_greedy",
            "wraps",
            "nowrap",
            "set_nowrap",
            "single_line",
            "selectable",
            "set_selectable",
            "selection_enabled",
            "caret_browsing",
            "selection_group",
            "selection_copy",
            "pill_copy_text",
            "inert",
            "uncopied",
            "copy_breaks",
            "copy_prefix",
            "set_content",
            "link",
            "spellcheck",
            "secure",
            "href",
            "link_url",
            "description",
            "description_static",
            "active_descendant",
            "labelled_by",
            "described_by",
            "controls",
            "owns",
            "busy",
            "invalid",
            "read_only",
            "required",
            "multiselectable",
            "has_popup",
            "orientation",
            "auto_complete",
            "sorted",
            "a11y_value",
            "range_value",
            "live_range_value",
            "range_step",
            "checked",
            "checked_mixed",
            "disabled",
            "aria_disabled",
            "a11y_hidden",
            "unselectable",
            "live_region",
            "position_in_set",
            "list_start",
            "shortcut_hint",
            "role",
            "set_role",
            "label",
            "label_static",
            "set_label",
            "level",
            "expanded",
            "accepts_files",
            "accepts_extensions",
            "accepts_drag",
            "focusable",
            "keyboard_focus_only",
            "tab_index",
            "focus_group",
            "focus_selected",
            "reveal_selected",
            "reveal_caret_on_focus",
            "preserve_focus_on_press",
            "focus_follows",
            "default_button",
            "press_on_return",
            "focus_return",
            "press_focuses_below",
            "hover_passes_below",
            "autofocus",
            "modal",
            "modal_tx",
            "modal_click_outside",
            "modal_wheel_outside",
            "set_on_press_tx",
            "drag_out",
            "pointer_lock",
            "line_home_end",
            "touch_drags_at_once",
            "press_on_down",
            "help",
            "set_help",
            "help_when_truncated",
            "help_row",
            "help_keys",
            "help_open",
            "revealed",
            "isolate",
            "drawn_rect_into",
            "chain_scroll_offset",
            "scroll",
            "set_scroll",
            "scroll_x",
            "set_scroll_x",
            "scroll_xy",
            "set_scroll_xy",
            "scroll_anchor",
            "no_scroll_anchor",
            "wheel_scrolls",
            "set_wheel_scrolls",
            "virtual_rows_version",
            "virtual_rows_append_only",
            "row_count",
            "column_count",
            "row_index",
            "column_index",
            "modal_trap",
        ];
        fn collect(root: &std::path::Path, files: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(root).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    collect(&path, files);
                } else if path.extension().is_some_and(|extension| extension == "rs") {
                    files.push(path);
                }
            }
        }
        let mut files = Vec::new();
        collect(&base, &mut files);
        files.sort();
        let mut missing = Vec::new();
        for path in files {
            let name = path.strip_prefix(&base).unwrap().display().to_string();
            let source = std::fs::read_to_string(&path).unwrap();
            let file = syn::parse_file(&source).unwrap();
            for item in file.items {
                if let Item::Impl(item) = item {
                    if let Type::Path(path) = item.self_ty.as_ref() {
                        if !path.path.is_ident("El") {
                            continue;
                        }
                    } else {
                        continue;
                    }
                    for item in item.items {
                        if let ImplItem::Fn(method) = item {
                            if !matches!(method.vis, Visibility::Public(_)) {
                                continue;
                            }
                            let ident = method.sig.ident.to_string();
                            if !forbidden(&ident)
                                && !semantic.contains(&ident.as_str())
                                && !ident.starts_with("on_")
                            {
                                missing.push(format!("{name}::{ident}"));
                            }
                        }
                    }
                }
            }
        }
        assert!(
            missing.is_empty(),
            "unclassified Rune APIs: {}",
            missing.join(", ")
        );
    }
}
