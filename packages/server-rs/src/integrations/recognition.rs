//! Three-way recognition of catalog integrations from an authoritative `PluginControls` snapshot
//! (`opencode/integrations/recognition.ts`).

use std::collections::{HashMap, HashSet};

use crate::plugin_controls::{
    catalog::{IntegrationCatalog, IntegrationCatalogEntry},
    snapshot::{ConfigScope, RuntimeEntry, RuntimeSource, RuntimeState, Snapshot},
    spec::registry_package_name,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum RecognitionWay {
    Package,
    Plugin,
    Git,
}

/// One catalog integration as the configuration and runtime inventory show it, before any RPC.
#[derive(Clone, Debug)]
pub(crate) struct IntegrationRecognition {
    pub(crate) entry: IntegrationCatalogEntry,
    pub(crate) ways: Vec<RecognitionWay>,
    /// Indices into `snapshot.configured.sources`.
    pub(crate) sources: Vec<usize>,
    pub(crate) scopes: Vec<ConfigScope>,
    pub(crate) runtime: Option<RuntimeEntry>,
    pub(crate) ambiguous: bool,
    /// Indices into `snapshot.configured.sources` that designated an ambiguous integration.
    pub(crate) candidates: Vec<usize>,
}

fn push_unique<T: PartialEq>(list: &mut Vec<T>, item: T) {
    if !list.contains(&item) {
        list.push(item);
    }
}

pub(crate) fn recognize_integrations(catalog: &IntegrationCatalog, snapshot: &Snapshot) -> Vec<IntegrationRecognition> {
    let mut designated: HashMap<usize, HashSet<String>> = HashMap::new();
    let mut recognitions: Vec<IntegrationRecognition> = catalog
        .integrations
        .iter()
        .map(|entry| {
            let mut ways: Vec<RecognitionWay> = Vec::new();
            let mut sources: Vec<usize> = Vec::new();
            let mut ambiguous = false;

            for (source_idx, source) in snapshot.configured.sources.iter().enumerate() {
                let by_package = registry_package_name(&source.target).as_deref() == Some(entry.package.as_str());
                let by_plugin = source.plugin_id.as_deref() == Some(entry.plugin.as_str());
                let by_git = entry
                    .sources
                    .as_ref()
                    .is_some_and(|s| s.git.iter().any(|prefix| source.target.starts_with(prefix.as_str())));
                if !by_package && !by_plugin && !by_git {
                    continue;
                }
                if by_package {
                    push_unique(&mut ways, RecognitionWay::Package);
                }
                if by_plugin {
                    push_unique(&mut ways, RecognitionWay::Plugin);
                }
                if by_git {
                    push_unique(&mut ways, RecognitionWay::Git);
                }
                if source.plugin_id.as_deref().is_some_and(|pid| pid != entry.plugin) {
                    ambiguous = true;
                }
                sources.push(source_idx);
                designated.entry(source_idx).or_default().insert(entry.id.clone());
            }

            let candidates: Vec<&RuntimeEntry> = snapshot
                .runtime
                .iter()
                .filter(|candidate| {
                    let target = match &candidate.source {
                        RuntimeSource::Package { target, .. } => Some(target.as_str()),
                        _ => None,
                    };
                    let matching = target.map_or(0, |t| {
                        sources.iter().filter(|&&idx| snapshot.configured.sources[idx].target == t).count()
                    });
                    if candidate.id.is_none() && matching > 1 {
                        ambiguous = true;
                    }
                    candidate.id.as_deref() == Some(entry.plugin.as_str())
                        || (candidate.id.is_none()
                            && matches!(candidate.state, RuntimeState::Failed { .. })
                            && matching == 1)
                })
                .collect();
            if candidates.len() > 1 {
                ambiguous = true;
            }
            let runtime = if candidates.len() == 1 { Some(candidates[0].clone()) } else { None };

            let rules: Vec<_> = snapshot.configured.rules.iter().filter(|r| r.selector == entry.plugin).collect();
            if !candidates.is_empty() || rules.iter().any(|r| !r.enabled) {
                push_unique(&mut ways, RecognitionWay::Plugin);
            }
            let mut scopes: Vec<ConfigScope> = Vec::new();
            for &idx in &sources {
                push_unique(&mut scopes, snapshot.configured.sources[idx].scope);
            }
            if ways.contains(&RecognitionWay::Plugin) {
                for rule in &rules {
                    push_unique(&mut scopes, rule.scope);
                }
            }

            IntegrationRecognition {
                entry: entry.clone(),
                ways,
                sources,
                scopes,
                runtime,
                ambiguous,
                candidates: Vec::new(),
            }
        })
        .collect();

    let is_shared = |idx: usize| designated.get(&idx).is_some_and(|set| set.len() > 1);
    for recognition in &mut recognitions {
        if recognition.sources.iter().any(|&idx| is_shared(idx)) {
            recognition.ambiguous = true;
        }
        if !recognition.ambiguous {
            continue;
        }
        recognition.candidates = recognition.sources.clone();
        recognition.runtime = None;
        let expected_plugin = recognition.entry.plugin.as_str();
        recognition.sources.retain(|&idx| {
            !is_shared(idx)
                && snapshot.configured.sources[idx].plugin_id.as_deref().is_none_or(|pid| pid == expected_plugin)
        });
        let mut scopes = Vec::new();
        for &idx in &recognition.sources {
            push_unique(&mut scopes, snapshot.configured.sources[idx].scope);
        }
        if recognition.ways.contains(&RecognitionWay::Plugin) {
            for rule in snapshot.configured.rules.iter().filter(|r| r.selector == expected_plugin) {
                push_unique(&mut scopes, rule.scope);
            }
        }
        recognition.scopes = scopes;
    }

    recognitions
}
