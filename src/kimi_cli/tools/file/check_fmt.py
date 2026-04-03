import xml.etree.ElementTree as ET
import json
import re
from typing import Callable


def check_json(file_path: str, json_callback=None) -> str | None:
    """Validate the format of a JSON file.

    Args:
        file_path: Path to the JSON file to validate.

    Returns:
        None if the JSON file is valid, error message string otherwise.
    """
    try:
        js = None
        with open(file_path, 'r', encoding='utf-8') as f:
            js = json.load(f)
        if json_callback:
            json_callback(js)
        return None

    except json.JSONDecodeError as exc:
        return f"JSON decode error at line {exc.lineno}, column {exc.colno}: {exc.msg}"
    except Exception as exc:
        return f"Failed to validate JSON file: {str(exc)}"


"""XML file validator tool."""


def check_xml(file_path: str, xml_callback=None) -> str | None:
    """Validate the format of an XML file.

    Args:
        file_path: Path to the XML file to validate.

    Returns:
        None if the XML file is valid, error message string otherwise.
    """
    try:
        tree = ET.parse(file_path)
        if xml_callback:
            xml_callback(tree)
        return None

    except ET.ParseError as exc:
        return f"XML parse error: {str(exc)}"
    except Exception as exc:
        return f"Failed to validate XML file: {str(exc)}"


class MarkdownValidationError(Exception):
    """Exception raised for markdown validation errors with position info."""

    def __init__(self, message: str, line: int = 0, column: int = 0):
        self.message = message
        self.line = line
        self.column = column
        super().__init__(
            f"Markdown validation error at line {line}, column {column}: {message}")


def check_md(file_path: str, md_callback: Callable[[str], None] | None = None) -> str | None:
    """Validate the format of a Markdown file.

    Args:
        file_path: Path to the Markdown file to validate.
        md_callback: Optional callback function to process the content.

    Returns:
        None if the Markdown file is valid, error message string otherwise.
    """
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()

        errors = _validate_markdown(content)
        if errors:
            return '\n'.join(errors)

        if md_callback:
            md_callback(content)
        return errors

    except MarkdownValidationError as exc:
        return f"Markdown validation error at line {exc.line}, column {exc.column}: {exc.message}"
    except Exception as exc:
        return f"Failed to validate Markdown file: {str(exc)}"


def check_md_str(content: str, md_callback: Callable[[str], None] | None = None) -> str | None:
    """Validate the format of a Markdown string.

    Args:
        content: Markdown string content to validate.
        md_callback: Optional callback function to process the content.

    Returns:
        None if the Markdown string is valid, error message string otherwise.
    """
    try:
        errors = _validate_markdown(content)
        if errors:
            return '\n'.join(errors)

        if md_callback:
            md_callback(content)
        return errors

    except MarkdownValidationError as exc:
        return f"Markdown validation error at line {exc.line}, column {exc.column}: {exc.message}"
    except Exception as exc:
        return f"Failed to validate Markdown content: {str(exc)}"


def _validate_markdown(content: str) -> list[str]:
    """Internal function to validate markdown content.

    Args:
        content: The markdown content to validate.

    Returns:
        List of error messages. Empty list if valid.
    """
    lines = content.split('\n')
    all_errors: list[str] = []

    # Check for basic structural issues
    checks = [
        _check_code_fence_balance,
        _check_header_syntax,
        _check_link_balance,
        _check_table_syntax,
    ]

    for check in checks:
        errors = check(lines)
        all_errors.extend(errors)

    return all_errors


def _check_code_fence_balance(lines: list[str]) -> list[str]:
    """Check if code fences (```) are properly balanced."""
    errors: list[str] = []
    in_code_block = False
    fence_info = None  # (line_num, col_num) of opening fence

    for line_idx, line in enumerate(lines, start=1):
        stripped = line.lstrip()

        # Check for code fence
        if stripped.startswith('```'):
            if not in_code_block:
                in_code_block = True
                col = line.index('```') + 1
                fence_info = (line_idx, col)
            else:
                in_code_block = False
                fence_info = None

    if in_code_block and fence_info:
        errors.append(
            f"Markdown validation error at line {fence_info[0]}, column {fence_info[1]}: Unclosed code fence")

    return errors


