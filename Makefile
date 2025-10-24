RUFF := $(shell command -v ruff 2> /dev/null || echo "uv run ruff")
PYRIGHT := $(shell command -v pyright 2> /dev/null || echo "uv run pyright")

.DEFAULT_GOAL := prepare

.PHONY: help
help: ## Show available make targets.
	@echo "Available make targets:"
	@awk 'BEGIN { FS = ":.*## " } /^[A-Za-z0-9_.-]+:.*## / { printf "  %-20s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

.PHONY: prepare
prepare: download-deps ## Sync dependencies using locked versions.
	uv sync --frozen

.PHONY: format
format: ## Auto-format Python sources with ruff.
	$(RUFF) check --fix
	$(RUFF) format

.PHONY: check
check: ## Run linting and type checks.
	$(RUFF) check
	$(RUFF) format --check
	$(PYRIGHT)

.PHONY: test
test: ## Run the test suite with pytest.
	uv run pytest tests -vv

.PHONY: build
build: ## Build the standalone executable with PyInstaller.
	uv run pyinstaller kimi.spec

include src/kimi_cli/deps/Makefile
