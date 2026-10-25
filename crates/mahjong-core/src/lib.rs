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

#[wasm_bindgen]
pub fn wasm_sha256_hex(input: &str) -> String {
    wall::sha256_hex(input)
}

#[wasm_bindgen]
pub fn wasm_verify_tile_leaf(
    wall_index: usize,
    tile_id: u8,
    salt: &str,
    expected_leaf_hash: &str,
) -> bool {
    wall::verify_tile_leaf(wall_index, tile_id, salt, expected_leaf_hash)
}

#[wasm_bindgen]
pub fn wasm_create_committed_wall_json(round_seed: &str, host_secret: &str) -> String {
    let (wall, salts, leaves) = wall::Wall::create_committed_wall(round_seed, host_secret);
    serde_json::to_string(&serde_json::json!({
        "tiles": wall.tiles,
        "salts": salts,
        "leafHashes": leaves,
    }))
    .unwrap_or_default()
}

#[wasm_bindgen]
pub fn wasm_evaluate_win_json(win_context_json: &str) -> String {
    let Ok(ctx) = serde_json::from_str::<yaku::WinContext>(win_context_json) else {
        return "{}".to_string();
    };
    let breakdown = yaku::evaluate_win(&ctx);
    serde_json::to_string(&breakdown).unwrap_or_default()
}

#[wasm_bindgen]
pub fn wasm_waiting_tiles_json(hand_json: &str) -> String {
    let Ok(hand) = serde_json::from_str::<hand::Hand>(hand_json) else {
        return "[]".to_string();
    };
    let waits = win_check::waiting_tiles(&hand);
    serde_json::to_string(&waits).unwrap_or_default()
}

#[wasm_bindgen]
pub fn wasm_bot_turn_decision_json(hand_json: &str, is_migi: bool) -> String {
    let Ok(hand) = serde_json::from_str::<hand::Hand>(hand_json) else {
        return "{}".to_string();
    };
    let decision = bot::decide_bot_turn_action(&hand, is_migi);
    serde_json::to_string(&decision).unwrap_or_default()
}
