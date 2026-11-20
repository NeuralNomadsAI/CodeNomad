//! Refs handed to an agent (`page/refs.ts`): a ref names one DOM node within the page generation
//! it was issued for; the same node keeps its ref, and every ref stays usable, for that generation.
use std::collections::{BTreeMap, HashMap};

pub(crate) struct RefTable {
    retry: &'static str,
    prefix: String,
    limit: usize,
    /// ref → (node, generation, recency)
    entries: HashMap<String, (u64, String, u64)>,
    by_node: HashMap<(String, u64), String>,
    recency: BTreeMap<u64, String>,
    next: u64,
    clock: u64,
}

impl RefTable {
    pub(crate) fn new(retry: &'static str, prefix: impl Into<String>) -> Self {
        Self {
            retry,
            prefix: prefix.into(),
            limit: 5_000,
            entries: HashMap::new(),
            by_node: HashMap::new(),
            recency: BTreeMap::new(),
            next: 0,
            clock: 0,
        }
    }

    /// Starts an inspection: refs of other generations can no longer resolve and are dropped.
    pub(crate) fn begin(&mut self, generation: &str) {
        let stale: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, e)| e.1 != generation)
            .map(|(r, _)| r.clone())
            .collect();
        for reference in stale {
            self.remove(&reference);
        }
    }

    pub(crate) fn issue(&mut self, generation: &str, node: u64) -> String {
        self.clock += 1;
        let key = (generation.to_string(), node);
        if let Some(reference) = self.by_node.get(&key).cloned() {
            // Shown again: keep it away from eviction.
            let entry = self.entries.get_mut(&reference).expect("indexed ref");
            self.recency.remove(&entry.2);
            entry.2 = self.clock;
            self.recency.insert(self.clock, reference.clone());
            return reference;
        }
        self.next += 1;
        let reference = format!("{}{}", self.prefix, self.next);
        self.entries
            .insert(reference.clone(), (node, key.0.clone(), self.clock));
        self.by_node.insert(key, reference.clone());
        self.recency.insert(self.clock, reference.clone());
        if self.entries.len() > self.limit {
            let oldest = self.recency.values().next().cloned().expect("an entry");
            self.remove(&oldest);
        }
        reference
    }

    pub(crate) fn resolve(&self, reference: &str, generation: &str) -> Result<u64, String> {
        match self.entries.get(reference) {
            Some((node, issued, _)) if issued == generation => Ok(*node),
            _ => Err(format!("Unknown or stale ref {reference}; {}", self.retry)),
        }
    }

    fn remove(&mut self, reference: &str) {
        if let Some((node, generation, recency)) = self.entries.remove(reference) {
            self.by_node.remove(&(generation, node));
            self.recency.remove(&recency);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refs_live_for_their_generation_and_names_are_never_reused() {
        let mut table = RefTable::new("inspect again", "e");
        table.begin("g1");
        assert_eq!(
            (
                table.issue("g1", 10),
                table.issue("g1", 11),
                table.issue("g1", 10)
            ),
            ("e1".into(), "e2".into(), "e1".into())
        );
        assert_eq!(table.resolve("e2", "g1"), Ok(11));
        assert_eq!(
            table.resolve("e2", "g2").unwrap_err(),
            "Unknown or stale ref e2; inspect again"
        );
        table.begin("g2");
        assert!(table.resolve("e1", "g1").is_err());
        assert_eq!(table.issue("g2", 10), "e3");
        table.limit = 2;
        table.issue("g2", 20);
        table.issue("g2", 10);
        table.issue("g2", 30);
        assert!(
            table.resolve("e4", "g2").is_err(),
            "the least recently shown ref is evicted"
        );
        assert_eq!(table.resolve("e3", "g2"), Ok(10));
    }
}
