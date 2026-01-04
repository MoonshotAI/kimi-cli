from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field


class DockerConfig(BaseModel):

    base_image_template: str = Field(
        default=(
            "sweb.eval.x86_64.{repo}_{version}_{name}:latest"
        ),
        description="Template for Docker image name",
    )
    use_gpu: bool = Field(default=False, description="Enable GPU support")
    remote_runtime_resource_factor: int = Field(
        default=1, description="Resource factor for remote runtime"
    )


class KimiCliConfig(BaseModel):

    model: str = Field(default="", description="Model name to use")
    api_key: str | None = Field(default=None, description="API key")
    base_url: str | None = Field(default=None, description="Base URL for API")
    temperature: float = Field(default=1.0, description="Temperature for LLM")
    top_p: float = Field(default=1.0, description="Top-p for sampling")
    max_output_tokens: int = Field(default=8192, description="Max output tokens")
    debug: bool = Field(default=False, description="Debug mode")


class EvalConfig(BaseModel):

    # Dataset
    dataset_path: str = Field(description="Path to SWE-Bench dataset")
    split: str = Field(default="train", description="Dataset split to use")
    selected_ids: list[str] = Field(
        default_factory=list, description="Specific instance IDs to evaluate"
    )

    # Output
    output_dir: str = Field(description="Output directory for results")
    eval_output_dir: str | None = Field(
        default=None, description="Evaluation output directory (auto-generated if None)"
    )

    # Timing
    timeout_seconds: int = Field(default=12 * 3600, description="Timeout per instance")
    max_workers: int = Field(default=1, description="Number of parallel workers")

    # Docker
    docker: DockerConfig = Field(default_factory=DockerConfig)

    # Kimi CLI
    kimi: KimiCliConfig = Field(default_factory=KimiCliConfig)

    # Instance
    max_iterations: int = Field(default=100, description="Max iterations per instance")

    class Config:
        """Pydantic config."""

        extra = "allow"  # Allow extra fields for forward compatibility

    @classmethod
    def from_file(cls, path: Path | str) -> EvalConfig:
        path = Path(path)
        if not path.exists():
            raise FileNotFoundError(f"Config file not found: {path}")

        content = path.read_text()

        if path.suffix == ".toml":
            try:
                import tomllib
            except ImportError:
                import tomli as tomllib  # type: ignore
            data = tomllib.loads(content)
        elif path.suffix == ".json":
            data = json.loads(content)
        elif path.suffix in {".yaml", ".yml"}:
            data = yaml.safe_load(content)
        else:
            raise ValueError(f"Unsupported config file format: {path.suffix}")

        if "evaluation" in data:
            data = data["evaluation"]

        return cls(**data)

    def to_file(self, path: Path | str, format: str = "toml") -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)

        config_dict = self.model_dump(exclude_none=True)

        if format == "toml":
            try:
                import tomli_w

                path.write_text(tomli_w.dumps({"evaluation": config_dict}))
            except ImportError:
                raise ImportError("tomli-w is required for TOML output")
        elif format == "json":
            path.write_text(json.dumps(config_dict, indent=2))
        elif format in {"yaml", "yml"}:
            path.write_text(yaml.dump({"evaluation": config_dict}, default_flow_style=False))
        else:
            raise ValueError(f"Unsupported format: {format}")


@dataclass
class RuntimeConfig:

    instance_id: str
    base_commit: str
    before_repo_set_cmd: str = ""
    work_dir: str = "/testbed"
    working_dir: str = "/testbed"

    def to_dict(self) -> dict[str, Any]:
        return {
            "instance_id": self.instance_id,
            "base_commit": self.base_commit,
            "before_repo_set_cmd": self.before_repo_set_cmd,
            "work_dir": self.work_dir,
            "working_dir": self.working_dir,
        }

