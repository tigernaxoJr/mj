//! WP-1.5: 單機啟發式向聽數 Bot AI
use crate::tile::TileId;

pub fn pick_discard_placeholder(concealed: &[TileId]) -> Option<TileId> {
    concealed.last().copied()
}
