.PHONY: format check test

format:
	uv run ruff check --fix
	uv run ruff format

check:
	uv run ruff check
	uv run ruff format --check
	uv run pyright

test:
	uv run pytest --doctest-modules -vv
