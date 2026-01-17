# Error Handling for Decoding

## Error handling when decoding user-provided content

**Scope**

All Python files inside `src/gitrekt_cli/tools/` except for the `load_desc` function.

**Requirements**

When decoding user-provided content, for example, reading files, decoding subprocess output, etc., `errors="replace"` must be specified to avoid runtime panics due to malformed UTF-8 sequences.

Writing files and encoding Python strings to bytes do not require `errors="replace"`.

<examples>
```python
subprocess.run(..., encoding="utf-8", errors="replace")  # Correct: replaces undecodable bytes
aiofiles.open(..., encoding="utf-8", errors="replace")  # Correct: replaces undecodable bytes
```
</examples>
