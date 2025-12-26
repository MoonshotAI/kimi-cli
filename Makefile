.DEFAULT_GOAL := prepare

.PHONY: help
help: ## Show available make targets.
	@echo "Available make targets:"
	@awk 'BEGIN { FS = ":.*## " } /^[A-Za-z0-9_.-]+:.*## / { printf "  %-20s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

.PHONY: prepare
prepare: download-deps ## Sync dependencies using locked versions.
	uv sync --frozen --all-extras

.PHONY: format format-kimi-cli format-kosong format-pykaos
format: format-kimi-cli format-kosong format-pykaos ## Auto-format Python sources with ruff.
format-kimi-cli:
	uv run ruff check --fix
	uv run ruff format
format-kosong:
	uv run --project packages/kosong --directory packages/kosong ruff check --fix
	uv run --project packages/kosong --directory packages/kosong ruff format
format-pykaos:
	uv run --project packages/kaos --directory packages/kaos ruff check --fix
	uv run --project packages/kaos --directory packages/kaos ruff format

.PHONY: check check-kimi-cli check-kosong check-pykaos
check: check-kimi-cli check-kosong check-pykaos ## Run linting and type checks.
check-kimi-cli:
	uv run ruff check
	uv run ruff format --check
	uv run pyright
check-kosong:
	uv run --project packages/kosong --directory packages/kosong ruff check
	uv run --project packages/kosong --directory packages/kosong ruff format --check
	uv run --project packages/kosong --directory packages/kosong pyright
check-pykaos:
	uv run --project packages/kaos --directory packages/kaos ruff check
	uv run --project packages/kaos --directory packages/kaos ruff format --check
	uv run --project packages/kaos --directory packages/kaos pyright


.PHONY: test test-kimi-cli test-kosong test-pykaos
test: test-kimi-cli test-kosong test-pykaos ## Run all test suites.
test-kimi-cli:
	uv run pytest tests -vv
test-kosong:
	uv run --project packages/kosong --directory packages/kosong pytest --doctest-modules -vv
test-pykaos:
	uv run --project packages/kaos --directory packages/kaos pytest tests -vv

.PHONY: build
build: ## Build the standalone executable with PyInstaller.
	uv run pyinstaller kimi.spec

.PHONY: ai-test
ai-test: ## Run the test suite with Kimi CLI.
	uv run tests_ai/scripts/run.py tests_ai

include src/kimi_cli/deps/Makefile
