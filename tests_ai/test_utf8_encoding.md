# UTF-8 Encoding and Decoding

## Explicit UTF-8 encoding

**Scope**

All Python files inside `src/kimi_cli/`.

**Requirements**

When reading or writing files, encoding or decoding text, `encoding="utf-8"` must be explicitly specified.

<examples>
```python
text.encode()  # Incorrect: relies on default encoding
path.read_text(encoding="utf-8")  # Correct: explicitly specifies UTF-8
with open(file, "r", encoding="utf-8") as f:  # Correct
with aiofiles.open(file, "w", encoding="utf-8") as f:  # Correct
process.output.decode() # Incorrect: relies on default encoding
```
</examples>
