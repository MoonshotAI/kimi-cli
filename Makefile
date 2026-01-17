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

.PHONY: format format-gitrekt-cli format-kosong format-pykaos format-gitrekt-sdk
format: format-gitrekt-cli format-kosong format-pykaos format-gitrekt-sdk ## Auto-format all workspace packages with ruff.
format-gitrekt-cli: ## Auto-format Gitrekt CLI sources with ruff.
	@echo "==> Formatting Gitrekt CLI sources"
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
format-gitrekt-sdk: ## Auto-format gitrekt-sdk sources with ruff.
	@echo "==> Formatting gitrekt-sdk sources"
	@uv run --project sdks/gitrekt-sdk --directory sdks/gitrekt-sdk ruff check --fix
	@uv run --project sdks/gitrekt-sdk --directory sdks/gitrekt-sdk ruff format

.PHONY: check check-gitrekt-cli check-kosong check-pykaos check-gitrekt-sdk
check: check-gitrekt-cli check-kosong check-pykaos check-gitrekt-sdk ## Run linting and type checks for all packages.
check-gitrekt-cli: ## Run linting and type checks for Gitrekt CLI.
	@echo "==> Checking Gitrekt CLI (ruff + pyright + ty; ty is non-blocking)"
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
check-gitrekt-sdk: ## Run linting and type checks for gitrekt-sdk.
	@echo "==> Checking gitrekt-sdk (ruff + pyright + ty; ty is non-blocking)"
	@uv run --project sdks/gitrekt-sdk --directory sdks/gitrekt-sdk ruff check
	@uv run --project sdks/gitrekt-sdk --directory sdks/gitrekt-sdk ruff format --check
	@uv run --project sdks/gitrekt-sdk --directory sdks/gitrekt-sdk pyright
	@uv run --project sdks/gitrekt-sdk --directory sdks/gitrekt-sdk ty check || true


.PHONY: test test-gitrekt-cli test-kosong test-pykaos test-gitrekt-sdk
test: test-gitrekt-cli test-kosong test-pykaos test-gitrekt-sdk ## Run all test suites.
test-gitrekt-cli: ## Run Gitrekt CLI tests.
	@echo "==> Running Gitrekt CLI tests"
	@uv run pytest tests -vv
test-kosong: ## Run kosong tests (including doctests).
	@echo "==> Running kosong tests"
	@uv run --project packages/kosong --directory packages/kosong pytest --doctest-modules -vv
test-pykaos: ## Run pykaos tests.
	@echo "==> Running pykaos tests"
	@uv run --project packages/kaos --directory packages/kaos pytest tests -vv
test-gitrekt-sdk: ## Run gitrekt-sdk tests.
	@echo "==> Running gitrekt-sdk tests"
	@uv run --project sdks/gitrekt-sdk --directory sdks/gitrekt-sdk pytest tests -vv

.PHONY: build build-gitrekt-cli build-kosong build-pykaos build-gitrekt-sdk build-bin
build: build-gitrekt-cli build-kosong build-pykaos build-gitrekt-sdk ## Build Python packages for release.
build-gitrekt-cli: ## Build the gitrekt-cli sdist and wheel.
	@echo "==> Building gitrekt-cli distributions"
	@uv build --package gitrekt-cli --no-sources --out-dir dist
build-kosong: ## Build the kosong sdist and wheel.
	@echo "==> Building kosong distributions"
	@uv build --package kosong --no-sources --out-dir dist/kosong
build-pykaos: ## Build the pykaos sdist and wheel.
	@echo "==> Building pykaos distributions"
	@uv build --package pykaos --no-sources --out-dir dist/pykaos
build-gitrekt-sdk: ## Build the gitrekt-sdk sdist and wheel.
	@echo "==> Building gitrekt-sdk distributions"
	@uv build --package gitrekt-sdk --no-sources --out-dir dist/gitrekt-sdk
build-bin: ## Build the standalone executable with PyInstaller.
	@echo "==> Building PyInstaller binary"
	@uv run pyinstaller gitrekt.spec

.PHONY: ai-test
ai-test: ## Run the test suite with Gitrekt CLI.
	@echo "==> Running AI test suite"
	@uv run tests_ai/scripts/run.py tests_ai

.PHONY: gen-changelog gen-docs
gen-changelog: ## Generate changelog with Gitrekt CLI.
	@echo "==> Generating changelog"
	@uv run gitrekt -c "$$(cat .gitrekt/prompts/gen-changelog.md)" --yolo
gen-docs: ## Generate user docs with Gitrekt CLI.
	@echo "==> Generating user docs"
	@uv run gitrekt -c "$$(cat .gitrekt/prompts/gen-docs.md)" --yolo

include src/gitrekt_cli/deps/Makefile
