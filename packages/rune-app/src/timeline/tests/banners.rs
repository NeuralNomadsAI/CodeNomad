use super::*;

const BANNERS: [&str; 3] = [
    "timeline-destination-filtered",
    "timeline-jump-retry",
    "timeline-outline-retry",
];

pub(super) struct Snapshot {
    pub(super) path: String,
    pub(super) mounted_banners: Vec<&'static str>,
    pub(super) visible_banners: Vec<&'static str>,
    pub(super) mounted_filtered_alerts: Vec<String>,
    pub(super) visible_filtered_alerts: Vec<String>,
    pub(super) outline_retry_button: Option<[f32; 4]>,
    pub(super) any_rail_keys: Vec<String>,
    pub(super) rail_keys: Vec<String>,
    pub(super) visible_keys: Vec<String>,
}

pub(super) fn anchor_offset(rt: &Runtime<State>) -> (f32, f32) {
    let history = rt.presented("history").unwrap().0;
    let row = rt.presented("row-4").unwrap().0;
    (history[3], row[1] - history[1])
}

pub(super) fn arm_rail_collision(rt: &mut Runtime<State>) {
    rt.update(|s, tx| {
        let mut sc = owner(s).scroll.get();
        let target = sc.at.max[1].max(120.0);
        sc.programmatic_rail = Some(target);
        owner(s).scroll.set(sc);
        rune_theme_codenomad::timeline::scroll_rail_to(target, tx);
    });
}

pub(super) fn snapshot(rt: &Runtime<State>) -> Snapshot {
    let filtered_text = crate::strings::t("history.destinationFiltered");
    let session_unavailable_text = crate::strings::t("history.sessionUnavailable");
    let outline_unavailable_text = crate::strings::t("history.navigation.outlineUnavailable");
    let retry_text = crate::strings::t("messageSection.search.retry");
    let elements = rt.elements();
    let path = elements
        .iter()
        .find(|node| node.key.as_deref() == Some("history"))
        .expect("history viewport mounted")
        .path
        .clone();
    let fully_unclipped = |rect: [f32; 4], visible: [f32; 4]| {
        rect[2] > 0.0
            && rect[3] > 0.0
            && (visible[2] - rect[2]).abs() <= 0.5
            && (visible[3] - rect[3]).abs() <= 0.5
    };
    let banner_ok = |key: Option<&str>,
                     role: &str,
                     text: Option<&str>,
                     path: &str,
                     rect: [f32; 4],
                     visible: [f32; 4]| {
        let prefix = format!("{path}/");
        let children: Vec<_> = elements
            .iter()
            .filter(|child| child.path.starts_with(&prefix))
            .collect();
        let expected_children = match key {
            Some("timeline-destination-filtered") => {
                role == "alert" && text == Some(filtered_text) && children.is_empty()
            }
            Some("timeline-jump-retry") | Some("timeline-outline-retry") => {
                let expected_message = if key == Some("timeline-jump-retry") {
                    session_unavailable_text
                } else {
                    outline_unavailable_text
                };
                let message_count = children
                    .iter()
                    .filter(|child| {
                        child.role != "button" && child.text.as_deref() == Some(expected_message)
                    })
                    .count();
                let button_count = children
                    .iter()
                    .filter(|child| {
                        child.role == "button"
                            && (child.label.as_deref() == Some(retry_text)
                                || child.text.as_deref() == Some(retry_text))
                    })
                    .count();
                message_count == 1 && button_count == 1
            }
            _ => true,
        };
        fully_unclipped(rect, visible)
            && expected_children
            && children
                .iter()
                .all(|child| fully_unclipped(child.rect, child.visible))
    };
    let mounted_banners = elements
        .iter()
        .filter_map(|node| {
            let key = node.key.as_deref()?;
            BANNERS.iter().copied().find(|banner| *banner == key)
        })
        .collect();
    let visible_banners = elements
        .iter()
        .filter_map(|node| {
            let key = node.key.as_deref()?;
            let banner = BANNERS.iter().copied().find(|banner| *banner == key)?;
            banner_ok(
                node.key.as_deref(),
                &node.role,
                node.text.as_deref(),
                &node.path,
                node.rect,
                node.visible,
            )
            .then_some(banner)
        })
        .collect();
    let mounted_filtered_alerts = elements
        .iter()
        .filter(|node| node.role == "alert" && node.text.as_deref() == Some(filtered_text))
        .map(|node| node.path.clone())
        .collect();
    let visible_filtered_alerts = elements
        .iter()
        .filter(|node| {
            node.role == "alert"
                && node.text.as_deref() == Some(filtered_text)
                && banner_ok(
                    node.key.as_deref(),
                    &node.role,
                    node.text.as_deref(),
                    &node.path,
                    node.rect,
                    node.visible,
                )
        })
        .map(|node| node.path.clone())
        .collect();
    let outline_retry_button = elements
        .iter()
        .find(|node| node.path.contains("/timeline-outline-retry/") && node.role == "button")
        .map(|node| node.rect);
    let any_rail_keys = elements
        .iter()
        .filter(|node| {
            node.path.contains("/timeline/") && node.visible[2] > 0.0 && node.visible[3] > 0.0
        })
        .filter_map(|node| node.key.clone())
        .collect();
    let rail_keys = elements
        .iter()
        .filter(|node| node.path.contains("/timeline/") && fully_unclipped(node.rect, node.visible))
        .filter_map(|node| node.key.clone())
        .collect();
    let visible_keys = elements
        .iter()
        .filter(|node| node.visible[3] > 0.0)
        .filter_map(|node| node.key.clone())
        .collect();
    Snapshot {
        path,
        mounted_banners,
        visible_banners,
        mounted_filtered_alerts,
        visible_filtered_alerts,
        outline_retry_button,
        any_rail_keys,
        rail_keys,
        visible_keys,
    }
}

