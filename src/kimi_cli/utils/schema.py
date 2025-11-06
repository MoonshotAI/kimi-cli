"""JSON Schema utility functions."""

from copy import deepcopy
from typing import Any


def inline_json_schema_refs(schema: dict[str, Any]) -> dict[str, Any]:
    """
    Inline all $ref references in a JSON Schema.
    
    This is useful for API providers that don't support JSON Schema references.
    For example, the kimi-k2-thinking API returns an error when schemas contain
    $ref and $defs.
    
    Args:
        schema: The JSON Schema dictionary with potential $ref and $defs
        
    Returns:
        A new schema with all references inlined
        
    Example:
        >>> schema = {
        ...     "$defs": {
        ...         "Item": {"type": "object", "properties": {"name": {"type": "string"}}}
        ...     },
        ...     "type": "object",
        ...     "properties": {
        ...         "items": {"type": "array", "items": {"$ref": "#/$defs/Item"}}
        ...     }
        ... }
        >>> inlined = inline_json_schema_refs(schema)
        >>> "$defs" in inlined
        False
        >>> "$ref" in str(inlined)
        False
    """
    defs: dict[str, Any] = schema.get('$defs', {})
    
    def resolve_ref(obj: Any) -> Any:
        """Recursively resolve all $ref in an object."""
        if isinstance(obj, dict):
            if '$ref' in obj:
                ref_path: str = obj['$ref']
                if isinstance(ref_path, str) and ref_path.startswith('#/$defs/'):
                    def_name: str = ref_path.replace('#/$defs/', '')
                    if def_name in defs:
                        return resolve_ref(deepcopy(defs[def_name]))
                return obj
            else:
                return {k: resolve_ref(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [resolve_ref(item) for item in obj]
        else:
            return obj
    
    resolved = resolve_ref(schema)
    

    if isinstance(resolved, dict) and '$defs' in resolved:
        result = dict(resolved)
        del result['$defs']
        return result
    
    return resolved if isinstance(resolved, dict) else schema
