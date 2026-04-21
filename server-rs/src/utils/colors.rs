use rand::seq::IndexedRandom;
use std::collections::HashSet;

const USER_COLORS: [&str; 8] = [
    "#30bced", "#6eeb83", "#ffbc42", "#ecd444", "#ee6352", "#9ac2c9", "#8acb88", "#1be7ff",
];

#[derive(Debug, Clone)]
pub struct SessionColor {
    pub slot: usize,
    pub color: String,
    pub color_light: String,
}

pub fn random_user_color() -> String {
    let mut rng = rand::rng();
    USER_COLORS
        .as_slice()
        .choose(&mut rng)
        .unwrap_or(&"#30bced")
        .to_string()
}

pub fn next_available_color_slot<I>(used_slots: I) -> usize
where
    I: IntoIterator<Item = usize>,
{
    let used: HashSet<usize> = used_slots.into_iter().collect();
    let mut slot = 0;
    while used.contains(&slot) {
        slot += 1;
    }
    slot
}

pub fn session_color_for_slot(slot: usize) -> SessionColor {
    let hue = ((slot as f64 * 137.508).round() as usize) % 360;
    let saturations = [78, 72, 84, 68];
    let lightnesses = [52, 46, 58, 64];
    let saturation = saturations[(slot / 360) % saturations.len()];
    let lightness = lightnesses[(slot / (360 * saturations.len())) % lightnesses.len()];

    SessionColor {
        slot,
        color: format!("hsl({hue}, {saturation}%, {lightness}%)"),
        color_light: format!(
            "hsla({hue}, {saturation}%, {}, 0.35)",
            (lightness + 24).min(88)
        ),
    }
}
