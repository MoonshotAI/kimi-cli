import re

def filter_binary_diffs(patch: str) -> str:
    lines = patch.split("\n")
    result = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if re.match(r"^Binary files .* differ$", line):
            i += 1
            continue
        if line.startswith("diff --git"):
            j = i + 1
            while j < len(lines) and lines[j].startswith("index "):
                j += 1
            if j < len(lines) and re.match(r"^Binary files .* differ$", lines[j]):
                i = j + 1
                continue
        result.append(line)
        i += 1
    return "\n".join(result)
