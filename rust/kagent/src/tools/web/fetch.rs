use std::collections::HashMap;

use html2md::parse_html;
use reqwest::header::HeaderMap;
use schemars::JsonSchema;
use scraper::{Html, Selector};
use serde::Deserialize;
use tracing::warn;
use url::Url;

use crate::config::MoonshotFetchConfig;
use crate::constant::user_agent;
use crate::soul::toolset::get_current_tool_call_or_none;
use crate::tools::utils::{DEFAULT_MAX_CHARS, ToolResultBuilder, load_desc};

use kosong::tooling::{CallableTool2, ToolReturnValue, tool_error};

const FETCH_DESC: &str = include_str!("../desc/web/fetch.md");

#[derive(Debug, Deserialize, JsonSchema)]
pub struct FetchParams {
    #[schemars(description = "The URL to fetch content from.")]
    pub url: String,
}

pub struct FetchURL {
    description: String,
    service: Option<MoonshotFetchConfig>,
}

impl FetchURL {
    pub fn new(runtime: &crate::soul::agent::Runtime) -> Self {
        let desc = load_desc(FETCH_DESC, &[]);
        Self {
            description: desc,
            service: runtime.config.services.moonshot_fetch.clone(),
        }
    }

    async fn fetch_with_service(&self, params: &FetchParams) -> ToolReturnValue {
        let service = match &self.service {
            Some(service) => service,
            None => {
                return tool_error(
                    "",
                    "Fetch service is not configured.",
                    "Fetch service not configured",
                );
            }
        };

        let tool_call = match get_current_tool_call_or_none() {
            Some(call) => call,
            None => {
                return tool_error(
                    "",
                    "Fetch service is not available without tool call context.",
                    "Fetch unavailable",
                );
            }
        };

        let mut headers = HeaderMap::new();
        headers.insert(reqwest::header::USER_AGENT, user_agent().parse().unwrap());
        headers.insert(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", service.api_key).parse().unwrap(),
        );
        headers.insert("X-Msh-Tool-Call-Id", tool_call.id.parse().unwrap());
        headers.insert(reqwest::header::ACCEPT, "text/markdown".parse().unwrap());
        if let Some(custom) = &service.custom_headers {
            for (key, value) in custom {
                if let (Ok(name), Ok(val)) = (
                    reqwest::header::HeaderName::from_bytes(key.as_bytes()),
                    value.parse(),
                ) {
                    headers.insert(name, val);
                }
            }
        }

        let client = reqwest::Client::new();
        let resp = match client
            .post(&service.base_url)
            .headers(headers)
            .json(&serde_json::json!({ "url": params.url }))
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(err) => {
                return tool_error(
                    "",
                    format!(
                        "Failed to fetch URL via service due to network error: {err}. This may indicate the service is unreachable."
                    ),
                    "Network error when calling fetch service",
                );
            }
        };

        if resp.status() != reqwest::StatusCode::OK {
            return tool_error(
                "",
                format!(
                    "Failed to fetch URL via service. Status: {}.",
                    resp.status()
                ),
                "Failed to fetch URL via fetch service",
            );
        }

        let text = resp.text().await.unwrap_or_default();
        let mut builder = ToolResultBuilder::new(DEFAULT_MAX_CHARS, None);
        builder.write(&text);
        builder.ok(
            "The returned content is the main content extracted from the page",
            "",
        )
    }

    async fn fetch_with_http_get(&self, params: &FetchParams) -> ToolReturnValue {
        let mut builder = ToolResultBuilder::new(DEFAULT_MAX_CHARS, None);
        let client = reqwest::Client::new();
        let resp = match client
            .get(&params.url)
            .header(
                reqwest::header::USER_AGENT,
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            )
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(err) => {
                return builder.error(
                    &format!(
                        "Failed to fetch URL due to network error: {err}. This may indicate the URL is invalid or the server is unreachable."
                    ),
                    "Network error",
                )
            }
        };

        if resp.status().as_u16() >= 400 {
            return builder.error(
                &format!(
                    "Failed to fetch URL. Status: {}. This may indicate the page is not accessible or the server is down.",
                    resp.status()
                ),
                &format!("HTTP {} error", resp.status()),
            );
        }

        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|val| val.to_str().ok())
            .unwrap_or("")
            .to_lowercase();

        let text = match resp.text().await {
            Ok(text) => text,
            Err(err) => {
                return builder.error(
                    &format!(
                        "Failed to fetch URL due to network error: {err}. This may indicate the URL is invalid or the server is unreachable."
                    ),
                    "Network error",
                )
            }
        };

        if content_type.starts_with("text/plain") || content_type.starts_with("text/markdown") {
            builder.write(&text);
            return builder.ok("The returned content is the full content of the page", "");
        }

        if text.is_empty() {
            return builder.ok("The response body is empty.", "Empty response body");
        }

        match extract_html_content(&text, &params.url) {
            Ok(content) => {
                builder.write(&content);
                builder.ok(
                    "The returned content is the main text content extracted from the page",
                    "",
                )
            }
            Err(message) => builder.error(&message, "No content extracted"),
        }
    }
}

