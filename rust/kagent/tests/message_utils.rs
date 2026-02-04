use kagent::utils::message_stringify;
use kosong::message::{ContentPart, ImageURLPart, Message, Role, TextPart};

fn user_message(parts: Vec<ContentPart>) -> Message {
    Message::new(Role::User, parts)
}

#[test]
fn test_extract_text_from_string_content() {
    let message = user_message(vec![TextPart::new("Simple text").into()]);
    assert_eq!(message.extract_text("\n"), "Simple text");
}

#[test]
fn test_extract_text_from_content_parts() {
    let message = user_message(vec![
        TextPart::new("Hello").into(),
        ImageURLPart::new("https://example.com/image.jpg").into(),
        TextPart::new("World").into(),
    ]);
    assert_eq!(message.extract_text("\n"), "Hello\nWorld");
}

#[test]
fn test_extract_text_from_empty_content_parts() {
    let message = user_message(vec![
        ImageURLPart::new("https://example.com/image.jpg").into(),
    ]);
    assert_eq!(message.extract_text("\n"), "");
}

#[test]
fn test_stringify_string_content() {
    let message = user_message(vec![TextPart::new("Simple text").into()]);
    assert_eq!(message_stringify(&message), "Simple text");
}

#[test]
fn test_stringify_text_parts() {
    let message = user_message(vec![
        TextPart::new("Hello").into(),
        TextPart::new("World").into(),
    ]);
    assert_eq!(message_stringify(&message), "HelloWorld");
}

#[test]
fn test_stringify_mixed_parts() {
    let message = user_message(vec![
        TextPart::new("Hello").into(),
        ImageURLPart::new("https://example.com/image.jpg").into(),
        TextPart::new("World").into(),
    ]);
    assert_eq!(message_stringify(&message), "Hello[image]World");
}

#[test]
fn test_stringify_only_image_parts() {
    let message = user_message(vec![
        ImageURLPart::new("https://example.com/image1.jpg").into(),
        ImageURLPart::new("https://example.com/image2.jpg").into(),
    ]);
    assert_eq!(message_stringify(&message), "[image][image]");
}

#[test]
fn test_stringify_image_with_id() {
    let mut part = ImageURLPart::new("https://example.com/image.jpg");
    part.image_url.id = Some("img-1".to_string());
    let message = user_message(vec![part.into()]);
    assert_eq!(message_stringify(&message), "[image]");
}

#[test]
fn test_stringify_empty_string() {
    let message = user_message(vec![TextPart::new("").into()]);
    assert_eq!(message_stringify(&message), "");
}

#[test]
fn test_stringify_empty_parts() {
    let message = user_message(vec![]);
    assert_eq!(message_stringify(&message), "");
}

#[test]
fn test_extract_text_from_empty_string() {
    let message = user_message(vec![TextPart::new("").into()]);
    assert_eq!(message.extract_text("\n"), "");
}
