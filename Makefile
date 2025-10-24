.PHONY: prepare
prepare: download-deps
	uv sync --frozen

.PHONY: format
format:
	uv run ruff check --fix
	uv run ruff format

.PHONY: check
check:
	uv run ruff check
	uv run ruff format --check
	uv run pyright

.PHONY: test
test:
	uv run pytest tests -vv

.PHONY: build
build:
	uv run pyinstaller kimi.spec

include src/kimi_cli/deps/Makefile
