//! Locale collation at the platform boundary; independent of translated UI labels.
use codenomad_client::files::{Entry, EntryKind};
use std::cmp::Ordering;

#[cfg(not(target_arch = "wasm32"))]
pub(crate) struct Collation {
    collator: icu_collator::CollatorBorrowed<'static>,
    locale: String,
}
#[cfg(not(target_arch = "wasm32"))]
impl Collation {
    /// Prefer the system locale; unconfigured/POSIX environments use Unicode root collation.
    pub(crate) fn try_default() -> Result<Self, String> {
        Self::try_system_locale(sys_locale::get_locale().as_deref())
    }
    fn try_system_locale(locale: Option<&str>) -> Result<Self, String> {
        Self::try_locale(match locale {
            None | Some("" | "C" | "POSIX") => "und",
            Some(locale) => locale,
        })
    }
    fn try_locale(locale: &str) -> Result<Self, String> {
        let locale_tag: icu_locale_core::Locale = locale
            .parse()
            .map_err(|error| format!("Invalid system collation locale: {error}"))?;
        let mut preferences: icu_collator::CollatorPreferences = locale_tag.into();
        preferences.numeric_ordering =
            Some(icu_collator::preferences::CollationNumericOrdering::False);
        let collator = icu_collator::Collator::try_new(preferences, Default::default())
            .map_err(|error| format!("Collation unavailable: {error}"))?;
        Ok(Self {
            collator,
            locale: locale.into(),
        })
    }
    pub(crate) fn locale(&self) -> &str {
        &self.locale
    }
    pub(crate) fn compare(&self, a: &str, b: &str) -> Result<Ordering, String> {
        Ok(self.collator.compare(a, b))
    }
    pub(crate) fn sort_files(&self, mut entries: Vec<Entry>) -> Result<Vec<Entry>, String> {
        entries.sort_by(|a, b| {
            (b.kind == EntryKind::Directory)
                .cmp(&(a.kind == EntryKind::Directory))
                .then_with(|| self.collator.compare(&a.name, &b.name))
        });
        Ok(entries)
    }
}

#[cfg(target_arch = "wasm32")]
mod browser {
    use super::{Entry, EntryKind, Ordering};
    use wasm_bindgen::{JsCast, JsValue};

    pub(crate) struct Collation {
        compare: js_sys::Function,
        locale: String,
    }
    fn error(_: JsValue) -> String {
        "Browser collation unavailable".into()
    }
    fn method(object: &JsValue, name: &str) -> Result<js_sys::Function, String> {
        js_sys::Reflect::get(object, &name.into())
            .map_err(error)?
            .dyn_into::<js_sys::Function>()
            .map_err(error)
    }
    impl Collation {
        pub(crate) fn try_default() -> Result<Self, String> {
            // Reflect::construct catches missing Intl/Collator and constructor failures.
            let intl = js_sys::Reflect::get(&js_sys::global(), &"Intl".into()).map_err(error)?;
            let constructor = method(&intl, "Collator")?;
            let collator =
                js_sys::Reflect::construct(&constructor, &js_sys::Array::new()).map_err(error)?;
            let compare = method(collator.as_ref(), "compare")?;
            let options = method(collator.as_ref(), "resolvedOptions")?
                .call0(collator.as_ref())
                .map_err(error)?;
            let locale = js_sys::Reflect::get(&options, &"locale".into())
                .map_err(error)?
                .as_string()
                .ok_or("Browser collation locale unavailable")?;
            Ok(Self { compare, locale })
        }
        pub(crate) fn locale(&self) -> &str {
            &self.locale
        }
        pub(crate) fn compare(&self, a: &str, b: &str) -> Result<Ordering, String> {
            let value = self
                .compare
                .call2(&JsValue::UNDEFINED, &a.into(), &b.into())
                .map_err(error)?
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or("Invalid browser collation result")?;
            value
                .partial_cmp(&0.0)
                .ok_or_else(|| "Invalid browser collation result".into())
        }
        pub(crate) fn sort_files(&self, entries: Vec<Entry>) -> Result<Vec<Entry>, String> {
            let index = |value: JsValue| {
                value
                    .as_f64()
                    .filter(|value| {
                        value.is_finite()
                            && *value >= 0.0
                            && value.fract() == 0.0
                            && *value < entries.len() as f64
                    })
                    .map(|value| value as usize)
                    .ok_or_else(|| "Invalid collation index".to_owned())
            };
            let indices = js_sys::Array::from_iter(
                (0..entries.len()).map(|index| JsValue::from_f64(index as f64)),
            )
            .try_sort_by(&mut |a, b| {
                let compare = || -> Result<i32, String> {
                    let a = &entries[index(a)?];
                    let b = &entries[index(b)?];
                    let kind =
                        (b.kind == EntryKind::Directory).cmp(&(a.kind == EntryKind::Directory));
                    Ok(if kind == Ordering::Equal {
                        self.compare(&a.name, &b.name)?
                    } else {
                        kind
                    } as i32)
                };
                compare().map_err(|error| wasm_bindgen::JsError::new(&error))
            })
            .map_err(error)?;
            if indices.length() as usize != entries.len() {
                return Err("Invalid collation permutation".into());
            }
            let indices = indices
                .iter()
                .map(index)
                .collect::<Result<Vec<_>, String>>()?;
            super::reorder(entries, indices)
        }
    }
}
#[cfg(target_arch = "wasm32")]
pub(crate) use browser::Collation;

