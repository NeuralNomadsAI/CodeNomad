use crate::{
    State,
    backend::Backend,
    content::{FAMILY_LIMIT, FamilyChange, FamilySnapshot, Usage},
};
use codenomad_client::{Receiver, Sender, bounded};

pub(super) const KEY: &str = "status-usage";

#[derive(Default)]
pub(crate) struct Totals {
    backend: Option<Backend>,
    loaded: Option<FamilySnapshot>,
    read: Option<Read>,
    demanded: bool,
    dirty: bool,
    pub(super) failed: bool,
}

struct Read {
    cancelled: Sender<()>,
    result: Receiver<Option<FamilySnapshot>>,
    live: std::collections::HashMap<String, Usage>,
    stale: bool,
}

impl Totals {
    pub(crate) fn bind(&mut self, backend: Backend) {
        self.close();
        self.backend = Some(backend);
    }

    pub(crate) fn close(&mut self) {
        self.cancel();
        self.loaded = None;
        self.demanded = false;
        self.dirty = false;
        self.failed = false;
    }

    fn cancel(&mut self) {
        if let Some(read) = self.read.take() {
            read.cancelled.close();
        }
    }

    pub(crate) fn refresh(&mut self) {
        self.dirty = true;
        if let Some(read) = &mut self.read {
            read.stale = true;
        }
    }

    pub(crate) fn event(&mut self, change: FamilyChange) -> bool {
        if !self.demanded {
            return false;
        }
        match change {
            FamilyChange::Usage { id, usage } => {
                if let Some(read) = &mut self.read {
                    if read.live.len() < FAMILY_LIMIT || read.live.contains_key(&id) {
                        read.live.insert(id.clone(), usage);
                    }
                }
                if let Some(slot) = self
                    .loaded
                    .as_mut()
                    .and_then(|family| family.members.get_mut(&id))
                {
                    let changed = slot.usage != usage;
                    slot.usage = usage;
                    return changed;
                }
            }
            FamilyChange::Membership { id, parent } => {
                let relevant = self.read.is_some()
                    || self
                        .backend
                        .as_ref()
                        .is_some_and(|b| parent.as_deref() == Some(b.session.as_str()))
                    || self.loaded.as_ref().is_some_and(|family| {
                        family.members.contains_key(&id)
                            || parent.is_some_and(|id| family.members.contains_key(&id))
                    });
                if relevant {
                    self.refresh();
                }
            }
        }
        false
    }

    pub(super) fn including(
        &self,
        root: Usage,
        included: impl Fn(&str, &str) -> bool,
    ) -> Option<(Usage, bool)> {
        let descendants = self
            .loaded
            .as_ref()
            .filter(|family| !family.members.is_empty())?;
        let total = descendants.members.values().fold(root, |total, member| {
            let mut usage = member.usage;
            if member
                .model
                .as_ref()
                .is_some_and(|(provider, id)| included(provider, id))
            {
                usage.cost = 0.0;
            }
            total.plus(usage)
        });
        Some((total, descendants.complete))
    }

    pub(crate) fn poll(s: &mut State) -> bool {
        let demanded = s.shell.visible(1)
            && crate::workspace::right_panel_tab(s) == crate::workspace::RightPanelTab::Status
            && s.transcript_display.toggled(KEY)
            && matches!(
                s.phase,
                crate::Phase::Ready | crate::Phase::Streaming | crate::Phase::Reconnecting
            );
        let family = &mut s.transcript_display.usage_family;
        if family.demanded != demanded {
            if demanded {
                family.demanded = true;
                family.dirty = true;
            } else {
                family.close();
            }
        }
        if !demanded {
            return false;
        }
        let mut changed = false;
        if let Some(result) = family
            .read
            .as_ref()
            .and_then(|read| read.result.try_recv().ok())
        {
            let read = family.read.take().expect("result belongs to a read");
            if !read.stale {
                let mut result = result;
                if let Some(next) = &mut result {
                    for (id, usage) in read.live {
                        if let Some(slot) = next.members.get_mut(&id) {
                            slot.usage = usage;
                        }
                    }
                }
                family.failed = result.is_none();
                family.loaded = result;
                changed = true;
            }
        }
        if family.read.is_none()
            && family.dirty
            && let Some(backend) = family.backend.clone()
        {
            family.dirty = false;
            family.failed = false;
            changed = true;
            let (cancelled, cancel) = bounded(1);
            let (out, result) = bounded(1);
            let (reads, wake) = (s.reads.clone(), s.wake.clone());
            family.read = Some(Read {
                cancelled,
                result,
                live: Default::default(),
                stale: false,
            });
            crate::platform::spawn(async move {
                let load = async {
                    let _slot = reads.background(&cancel).await?;
                    backend.family_usage().await.ok()
                };
                let result = crate::platform::reads::cancellable(&cancel, load).await;
                if let Some(result) = result
                    && out.send(result).await.is_ok()
                {
                    wake();
                }
            });
        }
        changed
    }

    pub(super) fn loading(&self) -> bool {
        self.read.is_some() || self.demanded && self.dirty
    }
}

#[cfg(test)]
#[test]
fn totals_include_the_root_once_and_replace_live_child_usage() {
    use crate::content::FamilyMember;
    let member = |input, cost, model| FamilyMember {
        usage: Usage {
            input,
            cost,
            ..Usage::default()
        },
        model,
    };
    let mut totals = Totals {
        demanded: true,
        loaded: Some(FamilySnapshot {
            complete: false,
            members: [
                ("child".into(), member(8, 0.25, None)),
                (
                    "grandchild".into(),
                    member(13, 0.5, Some(("provider".into(), "included".into()))),
                ),
            ]
            .into_iter()
            .collect(),
        }),
        ..Totals::default()
    };
    let root = Usage {
        input: 50,
        cost: 1.0,
        ..Usage::default()
    };
    let included = |provider: &str, id: &str| provider == "provider" && id == "included";
    let (initial, complete) = totals.including(root, included).unwrap();
    assert!(!complete, "partial snapshot keeps its marker");
    assert_eq!((initial.input, initial.cost), (71, 1.25));
    totals.event(FamilyChange::Usage {
        id: "unrelated".into(),
        usage: root,
    });
    assert_eq!(totals.including(root, included), Some((initial, false)));
    totals.event(FamilyChange::Usage {
        id: "child".into(),
        usage: member(16, 0.5, None).usage,
    });
    let (current, _) = totals.including(root, included).unwrap();
    assert_eq!((current.input, current.cost), (79, 1.5));
    totals.event(FamilyChange::Membership {
        id: "new".into(),
        parent: Some("grandchild".into()),
    });
    assert!(totals.dirty);
    totals.close();
    assert_eq!(totals.including(root, included), None);
}
