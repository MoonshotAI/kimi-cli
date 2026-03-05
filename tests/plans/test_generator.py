"""Tests for plans.generator module."""

import pytest
import json
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

from kimi_cli.plans.generator import PlanGenerator, PlanGenerationError
from kimi_cli.plans.models import Plan, PlanOption


class TestPlanGenerationError:
    """Tests for PlanGenerationError exception."""

    def test_error_is_exception(self):
        """Test PlanGenerationError is an Exception."""
        error = PlanGenerationError("test error")
        assert isinstance(error, Exception)
        assert str(error) == "test error"


class TestPlanGeneratorInit:
    """Tests for PlanGenerator initialization."""

    def test_init_with_llm(self, mock_llm):
        """Test initialization with LLM."""
        generator = PlanGenerator(llm=mock_llm)
        assert generator._llm is mock_llm

    def test_init_with_none(self):
        """Test initialization with None LLM."""
        generator = PlanGenerator(llm=None)
        assert generator._llm is None


class TestPlanGeneratorGenerate:
    """Tests for PlanGenerator.generate method."""

    @pytest.mark.asyncio
    async def test_generate_raises_without_llm(self):
        """Test generate raises error when LLM is None."""
        generator = PlanGenerator(llm=None)
        
        with pytest.raises(PlanGenerationError, match="LLM not configured"):
            await generator.generate("test request")

    @pytest.mark.asyncio
    async def test_generate_success(self, mock_llm):
        """Test successful plan generation."""
        # Mock the kosong.step function
        mock_result = MagicMock()
        mock_content = MagicMock()
        mock_content.text = json.dumps({
            "options": [
                {
                    "id": 1,
                    "title": "Quick Fix",
                    "description": "Fast solution",
                    "pros": ["Fast"],
                    "cons": ["Technical debt"],
                    "estimated_time": "15 min",
                    "approach_type": "quick",
                },
                {
                    "id": 2,
                    "title": "Proper Solution",
                    "description": "Complete solution",
                    "pros": ["Maintainable"],
                    "cons": ["Slow"],
                    "estimated_time": "2 hours",
                    "approach_type": "proper",
                },
            ]
        })
        mock_result.message.content = [mock_content]
        
        with patch("kimi_cli.plans.generator.kosong.step", new_callable=AsyncMock) as mock_step:
            mock_step.return_value = mock_result
            
            generator = PlanGenerator(llm=mock_llm)
            plan = await generator.generate(
                user_request="Implement feature X",
                work_dir="/tmp/project",
                files=["a.py", "b.py"],
                patterns=["mvc"],
            )
        
        assert isinstance(plan, Plan)
        assert plan.query == "Implement feature X"
        assert len(plan.options) == 2
        assert plan.options[0].title == "Quick Fix"
        assert plan.options[1].title == "Proper Solution"
        assert plan.context_snapshot["work_dir"] == "/tmp/project"
        assert plan.context_snapshot["files"] == ["a.py", "b.py"]
        assert plan.context_snapshot["patterns"] == ["mvc"]

    @pytest.mark.asyncio
    async def test_generate_with_empty_files_and_patterns(self, mock_llm):
        """Test generate with empty optional parameters."""
        mock_result = MagicMock()
        mock_content = MagicMock()
        mock_content.text = json.dumps({
            "options": [
                {
                    "id": 1,
                    "title": "Option 1",
                    "description": "Description",
                    "pros": [],
                    "cons": [],
                    "estimated_time": None,
                    "approach_type": "quick",
                },
                {
                    "id": 2,
                    "title": "Option 2",
                    "description": "Description",
                    "pros": [],
                    "cons": [],
                    "estimated_time": None,
                    "approach_type": "proper",
                },
            ]
        })
        mock_result.message.content = [mock_content]
        
        with patch("kimi_cli.plans.generator.kosong.step", new_callable=AsyncMock) as mock_step:
            mock_step.return_value = mock_result
            
            generator = PlanGenerator(llm=mock_llm)
            plan = await generator.generate("test request")
        
        assert isinstance(plan, Plan)
        assert plan.context_snapshot["files"] == []
        assert plan.context_snapshot["patterns"] == []

    @pytest.mark.asyncio
    async def test_generate_llm_failure(self, mock_llm):
        """Test generate handles LLM failure."""
        with patch("kimi_cli.plans.generator.kosong.step", new_callable=AsyncMock) as mock_step:
            mock_step.side_effect = Exception("LLM connection failed")
            
            generator = PlanGenerator(llm=mock_llm)
            
            with pytest.raises(PlanGenerationError, match="LLM call failed"):
                await generator.generate("test request")

    @pytest.mark.asyncio
    async def test_generate_empty_response(self, mock_llm):
        """Test generate handles empty LLM response."""
        mock_result = MagicMock()
        mock_content = MagicMock()
        mock_content.text = ""
        mock_result.message.content = [mock_content]
        
        with patch("kimi_cli.plans.generator.kosong.step", new_callable=AsyncMock) as mock_step:
            mock_step.return_value = mock_result
            
            generator = PlanGenerator(llm=mock_llm)
            
            with pytest.raises(PlanGenerationError, match="empty response"):
                await generator.generate("test request")


