# -*- mode: python ; coding: utf-8 -*-

import os
from kimi_cli.utils.pyinstaller import datas, hiddenimports

# Read codesign identity from environment variable (for macOS signing in CI)
codesign_identity = os.environ.get("APPLE_SIGNING_IDENTITY", None)

# Read build mode from environment variable (onedir mode for directory-based distribution)
onedir_mode = os.environ.get("PYINSTALLER_ONEDIR", "0") == "1"

a = Analysis(
    ["src/kimi_cli/cli/__main__.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

if onedir_mode:
    # one-dir mode: EXE contains only scripts, binaries/datas collected separately
    # Use a different name for EXE to avoid conflict with COLLECT directory
    exe = EXE(
        pyz,
        a.scripts,
        exclude_binaries=True,
        name="kimi-exe",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=True,
        upx_exclude=[],
        runtime_tmpdir=None,
        console=True,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=codesign_identity,
        entitlements_file=None,
    )
    coll = COLLECT(
        exe,
        a.binaries,
        a.datas,
        strip=False,
        upx=True,
        upx_exclude=[],
        name="kimi",
    )
else:
    # one-file mode (default): all binaries/datas bundled into single executable
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.datas,
        [],
        name="kimi",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=True,
        upx_exclude=[],
        runtime_tmpdir=None,
        console=True,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=codesign_identity,
        entitlements_file=None,
    )
