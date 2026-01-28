use std::collections::HashMap;
use std::sync::Arc;

use regex::Regex;

#[derive(Clone)]
pub struct SlashCommand<F> {
    pub name: String,
    pub description: String,
    pub func: F,
    pub aliases: Vec<String>,
}

impl<F> SlashCommand<F> {
    pub fn slash_name(&self) -> String {
        if self.aliases.is_empty() {
            format!("/{}", self.name)
        } else {
            format!("/{} ({})", self.name, self.aliases.join(", "))
        }
    }
}

#[derive(Clone, Debug)]
pub struct SlashCommandInfo {
    pub name: String,
    pub description: String,
    pub aliases: Vec<String>,
}

impl<F> From<&SlashCommand<F>> for SlashCommandInfo {
    fn from(command: &SlashCommand<F>) -> Self {
        Self {
            name: command.name.clone(),
            description: command.description.clone(),
            aliases: command.aliases.clone(),
        }
    }
}

pub struct SlashCommandRegistry<F> {
    commands: HashMap<String, Arc<SlashCommand<F>>>,
    aliases: HashMap<String, Arc<SlashCommand<F>>>,
}

impl<F> Default for SlashCommandRegistry<F> {
    fn default() -> Self {
        Self::new()
    }
}

impl<F> SlashCommandRegistry<F> {
    pub fn new() -> Self {
        Self {
            commands: HashMap::new(),
            aliases: HashMap::new(),
        }
    }

    pub fn register(
        &mut self,
        name: String,
        description: String,
        func: F,
        aliases: Vec<String>,
    ) -> Arc<SlashCommand<F>> {
        let description = description.trim().to_string();
        let cmd = Arc::new(SlashCommand {
            name: name.clone(),
            description,
            func,
            aliases: aliases.clone(),
        });

        self.commands.insert(name.clone(), Arc::clone(&cmd));
        self.aliases.insert(name, Arc::clone(&cmd));
        for alias in aliases {
            self.aliases.insert(alias, Arc::clone(&cmd));
        }
        cmd
    }

    pub fn find_command(&self, name: &str) -> Option<Arc<SlashCommand<F>>> {
        self.aliases.get(name).cloned()
    }

    pub fn list_commands(&self) -> Vec<Arc<SlashCommand<F>>> {
        self.commands.values().cloned().collect()
    }
}

#[derive(Clone, Debug)]
pub struct SlashCommandCall {
    pub name: String,
    pub args: String,
    pub raw_input: String,
}

pub fn parse_slash_command_call(user_input: &str) -> Option<SlashCommandCall> {
    let user_input = user_input.trim();
    if user_input.is_empty() || !user_input.starts_with('/') {
        return None;
    }

    let re = Regex::new(r"^/([a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*)").ok()?;
    let captures = re.captures(user_input)?;
    let command_name = captures.get(1)?.as_str();
    let whole_match = captures.get(0)?;

    if let Some(rest) = user_input.get(whole_match.end()..) {
        if let Some(next_char) = rest.chars().next() {
            if !next_char.is_whitespace() {
                return None;
            }
        }
    }

    let raw_args = user_input
        .get(whole_match.end()..)
        .unwrap_or("")
        .trim_start()
        .to_string();
    Some(SlashCommandCall {
        name: command_name.to_string(),
        args: raw_args,
        raw_input: user_input.to_string(),
    })
}
