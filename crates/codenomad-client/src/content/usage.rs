use serde_json::Value;

/// Native counters and USD cost on an assistant step or session.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub reasoning: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost: f64,
}

impl Usage {
    pub fn decode(record: &Value) -> Option<Self> {
        let tokens = record["tokens"].as_object()?;
        let count = |key| tokens.get(key).and_then(Value::as_u64).unwrap_or(0);
        let cache = tokens.get("cache").unwrap_or(&Value::Null);
        Some(Self {
            input: count("input"),
            output: count("output"),
            reasoning: count("reasoning"),
            cache_read: cache["read"].as_u64().unwrap_or(0),
            cache_write: cache["write"].as_u64().unwrap_or(0),
            cost: record["cost"].as_f64().filter(|cost| cost.is_finite() && *cost >= 0.0).unwrap_or(0.0),
        })
    }

    pub fn plus(self, other: Self) -> Self {
        Self {
            input: self.input.saturating_add(other.input),
            output: self.output.saturating_add(other.output),
            reasoning: self.reasoning.saturating_add(other.reasoning),
            cache_read: self.cache_read.saturating_add(other.cache_read),
            cache_write: self.cache_write.saturating_add(other.cache_write),
            cost: (self.cost + other.cost).min(f64::MAX),
        }
    }
}
