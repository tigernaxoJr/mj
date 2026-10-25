//! WP-1.3: 17 張胡牌檢驗（5 面子 + 1 雀頭 / 嚦咕嚦咕 / 八仙過海 / 七搶一）、聽牌與向聽數計算
use crate::hand::Hand;
use crate::tile::{kind_of, TileId, TileKind};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum ConcealedSet {
    Triplet(TileKind),
    Sequence(TileKind),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandDecomposition {
    pub pair: TileKind,
    pub sets: Vec<ConcealedSet>,
}

/// 檢查 34 種牌計數陣列是否滿足 `required_sets` 組面子 + 1 對雀頭
pub fn can_form_standard_win(counts: &[u8; 34], required_sets: u8) -> bool {
    let expected_tiles = (required_sets as u16) * 3 + 2;
    let total: u16 = counts.iter().map(|&c| c as u16).sum();
    if total != expected_tiles {
        return false;
    }
    let mut work = *counts;
    for i in 0..34 {
        if work[i] >= 2 {
            work[i] -= 2;
            if can_extract_melds(&mut work, required_sets) {
                return true;
            }
            work[i] += 2;
        }
    }
    false
}

fn can_extract_melds(counts: &mut [u8; 34], remaining_sets: u8) -> bool {
    if remaining_sets == 0 {
        return true;
    }
    let Some(first) = counts.iter().position(|&c| c > 0) else {
        return false;
    };
    if counts[first] >= 3 {
        counts[first] -= 3;
        if can_extract_melds(counts, remaining_sets - 1) {
            counts[first] += 3;
            return true;
        }
        counts[first] += 3;
    }
    if first < 27 && (first % 9) <= 6 && counts[first + 1] > 0 && counts[first + 2] > 0 {
        counts[first] -= 1;
        counts[first + 1] -= 1;
        counts[first + 2] -= 1;
        if can_extract_melds(counts, remaining_sets - 1) {
            counts[first] += 1;
            counts[first + 1] += 1;
            counts[first + 2] += 1;
            return true;
        }
        counts[first] += 1;
        counts[first + 1] += 1;
        counts[first + 2] += 1;
    }
    false
}

/// 枚舉所有合法的標準胡牌拆解（供台數計算器挑選最高台數）
pub fn enumerate_standard_decompositions(
    counts: &[u8; 34],
    required_sets: u8,
) -> Vec<HandDecomposition> {
    let expected_tiles = (required_sets as u16) * 3 + 2;
    let total: u16 = counts.iter().map(|&c| c as u16).sum();
    if total != expected_tiles {
        return Vec::new();
    }
    let mut results = Vec::new();
    let mut work = *counts;
    for pair_kind in 0..34 {
        if work[pair_kind] >= 2 {
            work[pair_kind] -= 2;
            let mut current_sets = Vec::with_capacity(required_sets as usize);
            collect_decompositions(
                &mut work,
                required_sets,
                pair_kind as u8,
                &mut current_sets,
                &mut results,
            );
            work[pair_kind] += 2;
        }
    }
    results
}

fn collect_decompositions(
    counts: &mut [u8; 34],
    remaining_sets: u8,
    pair_kind: TileKind,
    current_sets: &mut Vec<ConcealedSet>,
    results: &mut Vec<HandDecomposition>,
) {
    if remaining_sets == 0 {
        let mut sorted = current_sets.clone();
        sorted.sort_unstable();
        let candidate = HandDecomposition {
            pair: pair_kind,
            sets: sorted,
        };
        if !results.contains(&candidate) {
            results.push(candidate);
        }
        return;
    }
    let Some(first) = counts.iter().position(|&c| c > 0) else {
        return;
    };
    if counts[first] >= 3 {
        counts[first] -= 3;
        current_sets.push(ConcealedSet::Triplet(first as u8));
        collect_decompositions(counts, remaining_sets - 1, pair_kind, current_sets, results);
        current_sets.pop();
        counts[first] += 3;
    }
    if first < 27 && (first % 9) <= 6 && counts[first + 1] > 0 && counts[first + 2] > 0 {
        counts[first] -= 1;
        counts[first + 1] -= 1;
        counts[first + 2] -= 1;
        current_sets.push(ConcealedSet::Sequence(first as u8));
        collect_decompositions(counts, remaining_sets - 1, pair_kind, current_sets, results);
        current_sets.pop();
        counts[first] += 1;
        counts[first + 1] += 1;
        counts[first + 2] += 1;
    }
}

/// 嚦咕嚦咕（八對半）：門清 17 張，由 1 組刻子（3 張）+ 7 組對子（14 張）組成
pub fn is_likuliku(counts: &[u8; 34], melds_len: usize) -> bool {
    if melds_len != 0 {
        return false;
    }
    let total: u16 = counts.iter().map(|&c| c as u16).sum();
    if total != 17 {
        return false;
    }
    for k in 0..34 {
        if counts[k] >= 3 {
            let mut rem_ok = true;
            for j in 0..34 {
                let c = if j == k { counts[j] - 3 } else { counts[j] };
                if c % 2 != 0 {
                    rem_ok = false;
                    break;
                }
            }
            if rem_ok {
                return true;
            }
        }
    }
    false
}

/// 判斷手牌（可附加一張剛摸到或他人打出的 `extra_tile`）是否滿足胡牌
pub fn can_win_hand(hand: &Hand, extra_tile: Option<TileId>) -> bool {
    if hand.melds.len() > 5 {
        return false;
    }
    let mut counts = hand.kind_counts();
    if let Some(t) = extra_tile {
        let k = kind_of(t) as usize;
        if k < 34 {
            counts[k] += 1;
        }
    }
    let required_sets = (5 - hand.melds.len()) as u8;
    can_form_standard_win(&counts, required_sets) || is_likuliku(&counts, hand.melds.len())
}

/// 計算處於待摸狀態（$3k+1$ 張暗牌）時的聽牌種類列表 `Vec<TileKind>`
pub fn waiting_tiles(hand: &Hand) -> Vec<TileKind> {
    if hand.melds.len() > 5 {
        return Vec::new();
    }
    let required_sets = (5 - hand.melds.len()) as u8;
    let expected_wait_len = (required_sets as usize) * 3 + 1;
    if hand.concealed.len() != expected_wait_len {
        return Vec::new();
    }
    let mut counts = hand.kind_counts();
    let mut waits = Vec::new();
    for k in 0..34 {
        if counts[k] < 4 {
            counts[k] += 1;
            if can_form_standard_win(&counts, required_sets)
                || is_likuliku(&counts, hand.melds.len())
            {
                waits.push(k as u8);
            }
            counts[k] -= 1;
        }
    }
    waits
}

/// 計算台灣 16 張麻將向聽數（`-1` = 已胡牌，`0` = 聽牌，`>0` = 距離聽牌所需進張數）
pub fn calculate_shanten(counts: &[u8; 34], melds_len: usize) -> i8 {
    let target_sets = 5usize.saturating_sub(melds_len);
    let mut best_score = 0i8; // score = 2 * sets + taatsu (capped at target_sets)

    for pair_k in 0..34 {
        if counts[pair_k] >= 2 {
            let mut work = *counts;
            work[pair_k] -= 2;
            search_sets(&mut work, 0, target_sets as i8, 0, true, &mut best_score);
        }
    }
    let mut work = *counts;
    search_sets(&mut work, 0, target_sets as i8, 0, false, &mut best_score);

    let mut min_shanten = (2 * (target_sets as i8)) - best_score;

    // 若門清，同時檢查嚦咕嚦咕（八對半）向聽數
    if melds_len == 0 {
        let mut pairs = 0i8;
        let mut has_triplet = false;
        for &c in counts.iter() {
            pairs += (c / 2) as i8;
            if c >= 3 {
                has_triplet = true;
            }
        }
        let liku_shanten = 7 - pairs.min(7) + if has_triplet { 0 } else { 1 };
        if liku_shanten < min_shanten {
            min_shanten = liku_shanten;
        }
    }

    min_shanten
}

fn search_sets(
    counts: &mut [u8; 34],
    idx: usize,
    target_sets: i8,
    sets: i8,
    has_pair: bool,
    best_score: &mut i8,
) {
    let mut i = idx;
    while i < 34 && counts[i] == 0 {
        i += 1;
    }
    if i >= 34 {
        let taatsu = count_taatsu(counts, (target_sets - sets).max(0));
        let score = sets * 2 + taatsu + if has_pair { 1 } else { 0 };
        if score > *best_score {
            *best_score = score;
        }
        return;
    }

    // 樂觀剪枝：即使剩下的牌全部湊滿 target_sets 也無法超越 best_score 時直接返回
    let max_possible = target_sets * 2 + if has_pair { 1 } else { 0 };
    if *best_score >= max_possible {
        return;
    }

    if sets < target_sets {
        if counts[i] >= 3 {
            counts[i] -= 3;
            search_sets(counts, i, target_sets, sets + 1, has_pair, best_score);
            counts[i] += 3;
        }
        if i < 27 && (i % 9) <= 6 && counts[i + 1] > 0 && counts[i + 2] > 0 {
            counts[i] -= 1;
            counts[i + 1] -= 1;
            counts[i + 2] -= 1;
            search_sets(counts, i, target_sets, sets + 1, has_pair, best_score);
            counts[i] += 1;
            counts[i + 1] += 1;
            counts[i + 2] += 1;
        }
    }

    search_sets(counts, i + 1, target_sets, sets, has_pair, best_score);
}

fn count_taatsu(counts: &[u8; 34], max_needed: i8) -> i8 {
    if max_needed <= 0 {
        return 0;
    }
    let mut work = *counts;
    let mut taatsu = 0i8;
    for i in 0..34 {
        while work[i] >= 2 && taatsu < max_needed {
            work[i] -= 2;
            taatsu += 1;
        }
        if i < 27 && (i % 9) <= 7 && work[i] > 0 && work[i + 1] > 0 && taatsu < max_needed {
            work[i] -= 1;
            work[i + 1] -= 1;
            taatsu += 1;
        }
        if i < 27 && (i % 9) <= 6 && work[i] > 0 && work[i + 2] > 0 && taatsu < max_needed {
            work[i] -= 1;
            work[i + 2] -= 1;
            taatsu += 1;
        }
    }
    taatsu.min(max_needed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_17_tile_and_likuliku_win_checks() {
        let mut counts = [0u8; 34];
        // 123萬, 456萬, 789萬, 123筒, 東東東 + 中中 (17 張 = 5 面子 + 1 雀頭)
        for k in 0..9 {
            counts[k] = 1;
        }
        counts[9] = 1;
        counts[10] = 1;
        counts[11] = 1;
        counts[27] = 3;
        counts[31] = 2;
        assert!(can_form_standard_win(&counts, 5));
        assert_eq!(calculate_shanten(&counts, 0), -1);

        // 嚦咕嚦咕 (8 對半): 7 對 + 1 刻 = 17 張
        let mut liku = [0u8; 34];
        for k in 0..7 {
            liku[k] = 2;
        }
        liku[27] = 3;
        assert!(is_likuliku(&liku, 0));
        assert_eq!(calculate_shanten(&liku, 0), -1);
    }

    #[test]
    fn waiting_tiles_detects_multi_wait() {
        let mut hand = Hand::new();
        // 123萬(0,4,8), 456筒(21*.. wait: 9..17 is dot, so 12,16,20 is 456萬),
        // 讓我們直接放牌種對應 ID：
        // 萬 0..8, 筒 9..17, 條 18..26
        // 123筒(9,10,11), 456筒(12,13,14), 789筒(15,16,17), 東東東(27,27,27), 中中(31,31) + 23萬(1,2) -> 聽 1萬(0) 與 4萬(3)
        let kinds: [u8; 16] = [9, 10, 11, 12, 13, 14, 15, 16, 17, 27, 27, 27, 31, 31, 1, 2];
        for (i, &k) in kinds.iter().enumerate() {
            hand.add_tile(k * 4 + ((i % 3) as u8));
        }
        let waits = waiting_tiles(&hand);
        assert_eq!(waits, vec![0, 3]);
    }
}
