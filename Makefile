.DEFAULT_GOAL := prepare

.PHONY: help
help: ## Show available make targets.
	@echo "Available make targets:"
	@awk 'BEGIN { FS = ":.*## " } /^[A-Za-z0-9_.-]+:.*## / { printf "  %-20s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

.PHONY: prepare
prepare: download-deps ## Sync dependencies using locked versions.
	uv sync --frozen --all-extras

.PHONY: prepare-build
prepare-build: download-deps ## Sync dependencies for releases without workspace sources.
	uv sync --frozen --all-extras --no-sources

.PHONY: format format-kimi-cli format-kosong format-pykaos
format: format-kimi-cli format-kosong format-pykaos ## Auto-format all workspace packages with ruff.
format-kimi-cli: ## Auto-format Kimi CLI sources with ruff.
	uv run ruff check --fix
	uv run ruff format
format-kosong: ## Auto-format kosong sources with ruff.
	uv run --project packages/kosong --directory packages/kosong ruff check --fix
	uv run --project packages/kosong --directory packages/kosong ruff format
format-pykaos: ## Auto-format pykaos sources with ruff.
	uv run --project packages/kaos --directory packages/kaos ruff check --fix
	uv run --project packages/kaos --directory packages/kaos ruff format

.PHONY: check check-kimi-cli check-kosong check-pykaos
check: check-kimi-cli check-kosong check-pykaos ## Run linting and type checks for all packages.
check-kimi-cli: ## Run linting and type checks for Kimi CLI.
	uv run ruff check
	uv run ruff format --check
	uv run pyright
check-kosong: ## Run linting and type checks for kosong.
	uv run --project packages/kosong --directory packages/kosong ruff check
	uv run --project packages/kosong --directory packages/kosong ruff format --check
	uv run --project packages/kosong --directory packages/kosong pyright
check-pykaos: ## Run linting and type checks for pykaos.
	uv run --project packages/kaos --directory packages/kaos ruff check
	uv run --project packages/kaos --directory packages/kaos ruff format --check
	uv run --project packages/kaos --directory packages/kaos pyright


.PHONY: test test-kimi-cli test-kosong test-pykaos
test: test-kimi-cli test-kosong test-pykaos ## Run all test suites.
test-kimi-cli: ## Run Kimi CLI tests.
	uv run pytest tests -vv
test-kosong: ## Run kosong tests (including doctests).
	uv run --project packages/kosong --directory packages/kosong pytest --doctest-modules -vv
test-pykaos: ## Run pykaos tests.
	uv run --project packages/kaos --directory packages/kaos pytest tests -vv

.PHONY: build build-kimi-cli build-kosong build-pykaos build-bin
build: build-kimi-cli build-kosong build-pykaos ## Build Python packages for release.
build-kimi-cli: ## Build the kimi-cli sdist and wheel.
	uv build --package kimi-cli --no-sources --out-dir dist
build-kosong: ## Build the kosong sdist and wheel.
	uv build --package kosong --no-sources --out-dir dist/kosong
build-pykaos: ## Build the pykaos sdist and wheel.
	uv build --package pykaos --no-sources --out-dir dist/pykaos
build-bin: ## Build the standalone executable with PyInstaller.
	uv run pyinstaller kimi.spec

.PHONY: ai-test
ai-test: ## Run the test suite with Kimi CLI.
	uv run tests_ai/scripts/run.py tests_ai

include src/kimi_cli/deps/Makefile
