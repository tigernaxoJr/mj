//! WP-1.3: 17 張胡牌檢驗（5 面子 + 1 雀頭 / 嚦咕嚦咕 / 八仙過海 / 七搶一）、聽牌與向聽數計算

/// 檢查 34 種序數/字牌計數陣列是否滿足 `required_melds` 組面子 + 1 對雀頭
pub fn can_form_standard_win(counts: &[u8; 34], required_melds: u8) -> bool {
    let expected_tiles = (required_melds as u16) * 3 + 2;
    let total: u16 = counts.iter().map(|&c| c as u16).sum();
    if total != expected_tiles {
        return false;
    }
    let mut work = *counts;
    for i in 0..34 {
        if work[i] >= 2 {
            work[i] -= 2;
            if can_extract_melds(&mut work, required_melds) {
                return true;
            }
            work[i] += 2;
        }
    }
    false
}

fn can_extract_melds(counts: &mut [u8; 34], remaining_melds: u8) -> bool {
    if remaining_melds == 0 {
        return true;
    }
    let Some(first) = counts.iter().position(|&c| c > 0) else {
        return false;
    };
    if counts[first] >= 3 {
        counts[first] -= 3;
        if can_extract_melds(counts, remaining_melds - 1) {
            counts[first] += 3;
            return true;
        }
        counts[first] += 3;
    }
    if first < 27 && (first % 9) <= 6 && counts[first + 1] > 0 && counts[first + 2] > 0 {
        counts[first] -= 1;
        counts[first + 1] -= 1;
        counts[first + 2] -= 1;
        if can_extract_melds(counts, remaining_melds - 1) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_17_tile_win_check() {
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

        counts[31] = 1;
        counts[32] = 1;
        assert!(!can_form_standard_win(&counts, 5));
    }
}
