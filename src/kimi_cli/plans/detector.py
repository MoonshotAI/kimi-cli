"""Complexity Detector - Determines if a task needs planning."""

from dataclasses import dataclass


@dataclass
class ComplexityScore:
    """Complexity score with breakdown by factor."""
    total: int
    factors: dict[str, int]
    should_plan: bool


class ComplexityDetector:
    """Analyzes user requests to determine if planning is needed."""
    
    THRESHOLD = 60  # Score needed to trigger planning
    
    WEIGHTS = {
        "file_count": 30,      # > 3 files
        "lines_changed": 25,   # > 100 lines
        "keywords": 20,        # refactor, redesign
        "new_architecture": 20,
        "breaking_changes": 25,
        "security": 20,
        "cross_module": 15,
        "explicit_plan": 40,   # User said "plan"
    }
    
    COMPLEX_KEYWORDS = [
        "refactor", "redesign", "rearchitecture",
        "rewrite", "migrate", "overhaul",
        "breaking", "api change", "schema change"
    ]
    
    def analyze(
        self,
        user_request: str,
        predicted_files: list[str],
        predicted_tools: list[str],
    ) -> ComplexityScore:
        """Analyze request complexity and return score.
        
        Args:
            user_request: The user's request text
            predicted_files: List of predicted files to modify
            predicted_tools: List of predicted tools to use
            
        Returns:
            ComplexityScore with total score, factor breakdown, and planning decision
        """
        factors: dict[str, int] = {}
        request_lower = user_request.lower()
        
        # File count factor: > 3 files gets full weight
        if len(predicted_files) > 3:
            factors["file_count"] = self.WEIGHTS["file_count"]
        elif len(predicted_files) > 1:
            # Partial credit for 2-3 files
            factors["file_count"] = self.WEIGHTS["file_count"] // 2
        
        # Keyword factor: +20 per match, capped at weight
        keyword_matches = sum(
            1 for keyword in self.COMPLEX_KEYWORDS
            if keyword in request_lower
        )
        if keyword_matches > 0:
            factors["keywords"] = min(
                keyword_matches * self.WEIGHTS["keywords"],
                self.WEIGHTS["keywords"] * 2  # Cap at 2x weight
            )
        
        # Explicit plan factor: user said "plan" or "create plan"
        if "plan" in request_lower or "create a plan" in request_lower:
            factors["explicit_plan"] = self.WEIGHTS["explicit_plan"]
        
        # New architecture factor
        arch_keywords = ["architecture", "design pattern", "new system"]
        if any(kw in request_lower for kw in arch_keywords):
            factors["new_architecture"] = self.WEIGHTS["new_architecture"]
        
        # Breaking changes factor
        breaking_keywords = ["breaking change", "backward incompatible", "remove"]
        if any(kw in request_lower for kw in breaking_keywords):
            factors["breaking_changes"] = self.WEIGHTS["breaking_changes"]
        
        # Security factor
        security_keywords = ["security", "auth", "authentication", "authorization", "encrypt"]
        if any(kw in request_lower for kw in security_keywords):
            factors["security"] = self.WEIGHTS["security"]
        
        # Cross-module factor: check if files span multiple directories
        if len(predicted_files) > 1:
            dirs = set()
            for f in predicted_files:
                parts = f.split("/")
                if len(parts) > 1:
                    dirs.add(parts[0])
            if len(dirs) > 1:
                factors["cross_module"] = self.WEIGHTS["cross_module"]
        
        # Calculate total score
        total = sum(factors.values())
        
        # Determine if planning is needed
        should_plan = total >= self.THRESHOLD
        
        return ComplexityScore(
            total=total,
            factors=factors,
            should_plan=should_plan
        )


# =============================================================================
# Verification Tests (can be run with: python -m pytest detector.py -v)
# =============================================================================
if __name__ == "__main__":
    detector = ComplexityDetector()
    
    # Test: Simple request
    print("Test 1: Simple request ('fix typo')")
    score = detector.analyze("fix typo", [], [])
    print(f"  Score: {score.total}, Factors: {score.factors}, Should plan: {score.should_plan}")
    assert score.total < 60, f"Expected total < 60, got {score.total}"
    assert not score.should_plan, "Expected should_plan=False"
    print("  ✓ PASSED\n")
    
    # Test: Complex request with keywords and multiple files
    print("Test 2: Complex request ('refactor auth system' with 4 files)")
    score = detector.analyze("refactor auth system", ["a.py", "b.py", "c.py", "d.py"], [])
    print(f"  Score: {score.total}, Factors: {score.factors}, Should plan: {score.should_plan}")
    assert score.total >= 60, f"Expected total >= 60, got {score.total}"
    assert score.should_plan, "Expected should_plan=True"
    print("  ✓ PASSED\n")
    
    # Test: Explicit plan request (40 pts) + files (15 pts) = 55, still below threshold
    print("Test 3: Explicit plan request ('create a plan for feature X') with 3 files")
    score = detector.analyze("create a plan for feature X", ["a.py", "b.py", "c.py"], [])
    print(f"  Score: {score.total}, Factors: {score.factors}, Should plan: {score.should_plan}")
    assert "explicit_plan" in score.factors, "Expected explicit_plan factor"
    assert "file_count" in score.factors, "Expected file_count factor"
    # 40 + 15 = 55, still below threshold of 60
    assert not score.should_plan, "Expected should_plan=False (55 < 60)"
    print("  ✓ PASSED\n")
    
    # Test: Explicit plan request with 4+ files reaches threshold
    print("Test 3b: Explicit plan request with 4 files reaches threshold")
    score = detector.analyze("create a plan for feature X", ["a.py", "b.py", "c.py", "d.py"], [])
    print(f"  Score: {score.total}, Factors: {score.factors}, Should plan: {score.should_plan}")
    assert score.total >= 60, f"Expected total >= 60, got {score.total}"
    assert score.should_plan, "Expected should_plan=True"
    print("  ✓ PASSED\n")
    
    # Test: Security-related request
    print("Test 4: Security request ('fix security vulnerability in auth')")
    score = detector.analyze("fix security vulnerability in auth", ["auth.py"], [])
    print(f"  Score: {score.total}, Factors: {score.factors}, Should plan: {score.should_plan}")
    assert "security" in score.factors, "Expected security factor"
    print("  ✓ PASSED\n")
    
    # Test: Cross-module request
    print("Test 5: Cross-module request (files in multiple dirs)")
    score = detector.analyze("update API", ["src/api.py", "tests/test_api.py", "docs/api.md"], [])
    print(f"  Score: {score.total}, Factors: {score.factors}, Should plan: {score.should_plan}")
    assert "cross_module" in score.factors, "Expected cross_module factor"
    print("  ✓ PASSED\n")
    
    # Test: Borderline case (3 files - partial credit)
    print("Test 6: Borderline case (3 files, no keywords)")
    score = detector.analyze("update config", ["a.py", "b.py", "c.py"], [])
    print(f"  Score: {score.total}, Factors: {score.factors}, Should plan: {score.should_plan}")
    assert score.total == 15, f"Expected total=15 (partial file_count), got {score.total}"
    assert not score.should_plan, "Expected should_plan=False"
    print("  ✓ PASSED\n")
    
    print("=" * 50)
    print("All tests passed! ✓")
