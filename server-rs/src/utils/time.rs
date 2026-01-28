use chrono::{NaiveDateTime, TimeZone, Utc};

pub fn to_iso_string(value: NaiveDateTime) -> String {
    Utc.from_utc_datetime(&value).to_rfc3339()
}

pub fn to_iso_string_opt(value: Option<NaiveDateTime>) -> Option<String> {
    value.map(to_iso_string)
}
