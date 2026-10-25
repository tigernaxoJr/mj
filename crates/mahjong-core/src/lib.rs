pub mod bot;
pub mod hand;
pub mod meld_check;
pub mod tile;
pub mod wall;
pub mod win_check;
pub mod yaku;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn tile_kind_of(tile_id: u8) -> u8 {
    tile::kind_of(tile_id)
}
