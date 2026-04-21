use std::{collections::HashSet, sync::LazyLock};

pub const MIN_PASSWORD_LENGTH: usize = 10;

pub const PASSWORD_POLICY_MESSAGE: &str =
    "Password must be at least 10 characters long, include uppercase and lowercase letters, a number, and a special character, must not contain spaces, and must not be a common password";

static COMMON_PASSWORDS: LazyLock<HashSet<String>> = LazyLock::new(|| {
    include_str!("dicts/common_passwords_len10_cls4.txt")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| line.to_lowercase())
        .collect()
});

pub fn validate_password(password: &str) -> Result<(), &'static str> {
    if password.chars().count() < MIN_PASSWORD_LENGTH {
        return Err(PASSWORD_POLICY_MESSAGE);
    }

    if password.chars().any(char::is_whitespace) {
        return Err(PASSWORD_POLICY_MESSAGE);
    }

    let has_uppercase = password.chars().any(|ch| ch.is_ascii_uppercase());
    let has_lowercase = password.chars().any(|ch| ch.is_ascii_lowercase());
    let has_digit = password.chars().any(|ch| ch.is_ascii_digit());
    let has_special = password.chars().any(|ch| !ch.is_ascii_alphanumeric());

    if !has_uppercase || !has_lowercase || !has_digit || !has_special {
        return Err(PASSWORD_POLICY_MESSAGE);
    }

    if COMMON_PASSWORDS.contains(&password.to_lowercase()) {
        return Err(PASSWORD_POLICY_MESSAGE);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_password;

    #[test]
    fn accepts_strong_password() {
        assert!(validate_password("StrongPass123!").is_ok());
    }

    #[test]
    fn rejects_short_password() {
        assert!(validate_password("Short1!Aa").is_err());
    }

    #[test]
    fn rejects_password_without_required_categories() {
        assert!(validate_password("alllowercase123!").is_err());
        assert!(validate_password("ALLUPPERCASE123!").is_err());
        assert!(validate_password("MissingDigits!!").is_err());
        assert!(validate_password("MissingSpecial123").is_err());
    }

    #[test]
    fn rejects_password_with_spaces() {
        assert!(validate_password("Strong Pass123!").is_err());
    }

    #[test]
    fn rejects_common_password_variants() {
        assert!(validate_password("Password1!").is_err());
        assert!(validate_password("ABCabc123!@#").is_err());
    }
}
