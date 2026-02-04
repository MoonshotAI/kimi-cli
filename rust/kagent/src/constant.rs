pub const NAME: &str = "Kimi Code CLI";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn user_agent() -> String {
    format!("KimiCLI/{}", VERSION)
}
