#[cfg(test)]
use super::observation::Observation;
use crate::strings::{locale, t};
#[cfg(test)]
use codenomad_client::missions::MapHeader;
use codenomad_client::{
    history::valid_id,
    missions::{Task, TaskStatus},
};
use rune::{El, Tx, text};
use rune_theme_codenomad::{
    TextRole, attachment, catalogue, git_panel as theme,
    layout::{self, Layout},
    shell,
};
use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
    rc::Rc,
};

pub(super) type OpenTask<S> = Rc<dyn Fn(&mut S, String, &mut Tx)>;

/// Exact owned worker conversation for a task. Never falls back to the coordinator.
pub(super) fn task_conversation_with_actors(
    coordinator: &str,
    actors: &HashSet<String>,
    task: &Task,
) -> Option<String> {
    let id = task.actor_session_id()?;
    if id == coordinator || id == "global" || !valid_id(id) || !actors.contains(id) {
        return None;
    }
    Some(id.to_owned())
}

#[cfg(test)]
pub(super) fn task_conversation(
    header: &MapHeader,
    observation: &Observation,
    task: &Task,
) -> Option<String> {
    task_conversation_with_actors(
        header.root.coordinator_session_id(),
        &observation.current_actors(),
        task,
    )
}

pub(super) type TaskOpen<S> = Rc<dyn Fn(&mut S, String, String, &mut Tx)>;

#[derive(Clone)]
pub(super) struct TaskRows {
    rows: Vec<Rc<Task>>,
    keys: HashMap<String, usize>,
    ids: HashMap<String, usize>,
}

impl TaskRows {
    pub fn len(&self) -> u64 {
        self.rows.len() as u64
    }

    pub fn contains(&self, key: &str) -> bool {
        self.keys.contains_key(key)
    }

    pub fn find_by_id_or_key(&self, id: &str, key: &str) -> Option<&Task> {
        self.ids
            .get(id)
            .or_else(|| self.keys.get(key))
            .map(|&i| self.rows[i].as_ref())
    }

    pub fn find_by_key(&self, key: &str) -> Option<&Task> {
        self.keys.get(key).map(|&i| self.rows[i].as_ref())
    }

    pub fn iter(&self) -> impl Iterator<Item = &Task> {
        self.rows.iter().map(Rc::as_ref)
    }

    pub fn new(mut tasks: Vec<Task>) -> Self {
        tasks.sort_unstable_by_key(|task| task.order);
        let mut own = Self {
            rows: tasks.into_iter().map(Rc::new).collect(),
            keys: HashMap::new(),
            ids: HashMap::new(),
        };
        own.index();
        own
    }

    fn index(&mut self) {
        self.keys.clear();
        self.ids.clear();
        for (i, task) in self.rows.iter().enumerate() {
            self.keys.insert(task.key.clone(), i);
            self.ids.insert(task.id.clone(), i);
        }
    }

    pub fn extend(&mut self, tasks: Vec<Task>, offset: u64, end: u64) -> bool {
        for task in &tasks {
            if [self.keys.get(&task.key), self.ids.get(&task.id)]
                .into_iter()
                .flatten()
                .any(|&i| self.rows[i].order != task.order)
                || self
                    .rows
                    .binary_search_by_key(&task.order, |old| old.order)
                    .ok()
                    .is_some_and(|i| self.rows[i].id != task.id || self.rows[i].key != task.key)
            {
                return false;
            }
        }
        self.rows
            .retain(|task| !(offset..end).contains(&task.order));
        self.rows.extend(tasks.into_iter().map(Rc::new));
        self.rows.sort_unstable_by_key(|task| task.order);
        self.rows.dedup_by_key(|task| task.order);
        self.index();
        true
    }

    fn title(&self, key: &str) -> &str {
        self.keys.get(key).map_or("", |&i| title(&self.rows[i]))
    }

