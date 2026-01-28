use clap::Args;
use serde_json::json;

use crate::agentspec::SUPPORTED_AGENT_SPEC_VERSIONS;
use crate::constant::{NAME, VERSION};
use crate::wire::protocol::WIRE_PROTOCOL_VERSION;

#[derive(Args, Debug)]
#[command(about = "Show version and protocol information.")]
pub struct InfoArgs {
    #[arg(long = "json", help = "Output information as JSON.")]
    pub json_output: bool,
}

pub fn run_info_command(args: InfoArgs) {
    let agent_versions = SUPPORTED_AGENT_SPEC_VERSIONS
        .iter()
        .map(|version| version.to_string())
        .collect::<Vec<_>>();
    let python_version = "n/a";
    if args.json_output {
        let payload = json!({
            "kimi_cli_version": VERSION,
            "agent_spec_versions": agent_versions,
            "wire_protocol_version": WIRE_PROTOCOL_VERSION,
            "python_version": python_version,
            "server_name": NAME,
            "server_version": VERSION,
        });
        println!("{}", payload.to_string());
        return;
    }

    let agent_versions_text = agent_versions.join(", ");
    println!("kimi-cli version: {VERSION}");
    println!("agent spec versions: {agent_versions_text}");
    println!("wire protocol: {WIRE_PROTOCOL_VERSION}");
    println!("python version: {python_version}");
    println!("server name: {NAME}");
    println!("server version: {VERSION}");
}
