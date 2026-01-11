import re

def _get_evaluator_map():
    from benchmarking.benchmarks.swebench.run_infer import SWEBenchInstanceEvaluator
    from benchmarking.benchmarks.nl2repo.run_infer import NL2RepoInstanceEvaluator
    return {
        "swebench": SWEBenchInstanceEvaluator,
        "nl2repo": NL2RepoInstanceEvaluator,
    }

EVALUATOR_MAP = None 

def get_evaluator_map():
    global EVALUATOR_MAP
    if EVALUATOR_MAP is None:
        EVALUATOR_MAP = _get_evaluator_map()
    return EVALUATOR_MAP

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
