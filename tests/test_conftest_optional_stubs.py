"""Optional third-party stubs in tests/conftest.py must collect without extras."""

import importlib


def test_optional_textual_from_import_collects():
    mod = importlib.import_module("textual.reactive")
    reactive = getattr(mod, "reactive")
    assert reactive(0) is not None


def test_optional_mcp_stdio_from_import_collects():
    mod = importlib.import_module("mcp.client.stdio")
    assert getattr(mod, "stdio_client") is not None


def test_optional_mcp_stdio_from_import_collects():
    mod = importlib.import_module("mcp.client.stdio")
    assert getattr(mod, "stdio_client") is not None
