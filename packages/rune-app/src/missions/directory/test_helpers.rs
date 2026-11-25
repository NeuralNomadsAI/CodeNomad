use super::{Kind, Panel, Read};
use codenomad_client::missions::{Cleanup, DirectoryPage, DirectoryRows, Summary, Window};

impl Panel {
    pub(in crate::missions) fn cleanup_token_count(&self) -> usize {
        self.cleanup_tokens.len()
    }

    pub(crate) fn refresh_for_test(&mut self) {
        self.refresh();
    }

    pub(crate) fn load_more_cleanups_for_test(&mut self) {
        self.start(Kind::Cleanups, Read::More);
    }

    pub(crate) fn seed_summary_for_test(&mut self, id: &str) {
        self.summaries.push(Summary {
            id: id.into(),
            title: Some(id.into()),
            objective: id.into(),
            status: codenomad_client::missions::Status::Active,
            run_state: None,
            coordinator_session_id: "ses_c".into(),
            actor_count: 1,
            updated_at: 1.0,
            revision: 7,
            finish_sequence: None,
            task_count: None,
        });
        self.select(id);
    }

    pub(crate) fn has_summary_for_test(&self, id: &str) -> bool {
        self.summaries.iter().any(|row| row.id == id)
    }

    pub(crate) fn has_settled_cleanup_for_test(&self, deletion_id: &str) -> bool {
        self.cleanups
            .iter()
            .any(|row| row.deletion_id == deletion_id && !row.is_pending())
    }

    pub(in crate::missions) fn cleanup_seen_count(&self) -> usize {
        self.lanes[Kind::Cleanups as usize].seen.len()
    }

    pub(in crate::missions) fn accept_more_cleanups_for_test(
        &mut self,
        order: &str,
        offset: u64,
        total: u64,
        rows: Vec<Cleanup>,
    ) -> bool {
        let end = offset + rows.len() as u64;
        self.accept(
            Kind::Cleanups,
            if offset == 0 {
                Read::Refresh
            } else {
                Read::More
            },
            DirectoryPage {
                project_id: self.project.clone().unwrap_or_else(|| "project".into()),
                finish_high_water: None,
                window: Window {
                    order: order.into(),
                    offset,
                    end,
                    total,
                },
                rows: DirectoryRows::Cleanups(rows),
            },
        )
    }

    pub(in crate::missions) fn accept_manual_refresh_cleanups_for_test(
        &mut self,
        order: &str,
        total: u64,
        rows: Vec<Cleanup>,
    ) -> bool {
        let end = rows.len() as u64;
        self.accept(
            Kind::Cleanups,
            Read::ManualRefresh,
            DirectoryPage {
                project_id: self.project.clone().unwrap_or_else(|| "project".into()),
                finish_high_water: None,
                window: Window {
                    order: order.into(),
                    offset: 0,
                    end,
                    total,
                },
                rows: DirectoryRows::Cleanups(rows),
            },
        )
    }

    pub(crate) fn accept_cleanups_for_test(&mut self, rows: Vec<Cleanup>) -> bool {
        let len = rows.len() as u64;
        self.accept(
            Kind::Cleanups,
            Read::Refresh,
            DirectoryPage {
                project_id: self.project.clone().unwrap_or_else(|| "project".into()),
                finish_high_water: None,
                window: Window {
                    order: "test-order".into(),
                    offset: 0,
                    end: len,
                    total: len,
                },
                rows: DirectoryRows::Cleanups(rows),
            },
        )
    }

    pub(crate) fn accept_summaries_for_test(&mut self, rows: Vec<Summary>) -> bool {
        let len = rows.len() as u64;
        self.accept(
            Kind::Summaries,
            Read::Refresh,
            DirectoryPage {
                project_id: self.project.clone().unwrap_or_else(|| "project".into()),
                finish_high_water: None,
                window: Window {
                    order: "test-order".into(),
                    offset: 0,
                    end: len,
                    total: len,
                },
                rows: DirectoryRows::Summaries(rows),
            },
        )
    }

    pub(in crate::missions) fn cleanup_index_counts(&self) -> (usize, usize, usize, usize) {
        (
            self.cleanups.len(),
            self.lanes[Kind::Cleanups as usize].seen.len(),
            self.cleanup_meta.len(),
            self.pending_cleanup_set.len(),
        )
    }

    pub(in crate::missions) fn cleanup_tail_visits(&self) -> usize {
        self.lanes[Kind::Cleanups as usize].tail_visits
    }

    pub(in crate::missions) fn reset_cleanup_tail_visits(&mut self) {
        self.lanes[Kind::Cleanups as usize].tail_visits = 0;
    }
}
