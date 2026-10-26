//! WP-5.1: Mental Poker 牌山協定的密碼核心（設計見 docs/04-host-anticheat-mental-poker.md）
//!
//! - 牌的鎖：Ristretto255 純量乘法 `E_k(P) = k·P`，加解鎖順序可交換。
//! - 洗牌輪：每位真人依序 `deck ← shuffle(k_p · deck)`，結束後沒人知道排列。
//! - 換鑰輪：每位真人依序把全域鎖 `k_p` 換成逐張鎖 `k_{p,i}`，並承諾 `hash(k_{p,i})`。
//! - 摸牌：其他層持有者以 `crypto_box` 把 `k_{p,i}` 封裝給摸牌者，房主轉送也看不到。
//! - 結算：公開各家本局秘密，`audit_round` 重算每一輪並指出作弊者。
//!
//! 密碼學原語全部來自 `curve25519-dalek`、`ed25519-dalek`、`crypto_box`、`sha2`、`rand_chacha`；
//! 本模組只負責把它們組成 SRA 分層洗牌。
use crate::tile::{TileId, TOTAL_TILES};
use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar;
use sha2::{Digest, Sha256, Sha512};
use std::collections::HashMap;
use std::sync::OnceLock;

pub type Deck = Vec<RistrettoPoint>;
pub type Commit = [u8; 32];

const DOMAIN: &str = "twmj/mental-poker/v1";

struct TileTable {
    points: Vec<RistrettoPoint>,
    lookup: HashMap<CompressedRistretto, TileId>,
}

fn tile_table() -> &'static TileTable {
    static TABLE: OnceLock<TileTable> = OnceLock::new();
    TABLE.get_or_init(|| {
        // 必須 hash-to-curve（離散對數未知）；若用 s·G，同一層全域鎖下的密文比例會洩漏排列
        let points: Vec<RistrettoPoint> = (0..TOTAL_TILES)
            .map(|t| RistrettoPoint::hash_from_bytes::<Sha512>(format!("{DOMAIN}/tile/{t}").as_bytes()))
            .collect();
        let lookup = points
            .iter()
            .enumerate()
            .map(|(t, p)| (p.compress(), t as TileId))
            .collect();
        TileTable { points, lookup }
    })
}

/// 尚未加鎖的公開牌山：位置 `t` 即牌 `t`
pub fn initial_deck() -> Deck {
    tile_table().points.clone()
}

/// 每位真人每局的私密材料；整局只在結算時公開這 32 bytes，所有金鑰皆由它推導
#[derive(Clone)]
pub struct RoundSecret([u8; 32]);

impl RoundSecret {
    /// `bytes` 應來自 Web Crypto `crypto.getRandomValues`
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn to_bytes(&self) -> [u8; 32] {
        self.0
    }

    fn derive_scalar(&self, label: &str) -> Scalar {
        let mut h = Sha512::new();
        h.update(DOMAIN.as_bytes());
        h.update(label.as_bytes());
        h.update(self.0);
        Scalar::from_hash(h)
    }

    pub fn global_key(&self) -> Scalar {
        self.derive_scalar("/global")
    }

    pub fn card_key(&self, wall_index: usize) -> Scalar {
        self.derive_scalar(&format!("/card/{wall_index}"))
    }

    fn shuffle_seed(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(DOMAIN.as_bytes());
        h.update(b"/shuffle");
        h.update(self.0);
        h.finalize().into()
    }

    /// 換鑰輪公開的 144 筆承諾
    pub fn card_commits(&self) -> Vec<Commit> {
        (0..TOTAL_TILES).map(|i| commit_card_key(&self.card_key(i))).collect()
    }
}

pub fn commit_card_key(key: &Scalar) -> Commit {
    let mut h = Sha256::new();
    h.update(DOMAIN.as_bytes());
    h.update(b"/commit");
    h.update(key.as_bytes());
    h.finalize().into()
}

/// 洗牌輪：乘上全域鎖後以 ChaCha20 洗牌
pub fn shuffle_pass(deck: &[RistrettoPoint], secret: &RoundSecret) -> Deck {
    use rand::seq::SliceRandom;
    use rand::SeedableRng;
    let k = secret.global_key();
    let mut out: Deck = deck.iter().map(|c| k * c).collect();
    out.shuffle(&mut rand_chacha::ChaCha20Rng::from_seed(secret.shuffle_seed()));
    out
}

