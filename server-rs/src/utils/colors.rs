use rand::seq::IndexedRandom;

const USER_COLORS: [&str; 8] = [
    "#30bced", "#6eeb83", "#ffbc42", "#ecd444", "#ee6352", "#9ac2c9", "#8acb88", "#1be7ff",
];

pub fn random_user_color() -> String {
    let mut rng = rand::rng();
    USER_COLORS
        .as_slice()
        .choose(&mut rng)
        .unwrap_or(&"#30bced")
        .to_string()
}
