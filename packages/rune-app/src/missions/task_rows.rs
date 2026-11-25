use crate::strings::{locale, t};
use codenomad_client::missions::{Task, TaskStatus};
use rune::{El, Tx, col, row, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue, git_panel as theme,
    layout::{self, Layout},
};
use std::{borrow::Cow, collections::HashMap, rc::Rc};

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
        self.view_with_open::<S>(None, None)
    }

    pub fn view_with_open<S: 'static>(
        self: &Rc<Self>,
        open_task_id: Option<String>,
        on_open: Option<TaskOpen<S>>,
    ) -> El {
        let keys = self.clone();
        let rows = self.clone();
        let language = locale();
        layout::transcript_rows(
            rows.rows.len(),
            move |_: &S, i| Cow::Owned(format!("mission-task-{}", keys.rows[i].id)),
            move |_: &S, i| {
                crate::strings::with_locale(language, || {
                    rows.row(&rows.rows[i], open_task_id.as_deref(), on_open.as_ref())
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
        let header = if let Some(open) = on_open {
            let active = open_task_id == Some(task.id.as_str());
            let id = task.id.clone();
            let key = task.key.clone();
            let open = open.clone();
            row()
                .full_width()
                .child(text(title).wrap_anywhere().remaining())
                .child(
                    theme::icon_button(
                        &theme::EYE,
                        format!("{} · {title}", t("missions.control.task.details")),
                        false,
                        Some(active),
                        move |s: &mut S, tx| open(s, id.clone(), key.clone(), tx),
                    )
                    .key(format!("mission-task-eye-{}", task.id)),
                )
        } else {
            row().full_width().child(text(title).wrap_anywhere())
        };
        let mut row = col()
            .full_width()
            .pad(Space::Sm)
            .role("listitem")
            .label(title)
            .child(header)
            .child(text(state).text_role(TextRole::Small));
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
    use rune::{Env, Runtime, ScrollSpec};
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
}
