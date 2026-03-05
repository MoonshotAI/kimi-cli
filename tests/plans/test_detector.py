"""Tests for plans.detector module."""

import pytest

from kimi_cli.plans.detector import ComplexityDetector, ComplexityScore


class TestComplexityScore:
    """Tests for ComplexityScore dataclass."""

    def test_create_complexity_score(self):
        """Test creating a ComplexityScore."""
        score = ComplexityScore(
            total=75,
            factors={"file_count": 30, "keywords": 20},
            should_plan=True,
        )
        
        assert score.total == 75
        assert score.factors == {"file_count": 30, "keywords": 20}
        assert score.should_plan is True

    def test_complexity_score_low(self):
        """Test low complexity score."""
        score = ComplexityScore(
            total=25,
            factors={"file_count": 15},
            should_plan=False,
        )
        
        assert score.total == 25
        assert score.should_plan is False

    def test_complexity_score_empty_factors(self):
        """Test ComplexityScore with empty factors."""
        score = ComplexityScore(
            total=0,
            factors={},
            should_plan=False,
        )
        
        assert score.total == 0
        assert score.factors == {}
        assert score.should_plan is False


class TestComplexityDetector:
    """Tests for ComplexityDetector class."""

    def test_detector_threshold(self):
        """Test that detector has correct threshold."""
        detector = ComplexityDetector()
        assert detector.THRESHOLD == 60

    def test_detector_weights(self):
        """Test that detector has expected weights."""
        detector = ComplexityDetector()
        assert "file_count" in detector.WEIGHTS
        assert "keywords" in detector.WEIGHTS
        assert "explicit_plan" in detector.WEIGHTS
        assert detector.WEIGHTS["file_count"] == 30
        assert detector.WEIGHTS["keywords"] == 20

    def test_detector_keywords(self):
        """Test that detector has complex keywords defined."""
        detector = ComplexityDetector()
        assert "refactor" in detector.COMPLEX_KEYWORDS
        assert "redesign" in detector.COMPLEX_KEYWORDS
        assert "rewrite" in detector.COMPLEX_KEYWORDS
        assert "migrate" in detector.COMPLEX_KEYWORDS

    def test_analyze_simple_request_no_files(self):
        """Test analyze with simple request and no files."""
        detector = ComplexityDetector()
        score = detector.analyze("fix typo", [], [])
        
        assert score.total == 0
        assert score.factors == {}
        assert score.should_plan is False

    def test_analyze_simple_request_few_files(self):
        """Test analyze with simple request and few files."""
        detector = ComplexityDetector()
        score = detector.analyze("update docs", ["README.md", "CHANGELOG.md"], [])
        
        # 2 files = partial file_count credit (15 pts)
        assert score.total == 15
        assert "file_count" in score.factors
        assert score.should_plan is False

    def test_analyze_simple_request_three_files(self):
        """Test analyze with 3 files gets partial credit."""
        detector = ComplexityDetector()
        score = detector.analyze(
            "update config",
            ["a.py", "b.py", "c.py"],
            []
        )
        
        # 3 files = 15 points (partial credit)
        assert score.total == 15
        assert score.factors["file_count"] == 15
        assert score.should_plan is False

    def test_analyze_many_files(self):
        """Test analyze with many files triggers file_count factor."""
        detector = ComplexityDetector()
        files = ["a.py", "b.py", "c.py", "d.py", "e.py"]
        score = detector.analyze("update code", files, [])
        
        assert "file_count" in score.factors
        assert score.factors["file_count"] == 30
        assert score.should_plan is False  # 30 < 60

    def test_analyze_refactor_keyword(self):
        """Test analyze detects refactor keyword."""
        detector = ComplexityDetector()
        score = detector.analyze("refactor authentication module", [], [])
        
        assert "keywords" in score.factors
        assert score.factors["keywords"] == 20
        assert score.should_plan is False  # 20 < 60

    def test_analyze_multiple_keywords(self):
        """Test analyze with multiple complex keywords."""
        detector = ComplexityDetector()
        score = detector.analyze(
            "refactor and redesign the codebase",
            [],
            []
        )
        
        assert "keywords" in score.factors
        # 2 keywords * 20 = 40, but capped at 40 (2x weight)
        assert score.factors["keywords"] == 40
        assert score.should_plan is False  # 40 < 60 (no security keyword here)

    def test_analyze_redesign_keyword(self):
        """Test analyze detects redesign keyword."""
        detector = ComplexityDetector()
        score = detector.analyze("redesign the API", [], [])
        
        assert "keywords" in score.factors
        assert score.factors["keywords"] == 20

    def test_analyze_rewrite_keyword(self):
        """Test analyze detects rewrite keyword."""
        detector = ComplexityDetector()
        score = detector.analyze("rewrite the module", [], [])
        
        assert "keywords" in score.factors
        assert score.factors["keywords"] == 20

    def test_analyze_migrate_keyword(self):
        """Test analyze detects migrate keyword."""
        detector = ComplexityDetector()
        score = detector.analyze("migrate to new version", [], [])
        
        assert "keywords" in score.factors
        assert score.factors["keywords"] == 20

    def test_analyze_complex_request_high_score(self):
        """Test analyze with complex request gets high score."""
        detector = ComplexityDetector()
        score = detector.analyze(
            "refactor authentication system",
            ["auth.py", "models.py", "views.py", "tests.py"],
            []
        )
        
        # file_count (30) + keywords (20) + security (20) = 70
        assert score.total >= 60
        assert score.should_plan is True
        assert "file_count" in score.factors
        assert "keywords" in score.factors

    def test_analyze_explicit_plan_keyword(self):
        """Test analyze detects explicit plan keyword."""
        detector = ComplexityDetector()
        score = detector.analyze("create a plan for new feature", [], [])
        
        assert "explicit_plan" in score.factors
        assert score.factors["explicit_plan"] == 40

    def test_analyze_plan_keyword_alone(self):
        """Test analyze detects 'plan' keyword."""
        detector = ComplexityDetector()
        score = detector.analyze("plan the architecture", [], [])
        
        assert "explicit_plan" in score.factors
        assert score.factors["explicit_plan"] == 40

    def test_analyze_new_architecture_keyword(self):
        """Test analyze detects new architecture keywords."""
        detector = ComplexityDetector()
        score = detector.analyze("design new architecture for the system", [], [])
        
        assert "new_architecture" in score.factors
        assert score.factors["new_architecture"] == 20

    def test_analyze_design_pattern_keyword(self):
        """Test analyze detects design pattern keyword."""
        detector = ComplexityDetector()
        score = detector.analyze("implement design pattern", [], [])
        
        assert "new_architecture" in score.factors
        assert score.factors["new_architecture"] == 20

    def test_analyze_breaking_changes_keyword(self):
        """Test analyze detects breaking changes keywords."""
        detector = ComplexityDetector()
        score = detector.analyze("this is a breaking change", [], [])
        
        assert "breaking_changes" in score.factors
        assert score.factors["breaking_changes"] == 25

    def test_analyze_backward_incompatible_keyword(self):
        """Test analyze detects backward incompatible keyword."""
        detector = ComplexityDetector()
        score = detector.analyze("make backward incompatible changes", [], [])
        
        assert "breaking_changes" in score.factors
        assert score.factors["breaking_changes"] == 25

    def test_analyze_security_keyword(self):
        """Test analyze detects security keywords."""
        detector = ComplexityDetector()
        score = detector.analyze("fix security vulnerability", [], [])
        
        assert "security" in score.factors
        assert score.factors["security"] == 20

    def test_analyze_auth_keyword(self):
        """Test analyze detects auth keyword."""
        detector = ComplexityDetector()
        score = detector.analyze("update auth system", [], [])
        
        assert "security" in score.factors
        assert score.factors["security"] == 20

    def test_analyze_authentication_keyword(self):
        """Test analyze detects authentication keyword."""
        detector = ComplexityDetector()
        score = detector.analyze("implement authentication", [], [])
        
        assert "security" in score.factors
        assert score.factors["security"] == 20

    def test_analyze_authorization_keyword(self):
        """Test analyze detects authorization keyword."""
        detector = ComplexityDetector()
        score = detector.analyze("add authorization checks", [], [])
        
        assert "security" in score.factors
        assert score.factors["security"] == 20

    def test_analyze_encrypt_keyword(self):
        """Test analyze detects encrypt keyword."""
        detector = ComplexityDetector()
        score = detector.analyze("encrypt sensitive data", [], [])
        
        assert "security" in score.factors
        assert score.factors["security"] == 20

    def test_analyze_cross_module(self):
        """Test analyze detects cross-module changes."""
        detector = ComplexityDetector()
        files = ["src/api.py", "tests/test_api.py", "docs/api.md"]
        score = detector.analyze("update API", files, [])
        
        assert "cross_module" in score.factors
        assert score.factors["cross_module"] == 15
        assert score.should_plan is False  # 15 < 60

    def test_analyze_cross_module_same_dir(self):
        """Test analyze doesn't flag same directory as cross-module."""
        detector = ComplexityDetector()
        files = ["src/a.py", "src/b.py", "src/c.py"]
        score = detector.analyze("update files", files, [])
        
        assert "cross_module" not in score.factors

    def test_analyze_explicit_plan_with_files(self):
        """Test explicit plan + 3 files = below threshold."""
        detector = ComplexityDetector()
        score = detector.analyze(
            "create a plan for feature X",
            ["a.py", "b.py", "c.py"],
            []
        )
        
        # explicit_plan (40) + file_count (15) = 55
        assert "explicit_plan" in score.factors
        assert "file_count" in score.factors
        assert score.total == 55
        assert score.should_plan is False

    def test_analyze_explicit_plan_with_many_files(self):
        """Test explicit plan + 4 files = above threshold."""
        detector = ComplexityDetector()
        score = detector.analyze(
            "create a plan for feature X",
            ["a.py", "b.py", "c.py", "d.py"],
            []
        )
        
        # explicit_plan (40) + file_count (30) = 70
        assert score.total == 70
        assert score.should_plan is True

    def test_analyze_combined_factors(self):
        """Test analyze with multiple factors combined."""
        detector = ComplexityDetector()
        score = detector.analyze(
            "refactor auth system with new architecture",
            ["a.py", "b.py", "c.py", "d.py"],
            []
        )
        
        # file_count (30) + keywords (20) + security (20) + new_architecture (20) = 90
        assert score.total >= 60
        assert score.should_plan is True
        assert "file_count" in score.factors
        assert "keywords" in score.factors
        assert "security" in score.factors
        assert "new_architecture" in score.factors

    def test_analyze_case_insensitive(self):
        """Test analyze is case insensitive."""
        detector = ComplexityDetector()
        score = detector.analyze("REFACTOR the CODE", [], [])
        
        assert "keywords" in score.factors
        assert score.factors["keywords"] == 20

    def test_analyze_overhaul_keyword(self):
        """Test analyze detects overhaul keyword."""
        detector = ComplexityDetector()
        score = detector.analyze("overhaul the system", [], [])
        
        assert "keywords" in score.factors
        assert score.factors["keywords"] == 20

    def test_analyze_api_change_keyword(self):
        """Test analyze detects api change keyword."""
        detector = ComplexityDetector()
        score = detector.analyze("make api change", [], [])
        
        assert "keywords" in score.factors
        assert score.factors["keywords"] == 20

    def test_analyze_schema_change_keyword(self):
        """Test analyze detects schema change keyword."""
        detector = ComplexityDetector()
        score = detector.analyze("perform schema change", [], [])
        
        assert "keywords" in score.factors
        assert score.factors["keywords"] == 20

    def test_analyze_rearchitecture_keyword(self):
        """Test analyze detects rearchitecture keyword."""
        detector = ComplexityDetector()
        score = detector.analyze("rearchitecture needed", [], [])
        
        assert "keywords" in score.factors
        assert score.factors["keywords"] == 20

    def test_analyze_new_system_keyword(self):
        """Test analyze detects new system keyword."""
        detector = ComplexityDetector()
        score = detector.analyze("build new system", [], [])
        
        assert "new_architecture" in score.factors
        assert score.factors["new_architecture"] == 20

    def test_analyze_remove_keyword(self):
        """Test analyze detects remove keyword for breaking changes."""
        detector = ComplexityDetector()
        score = detector.analyze("remove deprecated methods", [], [])
        
        assert "breaking_changes" in score.factors
        assert score.factors["breaking_changes"] == 25
