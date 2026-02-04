use schemars::JsonSchema;
use serde::Deserialize;

use kosong::tooling::{CallableTool2, ToolReturnValue, tool_error, tool_ok};

use crate::soul::denwarenji::DMail;
use crate::tools::utils::load_desc;

const DMAIL_DESC: &str = include_str!("desc/dmail/dmail.md");

pub struct SendDMail {
    description: String,
    denwa_renji: std::sync::Arc<tokio::sync::Mutex<crate::soul::denwarenji::DenwaRenji>>,
}

impl SendDMail {
    pub fn new(runtime: &crate::soul::agent::Runtime) -> Self {
        Self {
            description: load_desc(DMAIL_DESC, &[]),
            denwa_renji: runtime.denwa_renji.clone(),
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DMailParams {
    #[schemars(description = "The message to send.")]
    pub message: String,
    #[schemars(
        description = "The checkpoint to send the message back to.",
        range(min = 0)
    )]
    pub checkpoint_id: i64,
}

impl From<DMailParams> for DMail {
    fn from(value: DMailParams) -> Self {
        DMail {
            message: value.message,
            checkpoint_id: value.checkpoint_id,
        }
    }
}

#[async_trait::async_trait]
impl CallableTool2 for SendDMail {
    type Params = DMailParams;

    fn name(&self) -> &str {
        "SendDMail"
    }

    fn description(&self) -> &str {
        &self.description
    }

    async fn call_typed(&self, params: Self::Params) -> ToolReturnValue {
        let dmail: DMail = params.into();
        let mut renji = self.denwa_renji.lock().await;
        if let Err(err) = renji.send_dmail(dmail) {
            return tool_error(
                "",
                format!("Failed to send D-Mail. Error: {err}"),
                "Failed to send D-Mail",
            );
        }
        tool_ok(
            "",
            "If you see this message, the D-Mail was NOT sent successfully. This may be because some other tool that needs approval was rejected.",
            "El Psy Kongroo",
        )
    }
}
