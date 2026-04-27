def acp_main() -> None:
    """Entry point for the multi-session ACP server."""
    import asyncio

    from acp.agent.connection import AgentSideConnection
    from acp.stdio import stdio_streams

    from kimi_cli.acp.server import ACPServer
    from kimi_cli.app import enable_logging
    from kimi_cli.utils.logging import logger

    # Maximum buffer size for the asyncio StreamReader used for stdio.
    # A 100MB limit is large enough for typical interactive use while still
    # protecting the process from unbounded memory growth.
    STDIO_BUFFER_LIMIT = 100 * 1024 * 1024

    async def _run() -> None:
        enable_logging()
        logger.info("Starting ACP server on stdio")

        # Create stdio streams with increased buffer limit
        output_stream, input_stream = await stdio_streams(limit=STDIO_BUFFER_LIMIT)

        # Create and run the agent connection
        server = ACPServer()
        conn = AgentSideConnection(
            server,
            input_stream,
            output_stream,
            listening=False,
            use_unstable_protocol=True,
        )
        await conn.listen()

    asyncio.run(_run())
