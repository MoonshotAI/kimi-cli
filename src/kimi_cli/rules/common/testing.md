---
name: "Testing Standards"
description: "Guidelines for writing effective tests"
priority: 110
---

# Testing Standards

## Test Coverage

- **Test critical paths**: Focus on business logic and edge cases
- **Aim for meaningful coverage**: Quality over quantity (80% is a good target)
- **Test behavior, not implementation**: Tests should verify what code does, not how

## Test Structure

- **Arrange-Act-Assert**: Structure tests clearly
  - Arrange: Set up test data and conditions
  - Act: Execute the code being tested
  - Assert: Verify the expected outcome

## Test Naming

- **Descriptive names**: Test names should explain the scenario being tested
- **Pattern**: `test_<function>_<condition>_<expected_result>`
- **Example**: `test_calculate_discount_negative_price_raises_error`

## Test Independence

- **Isolated tests**: Each test should be independent and not rely on others
- **Clean state**: Tests should clean up after themselves or use fresh fixtures
- **Deterministic**: Tests should produce the same result every time

## Test Maintenance

- **Keep tests simple**: Test code should be simpler than production code
- **Refactor tests**: Don't be afraid to improve test code structure
- **Review test failures**: Never ignore failing tests