    #[cfg(test)]
    pub fn view<S: 'static>(self: &Rc<Self>) -> El {
        self.view_with_open::<S>(None, None, None)
    }

    pub fn view_with_open<S: 'static>(
        self: &Rc<Self>,
        open_task_id: Option<String>,
        on_open: Option<TaskOpen<S>>,
        conversation: Option<(String, Rc<HashSet<String>>, OpenTask<S>)>,
    ) -> El {
        let keys = self.clone();
        let rows = self.clone();
        let language = locale();
        layout::transcript_rows(
            rows.rows.len(),
            move |_: &S, i| Cow::Owned(format!("mission-task-{}", keys.rows[i].id)),
            move |_: &S, i| {
                let task = &rows.rows[i];
                let action = conversation.as_ref().and_then(|(coordinator, actors, cb)| {
                    task_conversation_with_actors(coordinator, actors, task)
                        .map(|session_id| (session_id, cb.clone()))
                });
                crate::strings::with_locale(language, || {
                    rows.row(task, open_task_id.as_deref(), on_open.as_ref(), action)
                })
            },
        )
        .role("list")
        .label(t("missions.control.profiles.role.specialist"))
    }

    fn row<S: 'static>(
        &self,
        task: &Task,
        open_task_id: Option<&str>,
        on_open: Option<&TaskOpen<S>>,
        action: Option<(String, OpenTask<S>)>,
    ) -> El {
        let title = title(task);
        let state = t(match task.status {
            TaskStatus::Blocked => "missions.control.task.status.blocked",
            TaskStatus::Ready => "missions.control.task.status.ready",
            TaskStatus::Dispatching => "missions.control.task.status.dispatching",
            TaskStatus::Queued => "missions.control.task.status.queued",
            TaskStatus::Completed => "missions.control.task.status.completed",
            TaskStatus::NeedsInput => "missions.control.task.status.needs-input",
            TaskStatus::Failed => "missions.control.task.status.failed",
            TaskStatus::Withdrawn => "missions.control.task.status.superseded",
        });
        let active = on_open.is_some() && open_task_id == Some(task.id.as_str());
        let mut header = theme::file_row(active).child(text(title).wrap_anywhere().remaining());
        if let Some(open) = on_open {
            let id = task.id.clone();
            let key = task.key.clone();
            let open = open.clone();
            header = header.child(
                theme::icon_button(
                    &theme::EYE,
                    format!("{} · {title}", t("missions.control.task.details")),
                    false,
                    Some(active),
                    move |s: &mut S, tx| open(s, id.clone(), key.clone(), tx),
                )
                .key(format!("mission-task-eye-{}", task.id)),
            );
        }
        if let Some((session_id, open)) = action {
            header = header.child(
                theme::icon_button(
                    &shell::icons::CONVERSATION,
                    t("missionsPanel.task.openConversation"),
                    false,
                    None,
                    move |s: &mut S, tx| {
                        open(s, session_id.clone(), tx);
                        tx.instant();
                    },
                )
                .key(format!("mission-task-open-{}", task.id)),
            );
        }
        let mut row = theme::tools()
            .role("listitem")
            .label(title)
            .child(header)
            .child(attachment::status_badge(state));
        if !task.blocked_by.is_empty() {
            let dependencies = task
                .blocked_by
                .iter()
                .map(|key| {
                    let name = self.title(key);
                    if name.is_empty() { key.as_str() } else { name }
                })
                .collect::<Vec<_>>()
                .join(", ");
            row = row.child(
                text(catalogue::format(
                    locale(),
                    "missions.control.task.blockedBy",
                    &[("tasks", &dependencies)],
                ))
                .text_role(TextRole::Small)
                .wrap_anywhere(),
            );
        }
        row
    }
}