class TestPlanGeneratorParseOptions:
    """Tests for PlanGenerator._parse_options method."""

    def test_parse_valid_json(self):
        """Test parsing valid JSON response."""
        generator = PlanGenerator(llm=None)
        
        raw_json = json.dumps({
            "options": [
                {
                    "id": 1,
                    "title": "Quick Fix",
                    "description": "Fast solution",
                    "pros": ["Fast", "Simple"],
                    "cons": ["Debt"],
                    "estimated_time": "15 min",
                    "approach_type": "quick",
                },
                {
                    "id": 2,
                    "title": "Proper",
                    "description": "Good solution",
                    "pros": ["Good"],
                    "cons": ["Slow"],
                    "estimated_time": "2 hours",
                    "approach_type": "proper",
                },
            ]
        })
        
        options = generator._parse_options(raw_json)
        
        assert len(options) == 2
        assert options[0].id == 1
        assert options[0].title == "Quick Fix"
        assert options[0].approach_type == "quick"
        assert options[1].id == 2
        assert options[1].approach_type == "proper"

    def test_parse_json_from_markdown_code_block(self):
        """Test parsing JSON from markdown code block."""
        generator = PlanGenerator(llm=None)
        
        markdown_response = """
Here's the plan:

```json
{
  "options": [
    {
      "id": 1,
      "title": "Quick",
      "description": "Fast",
      "pros": [],
      "cons": [],
      "estimated_time": "5 min",
      "approach_type": "quick"
    },
    {
      "id": 2,
      "title": "Proper",
      "description": "Good",
      "pros": [],
      "cons": [],
      "estimated_time": "1 hour",
      "approach_type": "proper"
    }
  ]
}
```
"""
        
        options = generator._parse_options(markdown_response)
        
        assert len(options) == 2
        assert options[0].title == "Quick"
        assert options[1].title == "Proper"

    def test_parse_json_from_plain_markdown_block(self):
        """Test parsing JSON from plain markdown block."""
        generator = PlanGenerator(llm=None)
        
        markdown_response = """
```
{
  "options": [
    {
      "id": 1,
      "title": "Option 1",
      "description": "Desc",
      "pros": [],
      "cons": [],
      "estimated_time": null,
      "approach_type": "quick"
    },
    {
      "id": 2,
      "title": "Option 2",
      "description": "Desc",
      "pros": [],
      "cons": [],
      "estimated_time": null,
      "approach_type": "proper"
    }
  ]
}
```
"""
        
        options = generator._parse_options(markdown_response)
        
        assert len(options) == 2

    def test_parse_json_from_inline_code(self):
        """Test parsing JSON from inline code."""
        generator = PlanGenerator(llm=None)
        
        inline_response = (
            '`{"options": ['
            '{"id": 1, "title": "Test", "description": "Desc", "pros": [], "cons": [], '
            '"estimated_time": null, "approach_type": "quick"}, '
            '{"id": 2, "title": "Test2", "description": "Desc", "pros": [], "cons": [], '
            '"estimated_time": null, "approach_type": "proper"}]}`'
        )
        
        options = generator._parse_options(inline_response)
        
        assert len(options) == 2
        assert options[0].title == "Test"

    def test_parse_invalid_json(self):
        """Test parsing invalid JSON raises error."""
        generator = PlanGenerator(llm=None)
        
        with pytest.raises(PlanGenerationError, match="Invalid JSON"):
            generator._parse_options("not valid json")

    def test_parse_non_object_response(self):
        """Test parsing non-object JSON response."""
        generator = PlanGenerator(llm=None)
        
        with pytest.raises(PlanGenerationError, match="not a JSON object"):
            generator._parse_options('["option1", "option2"]')

    def test_parse_missing_options_field(self):
        """Test parsing JSON without options field."""
        generator = PlanGenerator(llm=None)
        
        with pytest.raises(PlanGenerationError, match="missing 'options' field"):
            generator._parse_options('{"plans": []}')

    def test_parse_options_not_list(self):
        """Test parsing JSON with non-list options."""
        generator = PlanGenerator(llm=None)
        
        with pytest.raises(PlanGenerationError, match="not a list"):
            generator._parse_options('{"options": "not a list"}')

    def test_parse_insufficient_options(self):
        """Test parsing JSON with fewer than 2 options."""
        generator = PlanGenerator(llm=None)
        
        with pytest.raises(PlanGenerationError, match="at least 2 options"):
            generator._parse_options('{"options": [{"id": 1, "title": "Only", "description": "One", "pros": [], "cons": [], "estimated_time": null, "approach_type": "quick"}]}')


