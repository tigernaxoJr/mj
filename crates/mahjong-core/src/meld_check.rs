//! WP-1.2: 吃/碰/槓合法性與 ClaimWindow 優先序裁決
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum ClaimPriority {
    Pass = 0,
    Chii = 1,
    PonOrKan = 2,
    Ron = 3,
}
