from pathlib import Path
import re

p = Path('/mnt/data/kimi_enterprise_complete.py')
text = p.read_text(encoding='utf-8')

text = text.replace(
    'from typing import Any, Dict, Iterable, List, Optional, Tuple, Literal\n',
    'from typing import Any, Dict, Iterable, List, Optional, Tuple, Literal, AsyncIterator\n',
)

if 'import shutil\n' not in text:
    text = text.replace('import shlex\n', 'import shlex\nimport shutil\n')

wire_pattern = re.compile(
    r'# ============================================================\n# Wire File\n# ============================================================\n.*?# ============================================================\n# Audit Logger\n# ============================================================',
    re.S,
)
wire_replacement = '''# ============================================================
# Wire File
# ============================================================

WIRE_PROTOCOL_VERSION = "kimi-enterprise-wire-v1"
WIRE_PROTOCOL_LEGACY_VERSION = "legacy"


@dataclass(slots=True)
class WireFileMetadata:
    type: Literal["metadata"] = "metadata"
    protocol_version: str = WIRE_PROTOCOL_VERSION

    def to_json(self) -> str:
        return json.dumps(
            {"type": self.type, "protocol_version": self.protocol_version},
            ensure_ascii=False,
        )


@dataclass(slots=True)
class WireMessageRecord:
    timestamp: float
    message: Dict[str, Any]

    @classmethod
    def from_message(cls, message: Dict[str, Any], *, timestamp: float) -> "WireMessageRecord":
        return cls(timestamp=timestamp, message=message)

    def to_json(self) -> str:
        return json.dumps(
            {"timestamp": self.timestamp, "message": self.message},
            ensure_ascii=False,
            default=str,
        )


def parse_wire_file_metadata(line: str) -> Optional[WireFileMetadata]:
    try:
        payload = json.loads(line)
    except Exception:
        return None
    if not isinstance(payload, dict) or payload.get("type") != "metadata":
        return None
    try:
        return WireFileMetadata(
            type="metadata",
            protocol_version=str(payload.get("protocol_version") or WIRE_PROTOCOL_VERSION),
        )
    except Exception:
        return None


def parse_wire_file_line(line: str) -> WireFileMetadata | WireMessageRecord | None:
    metadata = parse_wire_file_metadata(line)
    if metadata is not None:
        return metadata
    try:
        payload = json.loads(line)
    except Exception:
        return None
    if not isinstance(payload, dict) or "message" not in payload:
        return None
    return WireMessageRecord(
        timestamp=float(payload.get("timestamp", time.time())),
        message=payload.get("message") or {},
    )


def _load_protocol_version(path: Path) -> Optional[str]:
    try:
        with path.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                metadata = parse_wire_file_metadata(line)
                if metadata is None:
                    return None
                return metadata.protocol_version
    except OSError:
        return None
    return None


class WireFile:
    def __init__(self, path: Path, protocol_version: str = WIRE_PROTOCOL_VERSION):
        self.path = path
        self.protocol_version = protocol_version
        if self.path.exists():
            version = _load_protocol_version(self.path)
            self.protocol_version = version if version is not None else WIRE_PROTOCOL_LEGACY_VERSION

    @property
    def version(self) -> str:
        return self.protocol_version

    def is_empty(self) -> bool:
        if not self.path.exists():
            return True
        try:
            with self.path.open(encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    if parse_wire_file_metadata(line) is not None:
                        continue
                    return False
        except OSError:
            return False
        return True

    async def iter_records(self) -> AsyncIterator[WireMessageRecord]:
        if not self.path.exists():
            return
        try:
            with self.path.open(encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    parsed = parse_wire_file_line(line)
                    if parsed is None or isinstance(parsed, WireFileMetadata):
                        continue
                    yield parsed
        except OSError:
            return

    def append_message(self, message: Dict[str, Any], *, timestamp: Optional[float] = None) -> None:
        self.append_record(
            WireMessageRecord.from_message(
                message,
                timestamp=time.time() if timestamp is None else timestamp,
            )
        )

    def append_record(self, record: WireMessageRecord) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        needs_header = not self.path.exists() or self.path.stat().st_size == 0
        with self.path.open("a", encoding="utf-8") as f:
            if needs_header:
                f.write(WireFileMetadata(protocol_version=self.protocol_version).to_json() + "\\n")
            f.write(record.to_json() + "\\n")


# ============================================================
# Audit Logger
# ============================================================'''
text = wire_pattern.sub(wire_replacement, text)