class TestPlanGeneratorExtractJsonFromMarkdown:
    """Tests for PlanGenerator._extract_json_from_markdown method."""

    def test_extract_from_json_code_block(self):
        """Test extracting from ```json block."""
        generator = PlanGenerator(llm=None)
        
        text = '```json\n{"key": "value"}\n```'
        result = generator._extract_json_from_markdown(text)
        
        assert result == '{"key": "value"}'

    def test_extract_from_plain_code_block(self):
        """Test extracting from plain ``` block."""
        generator = PlanGenerator(llm=None)
        
        text = '```\n{"key": "value"}\n```'
        result = generator._extract_json_from_markdown(text)
        
        assert result == '{"key": "value"}'

    def test_extract_from_inline_code(self):
        """Test extracting from `inline` code."""
        generator = PlanGenerator(llm=None)
        
        text = '`{"key": "value"}`'
        result = generator._extract_json_from_markdown(text)
        
        assert result == '{"key": "value"}'

    def test_extract_returns_original_if_no_markdown(self):
        """Test returns original text if no markdown found."""
        generator = PlanGenerator(llm=None)
        
        text = '{"key": "value"}'
        result = generator._extract_json_from_markdown(text)
        
        assert result == '{"key": "value"}'

    def test_extract_strips_whitespace(self):
        """Test extracted JSON is stripped of whitespace."""
        generator = PlanGenerator(llm=None)
        
        text = '```json\n  {"key": "value"}  \n```'
        result = generator._extract_json_from_markdown(text)
        
        assert result == '{"key": "value"}'


