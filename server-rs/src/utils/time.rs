use chrono::{DateTime, Utc};

pub fn to_iso_string(value: DateTime<Utc>) -> String {
    value.to_rfc3339()
}

pub fn to_iso_string_opt(value: Option<DateTime<Utc>>) -> Option<String> {
    value.map(to_iso_string)
}
