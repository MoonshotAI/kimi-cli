.DEFAULT_GOAL := prepare

.PHONY: help
help: ## Show available make targets.
	@echo "Available make targets:"
	@awk 'BEGIN { FS = ":.*## " } /^[A-Za-z0-9_.-]+:.*## / { printf "  %-20s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

.PHONY: prepare
prepare: download-deps ## Sync dependencies for all workspace packages.
	@echo "==> Syncing dependencies for all workspace packages"
	@uv sync --frozen --all-extras --all-packages

.PHONY: prepare-build
prepare-build: download-deps ## Sync dependencies for releases without workspace sources.
	@echo "==> Syncing dependencies for release builds (no sources)"
	@uv sync --frozen --all-extras --all-packages --no-sources

.PHONY: format format-kimi-cli format-kosong format-pykaos
format: format-kimi-cli format-kosong format-pykaos ## Auto-format all workspace packages with ruff.
format-kimi-cli: ## Auto-format Kimi CLI sources with ruff.
	@echo "==> Formatting Kimi CLI sources"
	@uv run ruff check --fix
	@uv run ruff format
format-kosong: ## Auto-format kosong sources with ruff.
	@echo "==> Formatting kosong sources"
	@uv run --project packages/kosong --directory packages/kosong ruff check --fix
	@uv run --project packages/kosong --directory packages/kosong ruff format
format-pykaos: ## Auto-format pykaos sources with ruff.
	@echo "==> Formatting pykaos sources"
	@uv run --project packages/kaos --directory packages/kaos ruff check --fix
	@uv run --project packages/kaos --directory packages/kaos ruff format

.PHONY: check check-kimi-cli check-kosong check-pykaos
check: check-kimi-cli check-kosong check-pykaos ## Run linting and type checks for all packages.
check-kimi-cli: ## Run linting and type checks for Kimi CLI.
	@echo "==> Checking Kimi CLI (ruff + pyright)"
	@uv run ruff check
	@uv run ruff format --check
	@uv run pyright
check-kosong: ## Run linting and type checks for kosong.
	@echo "==> Checking kosong (ruff + pyright)"
	@uv run --project packages/kosong --directory packages/kosong ruff check
	@uv run --project packages/kosong --directory packages/kosong ruff format --check
	@uv run --project packages/kosong --directory packages/kosong pyright
check-pykaos: ## Run linting and type checks for pykaos.
	@echo "==> Checking pykaos (ruff + pyright)"
	@uv run --project packages/kaos --directory packages/kaos ruff check
	@uv run --project packages/kaos --directory packages/kaos ruff format --check
	@uv run --project packages/kaos --directory packages/kaos pyright


.PHONY: test test-kimi-cli test-kosong test-pykaos
test: test-kimi-cli test-kosong test-pykaos ## Run all test suites.
test-kimi-cli: ## Run Kimi CLI tests.
	@echo "==> Running Kimi CLI tests"
	@uv run pytest tests -vv
test-kosong: ## Run kosong tests (including doctests).
	@echo "==> Running kosong tests"
	@uv run --project packages/kosong --directory packages/kosong pytest --doctest-modules -vv
test-pykaos: ## Run pykaos tests.
	@echo "==> Running pykaos tests"
	@uv run --project packages/kaos --directory packages/kaos pytest tests -vv

.PHONY: build build-kimi-cli build-kosong build-pykaos build-bin
build: build-kimi-cli build-kosong build-pykaos ## Build Python packages for release.
build-kimi-cli: ## Build the kimi-cli sdist and wheel.
	@echo "==> Building kimi-cli distributions"
	@uv build --package kimi-cli --no-sources --out-dir dist
build-kosong: ## Build the kosong sdist and wheel.
	@echo "==> Building kosong distributions"
	@uv build --package kosong --no-sources --out-dir dist/kosong
build-pykaos: ## Build the pykaos sdist and wheel.
	@echo "==> Building pykaos distributions"
	@uv build --package pykaos --no-sources --out-dir dist/pykaos
build-bin: ## Build the standalone executable with PyInstaller.
	@echo "==> Building PyInstaller binary"
	@uv run pyinstaller kimi.spec

.PHONY: ai-test
ai-test: ## Run the test suite with Kimi CLI.
	@echo "==> Running AI test suite"
	@uv run tests_ai/scripts/run.py tests_ai

include src/kimi_cli/deps/Makefile
