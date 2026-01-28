use serde_json::Value;

use super::{WireError, WireMessage, WireMessageEnvelope};

pub fn serialize_wire_message(msg: &WireMessage) -> Result<Value, WireError> {
    let envelope = WireMessageEnvelope::from_wire_message(msg)?;
    serde_json::to_value(envelope).map_err(|err| WireError::Serde(err.to_string()))
}

pub fn deserialize_wire_message(value: Value) -> Result<WireMessage, WireError> {
    let envelope: WireMessageEnvelope =
        serde_json::from_value(value).map_err(|err| WireError::InvalidEnvelope(err.to_string()))?;
    envelope.to_wire_message()
}
