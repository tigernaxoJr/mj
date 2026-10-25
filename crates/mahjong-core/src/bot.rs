//! WP-1.5: 單機與房間補位電腦玩家 (Bot AI) 向聽數與攻防決策引擎
use crate::hand::Hand;
use crate::meld_check::{check_chii_options, check_pon, ClaimPriority, SubmittedClaim};
use crate::tile::{is_honor, kind_of, rank_of, TileId, TileKind};
use crate::win_check::{calculate_shanten, can_win_hand};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "UPPERCASE")]
pub enum BotTurnDecision {
    Tsumo,
    AnKan { kind: TileKind, tiles: [TileId; 4] },
    KaKan { meld_index: usize, tile_id: TileId, kind: TileKind },
    Discard { tile_id: TileId },
}

/// 電腦玩家摸牌（或吃碰）後的回合動作決策
pub fn decide_bot_turn_action(hand: &Hand, is_migi: bool) -> BotTurnDecision {
    // 1. 能自摸胡牌立刻自摸
    if can_win_hand(hand, None) {
        return BotTurnDecision::Tsumo;
    }

    // 2. 若未聽牌鎖定，檢查暗槓與加槓是否不惡化向聽數
    if !is_migi {
        let base_counts = hand.kind_counts();
        let base_shanten = calculate_shanten(&base_counts, hand.melds.len());

        for (k, tiles) in crate::meld_check::check_ankan_options(hand) {
            let mut after = base_counts;
            after[k as usize] = 0;
            let new_shanten = calculate_shanten(&after, hand.melds.len() + 1);
            if new_shanten <= base_shanten {
                return BotTurnDecision::AnKan { kind: k, tiles };
            }
        }

        for (meld_index, tile_id, kind) in crate::meld_check::check_kakan_options(hand) {
            let mut after = base_counts;
            after[kind as usize] = after[kind as usize].saturating_sub(1);
            let new_shanten = calculate_shanten(&after, hand.melds.len());
            if new_shanten <= base_shanten {
                return BotTurnDecision::KaKan {
                    meld_index,
                    tile_id,
                    kind,
                };
            }
        }
    }

    // 3. 若已宣告 MIGI 聽牌，強制摸切最後一張牌
    if is_migi {
        if let Some(&last) = hand.concealed.last() {
            return BotTurnDecision::Discard { tile_id: last };
        }
    }

    let tile_id = choose_best_discard(hand);
    BotTurnDecision::Discard { tile_id }
}

/// 選擇使向聽數最小、有效進張（Ukeire）最大，且優先打出孤立字牌/邊張的捨牌
pub fn choose_best_discard(hand: &Hand) -> TileId {
    if hand.concealed.is_empty() {
        return 0;
    }
    let base_counts = hand.kind_counts();
    let melds_len = hand.melds.len();

    let mut best_tile = hand.concealed[0];
    let mut best_shanten = i8::MAX;
    let mut best_ukeire = -1i32;
    let mut best_positional_score = i32::MIN;

    let mut seen_kinds = [false; 34];

    for &candidate_id in &hand.concealed {
        let k = kind_of(candidate_id) as usize;
        if k >= 34 || seen_kinds[k] {
            continue;
        }
        seen_kinds[k] = true;

        let mut work = base_counts;
        work[k] -= 1;
        let shanten = calculate_shanten(&work, melds_len);

        // 計算打掉 k 之後能讓向聽數下降的進張種類與剩餘張數
        let mut ukeire = 0i32;
        for draw_k in 0..34 {
            if work[draw_k] < 4 {
                work[draw_k] += 1;
                let next_s = calculate_shanten(&work, melds_len);
                if next_s < shanten {
                    ukeire += (4 - work[draw_k] as i32) + 1;
                }
                work[draw_k] -= 1;
            }
        }

        // 位置與孤張評分：孤立字牌與么九邊張優先丟棄（留下中張 3..7 更容易靠張）
        let pos_score = discard_preference_score(k as u8, &base_counts);

        let is_better = if shanten != best_shanten {
            shanten < best_shanten
        } else if ukeire != best_ukeire {
            ukeire > best_ukeire
        } else {
            pos_score > best_positional_score
        };

        if is_better {
            best_shanten = shanten;
            best_ukeire = ukeire;
            best_positional_score = pos_score;
            best_tile = candidate_id;
        }
    }

    best_tile
}