#[cfg(any(test, target_arch = "wasm32"))]
fn reorder(entries: Vec<Entry>, indices: Vec<usize>) -> Result<Vec<Entry>, String> {
    if entries.len() != indices.len() {
        return Err("Invalid collation permutation".into());
    }
    let mut seen = vec![false; entries.len()];
    for index in &indices {
        let used = seen.get_mut(*index).ok_or("Invalid collation index")?;
        if *used {
            return Err("Duplicate collation index".into());
        }
        *used = true;
    }
    let mut entries: Vec<_> = entries.into_iter().map(Some).collect();
    indices
        .into_iter()
        .map(|index| {
            entries
                .get_mut(index)
                .and_then(Option::take)
                .ok_or_else(|| "Invalid collation permutation".into())
        })
        .collect()
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    fn entry(name: &str, path: &str, kind: EntryKind) -> Entry {
        Entry {
            name: name.into(),
            path: path.into(),
            kind,
            absolute_path: None,
            directory_identity: None,
            size: None,
            modified_at: None,
        }
    }
    #[test]
    fn files_sort_directories_first_and_preserve_equal_input_order() {
        let collation = Collation::try_locale("fr-FR").unwrap();
        let entries = vec![
            entry("é", "first", EntryKind::File),
            entry("z", "directory-z", EntryKind::Directory),
            entry("e\u{301}", "second", EntryKind::File),
            entry("a", "directory-a", EntryKind::Directory),
            entry("file2", "file2", EntryKind::File),
            entry("file10", "file10", EntryKind::File),
        ];
        let sorted = collation.sort_files(entries).unwrap();
        assert_eq!(
            sorted
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            [
                "directory-a",
                "directory-z",
                "first",
                "second",
                "file10",
                "file2"
            ]
        );
    }
    #[test]
    fn validates_permutation_before_moving_files() {
        let entries = vec![
            entry("a", "a", EntryKind::File),
            entry("b", "b", EntryKind::File),
        ];
        assert!(reorder(entries.clone(), vec![0]).is_err());
        assert!(reorder(entries.clone(), vec![0, 2]).is_err());
        assert!(reorder(entries.clone(), vec![0, 0]).is_err());
        assert_eq!(
            reorder(entries, vec![1, 0])
                .unwrap()
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            ["b", "a"]
        );
        assert!(reorder(Vec::new(), Vec::new()).unwrap().is_empty());
    }
    #[test]
    fn system_locale_is_separate_from_ui_locale() {
        let collation = Collation::try_default().unwrap();
        let system = sys_locale::get_locale();
        let expected = match system.as_deref() {
            None | Some("" | "C" | "POSIX") => "und",
            Some(locale) => locale,
        };
        assert_eq!(collation.locale(), expected);
        assert!(Collation::try_locale("invalid_locale!").is_err());
        for locale in [None, Some(""), Some("C"), Some("POSIX")] {
            let neutral = Collation::try_system_locale(locale).unwrap();
            assert_eq!(neutral.locale(), "und");
            assert_eq!(neutral.compare("é", "e\u{301}").unwrap(), Ordering::Equal);
            assert_eq!(
                neutral.compare("file2", "file10").unwrap(),
                Ordering::Greater
            );
        }
    }
    #[test]
    fn preserves_unicode_equal_and_locale_order() {
        for locale in ["en-US", "fr-FR", "sv-SE", "tr-TR", "de-DE"] {
            let collation = Collation::try_locale(locale).unwrap();
            assert_eq!(collation.compare("é", "e\u{301}").unwrap(), Ordering::Equal);
            assert_eq!(
                collation.compare("file2", "file10").unwrap(),
                Ordering::Greater
            );
            let expected = if locale == "sv-SE" {
                Ordering::Greater
            } else {
                Ordering::Less
            };
            assert_eq!(collation.compare("ä", "z").unwrap(), expected);
        }
        let collation = Collation::try_locale("en-US").unwrap();
        let mut names = ["e\u{301}", "é"];
        names.sort_by(|a, b| collation.compare(a, b).unwrap());
        assert_eq!(names, ["e\u{301}", "é"]);
    }
    #[test]
    #[ignore = "requires Chromium matrix paths in RUNE_COLLATION_JS_PROOF and RUNE_COLLATION_NATIVE_PROOF"]
    fn compare_chromium_matrices() {
        let root =
            std::fs::canonicalize(concat!(env!("CARGO_MANIFEST_DIR"), "/../../target")).unwrap();
        let source =
            std::fs::canonicalize(std::env::var("RUNE_COLLATION_JS_PROOF").unwrap()).unwrap();
        let output =
            std::path::PathBuf::from(std::env::var("RUNE_COLLATION_NATIVE_PROOF").unwrap());
        assert!(source.starts_with(&root));
        assert!(
            std::fs::canonicalize(output.parent().unwrap())
                .unwrap()
                .starts_with(&root)
        );
        if output.exists() {
            assert!(std::fs::canonicalize(&output).unwrap().starts_with(&root));
        }
        let proof: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(source).unwrap()).unwrap();
        let mut comparisons = 0;
        let mut mismatches = Vec::new();
        let mut neutral_comparisons = 0;
        let mut neutral_mismatches = Vec::new();
        let neutral = Collation::try_system_locale(None).unwrap();
        for case in proof["cases"].as_array().unwrap() {
            let locale = case["resolved"]["locale"].as_str().unwrap();
            let collation = Collation::try_locale(locale).unwrap();
            let names = case["names"].as_array().unwrap();
            for (i, a) in names.iter().enumerate() {
                for (j, b) in names.iter().enumerate() {
                    let order = collation
                        .compare(a.as_str().unwrap(), b.as_str().unwrap())
                        .unwrap();
                    let sign = match order {
                        Ordering::Less => -1,
                        Ordering::Equal => 0,
                        Ordering::Greater => 1,
                    };
                    comparisons += 1;
                    if case["matrixSigns"][i][j].as_i64().unwrap() != sign {
                        mismatches.push(serde_json::json!({"locale":locale,"a":a,"b":b,"native":sign,"js":case["matrixSigns"][i][j]}));
                    }
                    if locale == "en-US" {
                        let neutral_sign = match neutral
                            .compare(a.as_str().unwrap(), b.as_str().unwrap())
                            .unwrap()
                        {
                            Ordering::Less => -1,
                            Ordering::Equal => 0,
                            Ordering::Greater => 1,
                        };
                        neutral_comparisons += 1;
                        if case["matrixSigns"][i][j].as_i64().unwrap() != neutral_sign {
                            neutral_mismatches.push(serde_json::json!({"a":a,"b":b,"native":neutral_sign,"js":case["matrixSigns"][i][j]}));
                        }
                    }
                }
            }
        }
        std::fs::write(output, serde_json::to_string_pretty(&serde_json::json!({
            "comparisons":comparisons,"mismatches":mismatches,"nativeLocale":Collation::try_default().unwrap().locale(),
            "icuCollator":"2.4.0","browserVersion":proof["browserVersion"],
            "neutralLocale":"und","neutralComparisons":neutral_comparisons,"neutralMismatches":neutral_mismatches,
        })).unwrap()).unwrap();
        println!(
            "Native/Chromium comparisons: {comparisons}; differences: {}",
            mismatches.len()
        );
        assert!(
            mismatches.is_empty(),
            "Native collation diverges from the recorded Source matrix"
        );
        assert!(
            neutral_mismatches.is_empty(),
            "Neutral collation diverges from the recorded default corpus"
        );
    }
}
