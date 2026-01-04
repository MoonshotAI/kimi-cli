import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from kimi_cli.utils.logging import logger


class EvalRunLogger:
    def __init__(self, output_dir: str, model: str):
        self.output_dir = Path(output_dir)
        self.model = model
        self.timestamp = datetime.now().isoformat()
        self.run_id = datetime.now().strftime("%Y%m%d_%H%M%S")
        
        self.run_dir = self.output_dir / f"{self.model}_{self.run_id}"
        self.run_dir.mkdir(parents=True, exist_ok=True)
        
        self.metadata_file = self.run_dir / "metadata.json"
        self.instance_logs_dir = self.run_dir / "instances"
        self.instance_logs_dir.mkdir(exist_ok=True)
        
        self._write_metadata()
    
    def _write_metadata(self) -> None:
        metadata = {
            "run_id": self.run_id,
            "model": self.model,
            "timestamp": self.timestamp,
            "run_dir": str(self.run_dir),
        }
        with open(self.metadata_file, "w") as f:
            json.dump(metadata, f, indent=2)
        logger.info(f"Run directory: {self.run_dir}")
    
    def log_instance_interaction(
        self, instance_id: str, round_num: int, role: str, content: str
    ) -> None:
        """Log a single interaction (input/output) for an instance.
        
        Args:
            instance_id: The SWE-Bench instance ID
            round_num: The interaction round number
            role: Either "user" or "assistant"
            content: The message content
        """
        instance_file = self.instance_logs_dir / f"{instance_id}.jsonl"
        
        interaction = {
            "timestamp": datetime.now().isoformat(),
            "round": round_num,
            "role": role,
            "content": content,
        }
        
        with open(instance_file, "a") as f:
            f.write(json.dumps(interaction, ensure_ascii=False) + "\n")
    
    def log_instance_summary(
        self, instance_id: str, status: str, metadata: dict[str, Any] | None = None
    ) -> None:
        """Log the final summary for an instance.
        
        Args:
            instance_id: The SWE-Bench instance ID
            status: Final status (e.g., "success", "error", "timeout")
            metadata: Additional metadata to record
        """
        summary_file = self.run_dir / "summary.jsonl"
        
        summary = {
            "timestamp": datetime.now().isoformat(),
            "instance_id": instance_id,
            "status": status,
            **(metadata or {}),
        }
        
        with open(summary_file, "a") as f:
            f.write(json.dumps(summary, ensure_ascii=False) + "\n")
    
    def get_run_info(self) -> dict[str, str]:
        """Get information about this run."""
        return {
            "run_id": self.run_id,
            "model": self.model,
            "timestamp": self.timestamp,
            "run_dir": str(self.run_dir),
        }

