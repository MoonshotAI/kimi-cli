use std::fmt::Write;

use kosong::message::{ContentPart, Message};

pub fn message_stringify(message: &Message) -> String {
    let mut out = String::new();
    for part in &message.content {
        match part {
            ContentPart::Text(part) => out.push_str(&part.text),
            ContentPart::ImageUrl(_) => out.push_str("[image]"),
            ContentPart::AudioUrl(part) => {
                append_media(&mut out, "audio", part.audio_url.id.as_deref())
            }
            ContentPart::VideoUrl(_) => out.push_str("[video]"),
            ContentPart::Think(part) => {
                let _ = write!(out, "[{}]", part.kind);
            }
        }
    }
    out
}

fn append_media(out: &mut String, label: &str, id: Option<&str>) {
    match id {
        Some(value) => {
            let _ = write!(out, "[{}:{}]", label, value);
        }
        None => {
            let _ = write!(out, "[{}]", label);
        }
    }
}
