# type: ignore
from pydantic import BaseModel, Field

class EvalConfig(BaseModel):
    api_key: str = Field(description="API key")
    base_url: str = Field(description="Base URL")
    model: str = Field(description="Model name")
    max_context_size: int = Field(default=131072, description="Max context size")
    temperature: float = Field(default=1.0, description="Temperature for LLM")
    top_p: float = Field(default=1.0, description="Top-p for sampling")
    max_tokens: int = Field(default=8192, description="Max output tokens")
    debug: bool = Field(default=False, description="Debug mode")
    dataset_path: str = Field(description="Path to dataset")
    split: str = Field(default="train", description="Dataset split to use")
    selected_ids: list[str] = Field(
        default_factory=list, description="Specific instance IDs to evaluate"
    )
    output_dir: str = Field(description="Output directory for results")
    timeout_seconds: int = Field(default=12 * 3600, description="Timeout per instance")
    max_workers: int = Field(default=1, description="Number of parallel workers")
    use_gpu: bool = Field(default=False, description="Enable GPU support")
    max_iterations: int = Field(default=100, description="Max iterations per instance")
    max_retries: int = Field(default=3, description="Max retries for failed instances")


@dataclass
class EvalResult:
    instance_id: str
    status: str
    git_patch: str = ""
    messages: list[dict[str, Any]] | None = None
    sub_messages: list[dict[str, Any]] | None = None
    error: str | None = None
    metrics: dict[str, Any] | None = None
    duration_seconds: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "instance_id": self.instance_id,
            "status": self.status,
            "git_patch": self.git_patch,
            "error": self.error,
            "metrics": self.metrics,
            "duration_seconds": self.duration_seconds,
            "messages": self.messages,
            "sub_messages": self.sub_messages,
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict())