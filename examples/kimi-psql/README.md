# kimi-psql

AI-assisted PostgreSQL interactive terminal.

## Features

- **AI Mode** (default): Natural language to SQL - AI executes read-only queries
- **PSQL Mode**: Full interactive psql experience (Ctrl-X to switch)
- **Read-only by design**: AI mode uses read-only transactions for safety

## Usage

```sh
cd examples/kimi-psql
uv sync --reinstall

# Connection URL with password
uv run main.py --conninfo 'postgresql://user:pass@host/db'

# Traditional psql arguments with PGPASSWORD env var
PGPASSWORD=yourpass uv run main.py -h localhost -U postgres -d mydb
```

## Example

```
kimi-psql✨ show all users who registered last month
• Used ExecuteSql ({"sql": "SELECT * FROM users WHERE ..."})

  id | name  | created_at
  ---+-------+------------
  42 | Alice | 2024-11-15

kimi-psql✨ ^X    # Switch to PSQL mode
postgres=# \d users
...
```
