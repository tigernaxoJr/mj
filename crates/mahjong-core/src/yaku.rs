//! WP-1.4: 台灣 16 張麻將完整台數與底台結算引擎
use crate::hand::{Hand, Meld};
use crate::tile::{is_honor, is_suited, kind_of, suit_of, Suit, TileId, TileKind};
use crate::win_check::{
    enumerate_standard_decompositions, is_likuliku, waiting_tiles, ConcealedSet, HandDecomposition,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaiItem {
    pub name: String,
    pub tai: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettlementBreakdown {
    pub items: Vec<TaiItem>,
    pub total_tai: u16,
    pub total_points: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WinContext {
    pub hand: Hand,
    /// 胡的那張牌（自摸或榮胡的最後一張牌；八仙過海/七搶一可為花牌）
    pub winning_tile: TileId,
    pub is_tsumo: bool,
    /// 圈風：`0=東, 1=南, 2=西, 3=北`
    pub round_wind: u8,
    /// 胡牌者門風：`0=東, 1=南, 2=西, 3=北`
    pub seat_wind: u8,
    /// 胡牌者或放銃者是否為莊家（莊家胡牌或莊家放銃皆須加計莊家連拉台）
    pub involves_dealer: bool,
    /// 莊家連莊次數 $N$（連 $N$ 拉 $N$ = $2N$ 台，加莊家 1 台共 $2N+1$ 台）
    pub dealer_streak: u8,
    /// 是否已宣告聽牌（MIGI）
    pub is_migi: bool,
    /// 是否為天聽（起手第一巡即宣告聽牌）
    pub is_tenhou_migi: bool,
    /// 天胡（莊家起手 17 張自摸）
    pub is_tenhou: bool,
    /// 地胡（閒家首巡未經副露首次摸牌自摸）
    pub is_chiihou: bool,
    /// 人胡（首巡無副露他人打第一張牌放銃）
    pub is_renhou: bool,
    /// 海底撈月（最後一張可摸牌自摸）或河底撈魚（最後一張打出放銃）
    pub is_last_tile: bool,
    /// 槓上開花（補花或槓牌嶺上補牌自摸）
    pub is_rinshan: bool,
    /// 搶槓胡（他人加槓時搶胡）
    pub is_chankan: bool,
    /// 七搶一特殊花胡
    pub is_seven_rob_one: bool,
    /// 底分（預設 300）
    pub base_points: i32,
    /// 每台分數（預設 100）
    pub tai_points: i32,
}

pub fn evaluate_win(ctx: &WinContext) -> SettlementBreakdown {
    // 1. 檢查八仙過海 / 七搶一特殊花胡
    if ctx.hand.flowers.len() == 8 || ctx.is_seven_rob_one {
        let mut items = Vec::new();
        add_dealer_tai(&mut items, ctx);
        if ctx.hand.flowers.len() == 8 {
            items.push(TaiItem {
                name: "八仙過海".to_string(),
                tai: 8,
            });
        } else {
            items.push(TaiItem {
                name: "七搶一".to_string(),
                tai: 8,
            });
        }
        return finalize_settlement(items, ctx.base_points, ctx.tai_points);
    }

    let mut full_hand = ctx.hand.clone();
    full_hand.add_tile(ctx.winning_tile);
    let counts = full_hand.kind_counts();
    let required_sets = 5usize.saturating_sub(full_hand.melds.len()) as u8;

    let decomps = enumerate_standard_decompositions(&counts, required_sets);
    let mut best: Option<SettlementBreakdown> = None;

    let waits = waiting_tiles(&ctx.hand);
    let win_kind = kind_of(ctx.winning_tile);

    for decomp in &decomps {
        let items = score_standard_decomposition(ctx, &full_hand, decomp, &waits, win_kind);
        let breakdown = finalize_settlement(items, ctx.base_points, ctx.tai_points);
        if best
            .as_ref()
            .map_or(true, |b| breakdown.total_tai > b.total_tai)
        {
            best = Some(breakdown);
        }
    }

    // 檢查嚦咕嚦咕（八對半）
    if is_likuliku(&counts, full_hand.melds.len()) {
        let items = score_likuliku(ctx, &full_hand);
        let breakdown = finalize_settlement(items, ctx.base_points, ctx.tai_points);
        if best
            .as_ref()
            .map_or(true, |b| breakdown.total_tai > b.total_tai)
        {
            best = Some(breakdown);
        }
    }

    best.unwrap_or_else(|| finalize_settlement(Vec::new(), ctx.base_points, ctx.tai_points))
}

fn add_dealer_tai(items: &mut Vec<TaiItem>, ctx: &WinContext) {
    if ctx.involves_dealer {
        items.push(TaiItem {
            name: "莊家".to_string(),
            tai: 1,
        });
        if ctx.dealer_streak > 0 {
            let n = ctx.dealer_streak as u16;
            items.push(TaiItem {
                name: format!("連{n}拉{n}"),
                tai: n * 2,
            });
        }
    }
}

fn add_flower_tai(items: &mut Vec<TaiItem>, hand: &Hand, seat_wind: u8) -> bool {
    let mut seasons = [false; 4];
    let mut plants = [false; 4];
    for &f in &hand.flowers {
        let k = kind_of(f);
        if (34..=37).contains(&k) {
            seasons[(k - 34) as usize] = true;
        } else if (38..=41).contains(&k) {
            plants[(k - 38) as usize] = true;
        }
    }

    let has_all_seasons = seasons.iter().all(|&b| b);
    let has_all_plants = plants.iter().all(|&b| b);

    if has_all_seasons {
        items.push(TaiItem {
            name: "花槓（四季）".to_string(),
            tai: 2,
        });
    } else if seasons[seat_wind as usize] {
        items.push(TaiItem {
            name: format!("正花（{}花）", seat_wind + 1),
            tai: 1,
        });
    }

    if has_all_plants {
        items.push(TaiItem {
            name: "花槓（四君子）".to_string(),
            tai: 2,
        });
    } else if plants[seat_wind as usize] {
        items.push(TaiItem {
            name: format!("正花（{}花）", seat_wind + 1),
            tai: 1,
        });
    }

    !hand.flowers.is_empty()
}

fn add_situational_tai(items: &mut Vec<TaiItem>, ctx: &WinContext, is_menzen: bool) {
    if ctx.is_tenhou {
        items.push(TaiItem {
            name: "天胡".to_string(),
            tai: 16,
        });
    } else if ctx.is_chiihou {
        items.push(TaiItem {
            name: "地胡".to_string(),
            tai: 16,
        });
    } else if ctx.is_renhou {
        items.push(TaiItem {
            name: "人胡".to_string(),
            tai: 8,
        });
    }

    if ctx.is_tenhou_migi {
        items.push(TaiItem {
            name: "天聽".to_string(),
            tai: 8,
        });
    } else if ctx.is_migi {
        items.push(TaiItem {
            name: "聽牌".to_string(),
            tai: 2,
        });
    }

    if is_menzen && ctx.is_tsumo {
        items.push(TaiItem {
            name: "門清一摸三".to_string(),
            tai: 3,
        });
    } else {
        if is_menzen {
            items.push(TaiItem {
                name: "門清".to_string(),
                tai: 1,
            });
        }
        if ctx.is_tsumo {
            items.push(TaiItem {
                name: "自摸".to_string(),
                tai: 1,
            });
        }
    }

    if ctx.is_rinshan && ctx.is_tsumo {
        items.push(TaiItem {
            name: "槓上開花".to_string(),
            tai: 1,
        });
    }
    if ctx.is_chankan && !ctx.is_tsumo {
        items.push(TaiItem {
            name: "搶槓".to_string(),
            tai: 1,
        });
    }
    if ctx.is_last_tile {
        items.push(TaiItem {
            name: if ctx.is_tsumo {
                "海底撈月".to_string()
            } else {
                "河底撈魚".to_string()
            },
            tai: 1,
        });
    }
}

fn add_flush_tai(items: &mut Vec<TaiItem>, full_hand: &Hand) {
    let mut suits_present = [false; 3];
    let mut has_honors = false;

    let mut inspect_kind = |k: TileKind| {
        match suit_of(k) {
            Suit::Character => suits_present[0] = true,
            Suit::Dot => suits_present[1] = true,
            Suit::Bamboo => suits_present[2] = true,
            Suit::Wind | Suit::Dragon => has_honors = true,
            Suit::Flower => {}
        }
    };

    for &t in &full_hand.concealed {
        inspect_kind(kind_of(t));
    }
    for m in &full_hand.melds {
        match m {
            Meld::Chii { tiles, .. } | Meld::Pon { tiles, .. } => {
                for &t in tiles {
                    inspect_kind(kind_of(t));
                }
            }
            Meld::MinKan { tiles, .. } | Meld::AnKan { tiles } | Meld::KaKan { tiles, .. } => {
                for &t in tiles {
                    inspect_kind(kind_of(t));
                }
            }
        }
    }

    let suit_count = suits_present.iter().filter(|&&b| b).count();
    if suit_count == 0 && has_honors {
        items.push(TaiItem {
            name: "字一色".to_string(),
            tai: 16,
        });
    } else if suit_count == 1 && !has_honors {
        items.push(TaiItem {
            name: "清一色".to_string(),
            tai: 8,
        });
    } else if suit_count == 1 && has_honors {
        items.push(TaiItem {
            name: "混一色".to_string(),
            tai: 4,
        });
    }
}

fn score_likuliku(ctx: &WinContext, full_hand: &Hand) -> Vec<TaiItem> {
    let mut items = Vec::new();
    add_dealer_tai(&mut items, ctx);
    add_situational_tai(&mut items, ctx, true);
    add_flower_tai(&mut items, full_hand, ctx.seat_wind);
    items.push(TaiItem {
        name: "嚦咕嚦咕".to_string(),
        tai: 8,
    });
    add_flush_tai(&mut items, full_hand);
    items
}

fn score_standard_decomposition(
    ctx: &WinContext,
    full_hand: &Hand,
    decomp: &HandDecomposition,
    waits: &[TileKind],
    win_kind: TileKind,
) -> Vec<TaiItem> {
    let mut items = Vec::new();
    let is_menzen = full_hand.is_menzen();

    add_dealer_tai(&mut items, ctx);
    add_situational_tai(&mut items, ctx, is_menzen);
    let has_flowers = add_flower_tai(&mut items, full_hand, ctx.seat_wind);

    // 收集所有刻子（含副露碰/槓與手牌暗刻）與順子
    let mut triplet_kinds: Vec<TileKind> = Vec::new();
    let mut sequence_count = 0usize;
    let mut concealed_triplets = 0usize;

    for m in &full_hand.melds {
        if m.is_sequence() {
            sequence_count += 1;
        } else {
            triplet_kinds.push(m.first_kind());
            if m.is_concealed() {
                concealed_triplets += 1;
            }
        }
    }

    // 若榮胡（非自摸），且胡牌張剛好只用來完成暗刻（而非完成順子或雀頭），該刻子視為明刻
    let mut ron_completed_sequence_or_pair = decomp.pair == win_kind;
    for s in &decomp.sets {
        if let ConcealedSet::Sequence(start) = *s {
            if win_kind >= start && win_kind <= start + 2 {
                ron_completed_sequence_or_pair = true;
            }
        }
    }

    let mut ron_triplet_discounted = false;
    for s in &decomp.sets {
        match *s {
            ConcealedSet::Triplet(k) => {
                triplet_kinds.push(k);
                if !ctx.is_tsumo
                    && k == win_kind
                    && !ron_completed_sequence_or_pair
                    && !ron_triplet_discounted
                {
                    ron_triplet_discounted = true;
                } else {
                    concealed_triplets += 1;
                }
            }
            ConcealedSet::Sequence(_) => {
                sequence_count += 1;
            }
        }
    }

    // 碰碰胡（5 組皆為刻子/槓子）
    if triplet_kinds.len() == 5 {
        items.push(TaiItem {
            name: "碰碰胡".to_string(),
            tai: 4,
        });
    }

    // 三暗刻 / 四暗刻 / 五暗刻
    match concealed_triplets {
        5 => items.push(TaiItem {
            name: "五暗刻".to_string(),
            tai: 8,
        }),
        4 => items.push(TaiItem {
            name: "四暗刻".to_string(),
            tai: 5,
        }),
        3 => items.push(TaiItem {
            name: "三暗刻".to_string(),
            tai: 2,
        }),
        _ => {}
    }

    // 四喜判定（東 27, 南 28, 西 29, 北 30）
    let wind_triplet_count = triplet_kinds
        .iter()
        .filter(|&&k| (27..=30).contains(&k))
        .count();
    let is_wind_pair = (27..=30).contains(&decomp.pair);

    if wind_triplet_count == 4 {
        items.push(TaiItem {
            name: "大四喜".to_string(),
            tai: 16,
        });
    } else if wind_triplet_count == 3 && is_wind_pair {
        items.push(TaiItem {
            name: "小四喜".to_string(),
            tai: 8,
        });
    } else {
        // 未成大小四喜時，個別計算圈風刻與門風刻
        let round_wind_kind = 27 + ctx.round_wind;
        let seat_wind_kind = 27 + ctx.seat_wind;
        if triplet_kinds.contains(&round_wind_kind) {
            items.push(TaiItem {
                name: "圈風刻".to_string(),
                tai: 1,
            });
        }
        if triplet_kinds.contains(&seat_wind_kind) {
            items.push(TaiItem {
                name: "門風刻".to_string(),
                tai: 1,
            });
        }
    }

    // 三元判定（中 31, 發 32, 白 33）
    let dragon_triplet_count = triplet_kinds
        .iter()
        .filter(|&&k| (31..=33).contains(&k))
        .count();
    let is_dragon_pair = (31..=33).contains(&decomp.pair);

    if dragon_triplet_count == 3 {
        items.push(TaiItem {
            name: "大三元".to_string(),
            tai: 8,
        });
    } else if dragon_triplet_count == 2 && is_dragon_pair {
        items.push(TaiItem {
            name: "小三元".to_string(),
            tai: 4,
        });
    } else {
        for &(k, label) in &[(31u8, "紅中"), (32u8, "青發"), (33u8, "白板")] {
            if triplet_kinds.contains(&k) {
                items.push(TaiItem {
                    name: label.to_string(),
                    tai: 1,
                });
            }
        }
    }

    // 清一色 / 混一色 / 字一色
    add_flush_tai(&mut items, full_hand);

    // 全求（5 組吃/碰/明槓露在外面，單吊胡牌且非自摸）
    let open_melds = full_hand.melds.iter().filter(|m| !m.is_concealed()).count();
    let is_quanqiu = open_melds == 5 && !ctx.is_tsumo;
    if is_quanqiu {
        items.push(TaiItem {
            name: "全求".to_string(),
            tai: 2,
        });
    }

    // 檢查聽牌型態：兩面聽 vs 獨聽（邊張、嵌張、單吊）
    let is_two_sided_wait = decomp.sets.iter().any(|s| {
        if let ConcealedSet::Sequence(start) = *s {
            let r = start % 9;
            // 例如 23萬(r=1)胡 1萬(start)或 4萬(start+2)；78萬(r=6)胡 6萬(start)或 9萬(start+2)
            (win_kind == start && r != 6) || (win_kind == start + 2 && r != 0)
        } else {
            false
        }
    });

    if !is_quanqiu && waits.len() == 1 && !is_two_sided_wait {
        items.push(TaiItem {
            name: "獨聽".to_string(),
            tai: 1,
        });
    }

    // 平胡（2 台）：無花、無字、5 組全順子、將眼非字牌、非自摸、兩面聽（且聽超過 1 種牌面）
    let has_any_honor = is_honor(decomp.pair);
    if !has_flowers
        && !has_any_honor
        && sequence_count == 5
        && !ctx.is_tsumo
        && is_two_sided_wait
        && waits.len() >= 2
        && is_suited(decomp.pair)
    {
        items.push(TaiItem {
            name: "平胡".to_string(),
            tai: 2,
        });
    }

    items
}

fn finalize_settlement(
    items: Vec<TaiItem>,
    base_points: i32,
    tai_points: i32,
) -> SettlementBreakdown {
    let total_tai: u16 = items.iter().map(|i| i.tai).sum();
    let total_points = base_points + (total_tai as i32) * tai_points;
    SettlementBreakdown {
        items,
        total_tai,
        total_points,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_ctx(hand: Hand, winning_tile: TileId, is_tsumo: bool) -> WinContext {
        WinContext {
            hand,
            winning_tile,
            is_tsumo,
            round_wind: 0,
            seat_wind: 0,
            involves_dealer: true,
            dealer_streak: 2, // 莊家(1) + 連2拉2(4) = 5 台
            is_migi: false,
            is_tenhou_migi: false,
            is_tenhou: false,
            is_chiihou: false,
            is_renhou: false,
            is_last_tile: false,
            is_rinshan: false,
            is_chankan: false,
            is_seven_rob_one: false,
            base_points: 300,
            tai_points: 100,
        }
    }

    #[test]
    fn scores_menzen_tsumo_dealer_streak_and_dragons() {
        let mut hand = Hand::new();
        // 萬子清一色 + 大三元? 不，測試混一色 + 大三元 + 碰碰胡 + 四暗刻 + 門清一摸三 + 莊家連2拉2
        // 中(31)*3, 發(32)*3, 白(33)*3, 東(27)*3, 一萬(0)*3 + 二萬(1)*1 (聽二萬單吊)
        let kinds: [u8; 16] = [
            31, 31, 31, 32, 32, 32, 33, 33, 33, 27, 27, 27, 0, 0, 0, 1,
        ];
        for (i, &k) in kinds.iter().enumerate() {
            hand.add_tile(k * 4 + ((i % 4) as u8));
        }
        let ctx = default_ctx(hand, 1 * 4 + 2, true);
        let res = evaluate_win(&ctx);
        let names: Vec<&str> = res.items.iter().map(|i| i.name.as_str()).collect();
        assert!(names.contains(&"莊家"));
        assert!(names.contains(&"連2拉2"));
        assert!(names.contains(&"門清一摸三"));
        assert!(names.contains(&"大三元"));
        assert!(names.contains(&"碰碰胡"));
        assert!(names.contains(&"五暗刻"));
        assert!(names.contains(&"混一色"));
    }

    #[test]
    fn scores_pinghu_accurately() {
        let mut hand = Hand::new();
        // 123萬(0,1,2), 456萬(3,4,5), 123筒(9,10,11), 456筒(12,13,14), 55條(22,22) + 23條(19,20) -> 榮胡 1條(18)
        let kinds: [u8; 16] = [0, 1, 2, 3, 4, 5, 9, 10, 11, 12, 13, 14, 22, 22, 19, 20];
        for (i, &k) in kinds.iter().enumerate() {
            hand.add_tile(k * 4 + ((i % 3) as u8));
        }
        let mut ctx = default_ctx(hand, 18 * 4, false);
        ctx.involves_dealer = false;
        let res = evaluate_win(&ctx);
        let names: Vec<&str> = res.items.iter().map(|i| i.name.as_str()).collect();
        assert!(names.contains(&"平胡"));
        assert!(names.contains(&"門清"));
        assert_eq!(res.total_tai, 3);
    }
}
