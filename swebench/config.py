# type: ignore
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, Field

class KimiCliConfig(BaseModel):
    model: str = Field(default="", description="Model name to use")
    api_key: str | None = Field(default=None, description="API key")
    base_url: str | None = Field(default=None, description="Base URL for API")
    temperature: float = Field(default=1.0, description="Temperature for LLM")
    top_p: float = Field(default=1.0, description="Top-p for sampling")
    max_output_tokens: int = Field(default=8192, description="Max output tokens")
    debug: bool = Field(default=False, description="Debug mode")


class EvalConfig(BaseModel):
    dataset_path: str = Field(description="Path to SWE-Bench dataset")
    split: str = Field(default="train", description="Dataset split to use")
    selected_ids: list[str] = Field(
        default_factory=list, description="Specific instance IDs to evaluate"
    )
    output_dir: str = Field(description="Output directory for results")
    timeout_seconds: int = Field(default=12 * 3600, description="Timeout per instance")
    max_workers: int = Field(default=1, description="Number of parallel workers")
    use_gpu: bool = Field(default=False, description="Enable GPU support")
    kimi: KimiCliConfig = Field(default_factory=KimiCliConfig)
    max_iterations: int = Field(default=100, description="Max iterations per instance")


@dataclass
class RuntimeConfig:
    instance_id: str
    base_commit: str
    before_repo_set_cmd: str = ""
    working_dir: str = "/testbed"

    def to_dict(self) -> dict[str, Any]:
        return {
            "instance_id": self.instance_id,
            "base_commit": self.base_commit,
            "before_repo_set_cmd": self.before_repo_set_cmd,
            "working_dir": self.working_dir,
        }