#[async_trait::async_trait]
impl CallableTool2 for FetchURL {
    type Params = FetchParams;

    fn name(&self) -> &str {
        "FetchURL"
    }

    fn description(&self) -> &str {
        &self.description
    }

    async fn call_typed(&self, params: Self::Params) -> ToolReturnValue {
        if self.service.is_some() {
            let result = self.fetch_with_service(&params).await;
            if !result.is_error {
                return result;
            }
            warn!("Failed to fetch URL via service: {}", result.message);
        }
        self.fetch_with_http_get(&params).await
    }
}

struct ExtractedMetadata {
    title: Option<String>,
    author: Option<String>,
    url: Option<String>,
    hostname: Option<String>,
    description: Option<String>,
    sitename: Option<String>,
    date: Option<String>,
    categories: Option<Vec<String>>,
}

fn extract_html_content(html: &str, url: &str) -> Result<String, String> {
    let document = Html::parse_document(html);
    let meta = collect_meta_tags(&document);
    let metadata = extract_metadata(&document, &meta, url);
    let content_html = extract_primary_html(&document)
        .or_else(|| extract_body_html(&document))
        .unwrap_or_default();

    let content = parse_html(&content_html).trim().to_string();
    if content.is_empty() {
        return Err(
            "Failed to extract meaningful content from the page. This may indicate the page content is not suitable for text extraction, or the page requires JavaScript to render its content.".to_string(),
        );
    }

    let frontmatter = build_frontmatter(&metadata);
    if frontmatter.is_empty() {
        Ok(content)
    } else {
        Ok(format!("{frontmatter}\n{content}"))
    }
}

fn collect_meta_tags(document: &Html) -> HashMap<String, String> {
    let mut meta = HashMap::new();
    let selector = Selector::parse("meta").unwrap();
    for element in document.select(&selector) {
        let value = element.value();
        let key = value
            .attr("name")
            .or_else(|| value.attr("property"))
            .map(|s| s.to_ascii_lowercase());
        let content = value.attr("content").map(|s| s.trim().to_string());
        if let (Some(key), Some(content)) = (key, content) {
            if !content.is_empty() {
                meta.entry(key).or_insert(content);
            }
        }
    }
    meta
}

fn extract_metadata(
    document: &Html,
    meta: &HashMap<String, String>,
    url: &str,
) -> ExtractedMetadata {
    let title = meta
        .get("og:title")
        .cloned()
        .or_else(|| meta.get("twitter:title").cloned())
        .or_else(|| meta.get("title").cloned())
        .or_else(|| extract_title(document));

    let description = meta
        .get("og:description")
        .cloned()
        .or_else(|| meta.get("description").cloned());

    let sitename = meta
        .get("og:site_name")
        .cloned()
        .or_else(|| meta.get("application-name").cloned());

    let author = meta
        .get("octolytics-dimension-user_login")
        .cloned()
        .or_else(|| meta.get("author").cloned())
        .or_else(|| extract_jsonld_author(document));

    let date = extract_jsonld_date(document)
        .or_else(|| meta.get("article:published_time").cloned())
        .or_else(|| meta.get("date").cloned())
        .and_then(normalize_date);

    let categories = meta
        .get("hovercard-subject-tag")
        .map(|value| split_categories(value))
        .filter(|items| !items.is_empty())
        .or_else(|| {
            meta.get("article:tag")
                .map(|value| split_categories(value))
                .filter(|items| !items.is_empty())
        });

    let url_value = if url.trim().is_empty() {
        None
    } else {
        Some(url.to_string())
    };
    let hostname = Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| host.to_string()));

    ExtractedMetadata {
        title,
        author,
        url: url_value,
        hostname,
        description,
        sitename,
        date,
        categories,
    }
}

fn extract_title(document: &Html) -> Option<String> {
    let selector = Selector::parse("title").ok()?;
    document
        .select(&selector)
        .next()
        .map(|node| node.text().collect::<Vec<_>>().join("").trim().to_string())
        .filter(|text| !text.is_empty())
}

fn extract_jsonld_date(document: &Html) -> Option<String> {
    let selector = Selector::parse("script[type=\"application/ld+json\"]").ok()?;
    for node in document.select(&selector) {
        let text = node.inner_html();
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(date) = find_jsonld_field(&value, "datePublished")
                .or_else(|| find_jsonld_field(&value, "dateCreated"))
            {
                return Some(date);
            }
        }
    }
    None
}

