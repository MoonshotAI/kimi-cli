from loguru import logger

# Disable logging by default for library usage.
# Application entry points (e.g., gitrekt_cli.cli) should call logger.enable("gitrekt_cli")
# to enable logging.
logger.disable("gitrekt_cli")