if 'def build_web_ui(' not in text:
    marker = '# ============================================================\n# Prompt Engine\n# ============================================================\n'
    helpers = '''
def resolve_npm() -> Optional[str]:
    candidates = ["npm"]
    if os.name == "nt":
        candidates.extend(["npm.cmd", "npm.exe", "npm.bat"])
    for candidate in candidates:
        npm = shutil.which(candidate)
        if npm:
            return npm
    return None


def run_npm(npm: str, args: List[str]) -> int:
    try:
        result = subprocess.run([npm, *args], check=False)
    except FileNotFoundError:
        print(
            "npm not found or failed to execute. Install Node.js (npm) and ensure it is on PATH.",
            file=sys.stderr,
        )
        return 1
    return int(result.returncode)


def build_web_ui(root: Path) -> int:
    web_dir = root / "web"
    dist_dir = web_dir / "dist"
    node_modules = web_dir / "node_modules"
    static_dir = root / "src" / "kimi_cli" / "web" / "static"
    strict_version = os.environ.get("KIMI_WEB_STRICT_VERSION", "").lower() in {"1", "true", "yes"}
    required_web_type_files = (
        node_modules / "vite" / "client.d.ts",
        node_modules / "@types" / "node" / "index.d.ts",
    )

    npm = resolve_npm()
    if npm is None:
        print("npm not found. Install Node.js (npm) to build the web UI.", file=sys.stderr)
        return 1

    pyproject = root / "pyproject.toml"
    if not pyproject.exists():
        print(f"pyproject.toml not found under {root}", file=sys.stderr)
        return 1

    with pyproject.open("rb") as handle:
        project_data = tomllib.load(handle)
    expected_version = str(project_data["project"]["version"])
    explicit_expected = os.environ.get("KIMI_WEB_EXPECT_VERSION")
    if explicit_expected and explicit_expected != expected_version:
        print(
            f"web version mismatch: pyproject={expected_version}, expected={explicit_expected}",
            file=sys.stderr,
        )
        return 1

    def has_required_web_type_files() -> bool:
        return all(path.is_file() for path in required_web_type_files)

    needs_install = (not node_modules.exists()) or (not has_required_web_type_files())
    if needs_install:
        if node_modules.exists():
            print("web dependencies are incomplete; reinstalling with devDependencies...")
        returncode = run_npm(npm, ["--prefix", str(web_dir), "ci", "--include=dev"])
        if returncode != 0:
            return returncode

    returncode = run_npm(npm, ["--prefix", str(web_dir), "run", "build"])
    if returncode != 0:
        return returncode

    if not dist_dir.exists():
        print("web/dist not found after build. Check the web build output.", file=sys.stderr)
        return 1

    def find_version_in_dist(version: str) -> bool:
        search_suffixes = {".js", ".css", ".html", ".map"}
        version_with_prefix = f"v{version}"
        found_plain = False
        for path in dist_dir.rglob("*"):
            if not path.is_file() or path.suffix not in search_suffixes:
                continue
            try:
                content = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            if version_with_prefix in content:
                return True
            if version in content:
                found_plain = True
        return found_plain

    if strict_version and not find_version_in_dist(expected_version):
        print(
            f"web version not found in build output; expected version {expected_version}",
            file=sys.stderr,
        )
        return 1

    if static_dir.exists():
        shutil.rmtree(static_dir)
    static_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(dist_dir, static_dir)

    print(f"Synced web UI to {static_dir}")
    return 0

'''
    text = text.replace(marker, helpers + marker)

text = text.replace(
    '    sub.add_parser("print-sdk-setup", help="Print Kimi Agent SDK / Wire setup instructions")\n',
    '    sub.add_parser("print-sdk-setup", help="Print Kimi Agent SDK / Wire setup instructions")\n'
    '    webbuild = sub.add_parser("build-web", help="Build and sync the web UI into src/kimi_cli/web/static")\n'
    '    webbuild.add_argument("--root", default=".", help="Repository root containing web/ and pyproject.toml")\n'
)

text = text.replace(
    '    if args.cmd == "print-sdk-setup":\n        print(sdk_setup_text())\n        return 0\n',
    '    if args.cmd == "print-sdk-setup":\n        print(sdk_setup_text())\n        return 0\n\n'
    '    if args.cmd == "build-web":\n        return build_web_ui(Path(args.root).resolve())\n'
)

p.write_text(text, encoding='utf-8')
print('Patched script with official-style wire file support and build-web command.')
