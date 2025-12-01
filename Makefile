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
