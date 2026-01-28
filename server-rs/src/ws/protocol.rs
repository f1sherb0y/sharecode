use yrs::encoding::read::{Cursor, Read as _};
use yrs::encoding::write::Write as _;
use yrs::sync::protocol::SyncMessage;
use yrs::updates::encoder::{Encode, Encoder, EncoderV1};

use super::state::WsError;

pub(crate) const MSG_SYNC: u8 = 0;
pub(crate) const MSG_AWARENESS: u8 = 1;
pub(crate) const MSG_AUTH: u8 = 2;
pub(crate) const MSG_QUERY_AWARENESS: u8 = 3;
pub(crate) const MSG_STATELESS: u8 = 5;
pub(crate) const MSG_CLOSE: u8 = 7;
pub(crate) const MSG_SYNC_STATUS: u8 = 8;

pub(crate) const AUTH_TOKEN: u8 = 0;
pub(crate) const AUTH_PERMISSION_DENIED: u8 = 1;
pub(crate) const AUTH_AUTHENTICATED: u8 = 2;

pub(crate) fn decode_frame(data: &[u8]) -> Result<(String, u8, &[u8]), WsError> {
    let mut cursor = Cursor::new(data);
    let document_name = cursor.read_string().map_err(WsError::Decode)?.to_string();
    let message_type: u8 = cursor.read_var().map_err(WsError::Decode)?;
    let payload = &data[cursor.next..];
    Ok((document_name, message_type, payload))
}

pub(crate) fn decode_auth(payload: &[u8]) -> Result<(u8, Option<String>), WsError> {
    let mut cursor = Cursor::new(payload);
    let auth_type: u8 = cursor.read_var().map_err(WsError::Decode)?;
    let token = if cursor.has_content() {
        Some(cursor.read_string().map_err(WsError::Decode)?.to_string())
    } else {
        None
    };
    Ok((auth_type, token))
}

pub(crate) fn decode_var_bytes(payload: &[u8]) -> Result<Vec<u8>, WsError> {
    let mut cursor = Cursor::new(payload);
    let buf = cursor.read_buf().map_err(WsError::Decode)?;
    Ok(buf.to_vec())
}

pub(crate) fn encode_var_bytes(payload: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    body.write_buf(payload);
    body
}

pub(crate) fn encode_message(document_name: &str, message_type: u8, payload: &[u8]) -> Vec<u8> {
    let mut message = Vec::with_capacity(document_name.len() + payload.len() + 8);
    message.write_string(document_name);
    message.write_var(message_type);
    message.extend_from_slice(payload);
    message
}

pub(crate) fn encode_auth_message(
    document_name: &str,
    auth_type: u8,
    payload: Option<&str>,
) -> Vec<u8> {
    let mut body = Vec::new();
    body.write_var(auth_type);
    if let Some(value) = payload {
        body.write_string(value);
    }
    encode_message(document_name, MSG_AUTH, &body)
}

pub(crate) fn encode_stateless_message(document_name: &str, payload: &str) -> Vec<u8> {
    let mut body = Vec::new();
    body.write_string(payload);
    encode_message(document_name, MSG_STATELESS, &body)
}

pub(crate) fn encode_sync_update(document_name: &str, update: &[u8]) -> Vec<u8> {
    let mut encoder = EncoderV1::new();
    SyncMessage::Update(update.to_vec()).encode(&mut encoder);
    let payload = encoder.to_vec();
    encode_message(document_name, MSG_SYNC, &payload)
}

pub(crate) fn encode_sync_message(document_name: &str, message: SyncMessage) -> Vec<u8> {
    let mut encoder = EncoderV1::new();
    message.encode(&mut encoder);
    let payload = encoder.to_vec();
    encode_message(document_name, MSG_SYNC, &payload)
}