/// 換鑰輪：位置不變，把全域鎖換成逐張鎖
pub fn rekey_pass(deck: &[RistrettoPoint], secret: &RoundSecret) -> Deck {
    let inv = secret.global_key().invert();
    deck.iter()
        .enumerate()
        .map(|(i, c)| (secret.card_key(i) * inv) * c)
        .collect()
}

/// 以所有層的逐張鎖開鎖；任何一把錯或缺都回傳 `None`（結果不是任何一張牌）
pub fn unlock(cipher: &RistrettoPoint, keys: &[Scalar]) -> Option<TileId> {
    let product = keys.iter().fold(Scalar::ONE, |acc, k| acc * k);
    let plain = product.invert() * cipher;
    tile_table().lookup.get(&plain.compress()).copied()
}

/// 牌山序列化：每張 32 bytes 壓縮點
pub fn deck_to_bytes(deck: &[RistrettoPoint]) -> Vec<u8> {
    deck.iter().flat_map(|p| p.compress().to_bytes()).collect()
}

pub fn deck_from_bytes(bytes: &[u8]) -> Option<Deck> {
    if bytes.len() != TOTAL_TILES * 32 {
        return None;
    }
    bytes
        .chunks_exact(32)
        .map(|c| CompressedRistretto::from_slice(c).ok()?.decompress())
        .collect()
}

pub fn scalar_from_bytes(bytes: [u8; 32]) -> Option<Scalar> {
    Option::from(Scalar::from_canonical_bytes(bytes))
}

