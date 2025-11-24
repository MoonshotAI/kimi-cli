# Contributing to Kimi CLI

Thank you for being interested in contributing to Kimi CLI!

We welcome all kinds of contributions, including bug fixes, features, document improvements, typo fixes, etc. To maintain a high-quality codebase and user experience, we provide the following guidelines for contributions:

1. We only merge pull requests that aligns with our roadmap. For any pull request that introduces changes larger than 100 lines of code, we highly recommend discussing with us by [raising an issue](https://github.com/MoonshotAI/kimi-cli/issues) or in an existing issue before you start working on it. Otherwise your pull request may be closed or ignored without review.
2. We insist on high code quality. Please ensure your code is as good as, if not better than, the code written by frontier coding agents. Changes may be requested before your pull request can be merged.

## Pre-commit hooks

We run formatting and checks locally via [pre-commit](https://pre-commit.com/).

1. Install pre-commit (pick one): `uv tool install pre-commit`, `pipx install pre-commit`, or
   `pip install pre-commit`.
2. Install the hooks in this repo: `pre-commit install`.
3. Optionally run on all files before sending a PR: `pre-commit run --all-files`.

After installation, formatting and checks run on every commit. You can skip for an intermediate
commit with `git commit --no-verify`, or trigger all hooks manually with
`pre-commit run --all-files`.

The hooks execute `make format` and `make check`, so ensure `make prepare` (or `uv sync`) has been
run and dependencies are available locally.
