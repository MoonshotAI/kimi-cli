use std::collections::HashMap;

use reqwest::header::HeaderMap;
use schemars::JsonSchema;
use serde::Deserialize;

use crate::constant::user_agent;
use crate::soul::toolset::get_current_tool_call_or_none;
use crate::tools::SkipThisTool;
use crate::tools::utils::{DEFAULT_MAX_CHARS, ToolResultBuilder, load_desc};

use kosong::tooling::{CallableTool2, ToolReturnValue};

const SEARCH_DESC: &str = include_str!("../desc/web/search.md");

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SearchParams {
    #[schemars(description = "The query text to search for.")]
    pub query: String,
    #[serde(default = "default_search_limit")]
    #[schemars(
        description = "The number of results to return. Typically you do not need to set this value. When the results do not contain what you need, you probably want to give a more concrete query.",
        range(min = 1, max = 20),
        default = "default_search_limit"
    )]
    pub limit: i64,
    #[serde(default)]
    #[schemars(
        description = "Whether to include the content of the web pages in the results. It can consume a large amount of tokens when this is set to True. You should avoid enabling this when `limit` is set to a large value.",
        default
    )]
    pub include_content: bool,
}

fn default_search_limit() -> i64 {
    5
}

#[derive(Clone, Deserialize)]
struct SearchResult {
    title: String,
    url: String,
    snippet: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    date: String,
}

#[derive(Deserialize)]
struct SearchResponse {
    search_results: Vec<SearchResult>,
}

pub struct SearchWeb {
    description: String,
    base_url: String,
    api_key: String,
    custom_headers: HashMap<String, String>,
}

impl SearchWeb {
    pub fn new(runtime: &crate::soul::agent::Runtime) -> Result<Self, SkipThisTool> {
        let service = runtime
            .config
            .services
            .moonshot_search
            .clone()
            .ok_or(SkipThisTool)?;
        let desc = load_desc(SEARCH_DESC, &[]);
        Ok(Self {
            description: desc,
            base_url: service.base_url,
            api_key: service.api_key,
            custom_headers: service.custom_headers.unwrap_or_default(),
        })
    }
}

#[async_trait::async_trait]
impl CallableTool2 for SearchWeb {
    type Params = SearchParams;

    fn name(&self) -> &str {
        "SearchWeb"
    }

    fn description(&self) -> &str {
        &self.description
    }

    async fn call_typed(&self, params: Self::Params) -> ToolReturnValue {
        let mut builder = ToolResultBuilder::new(DEFAULT_MAX_CHARS, None);

        if self.base_url.is_empty() || self.api_key.is_empty() {
            return builder.error(
                "Search service is not configured. You may want to try other methods to search.",
                "Search service not configured",
            );
        }

        let tool_call = match get_current_tool_call_or_none() {
            Some(call) => call,
            None => {
                return builder.error(
                    "Search service is not available without tool call context.",
                    "Search unavailable",
                );
            }
        };

        let mut headers = HeaderMap::new();
        headers.insert(reqwest::header::USER_AGENT, user_agent().parse().unwrap());
        headers.insert(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", self.api_key).parse().unwrap(),
        );
        headers.insert("X-Msh-Tool-Call-Id", tool_call.id.parse().unwrap());
        for (key, value) in &self.custom_headers {
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::from_bytes(key.as_bytes()),
                value.parse(),
            ) {
                headers.insert(name, val);
            }
        }

        let client = reqwest::Client::new();
        let resp = match client
            .post(&self.base_url)
            .headers(headers)
            .json(&serde_json::json!({
                "text_query": params.query,
                "limit": params.limit,
                "enable_page_crawling": params.include_content,
                "timeout_seconds": 30,
            }))
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(err) => {
                return builder.error(
                    &format!(
                        "Failed to search. Error: {err}. This may indicates that the search service is currently unavailable."
                    ),
                    "Failed to search",
                )
            }
        };

        if resp.status() != reqwest::StatusCode::OK {
            return builder.error(
                &format!(
                    "Failed to search. Status: {}. This may indicates that the search service is currently unavailable.",
                    resp.status()
                ),
                "Failed to search",
            );
        }

        let payload: SearchResponse = match resp.json().await {
            Ok(payload) => payload,
            Err(err) => {
                return builder.error(
                    &format!(
                        "Failed to parse search results. Error: {err}. This may indicates that the search service is currently unavailable."
                    ),
                    "Failed to parse search results",
                )
            }
        };

        for (idx, result) in payload.search_results.into_iter().enumerate() {
            if idx > 0 {
                builder.write("---\n\n");
            }
            builder.write(&format!(
                "Title: {}\nDate: {}\nURL: {}\nSummary: {}\n\n",
                result.title, result.date, result.url, result.snippet
            ));
            if !result.content.is_empty() {
                builder.write(&format!("{}\n\n", result.content));
            }
        }

        builder.ok("", "")
    }
}
