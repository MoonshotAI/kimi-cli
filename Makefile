.DEFAULT_GOAL := prepare

.PHONY: help
help: ## Show available make targets.
	@echo "Available make targets:"
	@awk 'BEGIN { FS = ":.*## " } /^[A-Za-z0-9_.-]+:.*## / { printf "  %-20s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

.PHONY: prepare
prepare: download-deps ## Sync dependencies using locked versions.
	uv sync --frozen --all-extras

.PHONY: format
format: ## Auto-format Python sources with ruff.
	uv run ruff check --fix
	uv run ruff format

.PHONY: check
check: ## Run linting and type checks.
	uv run ruff check
	uv run ruff format --check
	uv run pyright


.PHONY: test
test: ## Run the test suite with pytest.
	uv run pytest tests -vv

.PHONY: build
build: ## Build the standalone executable with PyInstaller.
	uv run pyinstaller kimi.spec

.PHONY: ai-test
ai-test: ## Run the test suite with Kimi CLI.
	uv run tests_ai/scripts/run.py tests_ai

include src/kimi_cli/deps/Makefile
