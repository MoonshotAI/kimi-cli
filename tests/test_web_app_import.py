def test_create_app_imports() -> None:
    # Import should not have side effects that crash on import.
    from kimi_cli.web.app import create_app

    app = create_app()
    assert app is not None
