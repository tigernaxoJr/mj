//! WP-1.2: 吃/碰/明槓/暗槓/加槓 合法性檢查與 ClaimWindow 優先序裁決
use crate::hand::{Hand, Meld};
use crate::tile::{is_suited, kind_of, suit_of, TileId, TileKind};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum ClaimPriority {
    Pass = 0,
    Chii = 1,
    PonOrKan = 2,
    Ron = 3,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscardClaimOptions {
    pub seat: u8,
    pub can_ron: bool,
    pub pon_tiles: Option<[TileId; 2]>,
    pub minkan_tiles: Option<[TileId; 3]>,
    pub chii_options: Vec<[TileId; 2]>,
}

impl DiscardClaimOptions {
    pub fn has_any(&self) -> bool {
        self.can_ron
            || self.pon_tiles.is_some()
            || self.minkan_tiles.is_some()
            || !self.chii_options.is_empty()
    }
}

/// 找出手牌中指定 `TileKind` 的前 `n` 張實體牌
pub fn find_tiles_of_kind<const N: usize>(hand: &Hand, kind: TileKind) -> Option<[TileId; N]> {
    let mut result = [0u8; N];
    let mut found = 0;
    for &id in &hand.concealed {
        if kind_of(id) == kind {
            result[found] = id;
            found += 1;
            if found == N {
                return Some(result);
            }
        }
    }
    None
}

/// 檢查下家是否可吃 `discard_tile`，回傳所有合法的兩張手牌組合 `[TileId; 2]`
pub fn check_chii_options(hand: &Hand, discard_tile: TileId, is_next_seat: bool) -> Vec<[TileId; 2]> {
    if !is_next_seat {
        return Vec::new();
    }
    let k = kind_of(discard_tile);
    if !is_suited(k) {
        return Vec::new();
    }
    let suit = suit_of(k);
    let rank_idx = (k % 9) as i8; // 0..=8
    let pairs: [(i8, i8); 3] = [(-2, -1), (-1, 1), (1, 2)];
    let mut options = Vec::new();

    for (d1, d2) in pairs {
        let r1 = rank_idx + d1;
        let r2 = rank_idx + d2;
        if (0..=8).contains(&r1) && (0..=8).contains(&r2) {
            let k1 = (k as i8 + d1) as u8;
            let k2 = (k as i8 + d2) as u8;
            debug_assert_eq!(suit_of(k1), suit);
            debug_assert_eq!(suit_of(k2), suit);
            if let (Some([t1]), Some([t2])) = (
                find_tiles_of_kind::<1>(hand, k1),
                find_tiles_of_kind::<1>(hand, k2),
            ) {
                options.push([t1, t2]);
            }
        }
    }
    options
}

pub fn check_pon(hand: &Hand, discard_tile: TileId) -> Option<[TileId; 2]> {
    let k = kind_of(discard_tile);
    if k >= 34 {
        return None;
    }
    find_tiles_of_kind::<2>(hand, k)
}

pub fn check_minkan(hand: &Hand, discard_tile: TileId) -> Option<[TileId; 3]> {
    let k = kind_of(discard_tile);
    if k >= 34 {
        return None;
    }
    find_tiles_of_kind::<3>(hand, k)
}

/// 摸牌後檢查手牌中可暗槓的牌種與 4 張牌 ID
pub fn check_ankan_options(hand: &Hand) -> Vec<(TileKind, [TileId; 4])> {
    let counts = hand.kind_counts();
    let mut res = Vec::new();
    for (k, &c) in counts.iter().enumerate() {
        if c == 4 {
            if let Some(tiles) = find_tiles_of_kind::<4>(hand, k as u8) {
                res.push((k as u8, tiles));
            }
        }
    }
    res
}

/// 摸牌後檢查手牌中可加槓（小明槓）的 `(meld_index, tile_id, kind)`
pub fn check_kakan_options(hand: &Hand) -> Vec<(usize, TileId, TileKind)> {
    let mut res = Vec::new();
    for (idx, meld) in hand.melds.iter().enumerate() {
        if let Meld::Pon { tiles, .. } = meld {
            let k = kind_of(tiles[0]);
            if let Some([t]) = find_tiles_of_kind::<1>(hand, k) {
                res.push((idx, t, k));
            }
        }
    }
    res
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubmittedClaim {
    pub seat: u8,
    pub priority: ClaimPriority,
    /// 若為 Chii，帶入選擇的兩張手牌
    pub chii_tiles: Option<[TileId; 2]>,
    pub is_minkan: bool,
}

/// 計算 `seat` 相對於出牌者 `discarder_seat` 的逆時針順位距離 `1..=3`（越小越優先）
#[inline]
pub const fn turn_distance(discarder_seat: u8, claimer_seat: u8) -> u8 {
    (claimer_seat + 4 - discarder_seat) % 4
}

/// 裁決 `ClaimWindow` 收集到的所有回應：
/// - 優先序：`Ron (3) > PonOrKan (2) > Chii (1) > Pass (0)`
/// - 同優先序（如多家同時胡牌且 `allow_multi_ron == false`）：取逆時針距離出牌者最近者（攔胡）
/// - 若 `allow_multi_ron == true` 且最高優先序為 `Ron`，回傳所有宣告 `Ron` 的玩家（依逆時針排序）
pub fn resolve_claims(
    discarder_seat: u8,
    claims: &[SubmittedClaim],
    allow_multi_ron: bool,
) -> Vec<SubmittedClaim> {
    let max_prio = claims
        .iter()
        .map(|c| c.priority)
        .max()
        .unwrap_or(ClaimPriority::Pass);
    if max_prio == ClaimPriority::Pass {
        return Vec::new();
    }

    let mut top: Vec<SubmittedClaim> = claims
        .iter()
        .filter(|c| c.priority == max_prio)
        .cloned()
        .collect();
    top.sort_by_key(|c| turn_distance(discarder_seat, c.seat));

    if max_prio == ClaimPriority::Ron && allow_multi_ron {
        top
    } else {
        top.into_iter().take(1).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_priority_and_counterclockwise_intercept() {
        // 東家(0)打出牌，西家(2)喊胡、北家(3)喊胡、南家(1)喊碰
        let claims = vec![
            SubmittedClaim {
                seat: 1,
                priority: ClaimPriority::PonOrKan,
                chii_tiles: None,
                is_minkan: false,
            },
            SubmittedClaim {
                seat: 3,
                priority: ClaimPriority::Ron,
                chii_tiles: None,
                is_minkan: false,
            },
            SubmittedClaim {
                seat: 2,
                priority: ClaimPriority::Ron,
                chii_tiles: None,
                is_minkan: false,
            },
        ];

        // 攔胡（預設 allow_multi_ron = false）：西家(2)比北家(3)更靠近東家(0)，由西家截胡
        let single = resolve_claims(0, &claims, false);
        assert_eq!(single.len(), 1);
        assert_eq!(single[0].seat, 2);

        // 一炮多響（allow_multi_ron = true）：西家(2)與北家(3)皆胡
        let multi = resolve_claims(0, &claims, true);
        assert_eq!(multi.len(), 2);
        assert_eq!(multi[0].seat, 2);
        assert_eq!(multi[1].seat, 3);
    }

    #[test]
    fn chii_options_only_for_next_seat_and_same_suit() {
        let mut hand = Hand::new();
        // 手上有 二萬(4), 三萬(8), 五萬(16), 六萬(20)
        hand.concealed = vec![4, 8, 16, 20];
        // 上家打出 四萬(12) -> 可吃 [23萬], [35萬], [56萬] 三組
        let opts = check_chii_options(&hand, 12, true);
        assert_eq!(opts.len(), 3);
        // 非下家不可吃
        assert!(check_chii_options(&hand, 12, false).is_empty());
    }
}
