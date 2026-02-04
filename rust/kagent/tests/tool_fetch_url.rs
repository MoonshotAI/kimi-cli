mod tool_test_utils;

use std::future::Future;

use kagent::config::MoonshotFetchConfig;
use kagent::soul::toolset::with_current_tool_call;
use kagent::tools::web::{FetchParams, FetchURL};
use kosong::message::ToolCall;
use kosong::tooling::{CallableTool2, ToolOutput, ToolReturnValue};
use wiremock::matchers::{body_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use tool_test_utils::RuntimeFixture;

async fn call_with_tool_call<F>(name: &str, fut: F) -> ToolReturnValue
where
    F: Future<Output = ToolReturnValue>,
{
    let call = ToolCall::new("test-call-id", name);
    with_current_tool_call(call, fut).await
}

fn output_text(result: &ToolReturnValue) -> &str {
    match &result.output {
        ToolOutput::Text(text) => text,
        _ => "",
    }
}

#[tokio::test]
async fn test_fetch_url_markdown_response() {
    let server = MockServer::start().await;
    let markdown = "# Title\n\nThis is a markdown document.\n";
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(
            ResponseTemplate::new(200).set_body_raw(markdown, "text/markdown; charset=utf-8"),
        )
        .mount(&server)
        .await;

    let mut fixture = RuntimeFixture::new();
    fixture.runtime.config.services.moonshot_fetch = None;
    let tool = FetchURL::new(&fixture.runtime);

    let url = format!("{}/", server.uri());
    let result = tool.call_typed(FetchParams { url: url.clone() }).await;

    assert!(!result.is_error);
    assert_eq!(output_text(&result), markdown);
    assert_eq!(
        result.message,
        "The returned content is the full content of the page."
    );
}

#[tokio::test]
async fn test_fetch_url_html_with_metadata() {
    let server = MockServer::start().await;
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

    Mock::given(method("GET"))
        .and(path("/issues/123"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(html, "text/html; charset=utf-8"))
        .mount(&server)
        .await;

    let mut fixture = RuntimeFixture::new();
    fixture.runtime.config.services.moonshot_fetch = None;
    let tool = FetchURL::new(&fixture.runtime);

    let url = format!("{}/issues/123", server.uri());
    let result = tool.call_typed(FetchParams { url: url.clone() }).await;

    let expected = format!(
        "---\n\
title: Example Title\n\
author: ExampleAuthor\n\
url: {url}\n\
hostname: 127.0.0.1\n\
description: Example description.\n\
sitename: Example Site\n\
date: 2025-02-23\n\
categories: ['issue:123']\n\
---\n\
Hello `world`."
    );

    assert!(!result.is_error);
    assert_eq!(output_text(&result), expected);
}

#[tokio::test]
async fn test_fetch_url_empty_body() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_raw("<html><body></body></html>", "text/html; charset=utf-8"),
        )
        .mount(&server)
        .await;

    let mut fixture = RuntimeFixture::new();
    fixture.runtime.config.services.moonshot_fetch = None;
    let tool = FetchURL::new(&fixture.runtime);

    let url = format!("{}/", server.uri());
    let result = tool.call_typed(FetchParams { url: url.clone() }).await;

    assert!(result.is_error);
    assert!(
        result
            .message
            .contains("Failed to extract meaningful content")
    );
}

#[tokio::test]
async fn test_fetch_url_404_status() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/missing"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let mut fixture = RuntimeFixture::new();
    fixture.runtime.config.services.moonshot_fetch = None;
    let tool = FetchURL::new(&fixture.runtime);

    let url = format!("{}/missing", server.uri());
    let result = tool.call_typed(FetchParams { url: url.clone() }).await;

    assert!(result.is_error);
    assert_eq!(
        result.message,
        "Failed to fetch URL. Status: 404 Not Found. This may indicate the page is not accessible or the server is down."
    );
}

#[tokio::test]
async fn test_fetch_url_invalid_url() {
    let mut fixture = RuntimeFixture::new();
    fixture.runtime.config.services.moonshot_fetch = None;
    let tool = FetchURL::new(&fixture.runtime);

    let result = tool
        .call_typed(FetchParams {
            url: "not-a-valid-url".to_string(),
        })
        .await;

    assert!(result.is_error);
    assert!(
        result
            .message
            .starts_with("Failed to fetch URL due to network error:")
    );
}

#[tokio::test]
async fn test_fetch_url_empty_url() {
    let mut fixture = RuntimeFixture::new();
    fixture.runtime.config.services.moonshot_fetch = None;
    let tool = FetchURL::new(&fixture.runtime);

    let result = tool
        .call_typed(FetchParams {
            url: "".to_string(),
        })
        .await;

    assert!(result.is_error);
    assert!(
        result
            .message
            .starts_with("Failed to fetch URL due to network error:")
    );
}

#[tokio::test]
async fn test_fetch_url_with_service() {
    let server = MockServer::start().await;
    let expected_content = "# Service Content\n\nThis content was fetched via the service.";

    Mock::given(method("POST"))
        .and(path("/fetch"))
        .and(header("Authorization", "Bearer test-key"))
        .and(header("Accept", "text/markdown"))
        .and(header("X-Custom-Header", "custom-value"))
        .and(header("X-Msh-Tool-Call-Id", "test-call-id"))
        .and(body_json(serde_json::json!({"url": "https://example.com"})))
        .respond_with(ResponseTemplate::new(200).set_body_string(expected_content))
        .mount(&server)
        .await;

    let mut fixture = RuntimeFixture::new();
    fixture.runtime.config.services.moonshot_fetch = Some(MoonshotFetchConfig {
        base_url: format!("{}/fetch", server.uri()),
        api_key: "test-key".to_string(),
        custom_headers: Some(
            [("X-Custom-Header".to_string(), "custom-value".to_string())]
                .into_iter()
                .collect(),
        ),
    });

    let tool = FetchURL::new(&fixture.runtime);
    let result = call_with_tool_call(
        "FetchURL",
        tool.call_typed(FetchParams {
            url: "https://example.com".to_string(),
        }),
    )
    .await;

    assert!(!result.is_error);
    assert_eq!(output_text(&result), expected_content);
    assert_eq!(
        result.message,
        "The returned content is the main content extracted from the page."
    );
}
