use super::directory::{digest_id, panel_id};
use serde::Deserialize;
use std::collections::HashSet;

#[derive(Clone, Debug, Deserialize)]
pub struct Attention {
    pub counts: Counts,
    pub omitted: u64,
    pub sequence: String,
    keys: Option<Vec<String>>,
    pub offset: Option<u64>,
    pub end: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Counts {
    pub notifications: u64,
    pub blocked: u64,
    pub failed: u64,
    pub recovery: u64,
}

pub(super) fn matches_page(
    base: Option<&Attention>,
    row: &super::TaskWindow,
    excluded: &[String],
) -> bool {
    let (Some(base), Some(actual)) = (base, row.task_page.attention.as_ref()) else {
        return false;
    };
    let (Some(offset), Some(end)) = (actual.offset, actual.end) else {
        return false;
    };
    base.sequence == actual.sequence
        && base.omitted == actual.omitted
        && base.counts == actual.counts
        && row.tasks.len() as u64 == end - offset
        && row.tasks.iter().all(|task| !excluded.contains(&task.id))
        && base.observed_keys(
            offset,
            end,
            &row.tasks.iter().map(|task| &task.key).collect(),
        )
}

impl Attention {
    pub(super) fn valid(&self, total: u64, blocked: u64, failed: u64, offset: Option<u64>) -> bool {
        let counts = [
            self.counts.notifications,
            self.counts.blocked,
            self.counts.failed,
            self.counts.recovery,
        ];
        self.omitted <= total
            && counts.iter().all(|count| *count <= total)
            && self.omitted <= counts.iter().sum()
            && self.counts.blocked == blocked
            && self.counts.failed == failed
            && digest_id(&self.sequence)
            && self.keys.as_ref().is_none_or(|keys| {
                keys.len() <= 50
                    && keys.len() as u64 <= self.omitted
                    && keys.iter().all(|key| panel_id(key))
                    && keys.iter().collect::<HashSet<_>>().len() == keys.len()
            })
            && match offset {
                None => self.offset.is_none() && self.end.is_none(),
                Some(offset) => {
                    let start = offset.min(self.omitted);
                    self.offset == Some(start) && self.end == Some((start + 50).min(self.omitted))
                }
            }
    }

    pub(super) fn observed_keys(&self, offset: u64, end: u64, keys: &HashSet<&String>) -> bool {
        self.keys.as_ref().is_none_or(|own| {
            own.iter()
                .enumerate()
                .all(|(i, key)| ((offset..end).contains(&(i as u64))) == keys.contains(key))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sequence_coverage_does_not_infer_unread_members() {
        let attention: Attention = serde_json::from_value(json!({
            "sequence":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "counts":{"notifications":1,"blocked":60,"failed":0,"recovery":0},
            "omitted":55,"offset":50,"end":55,
        }))
        .unwrap();
        assert!(attention.valid(100, 60, 0, Some(50)));
        assert!(!attention.valid(100, 60, 0, Some(0)));
        assert!(!attention.valid(100, 61, 0, Some(50)));
        assert!(attention.observed_keys(50, 55, &HashSet::new()));
    }
}
