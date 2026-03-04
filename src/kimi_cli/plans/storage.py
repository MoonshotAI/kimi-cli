"""
Plan persistence system for saving and loading plans.

This module provides the PlanStorage class for persisting plans to disk
and retrieving them later.
"""

import json
import re
import uuid
from pathlib import Path
from datetime import datetime
from typing import Optional, Tuple, List

from .models import Plan, PlanOption, PlanExecution


class PlanStorage:
    """Save and load plans from disk."""
    
    DIR = Path.home() / ".kimi" / "plans"
    
    def __init__(self):
        self.DIR.mkdir(parents=True, exist_ok=True)
    
    def save(self, plan: Plan) -> str:
        """Save plan to disk, return plan ID.
        
        Filename format: {timestamp}_{query_slug}.json
        Example: 20240304_153045_add_authentication.json
        
        Args:
            plan: Plan to save
            
        Returns:
            str: Plan ID (filename without extension)
        """
        # Generate filename from timestamp and query slug
        timestamp = plan.created_at.strftime("%Y%m%d_%H%M%S")
        query_slug = self._slugify(plan.query)
        plan_id = f"{timestamp}_{query_slug}"
        
        # Serialize Plan to JSON
        data = self._plan_to_dict(plan)
        
        # Save to DIR
        filepath = self.DIR / f"{plan_id}.json"
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        
        # Return ID
        return plan_id
    
    def load(self, plan_id: str) -> Optional[Plan]:
        """Load plan by ID.
        
        Args:
            plan_id: Plan ID (filename without .json)
            
        Returns:
            Plan or None if not found
        """
        filepath = self.DIR / f"{plan_id}.json"
        
        if not filepath.exists():
            return None
        
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            # Deserialize to Plan object
            return self._plan_from_dict(data)
        except (json.JSONDecodeError, KeyError, ValueError):
            return None
    
    def list(self) -> List[Tuple[str, str, datetime]]:
        """List saved plans.
        
        Returns:
            list of (id, query, created_at) tuples, sorted by date desc
        """
        plans = []
        
        # Scan DIR for *.json files
        for filepath in self.DIR.glob("*.json"):
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                
                plan_id = filepath.stem
                query = data.get("query", "Unknown")
                created_at_str = data.get("created_at", "")
                created_at = datetime.fromisoformat(created_at_str) if created_at_str else datetime.min
                
                plans.append((plan_id, query, created_at))
            except (json.JSONDecodeError, KeyError, ValueError):
                # Skip corrupted files
                continue
        
        # Sort by created_at descending
        plans.sort(key=lambda x: x[2], reverse=True)
        
        return plans
    
    def delete(self, plan_id: str) -> bool:
        """Delete plan by ID.
        
        Returns:
            True if deleted, False if not found
        """
        filepath = self.DIR / f"{plan_id}.json"
        
        if not filepath.exists():
            return False
        
        try:
            filepath.unlink()
            return True
        except OSError:
            return False
    
    def get_last(self) -> Optional[Plan]:
        """Get most recent plan."""
        # Find newest file by mtime
        json_files = list(self.DIR.glob("*.json"))
        
        if not json_files:
            return None
        
        # Sort by modification time descending
        newest_file = max(json_files, key=lambda p: p.stat().st_mtime)
        
        # Load and return
        plan_id = newest_file.stem
        return self.load(plan_id)
    
    def _slugify(self, text: str) -> str:
        """Convert text to filename-safe slug.
        
        Args:
            text: Input text to slugify
            
        Returns:
            Filename-safe slug string
        """
        # Remove special chars, replace spaces with underscores
        # Keep only alphanumeric, spaces, and underscores
        slug = re.sub(r'[^\w\s-]', '', text.lower())
        slug = re.sub(r'[-\s]+', '_', slug)
        
        # Truncate to reasonable length (50 chars)
        slug = slug[:50]
        
        # Remove trailing underscores
        slug = slug.rstrip('_')
        
        return slug or "plan"
    
    def _plan_to_dict(self, plan: Plan) -> dict:
        """Serialize Plan to dict for JSON.
        
        Args:
            plan: Plan to serialize
            
        Returns:
            Dictionary representation of the plan
        """
        return {
            "id": plan.id,
            "query": plan.query,
            "created_at": plan.created_at.isoformat(),
            "context_snapshot": plan.context_snapshot,
            "options": [
                {
                    "id": option.id,
                    "title": option.title,
                    "description": option.description,
                    "pros": option.pros,
                    "cons": option.cons,
                    "estimated_time": option.estimated_time,
                    "approach_type": option.approach_type
                }
                for option in plan.options
            ]
        }
    
    def _plan_from_dict(self, data: dict) -> Plan:
        """Deserialize Plan from dict.
        
        Args:
            data: Dictionary containing plan data
            
        Returns:
            Deserialized Plan object
        """
        options = [
            PlanOption(
                id=opt["id"],
                title=opt["title"],
                description=opt["description"],
                pros=opt["pros"],
                cons=opt["cons"],
                estimated_time=opt.get("estimated_time"),
                approach_type=opt["approach_type"]
            )
            for opt in data.get("options", [])
        ]
        
        return Plan(
            id=data["id"],
            query=data["query"],
            options=options,
            created_at=datetime.fromisoformat(data["created_at"]),
            context_snapshot=data.get("context_snapshot", {})
        )