class TestPlanGeneratorParseSingleOption:
    """Tests for PlanGenerator._parse_single_option method."""

    def test_parse_complete_option(self):
        """Test parsing complete option data."""
        generator = PlanGenerator(llm=None)
        
        data = {
            "id": 1,
            "title": "Test Option",
            "description": "Test description",
            "pros": ["Pro 1", "Pro 2"],
            "cons": ["Con 1"],
            "estimated_time": "30 min",
            "approach_type": "quick",
        }
        
        option = generator._parse_single_option(data, 1)
        
        assert option.id == 1
        assert option.title == "Test Option"
        assert option.description == "Test description"
        assert option.pros == ["Pro 1", "Pro 2"]
        assert option.cons == ["Con 1"]
        assert option.estimated_time == "30 min"
        assert option.approach_type == "quick"

    def test_parse_option_with_defaults(self):
        """Test parsing option with missing fields uses defaults."""
        generator = PlanGenerator(llm=None)
        
        data = {"id": 1}
        
        option = generator._parse_single_option(data, 1)
        
        assert option.id == 1
        assert option.title == "Option 1"
        assert option.description == ""
        assert option.pros == []
        assert option.cons == []
        assert option.estimated_time is None
        # approach_type defaults to hybrid when not specified and id doesn't match
        assert option.approach_type == "hybrid"

    def test_parse_option_invalid_id_type(self):
        """Test parsing option with invalid id type uses expected_id."""
        generator = PlanGenerator(llm=None)
        
        data = {"id": "not an int"}
        
        option = generator._parse_single_option(data, 2)
        
        assert option.id == 2

    def test_parse_option_missing_id(self):
        """Test parsing option with missing id uses expected_id."""
        generator = PlanGenerator(llm=None)
        
        data = {"title": "Test"}
        
        option = generator._parse_single_option(data, 3)
        
        assert option.id == 3

    def test_parse_option_empty_title(self):
        """Test parsing option with empty title uses default."""
        generator = PlanGenerator(llm=None)
        
        data = {"id": 1, "title": ""}
        
        option = generator._parse_single_option(data, 1)
        
        assert option.title == "Option 1"

    def test_parse_option_non_string_title(self):
        """Test parsing option with non-string title converts to string."""
        generator = PlanGenerator(llm=None)
        
        data = {"id": 1, "title": 123}
        
        option = generator._parse_single_option(data, 1)
        
        assert option.title == "Option 1"

    def test_parse_option_non_string_description(self):
        """Test parsing option with non-string description converts to string."""
        generator = PlanGenerator(llm=None)
        
        data = {"id": 1, "description": 123}
        
        option = generator._parse_single_option(data, 1)
        
        assert option.description == "123"

    def test_parse_option_non_list_pros(self):
        """Test parsing option with non-list pros uses empty list."""
        generator = PlanGenerator(llm=None)
        
        data = {"id": 1, "pros": "not a list"}
        
        option = generator._parse_single_option(data, 1)
        
        assert option.pros == []

    def test_parse_option_non_list_cons(self):
        """Test parsing option with non-list cons uses empty list."""
        generator = PlanGenerator(llm=None)
        
        data = {"id": 1, "cons": "not a list"}
        
        option = generator._parse_single_option(data, 1)
        
        assert option.cons == []

    def test_parse_option_non_string_estimated_time(self):
        """Test parsing option with non-string estimated_time converts to string."""
        generator = PlanGenerator(llm=None)
        
        data = {"id": 1, "estimated_time": 30}
        
        option = generator._parse_single_option(data, 1)
        
        assert option.estimated_time == "30"

    def test_parse_option_approach_type_inference_quick(self):
        """Test approach_type inference for id=1 (quick)."""
        generator = PlanGenerator(llm=None)
        
        data = {"id": 1, "approach_type": "invalid"}
        
        option = generator._parse_single_option(data, 1)
        
        assert option.approach_type == "quick"

    def test_parse_option_approach_type_inference_proper(self):
        """Test approach_type inference for id=2 (proper)."""
        generator = PlanGenerator(llm=None)
        
        data = {"id": 2, "approach_type": "invalid"}
        
        option = generator._parse_single_option(data, 2)
        
        assert option.approach_type == "proper"

    def test_parse_option_approach_type_inference_hybrid(self):
        """Test approach_type inference for id=3 (hybrid)."""
        generator = PlanGenerator(llm=None)
        
        data = {"id": 3, "approach_type": "invalid"}
        
        option = generator._parse_single_option(data, 3)
        
        assert option.approach_type == "hybrid"

    def test_parse_option_valid_approach_types(self):
        """Test all valid approach types are accepted."""
        generator = PlanGenerator(llm=None)
        
        for approach in ["quick", "proper", "hybrid"]:
            data = {"id": 1, "approach_type": approach}
            option = generator._parse_single_option(data, 1)
            assert option.approach_type == approach

    def test_parse_option_missing_approach_type(self):
        """Test missing approach_type defaults to hybrid."""
        generator = PlanGenerator(llm=None)
        
        data = {"id": 5}
        
        option = generator._parse_single_option(data, 5)
        
        assert option.approach_type == "hybrid"

    def test_parse_option_pros_filter_empty(self):
        """Test pros filters out empty/falsy values."""
        generator = PlanGenerator(llm=None)
        
        data = {"id": 1, "pros": ["Good", "", None, "Nice"]}
        
        option = generator._parse_single_option(data, 1)
        
        # Empty strings are filtered, None becomes "None" when converted to string
        assert option.pros == ["Good", "Nice"]

    def test_parse_option_cons_filter_empty(self):
        """Test cons filters out empty/falsy values."""
        generator = PlanGenerator(llm=None)
        
        data = {"id": 1, "cons": ["Bad", "", None]}
        
        option = generator._parse_single_option(data, 1)
        
        # Empty strings are filtered, None becomes "None" when converted to string
        assert option.cons == ["Bad"]
