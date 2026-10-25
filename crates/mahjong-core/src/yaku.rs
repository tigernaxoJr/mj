//! WP-1.4: 台灣 16 張台數與底台結算引擎
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
