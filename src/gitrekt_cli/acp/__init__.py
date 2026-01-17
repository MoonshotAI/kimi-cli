def acp_main() -> None:
    """Entry point for the multi-session ACP server."""
    import asyncio

    import acp

    from gitrekt_cli.acp.server import ACPServer
    from gitrekt_cli.app import enable_logging
    from gitrekt_cli.utils.logging import logger

    enable_logging()
    logger.info("Starting ACP server on stdio")
    asyncio.run(acp.run_agent(ACPServer(), use_unstable_protocol=True))
