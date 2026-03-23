from __future__ import annotations

import shutil
from dataclasses import asdict
from pathlib import Path
from typing import Any, cast

from kimi_cli.session import Session
from kimi_cli.subagents.models import AgentInstanceRecord, AgentLaunchSpec, SubagentStatus
from kimi_cli.utils.io import atomic_json_write


def _record_from_dict(data: dict[str, Any]) -> AgentInstanceRecord:
    launch_spec = data["launch_spec"]
    return AgentInstanceRecord(
        agent_id=data["agent_id"],
        subagent_type=data["subagent_type"],
        status=data["status"],
        description=data["description"],
        created_at=data["created_at"],
        updated_at=data["updated_at"],
        last_task_id=data.get("last_task_id"),
        launch_spec=AgentLaunchSpec(**launch_spec),
    )


class SubagentStore:
    def __init__(self, session: Session) -> None:
        self._session = session

    @property
    def root(self) -> Path:
        return self._session.dir / "subagents"

    def instance_dir(self, agent_id: str, *, create: bool = False) -> Path:
        path = self.root / agent_id
        if create:
            path.mkdir(parents=True, exist_ok=True)
        return path

    def context_path(self, agent_id: str) -> Path:
        return self.instance_dir(agent_id) / "context.jsonl"

    def wire_path(self, agent_id: str) -> Path:
        return self.instance_dir(agent_id) / "wire.jsonl"

    def meta_path(self, agent_id: str) -> Path:
        return self.instance_dir(agent_id) / "meta.json"

    def prompt_path(self, agent_id: str) -> Path:
        return self.instance_dir(agent_id) / "prompt.txt"

    def output_path(self, agent_id: str) -> Path:
        return self.instance_dir(agent_id) / "output"

    def create_instance(
        self,
        *,
        agent_id: str,
        description: str,
        launch_spec: AgentLaunchSpec,
    ) -> AgentInstanceRecord:
        self._initialize_instance_files(agent_id)
        record = AgentInstanceRecord(
            agent_id=agent_id,
            subagent_type=launch_spec.subagent_type,
            status="idle",
            description=description,
            created_at=launch_spec.created_at,
            updated_at=launch_spec.created_at,
            last_task_id=None,
            launch_spec=launch_spec,
        )
        self.write_instance(record)
        return record

    def write_instance(self, record: AgentInstanceRecord) -> None:
        instance_dir = self.instance_dir(record.agent_id)
        atomic_json_write(asdict(record), instance_dir / "meta.json")

    def _initialize_instance_files(self, agent_id: str) -> None:
        instance_dir = self.instance_dir(agent_id, create=True)
        (instance_dir / "context.jsonl").touch(exist_ok=True)
        (instance_dir / "wire.jsonl").touch(exist_ok=True)
        (instance_dir / "prompt.txt").touch(exist_ok=True)
        (instance_dir / "output").touch(exist_ok=True)

    def get_instance(self, agent_id: str) -> AgentInstanceRecord | None:
        meta = self.meta_path(agent_id)
        if not meta.exists():
            return None
        import json

        return _record_from_dict(json.loads(meta.read_text(encoding="utf-8")))

    def require_instance(self, agent_id: str) -> AgentInstanceRecord:
        record = self.get_instance(agent_id)
        if record is None:
            raise FileNotFoundError(f"Subagent instance not found: {agent_id}")
        return record

    def update_instance(
        self,
        agent_id: str,
        *,
        status: SubagentStatus | None = None,
        description: str | None = None,
        last_task_id: str | None | object = ...,
    ) -> AgentInstanceRecord:
        import time

        current = self.require_instance(agent_id)
        record = AgentInstanceRecord(
            agent_id=current.agent_id,
            subagent_type=current.subagent_type,
            status=current.status if status is None else status,
            description=current.description if description is None else description,
            created_at=current.created_at,
            updated_at=time.time(),
            last_task_id=(
                current.last_task_id if last_task_id is ... else cast(str | None, last_task_id)
            ),
            launch_spec=current.launch_spec,
        )
        self.write_instance(record)
        return record

    def list_instances(self) -> list[AgentInstanceRecord]:
        records: list[AgentInstanceRecord] = []
        if not self.root.exists():
            return records
        for path in self.root.iterdir():
            if not path.is_dir():
                continue
            meta = path / "meta.json"
            if not meta.exists():
                continue
            import json

            records.append(_record_from_dict(json.loads(meta.read_text(encoding="utf-8"))))
        records.sort(key=lambda record: record.updated_at, reverse=True)
        return records

    def delete_instance(self, agent_id: str) -> None:
        instance_dir = self.instance_dir(agent_id)
        if not instance_dir.exists():
            return
        shutil.rmtree(instance_dir)
