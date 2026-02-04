use serde_json::Value;

/// Expand local `$ref` entries in a JSON Schema without infinite recursion.
pub fn deref_json_schema(schema: &Value) -> Value {
    let mut full = schema.clone();
    let root = full.clone();
    let resolved = traverse(&mut full, &root);
    let mut cleaned = resolved;
    if let Value::Object(map) = &mut cleaned {
        map.remove("$defs");
        map.remove("definitions");
    }
    cleaned
}

fn resolve_pointer(root: &Value, pointer: &str) -> Option<Value> {
    let mut current = root;
    let trimmed = pointer.trim_start_matches('#').trim_start_matches('/');
    if trimmed.is_empty() {
        return Some(root.clone());
    }
    for part in trimmed.split('/') {
        match current {
            Value::Object(map) => {
                current = map.get(part)?;
            }
            _ => return None,
        }
    }
    Some(current.clone())
}

fn traverse(node: &mut Value, root: &Value) -> Value {
    match node {
        Value::Object(map) => {
            if let Some(Value::String(ref_path)) = map.get("$ref") {
                if ref_path.starts_with('#') {
                    if let Some(target) = resolve_pointer(root, ref_path) {
                        let mut resolved = target;
                        resolved = traverse(&mut resolved, root);
                        if let Value::Object(_) = resolved {
                            map.remove("$ref");
                            if let Value::Object(target_map) = resolved {
                                for (k, v) in target_map {
                                    map.insert(k, v);
                                }
                            }
                            return Value::Object(map.clone());
                        }
                    }
                }
            }
            let keys: Vec<String> = map.keys().cloned().collect();
            for key in keys {
                if let Some(mut value) = map.remove(&key) {
                    let new_value = traverse(&mut value, root);
                    map.insert(key, new_value);
                }
            }
            Value::Object(map.clone())
        }
        Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for mut item in items.clone() {
                out.push(traverse(&mut item, root));
            }
            Value::Array(out)
        }
        _ => node.clone(),
    }
}
