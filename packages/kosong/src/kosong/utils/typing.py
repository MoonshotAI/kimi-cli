from __future__ import annotations

type JsonType = None | int | float | str | bool | list[JsonType] | dict[str, JsonType]