def _check_header_syntax(lines: list[str]) -> list[str]:
    """Check if headers have proper syntax."""
    errors: list[str] = []

    for line_idx, line in enumerate(lines, start=1):
        stripped = line.lstrip()

        # Check for header syntax
        if stripped.startswith('#'):
            # Count leading hashes
            match = re.match(r'^(#{1,6})\s', stripped)
            if not match:
                # Check if it's more than 6 hashes (invalid header level)
                hash_match = re.match(r'^(#{7,})\s', stripped)
                if hash_match:
                    col = line.index('#') + 1
                    errors.append(
                        f"Markdown validation error at line {line_idx}, column {col}: Invalid header level (max 6), found {len(hash_match.group(1))} # characters")
                else:
                    # Header without space after hashes
                    hash_only_match = re.match(r'^(#{1,6})([^\s]|$)', stripped)
                    if hash_only_match:
                        col = line.index('#') + 1
                        errors.append(
                            f"Markdown validation error at line {line_idx}, column {col}: Header must be followed by a space")

    return errors


def _is_escaped(line: str, pos: int) -> bool:
    """Check if the character at pos is escaped by backslash."""
    backslash_count = 0
    j = pos - 1
    while j >= 0 and line[j] == '\\':
        backslash_count += 1
        j -= 1
    return backslash_count % 2 == 1


def _check_link_balance(lines: list[str]) -> list[str]:
    """Check if link brackets and parentheses are balanced."""
    errors: list[str] = []

    for line_idx, line in enumerate(lines, start=1):
        # Skip code blocks
        if line.strip().startswith('```'):
            continue

        # Find all link/image patterns: [text](url) or ![alt](url)
        i = 0
        while i < len(line):
            # Look for opening bracket (not escaped)
            if line[i] == '[' and not _is_escaped(line, i):
                # Find closing bracket
                bracket_depth = 1
                j = i + 1
                while j < len(line) and bracket_depth > 0:
                    if line[j] == '[' and not _is_escaped(line, j):
                        bracket_depth += 1
                    elif line[j] == ']' and not _is_escaped(line, j):
                        bracket_depth -= 1
                    j += 1

                if bracket_depth > 0:
                    col = i + 1
                    errors.append(
                        f"Markdown validation error at line {line_idx}, column {col}: Unclosed link bracket '['")
                    i += 1
                    continue

                # Check for opening parenthesis after closing bracket
                if j < len(line) and line[j] == '(':
                    # Find closing parenthesis
                    paren_depth = 1
                    k = j + 1
                    while k < len(line) and paren_depth > 0:
                        if line[k] == '(' and not _is_escaped(line, k):
                            paren_depth += 1
                        elif line[k] == ')' and not _is_escaped(line, k):
                            paren_depth -= 1
                        k += 1

                    if paren_depth > 0:
                        col = j + 1
                        errors.append(
                            f"Markdown validation error at line {line_idx}, column {col}: Unclosed link parenthesis '('")

            i += 1

    return errors


def _check_table_syntax(lines: list[str]) -> list[str]:
    """Check if table syntax is valid."""
    errors: list[str] = []
    in_table = False
    table_start_line = 0
    separator_found = False

    for line_idx, line in enumerate(lines, start=1):
        stripped = line.strip()

        # Skip empty lines and code blocks
        if not stripped or stripped.startswith('```'):
            if in_table and not separator_found:
                col = 1
                errors.append(
                    f"Markdown validation error at line {table_start_line}, column {col}: Table missing separator line (|---|---|)")
            in_table = False
            separator_found = False
            continue

        # Check if this is a table row (starts and ends with |)
        if stripped.startswith('|') and stripped.endswith('|'):
            if not in_table:
                in_table = True
                table_start_line = line_idx
                separator_found = False
            else:
                # Check if this is a separator line
                if re.match(r'^(\|[:\-]*+)+\|$', stripped.replace(' ', '')):
                    separator_found = True
        else:
            if in_table and not separator_found:
                col = 1
                errors.append(
                    f"Markdown validation error at line {table_start_line}, column {col}: Table missing separator line (|---|---|)")
            in_table = False
            separator_found = False

    # Check if table at end of file is missing separator
    if in_table and not separator_found:
        col = 1
        errors.append(
            f"Markdown validation error at line {table_start_line}, column {col}: Table missing separator line (|---|---|)")

    return errors
