"""在导入业务代码前校验解释器版本，避免 3.12 以下因 ``match`` 等语法在收集阶段即失败。"""

from __future__ import annotations

import importlib.abc
import importlib.machinery
import sys
import types
from unittest.mock import MagicMock

_MIN = (3, 12)

if sys.version_info < _MIN:
    v = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    msg = (
        f"当前 Python 为 {v}，本仓库要求 >= {_MIN[0]}.{_MIN[1]} "
        f"（见 pyproject.toml: requires-python）。\n"
        "请使用与 .python-version 一致的解释器，例如：\n"
        "  uv run --python 3.12 python -m pytest\n"
        "  或: make test\n"
        "  或: python3.12 -m pytest"
    )
    raise RuntimeError(msg)

# Optional extras omitted from a slim venv. Real installs still win: this finder
# is appended after PathFinder, so it only runs when the package is absent.
_OPTIONAL_STUB_ROOTS = (
    "tree_sitter",
    "tree_sitter_languages",
    "textual",
    "mcp",
    "httpx",
    "google",
    "anthropic",
    "openai",
    "ollama",
    "azure",
)


class _FlexMeta(type):
    def __getattr__(cls, name):
        if name.startswith("_"):
            raise AttributeError(name)
        val = type(name, (), {"__module__": getattr(cls, "__module__", "")})
        setattr(cls, name, val)
        return val

    def __getitem__(cls, item):  # App[None]
        return cls


class _FlexBase(metaclass=_FlexMeta):
    def __init__(self, *args, **kwargs):
        return None


class _StubPackage(types.ModuleType):
    def __init__(self, name: str):
        super().__init__(name)
        self.__path__ = []
        self.__package__ = name

    def __getattr__(self, item: str):
        if item.startswith("_"):
            raise AttributeError(item)
        child_name = f"{self.__name__}.{item}"
        if child_name in sys.modules:
            return sys.modules[child_name]
        if item[:1].isupper():
            val = type(item, (_FlexBase,), {"__module__": child_name})
        else:
            val = MagicMock(name=child_name)
        setattr(self, item, val)
        return val


class _OptionalStubLoader(importlib.abc.Loader):
    def create_module(self, spec):
        return _StubPackage(spec.name)

    def exec_module(self, module):
        return None


class _OptionalStubFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path, target=None):  # noqa: ARG002
        if not any(fullname == root or fullname.startswith(root + ".") for root in _OPTIONAL_STUB_ROOTS):
            return None
        return importlib.machinery.ModuleSpec(
            fullname,
            _OptionalStubLoader(),
            is_package=True,
        )


sys.meta_path.append(_OptionalStubFinder())
