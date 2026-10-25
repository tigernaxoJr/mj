//! WP-1.2: 手牌結構、理牌與副露管理
use crate::tile::{is_flower, kind_of, TileId, TileKind};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Meld {
    Chii {
        tiles: [TileId; 3],
        called: TileId,
        from_seat: u8,
    },
    Pon {
        tiles: [TileId; 3],
        called: TileId,
        from_seat: u8,
    },
    MinKan {
        tiles: [TileId; 4],
        called: TileId,
        from_seat: u8,
    },
    AnKan {
        tiles: [TileId; 4],
    },
    KaKan {
        tiles: [TileId; 4],
        called: TileId,
        from_seat: u8,
    },
}

impl Meld {
    pub fn first_kind(&self) -> TileKind {
        match self {
            Meld::Chii { tiles, .. } => {
                let mut kinds = [kind_of(tiles[0]), kind_of(tiles[1]), kind_of(tiles[2])];
                kinds.sort_unstable();
                kinds[0]
            }
            Meld::Pon { tiles, .. } => kind_of(tiles[0]),
            Meld::MinKan { tiles, .. } | Meld::AnKan { tiles } | Meld::KaKan { tiles, .. } => {
                kind_of(tiles[0])
            }
        }
    }

    pub fn is_concealed(&self) -> bool {
        matches!(self, Meld::AnKan { .. })
    }

    pub fn is_kan(&self) -> bool {
        matches!(
            self,
            Meld::MinKan { .. } | Meld::AnKan { .. } | Meld::KaKan { .. }
        )
    }

    pub fn is_sequence(&self) -> bool {
        matches!(self, Meld::Chii { .. })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hand {
    pub concealed: Vec<TileId>,
    pub melds: Vec<Meld>,
    pub flowers: Vec<TileId>,
}

impl Hand {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn sort_concealed(&mut self) {
        self.concealed.sort_by_key(|&id| (kind_of(id), id));
    }

    /// 抽出手牌中所有花牌移入 `flowers`，並回傳本次新抽出的花牌列表
    pub fn extract_flowers(&mut self) -> Vec<TileId> {
        let mut extracted = Vec::new();
        self.concealed.retain(|&id| {
            if is_flower(kind_of(id)) {
                self.flowers.push(id);
                extracted.push(id);
                false
            } else {
                true
            }
        });
        self.flowers.sort_by_key(|&id| (kind_of(id), id));
        extracted
    }

    pub fn add_tile(&mut self, tile_id: TileId) {
        self.concealed.push(tile_id);
    }

    pub fn remove_tile(&mut self, tile_id: TileId) -> bool {
        if let Some(pos) = self.concealed.iter().position(|&t| t == tile_id) {
            self.concealed.remove(pos);
            true
        } else {
            false
        }
    }

    /// 移除指定 `TileKind` 的一張暗牌並回傳其 `TileId`
    pub fn remove_first_of_kind(&mut self, kind: TileKind) -> Option<TileId> {
        if let Some(pos) = self.concealed.iter().position(|&t| kind_of(t) == kind) {
            Some(self.concealed.remove(pos))
        } else {
            None
        }
    }

    /// 僅計算暗牌的 34 種牌面數量
    pub fn kind_counts(&self) -> [u8; 34] {
        let mut counts = [0u8; 34];
        for &id in &self.concealed {
            let k = kind_of(id) as usize;
            if k < 34 {
                counts[k] += 1;
            }
        }
        counts
    }

    /// 檢查是否門清（無吃、碰、明槓、加槓；暗槓仍算門清）
    pub fn is_menzen(&self) -> bool {
        self.melds.iter().all(|m| m.is_concealed())
    }
}
