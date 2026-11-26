//! OpenCode's applied plugin order (`opencode/plugin-activation-order.ts`) and ID/collation rules.

use std::{cmp::Ordering, collections::HashSet, sync::LazyLock};

use icu_collator::{Collator, CollatorBorrowed, options::CollatorOptions};
use icu_locale_core::locale;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct AppliedEntry {
    pub(super) document: usize,
    pub(super) entry_index: usize,
    pub(super) remove: bool,
    pub(super) target: String,
    pub(super) plugin_id: Option<String>,
}

#[derive(Clone, Debug)]
pub(super) struct AppliedSequence {
    pub(super) entries: Vec<AppliedEntry>,
    pub(super) start_ids: HashSet<String>,
}

pub(super) fn matches_selector(selector: &str, plugin_id: &str) -> bool {
    selector == "*"
        || selector.strip_suffix(".*").map_or_else(
            || selector == plugin_id,
            |prefix| plugin_id.starts_with(prefix) && plugin_id.as_bytes().get(prefix.len()) == Some(&b'.'),
        )
}

fn defined_at_start(sequence: &AppliedSequence, id: &str) -> bool {
    sequence.start_ids.contains(id) || id.starts_with("opencode.")
}

/// Whether a verified definition of `id` precedes position `(document, entry_index)`, ignoring `exclude`.
pub(super) fn defined_before(
    sequence: &AppliedSequence,
    id: &str,
    document: usize,
    entry_index: usize,
    exclude: Option<(usize, usize)>,
) -> bool {
    if defined_at_start(sequence, id) {
        return true;
    }
    sequence.entries.iter().any(|entry| {
        exclude != Some((entry.document, entry.entry_index))
            && !entry.remove
            && entry.plugin_id.as_deref() == Some(id)
            && (entry.document < document || (entry.document == document && entry.entry_index < entry_index))
    })
}

/// Whether `id` is enabled after the documents up to `through` (inclusive).
pub(super) fn enabled_through(sequence: &AppliedSequence, id: &str, through: usize) -> bool {
    let prefix: Vec<&AppliedEntry> = sequence.entries.iter().filter(|entry| entry.document <= through).collect();
    let mut defined = defined_at_start(sequence, id)
        || !prefix.iter().any(|entry| !entry.remove && entry.plugin_id.as_deref() == Some(id));
    let mut enabled = defined;
    for entry in prefix {
        if entry.remove {
            if defined && matches_selector(&entry.target, id) {
                enabled = false;
            }
        } else if entry.plugin_id.as_deref() == Some(id) {
            defined = true;
            enabled = true;
        } else if defined && matches_selector(&entry.target, id) {
            enabled = true;
        }
    }
    enabled
}

pub(super) fn valid_plugin_id(value: &str) -> bool {
    let utf16_len = value.encode_utf16().count();
    (1..=256).contains(&utf16_len)
        && value == crate::shared::js_trim(value)
        && !value.starts_with('-')
        && !value.contains('*')
        && !crate::opencode_settings::has_control_chars(value)
}

pub(super) fn is_exact_selector(selector: &str) -> bool {
    selector != "*" && !selector.ends_with(".*") && valid_plugin_id(selector)
}

static COLLATOR: LazyLock<Option<CollatorBorrowed<'static>>> = LazyLock::new(|| {
    let mut options = CollatorOptions::default();
    options.strength = Some(icu_collator::options::Strength::Tertiary);
    Collator::try_new(locale!("en").into(), options).ok()
});

/// `new Intl.Collator("en", { sensitivity: "variant" }).compare`
pub(super) fn control_id_cmp(left: &str, right: &str) -> Ordering {
    if let Some(collator) = COLLATOR.as_ref() { collator.compare(left, right) } else { left.cmp(right) }
}
