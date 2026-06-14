use serde::{Deserialize, Serialize};

/// An axis-aligned rectangle in physical desktop pixels (absolute coordinates,
/// origin at the primary monitor's top-left, negative values allowed for
/// monitors placed to the left/above the primary).
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    pub fn right(&self) -> i32 {
        self.x + self.w as i32
    }
    pub fn bottom(&self) -> i32 {
        self.y + self.h as i32
    }
    pub fn center(&self) -> (i32, i32) {
        (self.x + self.w as i32 / 2, self.y + self.h as i32 / 2)
    }
    pub fn contains_point(&self, px: i32, py: i32) -> bool {
        px >= self.x && px < self.right() && py >= self.y && py < self.bottom()
    }
    /// Round width/height down to the nearest even number (required by yuv420p).
    pub fn even_size(&self) -> Rect {
        Rect {
            x: self.x,
            y: self.y,
            w: self.w & !1,
            h: self.h & !1,
        }
    }
}
