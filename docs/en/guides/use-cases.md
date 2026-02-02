# Common use cases

Kimi Code CLI can help you complete various software development and general tasks. Here are some typical scenarios.

## Implementing new features

When you need to add new features to a project, simply describe the requirements in natural language. Kimi Code CLI will automatically read relevant code, understand the project structure, and then make modifications.

```
Add pagination to the user list page, displaying 20 records per page
```

Kimi Code CLI typically follows a "read → modify → verify" workflow:

1. **Read**: Search and read relevant code to understand the existing implementation
2. **Modify**: Write or modify code, following the project's coding style
3. **Verify**: Run tests or builds to ensure modifications don't introduce issues

If you're not satisfied with the modifications, you can directly tell Kimi Code CLI to adjust:

```
The pagination component's style is inconsistent with other parts of the project. Reference the Button component's style
```

## Fixing bugs

Describe the problem you encountered, and Kimi Code CLI will help you locate the cause and fix it:

```
After user login, when redirecting to the home page, it occasionally shows an unlogged state. Please help me investigate
```

For issues with clear error messages, you can paste the error logs directly:

```
This error occurs when running npm test:

TypeError: Cannot read property 'map' of undefined
    at UserList.render (src/components/UserList.jsx:15:23)

Help me fix it
```

You can also have Kimi Code CLI run commands to reproduce and verify issues:

```
Run tests, and if there are any failed cases, fix them
```

## Understanding projects

Kimi Code CLI can help you explore and understand unfamiliar codebases:

```
What is the overall architecture of this project? Where is the entry file?
```

```
How is the user authentication flow implemented? Which files are involved?
```

```
Explain the purpose of the src/core/scheduler.py file
```

If you encounter parts you don't understand while reading code, you can ask at any time:

```
What is the difference between useCallback and useMemo? Why is useCallback used here?
```

## Automating small tasks

Kimi Code CLI can perform various repetitive small tasks:

```
Change var declarations to const or let in all .js files under the src directory
```

```
Add documentation comments to all public functions that don't have docstrings
```

```
Generate unit tests for this API module
```

```
Update all dependencies in package.json to the latest version, then run tests to ensure there are no issues
```

## Automating general tasks

In addition to code-related tasks, Kimi Code CLI can also handle some general scenarios.

**Research tasks**

```
Help me research Python's asynchronous web frameworks, comparing the pros and cons of FastAPI, Starlette, and Sanic
```

**Data analysis**

```
Analyze the access logs in the logs directory, counting the call frequency and average response time for each endpoint
```

**Batch file processing**

```
Convert all PNG images in the images directory to JPEG format and save them to the output directory
```
