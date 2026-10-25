//! WP-1.2: 手牌結構、理牌與副露管理
use crate::tile::{kind_of, TileId, TileKind};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Meld {
    Chii { tiles: [TileId; 3], called: TileId },
    Pon { tiles: [TileId; 3], called: TileId },
    MinKan { tiles: [TileId; 4], called: TileId },
    AnKan { tiles: [TileId; 4] },
    KaKan { tiles: [TileId; 4], called: TileId },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Hand {
    pub concealed: Vec<TileId>,
    pub melds: Vec<Meld>,
    pub flowers: Vec<TileId>,
}

impl Hand {
    pub fn sort_concealed(&mut self) {
        self.concealed.sort_by_key(|&id| (kind_of(id), id));
    }

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

    pub fn has_kind(&self, kind: TileKind) -> u8 {
        if (kind as usize) < 34 {
            self.kind_counts()[kind as usize]
        } else {
            0
        }
    }
}
