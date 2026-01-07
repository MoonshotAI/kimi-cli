# TODO: message format
import json
from datetime import datetime
from pathlib import Path

class EvalRunLogger:
    def __init__(self, output_dir: str, model: str):
        self.output_dir = Path(output_dir)
        self.model = model
        self.timestamp = datetime.now().isoformat()
        
        self.run_id = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.run_dir = self.output_dir / f"{self.model}_{self.run_id}"
        self.run_dir.mkdir(parents=True, exist_ok=True)
        
        self.metadata_file = self.run_dir / "metadata.json"
    
        metadata = {
            "run_id": self.run_id,
            "model": self.model,
            "timestamp": self.timestamp,
            "run_dir": str(self.run_dir),
        }
        with open(self.metadata_file, "w") as f:
            json.dump(metadata, f, indent=2)
    
    
    def log_instance_summary(self, instance_id, status, metadata = None):
        summary_file = self.run_dir / "summary.jsonl"
        summary = {
            "timestamp": datetime.now().isoformat(),
            "instance_id": instance_id,
            "status": status,
            **(metadata or {}),
        }
        with open(summary_file, "a") as f:
            f.write(json.dumps(summary, ensure_ascii=False) + "\n")