use rand::Rng;

pub fn shorten_middle(text: &str, width: usize, remove_newline: bool) -> String {
    if text.len() <= width {
        return text.to_string();
    }
    let mut cleaned = text.to_string();
    if remove_newline {
        cleaned = cleaned.replace('\n', " ").replace('\r', " ");
    }
    let half = width / 2;
    format!(
        "{}...{}",
        &cleaned[..half],
        &cleaned[cleaned.len().saturating_sub(half)..]
    )
}

pub fn random_string(length: usize) -> String {
    let mut rng = rand::rng();
    let mut out = String::new();
    for _ in 0..length {
        let c = rng.random_range(b'a'..=b'z') as char;
        out.push(c);
    }
    out
}
