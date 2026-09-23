"""Data models for Rules system."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal


@dataclass(frozen=True, slots=True)
class RuleMetadata:
    """Rule 文件的 YAML frontmatter 元数据"""

    name: str | None = None  # 规则显示名称
    description: str | None = None  # 规则描述
    paths: list[str] = field(default_factory=list)  # 匹配的文件路径 glob 模式
    priority: int = 100  # 优先级（数值越小越优先）
    extends: list[str] = field(default_factory=list)  # 继承的其他规则


@dataclass(frozen=True, slots=True)
class Rule:
    """单个 Rule 定义"""

    id: str  # 唯一标识符（如 "common/coding-style"）
    name: str  # 显示名称
    description: str  # 描述
    source: Path  # 文件路径
    level: Literal["builtin", "user", "project"]  # 层级
    category: str  # 分类（如 "common", "python"）
    metadata: RuleMetadata  # 元数据
    content: str  # 规则内容（不含 frontmatter）

    @property
    def full_id(self) -> str:
        """返回包含层级的完整 ID"""
        return f"{self.level}/{self.id}"


@dataclass
class RuleState:
    """Rule 开关状态（持久化到 rules.state.toml）"""

    enabled: bool = True  # 是否启用
    pinned: bool = False  # 是否固定（不受自动检测影响）
    last_modified: str | None = None  # 最后修改时间 ISO 格式
    level: Literal["builtin", "user", "project"] | None = None  # 规则来源层级

    def to_dict(self) -> dict:
        """转换为字典用于序列化（不包含 level，因为 level 决定保存位置而非内容）"""
        result: dict = {"enabled": self.enabled}
        if self.pinned:
            result["pinned"] = True
        if self.last_modified:
            result["last_modified"] = self.last_modified
        return result

    @classmethod
    def from_dict(cls, data: dict) -> RuleState:
        """从字典反序列化"""
        return cls(
            enabled=data.get("enabled", True),
            pinned=data.get("pinned", False),
            last_modified=data.get("last_modified"),
            level=data.get("level"),  # May be None for legacy states
        )


@dataclass
class RulesStats:
    """Rules 统计信息"""

    total: int = 0
    enabled: int = 0
    builtin: int = 0
    user: int = 0
    project: int = 0
