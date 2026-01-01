from loguru import logger

# Disable logging by default for library usage.
# Application entry points (e.g., kimi_cli.cli) should call logger.enable("kimi_cli")
# to enable logging.
logger.disable("kimi_cli")
