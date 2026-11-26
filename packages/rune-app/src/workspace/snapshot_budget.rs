/// Cover the excess with the fewest bytes lost. Admit reserved items as candidates
/// only if items below their priority cannot cover the excess.
pub(super) fn choose(weights: &[(u8, usize)], excess: usize) -> Option<Vec<usize>> {
    if excess == 0 {
        return Some(Vec::new());
    }
    let max_tier = weights.iter().map(|(tier, _)| *tier).max().unwrap_or(0);
    let priority = (0..=max_tier).find(|priority| {
        weights
            .iter()
            .filter(|(tier, _)| tier <= priority)
            .map(|(_, n)| n)
            .sum::<usize>()
            >= excess
    })?;
    let candidates: Vec<_> = weights
        .iter()
        .enumerate()
        .filter_map(|(i, (tier, n))| (*tier <= priority && *n != 0).then_some((i, *n)))
        .collect();
    let total: usize = candidates.iter().map(|(_, n)| n).sum();
    let largest = candidates.iter().map(|(_, n)| *n).max()?;
    let remove_limit = total.min(excess + largest - 1);
    let keep_limit = total - excess;
    let keep = keep_limit < remove_limit;
    let limit = if keep { keep_limit } else { remove_limit };
    let mut reachable = vec![0u64; limit / 64 + 1];
    let mut parent = vec![u16::MAX; limit + 1];
    reachable[0] = 1;
    for &(index, weight) in &candidates {
        if weight > limit {
            continue;
        }
        let (whole, bits) = (weight / 64, weight % 64);
        for to in (whole..reachable.len()).rev() {
            let from = to - whole;
            let mut shifted = reachable[from] << bits;
            if bits != 0 && from > 0 {
                shifted |= reachable[from - 1] >> (64 - bits);
            }
            let mut fresh = shifted & !reachable[to];
            reachable[to] |= shifted;
            while fresh != 0 {
                let bit = fresh.trailing_zeros() as usize;
                if let Some(parent) = parent.get_mut(to * 64 + bit) {
                    *parent = u16::try_from(index).ok()?;
                }
                fresh &= fresh - 1;
            }
        }
    }
    let mut sum = if keep {
        (1..=limit)
            .rev()
            .find(|sum| parent[*sum] != u16::MAX)
            .unwrap_or(0)
    } else {
        (excess..=limit).find(|sum| parent[*sum] != u16::MAX)?
    };
    let mut selected = vec![false; weights.len()];
    while sum != 0 {
        let index = usize::from(parent[sum]);
        let (_, weight) = *weights.get(index)?;
        selected[index] = true;
        sum -= weight;
    }
    Some(
        candidates
            .into_iter()
            .filter_map(|(i, _)| (selected[i] != keep).then_some(i))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::choose;

    #[test]
    fn finds_the_smallest_total_and_reserves_active_drafts() {
        let weights = [(2, 5), (0, 3), (0, 3), (0, 255)];
        assert_eq!(choose(&weights, 4), Some(vec![1, 2]));
        assert_eq!(choose(&weights, 250), Some(vec![3]));
        let selected = choose(&weights, 263).unwrap();
        assert!(selected.contains(&0));
        assert_eq!(selected.iter().map(|&id| weights[id].1).sum::<usize>(), 263);
        assert_eq!(choose(&weights, 267), None);
    }
}
