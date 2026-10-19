/// The longest username, in characters.
pub const MAX_USERNAME_CHARS: usize = 32;

pub const INVALID_USERNAME: &str = "A username of 2 to 32 characters without spaces is required";

/// The form every new or changed username takes: no surrounding spaces, 2 to 32
/// characters, no spaces or control characters inside.
pub fn normalize_username(raw: &str) -> Result<String, &'static str> {
    let name = raw.trim();
    let length = name.chars().count();
    if !(2..=MAX_USERNAME_CHARS).contains(&length) || name.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(INVALID_USERNAME);
    }
    Ok(name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_and_rejects_spaces_controls_and_lengths() {
        assert_eq!(normalize_username(" linfeikai ").unwrap(), "linfeikai");
        assert_eq!(normalize_username("王小明").unwrap(), "王小明");
        for bad in ["", " a ", "two words", "tab\there", "bell\u{7}", &"x".repeat(33)] {
            assert!(normalize_username(bad).is_err(), "{bad:?}");
        }
    }
}
