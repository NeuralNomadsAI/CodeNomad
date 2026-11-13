#![cfg(target_os = "linux")]

#[test]
fn variant_string_iterators_preserve_borrowed_strings() {
    use glib::prelude::*;

    let strings = ["first", "", "é漢🙂", "last"];
    let variant = strings.to_variant();
    let iter = || variant.array_iter_str().unwrap();
    assert_eq!(iter().collect::<Vec<_>>(), strings);
    assert_eq!(
        iter().rev().collect::<Vec<_>>(),
        ["last", "é漢🙂", "", "first"]
    );
    assert_eq!(iter().nth(2), Some("é漢🙂"));
    assert_eq!(iter().nth_back(2), Some(""));
    assert_eq!(iter().last(), Some("last"));

    let mut mixed = iter();
    let first = mixed.next().unwrap();
    assert_eq!(mixed.next_back(), Some("last"));
    assert_eq!(mixed.nth(0), Some(""));
    assert_eq!(mixed.nth_back(0), Some("é漢🙂"));
    assert_eq!(mixed.len(), 0);
    assert_eq!(mixed.next(), None);
    assert_eq!(mixed.next_back(), None);
    drop(mixed);
    assert_eq!(first, "first");

    let empty: [&str; 0] = [];
    let empty = empty.to_variant();
    let mut empty = empty.array_iter_str().unwrap();
    assert_eq!(empty.len(), 0);
    assert_eq!(empty.next(), None);
    assert_eq!(empty.next_back(), None);
    assert!(42_i32.to_variant().array_iter_str().is_err());
}
