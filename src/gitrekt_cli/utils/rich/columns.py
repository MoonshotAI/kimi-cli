from __future__ import annotations

from rich.columns import Columns
from rich.console import Console, ConsoleOptions, RenderableType, RenderResult
from rich.measure import Measurement
from rich.segment import Segment
from rich.text import Text


class _ShrinkToWidth:
    def __init__(self, renderable: RenderableType, max_width: int) -> None:
        self._renderable = renderable
        self._max_width = max(max_width, 1)

    def __rich_measure__(self, console: Console, options: ConsoleOptions) -> Measurement:
        width = self._resolve_width(options)
        return Measurement(0, width)

    def __rich_console__(self, console: Console, options: ConsoleOptions) -> RenderResult:
        width = self._resolve_width(options)
        child_options = options.update(width=width)
        yield from console.render(self._renderable, child_options)

    def _resolve_width(self, options: ConsoleOptions) -> int:
        return max(1, min(self._max_width, options.max_width))


def _strip_trailing_spaces(segments: list[Segment]) -> list[Segment]:
    lines = list(Segment.split_lines(segments))
    trimmed: list[Segment] = []
    n_lines = len(lines)
    for index, line in enumerate(lines):
        line_segments = list(line)
        while line_segments:
            segment = line_segments[-1]
            if segment.control is not None:
                break
            trimmed_text = segment.text.rstrip(" ")
            if trimmed_text != segment.text:
                if trimmed_text:
                    line_segments[-1] = Segment(trimmed_text, segment.style, segment.control)
                    break
                line_segments.pop()
                continue
            break
        trimmed.extend(line_segments)
        if index != n_lines - 1:
            trimmed.append(Segment.line())
    if trimmed:
        trimmed.append(Segment.line())
    return trimmed


class BulletColumns:
    def __init__(
        self,
        renderable: RenderableType,
        *,
        bullet_style: str | None = None,
        bullet: RenderableType | None = None,
        padding: int = 1,
    ) -> None:
        self._renderable = renderable
        self._bullet = bullet
        self._bullet_style = bullet_style
        self._padding = padding

    def _bullet_renderable(self) -> RenderableType:
        if self._bullet is not None:
            return self._bullet
        return Text("•", style=self._bullet_style or "")

    def _available_width(self, console: Console, options: ConsoleOptions, bullet_width: int) -> int:
        max_width = options.max_width or console.width or (bullet_width + self._padding + 1)
        available = max_width - bullet_width - self._padding
        return max(available, 1)

    def __rich_measure__(self, console: Console, options: ConsoleOptions) -> Measurement:
        bullet = self._bullet_renderable()
        bullet_measure = Measurement.get(console, options, bullet)
        bullet_width = max(bullet_measure.maximum, 1)
        available = self._available_width(console, options, bullet_width)
        constrained = _ShrinkToWidth(self._renderable, available)
        columns = Columns([bullet, constrained], expand=False, padding=(0, self._padding))
        return Measurement.get(console, options, columns)

    def __rich_console__(self, console: Console, options: ConsoleOptions) -> RenderResult:
        bullet = self._bullet_renderable()
        bullet_measure = Measurement.get(console, options, bullet)
        bullet_width = max(bullet_measure.maximum, 1)
        available = self._available_width(console, options, bullet_width)
        columns = Columns(
            [bullet, _ShrinkToWidth(self._renderable, available)],
            expand=False,
            padding=(0, self._padding),
        )
        segments = list(console.render(columns, options))
        trimmed = _strip_trailing_spaces(segments)
        yield from trimmed
