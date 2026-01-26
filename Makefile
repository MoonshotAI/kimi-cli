.DEFAULT_GOAL := prepare

.PHONY: help
help: ## Show available make targets.
	@echo "Available make targets:"
	@awk 'BEGIN { FS = ":.*## " } /^[A-Za-z0-9_.-]+:.*## / { printf "  %-20s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

.PHONY: install-prek
install-prek: ## Install prek and repo git hooks.
	@echo "==> Installing prek"
	@uv tool install prek
	@echo "==> Installing git hooks with prek"
	@uv tool run prek install

.PHONY: prepare
prepare: download-deps install-prek ## Sync dependencies for all workspace packages and install prek hooks.
	@echo "==> Syncing dependencies for all workspace packages"
	@uv sync --frozen --all-extras --all-packages

.PHONY: prepare-build
prepare-build: download-deps ## Sync dependencies for releases without workspace sources.
	@echo "==> Syncing dependencies for release builds (no sources)"
	@uv sync --all-extras --all-packages --no-sources

.PHONY: format format-kimi-cli format-kosong format-pykaos format-kimi-sdk
format: format-kimi-cli format-kosong format-pykaos format-kimi-sdk ## Auto-format all workspace packages with ruff.
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
format-kimi-sdk: ## Auto-format kimi-sdk sources with ruff.
	@echo "==> Formatting kimi-sdk sources"
	@uv run --project sdks/kimi-sdk --directory sdks/kimi-sdk ruff check --fix
	@uv run --project sdks/kimi-sdk --directory sdks/kimi-sdk ruff format

.PHONY: check check-kimi-cli check-kosong check-pykaos check-kimi-sdk
check: check-kimi-cli check-kosong check-pykaos check-kimi-sdk ## Run linting and type checks for all packages.
check-kimi-cli: ## Run linting and type checks for Kimi CLI.
	@echo "==> Checking Kimi CLI (ruff + pyright + ty; ty is non-blocking)"
	@uv run ruff check
	@uv run ruff format --check
	@uv run pyright
	@uv run ty check || true
check-kosong: ## Run linting and type checks for kosong.
	@echo "==> Checking kosong (ruff + pyright + ty; ty is non-blocking)"
	@uv run --project packages/kosong --directory packages/kosong ruff check
	@uv run --project packages/kosong --directory packages/kosong ruff format --check
	@uv run --project packages/kosong --directory packages/kosong pyright
	@uv run --project packages/kosong --directory packages/kosong ty check || true
check-pykaos: ## Run linting and type checks for pykaos.
	@echo "==> Checking pykaos (ruff + pyright + ty; ty is non-blocking)"
	@uv run --project packages/kaos --directory packages/kaos ruff check
	@uv run --project packages/kaos --directory packages/kaos ruff format --check
	@uv run --project packages/kaos --directory packages/kaos pyright
	@uv run --project packages/kaos --directory packages/kaos ty check || true
check-kimi-sdk: ## Run linting and type checks for kimi-sdk.
	@echo "==> Checking kimi-sdk (ruff + pyright + ty; ty is non-blocking)"
	@uv run --project sdks/kimi-sdk --directory sdks/kimi-sdk ruff check
	@uv run --project sdks/kimi-sdk --directory sdks/kimi-sdk ruff format --check
	@uv run --project sdks/kimi-sdk --directory sdks/kimi-sdk pyright
	@uv run --project sdks/kimi-sdk --directory sdks/kimi-sdk ty check || true


.PHONY: test test-kimi-cli test-kosong test-pykaos test-kimi-sdk
test: test-kimi-cli test-kosong test-pykaos test-kimi-sdk ## Run all test suites.
test-kimi-cli: ## Run Kimi CLI tests.
	@echo "==> Running Kimi CLI tests"
	@uv run pytest tests -vv
	@uv run pytest tests_e2e -vv
test-kosong: ## Run kosong tests (including doctests).
	@echo "==> Running kosong tests"
	@uv run --project packages/kosong --directory packages/kosong pytest --doctest-modules -vv
test-pykaos: ## Run pykaos tests.
	@echo "==> Running pykaos tests"
	@uv run --project packages/kaos --directory packages/kaos pytest tests -vv
test-kimi-sdk: ## Run kimi-sdk tests.
	@echo "==> Running kimi-sdk tests"
	@uv run --project sdks/kimi-sdk --directory sdks/kimi-sdk pytest tests -vv

.PHONY: build build-kimi-cli build-kosong build-pykaos build-kimi-sdk build-bin build-bin-onedir
build: build-kimi-cli build-kosong build-pykaos build-kimi-sdk ## Build Python packages for release.
build-kimi-cli: ## Build the kimi-cli and kimi-code sdists and wheels.
	@echo "==> Building kimi-cli distributions"
	@uv build --package kimi-cli --no-sources --out-dir dist
	@echo "==> Building kimi-code distributions"
	@uv build --package kimi-code --no-sources --out-dir dist
build-kosong: ## Build the kosong sdist and wheel.
	@echo "==> Building kosong distributions"
	@uv build --package kosong --no-sources --out-dir dist/kosong
build-pykaos: ## Build the pykaos sdist and wheel.
	@echo "==> Building pykaos distributions"
	@uv build --package pykaos --no-sources --out-dir dist/pykaos
build-kimi-sdk: ## Build the kimi-sdk sdist and wheel.
	@echo "==> Building kimi-sdk distributions"
	@uv build --package kimi-sdk --no-sources --out-dir dist/kimi-sdk
build-bin: ## Build the standalone executable with PyInstaller (one-file mode).
	@echo "==> Building PyInstaller binary (one-file)"
	@uv run pyinstaller kimi.spec
	@mkdir -p dist/onefile
	@if [ -f dist/kimi.exe ]; then mv dist/kimi.exe dist/onefile/; elif [ -f dist/kimi ]; then mv dist/kimi dist/onefile/; fi
build-bin-onedir: ## Build the standalone executable with PyInstaller (one-dir mode).
	@echo "==> Building PyInstaller binary (one-dir)"
	@rm -rf dist/onedir dist/kimi
	@uv run pyinstaller kimi.spec
	@if [ -f dist/kimi/kimi-exe.exe ]; then mv dist/kimi/kimi-exe.exe dist/kimi/kimi.exe; elif [ -f dist/kimi/kimi-exe ]; then mv dist/kimi/kimi-exe dist/kimi/kimi; fi
	@mkdir -p dist/onedir && mv dist/kimi dist/onedir/

.PHONY: ai-test
ai-test: ## Run the test suite with Kimi CLI.
	@echo "==> Running AI test suite"
	@uv run tests_ai/scripts/run.py tests_ai

.PHONY: gen-changelog gen-docs
gen-changelog: ## Generate changelog with Kimi CLI.
	@echo "==> Generating changelog"
	@uv run kimi --yolo --prompt /skill:gen-changelog
gen-docs: ## Generate user docs with Kimi CLI.
	@echo "==> Generating user docs"
	@uv run kimi --yolo --prompt /skill:gen-docs

include src/kimi_cli/deps/Makefile