fn title(task: &Task) -> &str {
    if task.title.is_empty() {
        &task.key
    } else {
        &task.title
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Env, Runtime, ScrollSpec, col};
    use serde_json::json;

    #[test]
    fn a_2400_task_plan_only_mounts_nearby_rows_and_indexes_offscreen_dependencies() {
        let plan = (0..2400).map(|i| serde_json::from_value(json!({
            "id":format!("tsk-{i}"),"key":format!("task-{i}"),"title":format!("Task {i}"),
            "role":"specialist","status":"blocked","blockedBy":if i==0 {vec!["task-2399"]} else {vec!["task-0"]},
            "order":i,"createdAt":1,"updatedAt":1,"dependents":0,"reportCount":0,"outstandingExecution":false,
        })).unwrap()).collect();
        let mut rt = Runtime::new(
            Rc::new(TaskRows::new(plan)),
            |rows, _| {
                crate::strings::with_locale("en", || {
                    col()
                        .full_width()
                        .full_height()
                        .scroll(ScrollSpec {
                            stick_bottom: false,
                        })
                        .child(rows.view::<Rc<TaskRows>>())
                })
            },
            (340.0, 720.0),
            Env::new(false, 1.0),
        );
        for _ in 0..8 {
            rt.frame(1.0 / 60.0);
        }
        let count = rt
            .elements()
            .iter()
            .filter(|e| {
                e.key
                    .as_deref()
                    .is_some_and(|key| key.starts_with("mission-task-tsk-"))
            })
            .count();
        assert!((1..100).contains(&count), "{count} mounted rows");
        assert!(rt.find("mission-task-tsk-0").is_some());
        assert!(rt.find("mission-task-tsk-2399").is_none());
        assert!(
            rt.accessibility_json()
                .to_string()
                .contains("Depends on Task 2399")
        );
        rt.update(|_, tx| tx.scroll_into_view("mission-task-tsk-2399"));
        for _ in 0..8 {
            rt.frame(1.0 / 60.0);
        }
        assert!(rt.find("mission-task-tsk-2399").is_some());
        assert!(rt.find("mission-task-tsk-0").is_none());
    }

    #[test]
    fn task_conversation_requires_verified_owned_non_coordinator_actor() {
        let header: MapHeader = serde_json::from_value(json!({
            "root": {
                "id": "msn-1", "title": "Mission", "excerpt": "Obj",
                "status": "active", "runState": "running", "revision": 2,
                "projectID": "proj-1", "projectCanonical": "/repo",
                "coordinatorSessionId": "ses_coord", "version": 1,
                "template": "custom", "createdAt": 1.0, "updatedAt": 2.0,
                "historyTruncated": false, "bodies": {}
            },
            "tasks": {
                "page": {"order": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "offset": 0, "end": 0, "total": 0, "counts": {}, "reports": 0},
                "pins": [], "reportPins": [], "version": "1"
            },
            "collections": {
                "actors": {"characters": 2, "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "total": 0, "array": true},
                "history": {"characters": 2, "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "total": 0, "array": true},
                "reports": {"characters": 2, "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "total": 0, "array": true}
            }
        }))
        .unwrap();
        let make_task = |id: &str, actor: Option<&str>| -> Task {
            let mut val = json!({
                "id": id, "key": id, "title": id, "role": "specialist",
                "status": "queued", "blockedBy": [], "order": 0,
                "createdAt": 1, "updatedAt": 1, "dependents": 0,
                "reportCount": 0, "outstandingExecution": false,
            });
            if let Some(actor) = actor {
                val["actorSessionId"] = json!(actor);
            }
            serde_json::from_value(val).unwrap()
        };
        let mut obs = Observation::default();
        obs.fixture_actor("ses_worker");
        obs.fixture_actor("ses_coord");

        assert_eq!(
            task_conversation(&header, &obs, &make_task("t1", Some("ses_worker"))),
            Some("ses_worker".into())
        );
        // Never falls back to coordinator or unowned/unobserved/global actors.
        assert_eq!(
            task_conversation(&header, &obs, &make_task("t2", Some("ses_coord"))),
            None
        );
        assert_eq!(
            task_conversation(&header, &obs, &make_task("t3", Some("ses_unobserved"))),
            None
        );
        assert_eq!(
            task_conversation(&header, &obs, &make_task("t4", Some("global"))),
            None
        );
        assert_eq!(
            task_conversation(&header, &obs, &make_task("t5", None)),
            None
        );
    }

    #[test]
    fn task_row_coexists_reader_eye_and_worker_conversation_button() {
        struct Harness {
            rows: Rc<TaskRows>,
            actors: Rc<HashSet<String>>,
            opened_reader: Vec<(String, String)>,
            opened_conversation: Vec<String>,
        }
        let tasks: Vec<Task> = vec![
            serde_json::from_value(json!({
                "id": "tsk-worker", "key": "task-worker", "title": "Worker task",
                "role": "specialist", "status": "queued", "blockedBy": [], "order": 0,
                "createdAt": 1, "updatedAt": 1, "dependents": 0, "reportCount": 0,
                "outstandingExecution": false, "actorSessionId": "ses_worker"
            }))
            .unwrap(),
            serde_json::from_value(json!({
                "id": "tsk-coord", "key": "task-coord", "title": "Coord task",
                "role": "specialist", "status": "queued", "blockedBy": [], "order": 1,
                "createdAt": 1, "updatedAt": 1, "dependents": 0, "reportCount": 0,
                "outstandingExecution": false, "actorSessionId": "ses_coord"
            }))
            .unwrap(),
        ];
        let mut actors = HashSet::new();
        actors.insert("ses_worker".to_owned());
        actors.insert("ses_coord".to_owned());
        let state = Harness {
            rows: Rc::new(TaskRows::new(tasks)),
            actors: Rc::new(actors),
            opened_reader: Vec::new(),
            opened_conversation: Vec::new(),
        };
        let mut rt = Runtime::new(
            state,
            |s, _| {
                crate::strings::with_locale("en", || {
                    let on_reader: TaskOpen<Harness> = Rc::new(|h, id, key, _| {
                        h.opened_reader.push((id, key));
                    });
                    let on_conv: OpenTask<Harness> = Rc::new(|h, session_id, _| {
                        h.opened_conversation.push(session_id);
                    });
                    col()
                        .full_width()
                        .full_height()
                        .scroll(ScrollSpec {
                            stick_bottom: false,
                        })
                        .child(s.rows.view_with_open(
                            Some("tsk-worker".to_owned()),
                            Some(on_reader),
                            Some(("ses_coord".to_owned(), s.actors.clone(), on_conv)),
                        ))
                })
            },
            (360.0, 480.0),
            Env::new(false, 1.0),
        );
        for _ in 0..4 {
            rt.frame(1.0 / 60.0);
        }
        let (ex, ey) = rt.find("mission-task-eye-tsk-worker").unwrap();
        let (ox, oy) = rt.find("mission-task-open-tsk-worker").unwrap();
        assert!(rt.find("mission-task-eye-tsk-coord").is_some());
        assert!(rt.find("mission-task-open-tsk-coord").is_none());
        let elements = rt.elements();
        let eye_el = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("mission-task-eye-tsk-worker"))
            .unwrap();
        let open_el = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("mission-task-open-tsk-worker"))
            .unwrap();
        assert!(
            open_el.rect[2] <= 36.0 && open_el.rect[3] <= 36.0,
            "task open conversation action must be a compact icon button: {:?}",
            open_el.rect
        );
        assert!(
            (eye_el.rect[1] - open_el.rect[1]).abs() <= 4.0 && eye_el.rect[0] < open_el.rect[0],
            "task conversation icon must sit inline after the reader eye icon: eye={:?} open={:?}",
            eye_el.rect,
            open_el.rect
        );
        assert!(
            elements.iter().any(|el| el.role == "status"),
            "task row must render its status as a badge"
        );

        rt.pointer_down(ex, ey);
        rt.pointer_up(ex, ey);
        rt.frame(1.0 / 60.0);
        rt.pointer_down(ox, oy);
        rt.pointer_up(ox, oy);
        rt.frame(1.0 / 60.0);
        assert_eq!(
            rt.state.opened_reader,
            vec![("tsk-worker".to_owned(), "task-worker".to_owned())]
        );
        assert_eq!(rt.state.opened_conversation, vec!["ses_worker".to_owned()]);
    }
}