fn extract_jsonld_author(document: &Html) -> Option<String> {
    let selector = Selector::parse("script[type=\"application/ld+json\"]").ok()?;
    for node in document.select(&selector) {
        let text = node.inner_html();
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(author) = find_jsonld_author(&value) {
                return Some(author);
            }
        }
    }
    None
}

fn find_jsonld_field(value: &serde_json::Value, field: &str) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(val) = map.get(field).and_then(|val| val.as_str()) {
                return Some(val.to_string());
            }
            for (_, child) in map {
                if let Some(found) = find_jsonld_field(child, field) {
                    return Some(found);
                }
            }
            None
        }
        serde_json::Value::Array(items) => {
            items.iter().find_map(|item| find_jsonld_field(item, field))
        }
        _ => None,
    }
}

fn find_jsonld_author(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(author) = map.get("author") {
                if let Some(name) = author.get("name").and_then(|val| val.as_str()) {
                    return Some(name.to_string());
                }
            }
            for (_, child) in map {
                if let Some(found) = find_jsonld_author(child) {
                    return Some(found);
                }
            }
            None
        }
        serde_json::Value::Array(items) => items.iter().find_map(|item| find_jsonld_author(item)),
        _ => None,
    }
}

fn normalize_date(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() >= 10 {
        return Some(trimmed[..10].to_string());
    }
    Some(trimmed.to_string())
}

fn split_categories(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

fn extract_primary_html(document: &Html) -> Option<String> {
    let selectors = [".comment-body", "article", "main"];
    for selector in selectors {
        if let Ok(sel) = Selector::parse(selector) {
            if let Some(node) = document.select(&sel).next() {
                let html = node.inner_html();
                if !html.trim().is_empty() {
                    return Some(html);
                }
            }
        }
    }
    None
}

fn extract_body_html(document: &Html) -> Option<String> {
    let selector = Selector::parse("body").ok()?;
    document
        .select(&selector)
        .next()
        .map(|node| node.inner_html())
}

fn build_frontmatter(meta: &ExtractedMetadata) -> String {
    let mut lines = Vec::new();
    lines.push("---".to_string());

    if let Some(value) = meta.title.as_ref() {
        lines.push(format!("title: {}", normalize_scalar(value)));
    }
    if let Some(value) = meta.author.as_ref() {
        lines.push(format!("author: {}", normalize_scalar(value)));
    }
    if let Some(value) = meta.url.as_ref() {
        lines.push(format!("url: {}", normalize_scalar(value)));
    }
    if let Some(value) = meta.hostname.as_ref() {
        lines.push(format!("hostname: {}", normalize_scalar(value)));
    }
    if let Some(value) = meta.description.as_ref() {
        lines.push(format!("description: {}", normalize_scalar(value)));
    }
    if let Some(value) = meta.sitename.as_ref() {
        lines.push(format!("sitename: {}", normalize_scalar(value)));
    }
    if let Some(value) = meta.date.as_ref() {
        lines.push(format!("date: {}", normalize_scalar(value)));
    }
    if let Some(values) = meta.categories.as_ref() {
        if !values.is_empty() {
            let rendered = values
                .iter()
                .map(|item| format!("'{}'", item.replace('\'', "''")))
                .collect::<Vec<_>>()
                .join(", ");
            lines.push(format!("categories: [{rendered}]"));
        }
    }

    if lines.len() == 1 {
        return String::new();
    }
    lines.push("---".to_string());
    lines.join("\n")
}

fn normalize_scalar(value: &str) -> String {
    let trimmed = value.trim().replace('\n', " ").replace('\r', " ");
    trimmed.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::extract_html_content;

    #[test]
    fn extract_html_content_with_metadata() {
        let html = r#"
<!doctype html>
<html>
  <head>
    <title>Example Title</title>
    <meta name="description" content="Example description." />
    <meta property="og:site_name" content="Example Site" />
    <meta name="octolytics-dimension-user_login" content="ExampleAuthor" />
    <meta name="hovercard-subject-tag" content="issue:123" />
    <script type="application/ld+json">{"datePublished":"2025-02-23T18:26:02.000Z"}</script>
  </head>
  <body>
    <div class="comment-body"><p>Hello <code>world</code>.</p></div>
  </body>
</html>
"#;

        let output = extract_html_content(html, "https://example.com/issues/123").unwrap();
        let expected = r#"---
title: Example Title
author: ExampleAuthor
url: https://example.com/issues/123
hostname: example.com
description: Example description.
sitename: Example Site
date: 2025-02-23
categories: ['issue:123']
---
Hello `world`."#;
        assert_eq!(output, expected);
    }
}
