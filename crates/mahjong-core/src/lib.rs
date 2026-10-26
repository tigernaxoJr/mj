pub mod bot;
pub mod hand;
pub mod meld_check;
pub mod mental_poker;
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

/// 電腦玩家最佳捨牌；手牌 JSON 無法解析時回傳 -1
#[wasm_bindgen]
pub fn wasm_bot_best_discard(hand_json: &str) -> i32 {
    match serde_json::from_str::<hand::Hand>(hand_json) {
        Ok(hand) => bot::choose_best_discard(&hand) as i32,
        Err(_) => -1,
    }
}

#[wasm_bindgen]
pub fn wasm_bot_turn_decision_json(hand_json: &str, is_migi: bool) -> String {
    let Ok(hand) = serde_json::from_str::<hand::Hand>(hand_json) else {
        return "{}".to_string();
    };
    let decision = bot::decide_bot_turn_action(&hand, is_migi);
    serde_json::to_string(&decision).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// WP-5.2: Mental Poker 綁定。點、純量、金鑰一律以 Uint8Array 傳遞（每個 32 bytes），
// 牌山為 144 × 32 bytes；多層資料依層順序串接。無狀態：秘密留在 JS 端，每次呼叫帶入。
// ---------------------------------------------------------------------------

use mental_poker as mp;
use tile::TOTAL_TILES;

const DECK_BYTES: usize = TOTAL_TILES * 32;

fn arr32(bytes: &[u8], what: &str) -> Result<[u8; 32], JsError> {
    bytes.try_into().map_err(|_| JsError::new(&format!("{what} 必須是 32 bytes")))
}

fn deck_arg(bytes: &[u8]) -> Result<mp::Deck, JsError> {
    mp::deck_from_bytes(bytes).ok_or_else(|| JsError::new("牌山格式錯誤（需 144 個合法的壓縮點）"))
}

fn scalar_arg(bytes: &[u8]) -> Result<curve25519_dalek::scalar::Scalar, JsError> {
    mp::scalar_from_bytes(arr32(bytes, "金鑰")?).ok_or_else(|| JsError::new("金鑰不是正規純量"))
}

fn layers<T>(bytes: &[u8], layer_bytes: usize, parse: impl Fn(&[u8]) -> Option<T>) -> Option<Vec<T>> {
    if bytes.is_empty() || bytes.len() % layer_bytes != 0 {
        return None;
    }
    bytes.chunks_exact(layer_bytes).map(parse).collect()
}

#[wasm_bindgen]
pub fn mp_initial_deck() -> Vec<u8> {
    mp::deck_to_bytes(&mp::initial_deck())
}

#[wasm_bindgen]
pub fn mp_shuffle_pass(deck: &[u8], secret: &[u8]) -> Result<Vec<u8>, JsError> {
    let secret = mp::RoundSecret::from_bytes(arr32(secret, "本局秘密")?);
    Ok(mp::deck_to_bytes(&mp::shuffle_pass(&deck_arg(deck)?, &secret)))
}

#[wasm_bindgen]
pub fn mp_rekey_pass(deck: &[u8], secret: &[u8]) -> Result<Vec<u8>, JsError> {
    let secret = mp::RoundSecret::from_bytes(arr32(secret, "本局秘密")?);
    Ok(mp::deck_to_bytes(&mp::rekey_pass(&deck_arg(deck)?, &secret)))
}

#[wasm_bindgen]
pub fn mp_card_key(secret: &[u8], wall_index: usize) -> Result<Vec<u8>, JsError> {
    if wall_index >= TOTAL_TILES {
        return Err(JsError::new("牌山位置超出範圍"));
    }
    let secret = mp::RoundSecret::from_bytes(arr32(secret, "本局秘密")?);
    Ok(secret.card_key(wall_index).to_bytes().to_vec())
}

/// 換鑰輪公開的 144 筆承諾（144 × 32 bytes）
#[wasm_bindgen]
pub fn mp_card_commits(secret: &[u8]) -> Result<Vec<u8>, JsError> {
    let secret = mp::RoundSecret::from_bytes(arr32(secret, "本局秘密")?);
    Ok(secret.card_commits().concat())
}

#[wasm_bindgen]
pub fn mp_commit_card_key(key: &[u8]) -> Result<Vec<u8>, JsError> {
    Ok(mp::commit_card_key(&scalar_arg(key)?).to_vec())
}

/// 以各層逐張鎖（n × 32 bytes）開鎖；金鑰錯、缺或格式不符時回傳 -1
#[wasm_bindgen]
pub fn mp_unlock(cipher: &[u8], keys: &[u8]) -> i32 {
    let Some(point) = <[u8; 32]>::try_from(cipher)
        .ok()
        .and_then(|b| curve25519_dalek::ristretto::CompressedRistretto(b).decompress())
    else {
        return -1;
    };
    let Some(keys) = layers(keys, 32, |k| mp::scalar_from_bytes(k.try_into().ok()?)) else {
        return -1;
    };
    mp::unlock(&point, &keys).map_or(-1, i32::from)
}

/// 結算稽核；回傳 JSON：`{"wall":[...]}` 或 `{"fault":"shuffle|rekey|commit|malformed","layer":n,"wallIndex":i}`
#[wasm_bindgen]
pub fn mp_audit_round_json(shuffled: &[u8], rekeyed: &[u8], commits: &[u8], secrets: &[u8]) -> String {
    let malformed = || serde_json::json!({ "fault": "malformed" }).to_string();
    let (Some(shuffled), Some(rekeyed), Some(commits), Some(secrets)) = (
        layers(shuffled, DECK_BYTES, mp::deck_from_bytes),
        layers(rekeyed, DECK_BYTES, mp::deck_from_bytes),
        layers(commits, DECK_BYTES, |c| c.chunks_exact(32).map(|h| h.try_into().ok()).collect()),
        layers(secrets, 32, |s| Some(mp::RoundSecret::from_bytes(s.try_into().ok()?))),
    ) else {
        return malformed();
    };
    let transcript = mp::Transcript { shuffled, rekeyed, commits };
    let out = match mp::audit_round(&transcript, &secrets) {
        Ok(wall) => serde_json::json!({ "wall": wall }),
        Err(mp::AuditFault::Malformed) => return malformed(),
        Err(mp::AuditFault::Shuffle { layer }) => serde_json::json!({ "fault": "shuffle", "layer": layer }),
        Err(mp::AuditFault::Rekey { layer, wall_index }) => {
            serde_json::json!({ "fault": "rekey", "layer": layer, "wallIndex": wall_index })
        }
        Err(mp::AuditFault::Commit { layer, wall_index }) => {
            serde_json::json!({ "fault": "commit", "layer": layer, "wallIndex": wall_index })
        }
    };
    out.to_string()
}

fn identity_arg(sign_seed: &[u8], box_seed: &[u8]) -> Result<mp::Identity, JsError> {
    Ok(mp::Identity::from_seeds(arr32(sign_seed, "簽章種子")?, arr32(box_seed, "加密種子")?))
}

/// 身分公鑰：`signPub(32) ‖ boxPub(32)`
#[wasm_bindgen]
pub fn mp_identity_public(sign_seed: &[u8], box_seed: &[u8]) -> Result<Vec<u8>, JsError> {
    let id = identity_arg(sign_seed, box_seed)?;
    Ok([id.sign_public(), id.box_public()].concat())
}

#[wasm_bindgen]
pub fn mp_sign(sign_seed: &[u8], message: &[u8]) -> Result<Vec<u8>, JsError> {
    let id = mp::Identity::from_seeds(arr32(sign_seed, "簽章種子")?, [0u8; 32]);
    Ok(id.sign(message).to_vec())
}

#[wasm_bindgen]
pub fn mp_verify_signature(sign_pub: &[u8], message: &[u8], signature: &[u8]) -> bool {
    match (<[u8; 32]>::try_from(sign_pub), <[u8; 64]>::try_from(signature)) {
        (Ok(pk), Ok(sig)) => mp::verify_signature(&pk, message, &sig),
        _ => false,
    }
}

fn share_ctx(round: u32, wall_index: u16, from_seat: u8, to_seat: u8) -> mp::ShareContext {
    mp::ShareContext { round, wall_index, from_seat, to_seat }
}

#[wasm_bindgen]
pub fn mp_seal_share(
    box_seed: &[u8],
    recipient_box_pub: &[u8],
    round: u32,
    wall_index: u16,
    from_seat: u8,
    to_seat: u8,
    key: &[u8],
) -> Result<Vec<u8>, JsError> {
    let id = mp::Identity::from_seeds([0u8; 32], arr32(box_seed, "加密種子")?);
    let recipient = arr32(recipient_box_pub, "收方公鑰")?;
    Ok(id.seal_share(&recipient, share_ctx(round, wall_index, from_seat, to_seat), &scalar_arg(key)?))
}

/// 解開金鑰分享；被竄改、送錯人或情境不符時回傳 `undefined`
#[wasm_bindgen]
pub fn mp_open_share(
    box_seed: &[u8],
    sender_box_pub: &[u8],
    round: u32,
    wall_index: u16,
    from_seat: u8,
    to_seat: u8,
    sealed: &[u8],
) -> Result<Option<Vec<u8>>, JsError> {
    let id = mp::Identity::from_seeds([0u8; 32], arr32(box_seed, "加密種子")?);
    let sender = arr32(sender_box_pub, "送方公鑰")?;
    Ok(id
        .open_share(&sender, share_ctx(round, wall_index, from_seat, to_seat), sealed)
        .map(|k| k.to_bytes().to_vec()))
}

/// 任意內容的端對端加密（斷線降級用）；情境不可與金鑰分享重複
#[wasm_bindgen]
pub fn mp_seal_bytes(
    box_seed: &[u8],
    recipient_box_pub: &[u8],
    round: u32,
    wall_index: u16,
    from_seat: u8,
    to_seat: u8,
    plain: &[u8],
) -> Result<Vec<u8>, JsError> {
    let id = mp::Identity::from_seeds([0u8; 32], arr32(box_seed, "加密種子")?);
    let recipient = arr32(recipient_box_pub, "收方公鑰")?;
    Ok(id.seal_bytes(&recipient, share_ctx(round, wall_index, from_seat, to_seat), plain))
}

#[wasm_bindgen]
pub fn mp_open_bytes(
    box_seed: &[u8],
    sender_box_pub: &[u8],
    round: u32,
    wall_index: u16,
    from_seat: u8,
    to_seat: u8,
    sealed: &[u8],
) -> Result<Option<Vec<u8>>, JsError> {
    let id = mp::Identity::from_seeds([0u8; 32], arr32(box_seed, "加密種子")?);
    let sender = arr32(sender_box_pub, "送方公鑰")?;
    Ok(id.open_bytes(&sender, share_ctx(round, wall_index, from_seat, to_seat), sealed))
}

/// 房間安全碼；`members` 為 n × 65 bytes：`seat(1) ‖ signPub(32) ‖ boxPub(32)`
#[wasm_bindgen]
pub fn mp_room_fingerprint(room_code: &str, members: &[u8]) -> Result<Vec<u8>, JsError> {
    let members = layers(members, 65, |m| {
        Some((m[0], m[1..33].try_into().ok()?, m[33..65].try_into().ok()?))
    })
    .ok_or_else(|| JsError::new("成員資料必須是 n × 65 bytes"))?;
    Ok(mp::room_fingerprint(room_code, &members).to_vec())
}