fn discard_preference_score(kind: TileKind, counts: &[u8; 34]) -> i32 {
    let k = kind as usize;
    let c = counts[k];
    if is_honor(kind) {
        // 單張字牌最優先打掉（分數最高），對子或刻子字牌保留（分數低）
        return match c {
            1 => 100,
            2 => -40,
            _ => -100,
        };
    }
    let rank = rank_of(kind).unwrap_or(5) as i32; // 1..=9
    let center_dist = (rank - 5).abs(); // 0..=4（么九為 4，五為 0）
    let mut neighbor_support = 0i32;
    if rank > 1 && counts[k - 1] > 0 {
        neighbor_support += 25;
    }
    if rank < 9 && counts[k + 1] > 0 {
        neighbor_support += 25;
    }
    if rank > 2 && counts[k - 2] > 0 {
        neighbor_support += 10;
    }
    if rank < 8 && counts[k + 2] > 0 {
        neighbor_support += 10;
    }
    let pair_keep = if c >= 2 { 45 } else { 0 };
    center_dist * 8 - neighbor_support - pair_keep
}

/// 電腦玩家對他人捨牌的副露／榮胡回應決策
pub fn decide_bot_claim_response(
    seat: u8,
    hand: &Hand,
    discard_tile: TileId,
    is_next_seat: bool,
    can_ron_now: bool,
    is_migi: bool,
) -> SubmittedClaim {
    // 1. 能胡必胡
    if can_ron_now && can_win_hand(hand, Some(discard_tile)) {
        return SubmittedClaim {
            seat,
            priority: ClaimPriority::Ron,
            chii_tiles: None,
            is_minkan: false,
        };
    }

    if is_migi {
        return SubmittedClaim {
            seat,
            priority: ClaimPriority::Pass,
            chii_tiles: None,
            is_minkan: false,
        };
    }

    let base_counts = hand.kind_counts();
    let base_shanten = calculate_shanten(&base_counts, hand.melds.len());

    // 2. 評估碰牌是否能降低向聽數
    if check_pon(hand, discard_tile).is_some() {
        let k = kind_of(discard_tile) as usize;
        let mut after_pon = base_counts;
        after_pon[k] = after_pon[k].saturating_sub(2);
        // 模擬碰完打出一張最佳牌後的向聽數
        let mut best_after = i8::MAX;
        for d in 0..34 {
            if after_pon[d] > 0 {
                after_pon[d] -= 1;
                let s = calculate_shanten(&after_pon, hand.melds.len() + 1);
                if s < best_after {
                    best_after = s;
                }
                after_pon[d] += 1;
            }
        }
        if best_after < base_shanten {
            return SubmittedClaim {
                seat,
                priority: ClaimPriority::PonOrKan,
                chii_tiles: None,
                is_minkan: false,
            };
        }
    }

    // 3. 評估吃牌（僅下家）是否能降低向聽數且接近聽牌（base_shanten <= 2）
    if is_next_seat && base_shanten <= 2 {
        let chii_opts = check_chii_options(hand, discard_tile, true);
        for pair in chii_opts {
            let mut after_chii = base_counts;
            let k0 = kind_of(pair[0]) as usize;
            let k1 = kind_of(pair[1]) as usize;
            after_chii[k0] = after_chii[k0].saturating_sub(1);
            after_chii[k1] = after_chii[k1].saturating_sub(1);

            let mut best_after = i8::MAX;
            for d in 0..34 {
                if after_chii[d] > 0 {
                    after_chii[d] -= 1;
                    let s = calculate_shanten(&after_chii, hand.melds.len() + 1);
                    if s < best_after {
                        best_after = s;
                    }
                    after_chii[d] += 1;
                }
            }
            if best_after < base_shanten {
                return SubmittedClaim {
                    seat,
                    priority: ClaimPriority::Chii,
                    chii_tiles: Some(pair),
                    is_minkan: false,
                };
            }
        }
    }

    SubmittedClaim {
        seat,
        priority: ClaimPriority::Pass,
        chii_tiles: None,
        is_minkan: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bot_discards_isolated_wind_over_connected_suited_tiles() {
        let mut hand = Hand::new();
        // 123萬(0,1,2), 45萬(3,4), 67筒(14,15) + 單張北風(30)
        let kinds: [u8; 8] = [0, 1, 2, 3, 4, 14, 15, 30];
        for (i, &k) in kinds.iter().enumerate() {
            hand.add_tile(k * 4 + (i as u8 % 4));
        }
        let discard = choose_best_discard(&hand);
        assert_eq!(kind_of(discard), 30);
    }
}
