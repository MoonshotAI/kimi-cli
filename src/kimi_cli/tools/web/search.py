from pathlib import Path
from typing import override

from kosong.tooling import CallableTool2, ToolReturnType
from pydantic import BaseModel, Field, ValidationError

from kimi_cli.config import Config
from kimi_cli.constant import USER_AGENT
from kimi_cli.soul.toolset import get_current_tool_call_or_none
from kimi_cli.tools.utils import ToolResultBuilder, load_desc
from kimi_cli.utils.aiohttp import new_client_session


class Params(BaseModel):
    query: str = Field(description="The query text to search for.")
    limit: int = Field(
        description=(
            "The number of results to return. "
            "Typically you do not need to set this value. "
            "When the results do not contain what you need, "
            "you probably want to give a more concrete query."
        ),
        default=5,
        ge=1,
        le=20,
    )
    include_content: bool = Field(
        description=(
            "Whether to include the content of the web pages in the results. "
            "It can consume a large amount of tokens when this is set to True. "
            "You should avoid enabling this when `limit` is set to a large value."
        ),
        default=False,
    )


class SearchWeb(CallableTool2[Params]):
    name: str = "SearchWeb"
    description: str = load_desc(Path(__file__).parent / "search.md", {})
    params: type[Params] = Params

    def __init__(self, config: Config, **kwargs):
        super().__init__(**kwargs)
        if config.services.moonshot_search is not None:
            self._base_url = config.services.moonshot_search.base_url
            self._api_key = config.services.moonshot_search.api_key.get_secret_value()
            self._custom_headers = config.services.moonshot_search.custom_headers or {}
        else:
            self._base_url = ""
            self._api_key = ""
            self._custom_headers = {}

    @override
    async def __call__(self, params: Params) -> ToolReturnType:
        builder = ToolResultBuilder(max_line_length=None)

        if not self._base_url or not self._api_key:
            return builder.error(
                "Search service is not configured. You may want to try other methods to search.",
                brief="Search service not configured",
            )

        tool_call = get_current_tool_call_or_none()
        assert tool_call is not None, "Tool call is expected to be set"

        async with (
            new_client_session() as session,
            session.post(
                self._base_url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Authorization": f"Bearer {self._api_key}",
                    "X-Msh-Tool-Call-Id": tool_call.id,
                    **self._custom_headers,
                },
                json={
                    "text_query": params.query,
                    "limit": params.limit,
                    "enable_page_crawling": params.include_content,
                    "timeout_seconds": 30,
                },
            ) as response,
        ):
            if response.status != 200:
                return builder.error(
                    (
                        f"Failed to search. Status: {response.status}. "
                        "This may indicates that the search service is currently unavailable."
                    ),
                    brief="Failed to search",
                )

            try:
                results = Response(**await response.json()).search_results
            except ValidationError as e:
                return builder.error(
                    (
                        f"Failed to parse search results. Error: {e}. "
                        "This may indicates that the search service is currently unavailable."
                    ),
                    brief="Failed to parse search results",
                )

        for i, result in enumerate(results):
            if i > 0:
                builder.write("---\n\n")
            builder.write(
                f"Title: {result.title}\nDate: {result.date}\n"
                f"URL: {result.url}\nSummary: {result.snippet}\n\n"
            )
            if result.content:
                builder.write(f"{result.content}\n\n")

        return builder.ok()


class SearchResult(BaseModel):
    site_name: str
    title: str
    url: str
    snippet: str
    content: str = ""
    date: str = ""
    icon: str = ""
    mime: str = ""


class Response(BaseModel):
    search_results: list[SearchResult]
