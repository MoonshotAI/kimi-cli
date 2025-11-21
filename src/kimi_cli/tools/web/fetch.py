from pathlib import Path
from typing import Any, override

import aiohttp
import trafilatura
from kosong.tooling import CallableTool2, ToolOk, ToolReturnType
from pydantic import BaseModel, Field

from kimi_cli.config import Config
from kimi_cli.constant import USER_AGENT
from kimi_cli.soul.toolset import get_current_tool_call_or_none
from kimi_cli.tools.utils import ToolResultBuilder, load_desc
from kimi_cli.utils.aiohttp import new_client_session
from kimi_cli.utils.logging import logger


class Params(BaseModel):
    url: str = Field(description="The URL to fetch content from.")


class FetchURL(CallableTool2[Params]):
    name: str = "FetchURL"
    description: str = load_desc(Path(__file__).parent / "fetch.md", {})
    params: type[Params] = Params

    def __init__(self, config: Config, **kwargs: Any):
        super().__init__(**kwargs)
        self._service_config = config.services.moonshot_fetch

    @override
    async def __call__(self, params: Params) -> ToolReturnType:
        builder = ToolResultBuilder(max_line_length=None)

        if self._service_config:
            result = await self._fetch_with_service(params, builder)
            if isinstance(result, ToolOk):
                return result
            logger.warning("Failed to fetch URL via service: {error}", error=result.message)
            # fallback to local fetch if service fetch fails

        try:
            async with (
                new_client_session() as session,
                session.get(
                    params.url,
                    headers={
                        "User-Agent": (
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                            "(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
                        ),
                    },
                ) as response,
            ):
                if response.status >= 400:
                    return builder.error(
                        (
                            f"Failed to fetch URL. Status: {response.status}. "
                            f"This may indicate the page is not accessible or the server is down."
                        ),
                        brief=f"HTTP {response.status} error",
                    )

                resp_text = await response.text()

                content_type = response.headers.get(aiohttp.hdrs.CONTENT_TYPE, "").lower()
                if content_type.startswith(("text/plain", "text/markdown")):
                    builder.write(resp_text)
                    return builder.ok("The returned content is the full content of the page.")
        except aiohttp.ClientError as e:
            return builder.error(
                (
                    f"Failed to fetch URL due to network error: {str(e)}. "
                    "This may indicate the URL is invalid or the server is unreachable."
                ),
                brief="Network error",
            )

        if not resp_text:
            return builder.ok(
                "The response body is empty.",
                brief="Empty response body",
            )

        extracted_text = trafilatura.extract(
            resp_text,
            include_comments=True,
            include_tables=True,
            include_formatting=False,
            output_format="txt",
            with_metadata=True,
        )

        if not extracted_text:
            return builder.error(
                (
                    "Failed to extract meaningful content from the page. "
                    "This may indicate the page content is not suitable for text extraction, "
                    "or the page requires JavaScript to render its content."
                ),
                brief="No content extracted",
            )

        builder.write(extracted_text)
        return builder.ok("The returned content is the main text content extracted from the page.")

    async def _fetch_with_service(
        self, params: Params, builder: ToolResultBuilder
    ) -> ToolReturnType:
        assert self._service_config is not None

        tool_call = get_current_tool_call_or_none()
        assert tool_call is not None, "Tool call is expected to be set"

        headers = {
            "User-Agent": USER_AGENT,
            "Authorization": f"Bearer {self._service_config.api_key.get_secret_value()}",
            "Accept": "text/markdown",
            "X-Msh-Tool-Call-Id": tool_call.id,
            **(self._service_config.custom_headers or {}),
        }

        async with (
            new_client_session() as session,
            session.post(
                self._service_config.base_url,
                headers=headers,
                json={"url": params.url},
            ) as response,
        ):
            if response.status != 200:
                return builder.error(
                    f"Failed to fetch URL via service. Status: {response.status}.",
                    brief="Failed to fetch URL via fetch service",
                )

            content = await response.text()
            builder.write(content)
            return builder.ok("The returned content is the main content extracted from the page.")