pub(super) fn has_any_rail_marker(snap: &Snapshot, id: &str) -> bool {
    let key = format!("{id}:User:0:false");
    snap.any_rail_keys.iter().any(|k| k == &key)
}

pub(super) fn has_rail_marker_key(snap: &Snapshot, key: &str) -> bool {
    snap.rail_keys.iter().any(|k| k == key)
}

pub(super) fn has_rail_marker(snap: &Snapshot, id: &str) -> bool {
    let key = format!("{id}:User:0:false");
    has_rail_marker_key(snap, &key)
}

pub(super) fn is_row_visible(rt: &Runtime<State>, snap: &Snapshot, id: &str) -> bool {
    let hist = rt.presented("history").expect("history presented").0;
    rt.presented(id).is_some_and(|(row, _)| {
        row[3] > 0.0
            && row[1] + row[3] > hist[1] + 0.5
            && row[1] < hist[1] + hist[3] - 0.5
            && snap.visible_keys.iter().any(|k| k == id)
    })
}

#[test]
fn banners_keep_the_history_viewport_mounted_and_preserve_reading_position() {
    for reduced_motion in [false, true] {
        banners_keep_history_mounted(reduced_motion);
    }
}

fn banners_keep_history_mounted(reduced_motion: bool) {
    let mut s = crate::init();
    s.messages = (0..25).map(|i| user(&format!("row-{i}"))).collect();
    owner(&mut s).width = 800.0;
    owner(&mut s).changed = true;
    owner(&mut s).backend = Some(codenomad_client::backend::Backend {
        client: codenomad_client::http::Http::new().unwrap(),
        base: "http://127.0.0.1:9/".into(),
        workspace: "w".into(),
        session: "s".into(),
        client_id: "c".into(),
        session_directory: None,
        fresh_mode: false,
    });
    assert!(demanded(&s));
    let mut rt = Runtime::new(s, view, (800.0, 540.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    rt.set_system_reduced_motion(reduced_motion);
    rt.frame(0.0);
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("row-4", -14.0);
    });
    settle(&mut rt);

    let history_path = |rt: &Runtime<State>| {
        rt.elements()
            .into_iter()
            .find(|node| node.key.as_deref() == Some("history"))
            .expect("history viewport mounted")
            .path
    };
    let expected_path = history_path(&rt);
    let (base_height, expected_offset) = anchor_offset(&rt);
    assert_eq!(rt.scroll_at_bottom("history"), Some(false));
    assert!(
        (expected_offset - (-14.0)).abs() < 1.0,
        "unexpected initial anchor offset: {expected_offset}"
    );

    let assert_preserved = |rt: &Runtime<State>, label: &str, banner_key: Option<&str>| {
        let snap = snapshot(rt);
        assert_eq!(snap.path, expected_path, "{label}: history remounted");
        assert_eq!(
            rt.scroll_at_bottom("history"),
            Some(false),
            "{label}: jumped to bottom"
        );
        let (height, offset) = anchor_offset(rt);
        assert!(
            (offset - expected_offset).abs() < 0.5,
            "{label}: anchor drifted from {expected_offset} to {offset}"
        );
        let expected_banners: Vec<&str> = banner_key.into_iter().collect();
        assert_eq!(
            snap.mounted_banners, expected_banners,
            "{label}: unexpected mounted banners"
        );
        assert_eq!(
            snap.visible_banners, expected_banners,
            "{label}: unexpected visible banners"
        );
        let expect_filtered_alert = banner_key == Some("timeline-destination-filtered")
            || (search::is_open(&rt.state) && rt.state.transcript_display.timeline.jump.filtered);
        assert_eq!(
            snap.mounted_filtered_alerts.len(),
            usize::from(expect_filtered_alert),
            "{label}: unexpected destinationFiltered alerts: {:?}",
            snap.mounted_filtered_alerts
        );
        if banner_key.is_some() {
            assert!(
                height < base_height,
                "{label}: history height {height} did not shrink below {base_height}"
            );
        } else {
            assert!(
                (height - base_height).abs() < 0.5,
                "{label}: history height {height} did not restore to {base_height}"
            );
        }
        snap
    };

    rt.update(|s, _| {
        let t = owner(s);
        t.refresh = false;
        t.outline_error = true;
    });
    settle(&mut rt);
    let retry_snap = assert_preserved(&rt, "outline_error shown", Some("timeline-outline-retry"));
    let [x, y, w, h] = retry_snap
        .outline_retry_button
        .expect("outline retry button");
    rt.pointer_down(x + w / 2.0, y + h / 2.0);
    rt.pointer_up(x + w / 2.0, y + h / 2.0);
    settle(&mut rt);
    assert!(
        !owner(&mut rt.state).outline_error && owner(&mut rt.state).refresh,
        "clicking outline retry must clear error AND request a fresh outline read"
    );
    assert_preserved(&rt, "outline_error cleared", None);

    let retry_marker = Marker::from(timeline::Marker {
        message: "distant",
        kind: MarkerKind::User,
        ordinal: 0,
        continued: false,
        omitted_before: false,
        tool_name: None,
    });
    let (jump_tx, jump_rx) = codenomad_client::bounded(4);
    let mut prev_jump_env = None;
    rt.update(|s, _| {
        let prev_commands = s.commands.replace(jump_tx);
        let t = owner(s);
        prev_jump_env = Some((prev_commands, t.online, t.refresh));
        t.online = true;
        t.refresh = false;
        t.jump.retry = Some(retry_marker.clone());
    });
    settle(&mut rt);
    assert_preserved(&rt, "jump.retry shown", Some("timeline-jump-retry"));
    let [jx, jy, jw, jh] = rt
        .elements()
        .into_iter()
        .find(|n| n.path.contains("/timeline-jump-retry/") && n.role == "button")
        .map(|n| n.rect)
        .expect("timeline-jump-retry button");
    rt.pointer_down(jx + jw / 2.0, jy + jh / 2.0);
    rt.pointer_up(jx + jw / 2.0, jy + jh / 2.0);
    settle(&mut rt);
    match jump_rx
        .try_recv()
        .expect("jump retry button must dispatch Command::Anchor")
    {
        crate::transport::Command::Anchor(jump) => assert_eq!(jump.message, "distant"),
        other => panic!("unexpected command from jump retry button: {other:?}"),
    }
    assert!(owner(&mut rt.state).jump.retry.is_none());
    assert_preserved(&rt, "jump.retry cleared", None);
    rt.update(|s, _| {
        navigation::cancel_jump(s);
        let (prev_commands, prev_online, prev_refresh) = prev_jump_env.take().unwrap();
        s.commands = prev_commands;
        let t = owner(s);
        t.online = prev_online;
        t.refresh = prev_refresh;
    });
    settle(&mut rt);

    rt.update(|s, _| owner(s).jump.filtered = true);
    settle(&mut rt);
    assert_preserved(
        &rt,
        "destinationFiltered shown",
        Some("timeline-destination-filtered"),
    );
    rt.update(|s, _| owner(s).jump.filtered = false);
    settle(&mut rt);
    assert_preserved(&rt, "destinationFiltered cleared", None);

    rt.update(|s, _| owner(s).outline_error = true);
    settle(&mut rt);
    assert_preserved(
        &rt,
        "transition outline_error",
        Some("timeline-outline-retry"),
    );
    rt.update(|s, _| owner(s).jump.retry = Some(retry_marker));
    settle(&mut rt);
    assert_preserved(&rt, "transition jump.retry", Some("timeline-jump-retry"));
    rt.update(|s, _| owner(s).jump.filtered = true);
    settle(&mut rt);
    assert_preserved(
        &rt,
        "transition destinationFiltered",
        Some("timeline-destination-filtered"),
    );
    rt.update(|s, tx| {
        assert!(search::keys(
            s,
            &rune::KeyEvent {
                key: rune::Key::Command('f'),
                mods: rune::Mods {
                    ctrl: !cfg!(target_os = "macos"),
                    cmd: true,
                    logo: cfg!(target_os = "macos"),
                    ..Default::default()
                },
            },
            tx,
        ));
    });
    settle(&mut rt);
    let search_jump_snap = assert_preserved(
        &rt,
        "search open falls through to jump.retry",
        Some("timeline-jump-retry"),
    );
    let assert_search_filtered_alert = |snap: &Snapshot| {
        assert_eq!(
            snap.mounted_filtered_alerts.len(),
            1,
            "expected one mounted destinationFiltered alert"
        );
        assert_eq!(
            snap.visible_filtered_alerts, snap.mounted_filtered_alerts,
            "destinationFiltered alert must be completely visible without clipping"
        );
        assert!(
            snap.visible_filtered_alerts[0].contains("/history-search-body/"),
            "destinationFiltered alert must belong to history-search-body: {}",
            snap.visible_filtered_alerts[0]
        );
    };
    assert_search_filtered_alert(&search_jump_snap);
    rt.update(|s, _| owner(s).jump.retry = None);
    settle(&mut rt);
    let search_outline_snap = assert_preserved(
        &rt,
        "search open falls through to outline_error",
        Some("timeline-outline-retry"),
    );
    assert_search_filtered_alert(&search_outline_snap);
    rt.update(|s, _| search::close(s));
    settle(&mut rt);
    assert!(!owner(&mut rt.state).jump.filtered);
    let closed_snap = assert_preserved(
        &rt,
        "search closed clears destinationFiltered and keeps outline_error",
        Some("timeline-outline-retry"),
    );
    assert!(
        closed_snap.mounted_filtered_alerts.is_empty(),
        "no destinationFiltered alert (even clipped) may remain mounted after search closes: {:?}",
        closed_snap.mounted_filtered_alerts
    );
    let assert_bottom_snapshot = |rt: &Runtime<State>, label: &str| {
        let snap = snapshot(rt);
        assert_eq!(snap.path, expected_path, "{label}: history remounted");
        assert_eq!(
            rt.scroll_at_bottom("history"),
            Some(true),
            "{label}: lost bottom follow"
        );
        snap
    };
    rt.update(|s, _| {
        let msg: crate::history::Row = crate::history::decode_message(&json!({
            "id": "row-mid",
            "type": "user",
            "text": "Long transcript below this anchor.\n\n".repeat(14)
        }))
        .unwrap()
        .into();
        s.messages.push(msg.clone());
        s.revision += 1;
        observe(s, &crate::transport::Event::Message((*msg).clone()));
    });
    settle(&mut rt);
    let mid_snap = assert_preserved(
        &rt,
        "mid-scroll append with outline_error keeps anchor and updates rail",
        Some("timeline-outline-retry"),
    );
    assert!(
        !is_row_visible(&rt, &mid_snap, "row-mid"),
        "row-mid must remain off-screen while anchored mid-transcript"
    );
    assert!(
        !has_any_rail_marker(&mid_snap, "row-mid"),
        "row-mid marker starts completely below the visible rail while anchored at row-4"
    );
    assert_eq!(
        owner(&mut rt.state)
            .markers
            .last()
            .map(|m| m.message.as_str()),
        Some("row-mid")
    );
    rt.update(|s, _| owner(s).outline_error = false);
    settle(&mut rt);
    let cleared_snap = assert_preserved(&rt, "transition cleared", None);
    assert!(
        !has_any_rail_marker(&cleared_snap, "row-mid"),
        "row-mid marker must stay completely below the taller banner-free rail before returning to bottom"
    );

    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_to_bottom_instant("history");
    });
    settle(&mut rt);
    let bottom_snap = assert_bottom_snapshot(&rt, "scroll to bottom");
    assert!(
        is_row_visible(&rt, &bottom_snap, "row-mid"),
        "row-mid must be visible after returning to bottom"
    );
    assert!(
        has_rail_marker(&bottom_snap, "row-mid"),
        "rail must reveal off-screen row-mid marker after returning to bottom"
    );
    assert_eq!(
        owner(&mut rt.state).jump.active.as_deref(),
        Some("row-mid:User:0:false")
    );
    let offset_before_unlocked_banner = owner(&mut rt.state).scroll.get().at.offset[1];
    rt.update(|s, _| owner(s).outline_error = true);
    settle(&mut rt);
    let offset_after_unlocked_banner = owner(&mut rt.state).scroll.get().at.offset[1];
    assert_eq!(
        owner(&mut rt.state).jump.active.as_deref(),
        Some("row-mid:User:0:false")
    );
    assert!(
        offset_after_unlocked_banner > offset_before_unlocked_banner + 10.0,
        "banner shrinking the rail must scroll to re-reveal unchanged active marker row-mid: before={offset_before_unlocked_banner}, after={offset_after_unlocked_banner}"
    );
    let outline_bottom_snap = assert_bottom_snapshot(&rt, "outline_error at bottom");
    assert!(
        has_rail_marker(&outline_bottom_snap, "row-mid"),
        "shrinking the rail for a banner must automatically re-reveal unchanged active marker row-mid"
    );
    let active_before_25 = owner(&mut rt.state).jump.active.clone();
    rt.update(|s, _| {
        let msg: crate::history::Row = crate::history::decode_message(&json!({
            "id": "row-25",
            "type": "user",
            "text": "Long transcript below this anchor.\n\n".repeat(14)
        }))
        .unwrap()
        .into();
        s.messages.push(msg.clone());
        s.revision += 1;
        observe(s, &crate::transport::Event::Message((*msg).clone()));
    });
    settle(&mut rt);
    let post_25_snap = assert_bottom_snapshot(&rt, "row-25 appended with outline_error");
    assert!(is_row_visible(&rt, &post_25_snap, "row-25"));
    let active_after_25 = owner(&mut rt.state)
        .jump
        .active
        .clone()
        .expect("active reading-line marker after row-25");
    assert_ne!(Some(active_after_25.clone()), active_before_25);
    assert!(
        has_rail_marker_key(&post_25_snap, active_after_25.as_str()),
        "rail must automatically reveal active marker {active_after_25} while following bottom"
    );
    assert!(has_rail_marker(&post_25_snap, "row-25"));
    rt.update(|s, _| owner(s).outline_error = false);
    settle(&mut rt);
    let _ = assert_bottom_snapshot(&rt, "outline_error cleared at bottom");
    rt.update(|s, _| {
        let msg: crate::history::Row = crate::history::decode_message(&json!({
            "id": "row-26",
            "type": "user",
            "text": "Long transcript below this anchor.\n\n".repeat(14)
        }))
        .unwrap()
        .into();
        s.messages.push(msg.clone());
        s.revision += 1;
        observe(s, &crate::transport::Event::Message((*msg).clone()));
    });
    settle(&mut rt);
    let post_26_snap = assert_bottom_snapshot(&rt, "row-26 appended after banner clears");
    assert!(is_row_visible(&rt, &post_26_snap, "row-26"));
    let active_after_26 = owner(&mut rt.state)
        .jump
        .active
        .clone()
        .expect("active reading-line marker after row-26");
    assert_eq!(active_after_26, "row-26:User:0:false");
    assert!(
        has_rail_marker_key(&post_26_snap, active_after_26.as_str()),
        "rail must automatically reveal active marker {active_after_26} after banner clears"
    );
    assert!(
        !rune_theme_codenomad::timeline::fits(419.0) && rune_theme_codenomad::timeline::fits(420.0),
        "test expects TIMELINE_MIN_WIDTH boundary at 420 px"
    );
    rt.set_viewport((419.0, 600.0), 1.0);
    settle(&mut rt);
    assert!(
        rt.presented("timeline").is_none(),
        "viewport 1 px below TIMELINE_MIN_WIDTH must unmount the rail"
    );
    rt.set_viewport((420.0, 600.0), 1.0);
    settle(&mut rt);
    let remounted_snap = snapshot(&rt);
    assert!(
        owner(&mut rt.state).scroll.get().at.offset[1] > 10.0
            && has_rail_marker(&remounted_snap, "row-26"),
        "widening back to TIMELINE_MIN_WIDTH must re-reveal row-26 on the remounted rail"
    );
    let rt = banners_rail::check(rt, expected_offset);
    let (rt, cmd_rx) = banners_wheel::check(rt);
    let _rt = banners_edges::check(rt, cmd_rx);
}