/// 一局的公開紀錄（依層順序，也就是真人座位順序）
#[derive(Clone, Default)]
pub struct Transcript {
    pub shuffled: Vec<Deck>,
    pub rekeyed: Vec<Deck>,
    pub commits: Vec<Vec<Commit>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuditFault {
    /// 紀錄的層數與公開的秘密數不符
    Malformed,
    /// 第 `layer` 層的洗牌輸出不是 `k·輸入` 的排列
    Shuffle { layer: usize },
    /// 第 `layer` 層的換鑰輸出在 `wall_index` 不符
    Rekey { layer: usize, wall_index: usize },
    /// 第 `layer` 層在 `wall_index` 的承諾與公開秘密推導出的金鑰不符
    Commit { layer: usize, wall_index: usize },
}

/// 結算稽核：依公開的秘密重算每一輪；成功時回傳完整牌山（位置 → 牌）
pub fn audit_round(transcript: &Transcript, secrets: &[RoundSecret]) -> Result<Vec<TileId>, AuditFault> {
    let layers = secrets.len();
    if layers == 0
        || transcript.shuffled.len() != layers
        || transcript.rekeyed.len() != layers
        || transcript.commits.len() != layers
    {
        return Err(AuditFault::Malformed);
    }

    let mut prev = initial_deck();
    for (layer, (out, secret)) in transcript.shuffled.iter().zip(secrets).enumerate() {
        // 不需公開排列：k·輸入 與 輸出 的集合相等即可
        let k = secret.global_key();
        let mut expect: Vec<[u8; 32]> = prev.iter().map(|c| (k * c).compress().to_bytes()).collect();
        let mut got: Vec<[u8; 32]> = out.iter().map(|c| c.compress().to_bytes()).collect();
        expect.sort_unstable();
        got.sort_unstable();
        if expect != got {
            return Err(AuditFault::Shuffle { layer });
        }
        prev = out.clone();
    }

    for (layer, (out, secret)) in transcript.rekeyed.iter().zip(secrets).enumerate() {
        let expect = rekey_pass(&prev, secret);
        if out.len() != expect.len() {
            return Err(AuditFault::Malformed);
        }
        if let Some(wall_index) = (0..expect.len()).find(|&i| expect[i] != out[i]) {
            return Err(AuditFault::Rekey { layer, wall_index });
        }
        let commits = &transcript.commits[layer];
        if commits.len() != TOTAL_TILES {
            return Err(AuditFault::Malformed);
        }
        if let Some(wall_index) =
            (0..TOTAL_TILES).find(|&i| commits[i] != commit_card_key(&secret.card_key(i)))
        {
            return Err(AuditFault::Commit { layer, wall_index });
        }
        prev = out.clone();
    }

    // 洗牌輪已保證是排列，這裡逐張開鎖必然成功
    (0..TOTAL_TILES)
        .map(|i| {
            let keys: Vec<Scalar> = secrets.iter().map(|s| s.card_key(i)).collect();
            unlock(&prev[i], &keys).ok_or(AuditFault::Malformed)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 身分、簽章與端對端金鑰分享
// ---------------------------------------------------------------------------

/// 玩家本次連線的身分：`ed25519` 簽章 + `crypto_box`（X25519）加密金鑰
pub struct Identity {
    signing: ed25519_dalek::SigningKey,
    boxing: crypto_box::SecretKey,
}

impl Identity {
    /// 兩組 32 bytes 種子應來自 Web Crypto `crypto.getRandomValues`
    pub fn from_seeds(sign_seed: [u8; 32], box_seed: [u8; 32]) -> Self {
        Self {
            signing: ed25519_dalek::SigningKey::from_bytes(&sign_seed),
            boxing: crypto_box::SecretKey::from_bytes(box_seed),
        }
    }

    pub fn sign_public(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }

    pub fn box_public(&self) -> [u8; 32] {
        *self.boxing.public_key().as_bytes()
    }

    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        use ed25519_dalek::Signer;
        self.signing.sign(message).to_bytes()
    }

    pub fn seal_share(&self, recipient_box_pub: &[u8; 32], ctx: ShareContext, key: &Scalar) -> Vec<u8> {
        use crypto_box::aead::Aead;
        let recipient = crypto_box::PublicKey::from_bytes(*recipient_box_pub);
        crypto_box::SalsaBox::new(&recipient, &self.boxing)
            .encrypt(&ctx.nonce(), key.as_bytes().as_slice())
            .expect("XSalsa20Poly1305 encryption of 32 bytes cannot fail")
    }

    pub fn open_share(&self, sender_box_pub: &[u8; 32], ctx: ShareContext, sealed: &[u8]) -> Option<Scalar> {
        use crypto_box::aead::Aead;
        let sender = crypto_box::PublicKey::from_bytes(*sender_box_pub);
        let plain = crypto_box::SalsaBox::new(&sender, &self.boxing)
            .decrypt(&ctx.nonce(), sealed)
            .ok()?;
        scalar_from_bytes(plain.try_into().ok()?)
    }
}

pub fn verify_signature(sign_pub: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
    let Ok(key) = ed25519_dalek::VerifyingKey::from_bytes(sign_pub) else {
        return false;
    };
    key.verify_strict(message, &ed25519_dalek::Signature::from_bytes(signature)).is_ok()
}

/// 金鑰分享的情境；同一房間內（局號, 位置, 送方, 收方）不重複，因此可直接作為 nonce
#[derive(Debug, Clone, Copy)]
pub struct ShareContext {
    pub round: u32,
    pub wall_index: u16,
    pub from_seat: u8,
    pub to_seat: u8,
}

impl ShareContext {
    fn nonce(&self) -> crypto_box::Nonce {
        let mut n = [0u8; 24];
        n[..4].copy_from_slice(&self.round.to_le_bytes());
        n[4..6].copy_from_slice(&self.wall_index.to_le_bytes());
        n[6] = self.from_seat;
        n[7] = self.to_seat;
        n.into()
    }
}

/// 房間安全碼：四家各自計算後口頭比對，不一致代表有人（房主）掉包公鑰
pub fn room_fingerprint(room_code: &str, members: &[(u8, [u8; 32], [u8; 32])]) -> [u8; 32] {
    let mut sorted = members.to_vec();
    sorted.sort_by_key(|m| m.0);
    let mut h = Sha256::new();
    h.update(DOMAIN.as_bytes());
    h.update(b"/room/");
    h.update(room_code.as_bytes());
    for (seat, sign_pub, box_pub) in &sorted {
        h.update([*seat]);
        h.update(sign_pub);
        h.update(box_pub);
    }
    h.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secrets(n: usize, tag: &str) -> Vec<RoundSecret> {
        (0..n)
            .map(|p| RoundSecret::from_bytes(crate::wall::sha256_bytes(format!("{tag}/{p}").as_bytes())))
            .collect()
    }

    fn honest_round(secrets: &[RoundSecret]) -> Transcript {
        let mut t = Transcript::default();
        let mut deck = initial_deck();
        for s in secrets {
            deck = shuffle_pass(&deck, s);
            t.shuffled.push(deck.clone());
        }
        for s in secrets {
            deck = rekey_pass(&deck, s);
            t.rekeyed.push(deck.clone());
            t.commits.push(s.card_commits());
        }
        t
    }

    fn keys_at(secrets: &[RoundSecret], i: usize) -> Vec<Scalar> {
        secrets.iter().map(|s| s.card_key(i)).collect()
    }

    #[test]
    fn full_round_deals_a_shuffled_permutation_of_144_tiles() {
        let s = secrets(4, "perm");
        let deck = honest_round(&s).rekeyed.pop().unwrap();
        let order: Vec<TileId> = (0..TOTAL_TILES).map(|i| unlock(&deck[i], &keys_at(&s, i)).unwrap()).collect();
        let mut sorted = order.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, (0..TOTAL_TILES as TileId).collect::<Vec<_>>());
        assert_ne!(order, sorted, "牌山應已洗亂");
    }

    #[test]
    fn any_missing_layer_reveals_nothing() {
        // 模擬房主收齊除了摸牌者以外的所有層金鑰：每個位置都認不出牌
        let s = secrets(4, "missing");
        let deck = honest_round(&s).rekeyed.pop().unwrap();
        for drawer in 0..s.len() {
            for i in 0..TOTAL_TILES {
                let keys: Vec<Scalar> = (0..s.len()).filter(|&p| p != drawer).map(|p| s[p].card_key(i)).collect();
                assert_eq!(unlock(&deck[i], &keys), None);
            }
        }
    }

    #[test]
    fn two_humans_are_enough() {
        let s = secrets(2, "two");
        let deck = honest_round(&s).rekeyed.pop().unwrap();
        assert_eq!(unlock(&deck[0], &[s[0].card_key(0)]), None);
        assert!(unlock(&deck[0], &keys_at(&s, 0)).is_some());
    }

    #[test]
    fn wrong_card_key_fails_commit_and_unlock() {
        let s = secrets(4, "wrong");
        let t = honest_round(&s);
        let deck = t.rekeyed.last().unwrap();
        let fake = s[2].card_key(11);
        assert_ne!(commit_card_key(&fake), t.commits[2][10]);
        assert_eq!(commit_card_key(&s[2].card_key(10)), t.commits[2][10]);
        let mut keys = keys_at(&s, 10);
        keys[2] = fake;
        assert_eq!(unlock(&deck[10], &keys), None);
    }

    #[test]
    fn audit_returns_the_dealt_wall_for_an_honest_round() {
        let s = secrets(4, "audit-ok");
        let t = honest_round(&s);
        let wall = audit_round(&t, &s).unwrap();
        let deck = t.rekeyed.last().unwrap();
        for (i, &tile) in wall.iter().enumerate() {
            assert_eq!(unlock(&deck[i], &keys_at(&s, i)), Some(tile));
        }
    }

    #[test]
    fn audit_catches_a_shuffler_who_duplicates_a_tile() {
        // 第 0 層（房主）洗牌時把一張牌換成另一張的複本
        let s = secrets(4, "dup");
        let mut t = honest_round(&s);
        let mut deck = initial_deck();
        t.shuffled.clear();
        t.rekeyed.clear();
        t.commits.clear();
        for (layer, secret) in s.iter().enumerate() {
            deck = shuffle_pass(&deck, secret);
            if layer == 0 {
                deck[5] = deck[6];
            }
            t.shuffled.push(deck.clone());
        }
        for secret in &s {
            deck = rekey_pass(&deck, secret);
            t.rekeyed.push(deck.clone());
            t.commits.push(secret.card_commits());
        }
        assert_eq!(audit_round(&t, &s), Err(AuditFault::Shuffle { layer: 0 }));
    }

    #[test]
    fn audit_catches_a_tampered_rekey_and_a_false_commit() {
        let s = secrets(4, "rekey");
        let mut t = honest_round(&s);
        t.rekeyed[2][40] = t.rekeyed[2][41];
        assert_eq!(audit_round(&t, &s), Err(AuditFault::Rekey { layer: 2, wall_index: 40 }));

        let mut t = honest_round(&s);
        t.commits[1][7] = [0u8; 32];
        assert_eq!(audit_round(&t, &s), Err(AuditFault::Commit { layer: 1, wall_index: 7 }));
    }

    #[test]
    fn audit_catches_a_revealed_secret_that_differs_from_play() {
        let s = secrets(4, "liar");
        let t = honest_round(&s);
        let mut revealed = s.clone();
        revealed[3] = RoundSecret::from_bytes([9u8; 32]);
        assert_eq!(audit_round(&t, &revealed), Err(AuditFault::Shuffle { layer: 3 }));
        assert_eq!(audit_round(&t, &s[..3]), Err(AuditFault::Malformed));
    }

    #[test]
    fn deck_bytes_round_trip_and_reject_garbage() {
        let s = secrets(2, "bytes");
        let deck = honest_round(&s).rekeyed.pop().unwrap();
        let bytes = deck_to_bytes(&deck);
        assert_eq!(bytes.len(), TOTAL_TILES * 32);
        assert_eq!(deck_from_bytes(&bytes), Some(deck));
        assert_eq!(deck_from_bytes(&bytes[..32]), None);
        assert_eq!(deck_from_bytes(&vec![0xff; TOTAL_TILES * 32]), None);
    }

    fn identity(tag: &str) -> Identity {
        let h = |s: &str| crate::wall::sha256_bytes(format!("{tag}/{s}").as_bytes());
        Identity::from_seeds(h("sign"), h("box"))
    }

    #[test]
    fn sealed_share_relayed_by_the_host_stays_private_and_intact() {
        let (south, west, host) = (identity("south"), identity("west"), identity("host"));
        let key = secrets(1, "share")[0].card_key(7);
        let ctx = ShareContext { round: 1, wall_index: 7, from_seat: 1, to_seat: 2 };
        let mut sealed = south.seal_share(&west.box_public(), ctx, &key);
        assert_eq!(west.open_share(&south.box_public(), ctx, &sealed), Some(key));
        // 房主轉送但沒有收方私鑰：解不開
        assert_eq!(host.open_share(&south.box_public(), ctx, &sealed), None);
        // 換位置重放無效
        let replay = ShareContext { wall_index: 8, ..ctx };
        assert_eq!(west.open_share(&south.box_public(), replay, &sealed), None);
        // 竄改一個位元被 Poly1305 拒絕
        sealed[0] ^= 1;
        assert_eq!(west.open_share(&south.box_public(), ctx, &sealed), None);
    }

    #[test]
    fn signatures_bind_the_message_and_the_signer() {
        let (a, b) = (identity("a"), identity("b"));
        let sig = a.sign(b"DISCARD 37");
        assert!(verify_signature(&a.sign_public(), b"DISCARD 37", &sig));
        assert!(!verify_signature(&a.sign_public(), b"DISCARD 38", &sig));
        assert!(!verify_signature(&b.sign_public(), b"DISCARD 37", &sig));
    }

    #[test]
    fn room_fingerprint_changes_when_any_key_is_swapped() {
        let ids: Vec<Identity> = (0..4).map(|p| identity(&format!("p{p}"))).collect();
        let members: Vec<(u8, [u8; 32], [u8; 32])> = ids
            .iter()
            .enumerate()
            .map(|(seat, id)| (seat as u8, id.sign_public(), id.box_public()))
            .collect();
        let honest = room_fingerprint("ABC123", &members);
        let mut reversed = members.clone();
        reversed.reverse();
        assert_eq!(room_fingerprint("ABC123", &reversed), honest, "與排列順序無關");

        // 房主把西家的公鑰掉包成自己的（中間人）
        let mut mitm = members.clone();
        mitm[2].2 = ids[0].box_public();
        assert_ne!(room_fingerprint("ABC123", &mitm), honest);
        assert_ne!(room_fingerprint("ABC124", &members), honest);
    }
}
