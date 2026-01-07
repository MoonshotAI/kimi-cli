# type: ignore
import shlex
import subprocess
import tarfile
import io
from pathlib import Path
import json

from kimi_cli.utils.logging import logger

from swebench.config import EvalConfig
from swebench.utils.docker import Container

class KimiContainerSolver:
    def __init__(
        self,
        container: Container,
        working_dir: str,
        config: EvalConfig,
        problem_statement: str,
        instance: dict,
    ):
        self.container = container
        self.working_dir = working_dir
        self.config = config
        self.problem_statement = problem_statement
        self.instance = instance
        self.round = 0

    async def solve(self):
        """Run Kimi CLI in container to solve the problem."""
        try:
            logger.info("Copying kimi-cli source to container...")
            await self._copy_kimi_to_container()
            logger.info("Installing kimi-cli dependencies in container...")
            await self._install_kimi_in_container()
            logger.info("Running kimi-cli in container...")
            result = await self._run_kimi_in_container()
            return result
        except Exception as e:
            logger.error("Kimi solver failed: {}", str(e), exc_info=True)
            raise

    async def _copy_kimi_to_container(self) -> None:
        workspace_root = Path(__file__).parent.parent
        kimi_cli_src = workspace_root / "src" / "kimi_cli"
        pyproject = workspace_root / "pyproject.toml"
        container_name = self.container.container_name
        try:
            tar_buffer = io.BytesIO()
            with tarfile.open(fileobj=tar_buffer, mode="w") as tar:
                tar.add(kimi_cli_src, arcname="src/kimi_cli")
                tar.add(pyproject, arcname="pyproject.toml")
            tar_buffer.seek(0)
            tar_data = tar_buffer.read()
            tar_cmd = ["docker", "exec", "-i", container_name, "tar", "-xvf", "-", "-C", "/openhands"]
            result = subprocess.run(
                tar_cmd,
                input=tar_data,
                capture_output=True,
                timeout=600,
            )

            if result.returncode != 0:
                logger.error(f"tar stderr: {result.stderr.decode()}")
                logger.error(f"tar stdout: {result.stdout.decode()}")
                raise RuntimeError(f"tar extract failed: {result.stderr.decode()}")
        except Exception as e:
            logger.error("Failed to copy sources: {}", str(e), exc_info=True)
            raise

    async def _install_kimi_in_container(self) -> None:
        install_cmd = "cd /openhands && /openhands/poetry/openhands-ai-5O4_aCHf-py3.12/bin/pip install -e ."
        result = await self.container.execute(
            ["bash", "-c", install_cmd],
            timeout=600,
            check=False,
        )
        if result.get("exit_code", 0) != 0:
            logger.warning(f"Installation warnings: {result.get('stderr', '')}")
        logger.info("✓ kimi-cli dependencies installed in poetry environment")

    async def _run_kimi_in_container(self):
        env_vars = f"KIMI_API_KEY={shlex.quote(self.config.api_key)}"
        env_vars += f" KIMI_BASE_URL={shlex.quote(self.config.base_url)}"
        env_vars += f" KIMI_MODEL_NAME={shlex.quote(self.config.model)}"
        env_vars += f" KIMI_MODEL_MAX_CONTEXT_SIZE={shlex.quote(str(self.config.max_context_size))}"
        env_vars += f" KIMI_MODEL_TEMPERATURE={shlex.quote(str(self.config.temperature))}"
        env_vars += f" KIMI_MODEL_TOP_P={shlex.quote(str(self.config.top_p))}"
        env_vars += f" KIMI_MODEL_MAX_TOKENS={shlex.quote(str(self.config.max_tokens))}"
        
        config_json = json.dumps({
            "loop_control": {
                "max_steps_per_run": self.config.max_iterations,
                "max_retries_per_step": 3,
            }
        })
        
        # --print will auto approve, use config for loop control
        kimi_cmd = (
            f"cd {shlex.quote(self.working_dir)} && "
            f"{env_vars} "
            f"/openhands/poetry/openhands-ai-5O4_aCHf-py3.12/bin/python -m kimi_cli.cli "
            f"--work-dir {shlex.quote(self.working_dir)} "
            f"--command {shlex.quote(self.problem_statement)} "
            f"--config {shlex.quote(config_json)} "
            f"--print "
            f"--thinking "
        )

        # logger.debug(f"Command: {kimi_cmd}")
        result = await self.container.execute(
            ["bash", "-c", kimi_cmd],
            timeout=self.config.timeout_seconds,
            check=False,
        )
        
        exit_code = result.get("exit_code", 0)
        stdout = result.get("stdout", "")
        stderr = result.get("stderr", "")
        
        logger.info(f"Kimi execution completed with exit code: {exit_code}")
        
        if exit_code != 0:
            logger.warning(f"Kimi exit code: {exit_code}")
            if stderr:
                logger.warning(f"Stderr: {stderr}")
            logger.info(f"Stdout: {stdout}")
        
        trace_result = await self._extract_trace()
        git_diff = await self._get_container_diff()
        return {
            "output": stdout,
            "git_diff": git_diff,
            "messages": trace_result.get("messages", []),
            "sub_messages": trace_result.get("sub_messages", []),
        }

    async def _extract_trace(self) -> dict:
        """Extract conversation history from context.jsonl (main and subagent contexts separately)."""
        try:
            # Find the most recent context.jsonl file (main agent)
            find_context_cmd = "find ~/.kimi/sessions -name 'context.jsonl' -type f 2>/dev/null | sort -r | head -1"
            find_result = await self.container.execute(
                ["bash", "-c", find_context_cmd],
                timeout=120,
                check=False,
            )
            context_file = find_result.get("stdout", "").strip()
            if not context_file:
                logger.warning("No context.jsonl file found")
                return {"messages": [], "sub_messages": []}
                
            logger.info(f"Found context file: {context_file}")
            
            # Read main context.jsonl
            read_cmd = f"cat {context_file}"
            context_result = await self.container.execute(
                ["bash", "-c", read_cmd],
                timeout=120,
                check=False,
            )
            
            context_content = context_result.get("stdout", "").strip()
            trace_lines = context_content.split("\n")
            messages = []
            
            for line in trace_lines:
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                    
                    if isinstance(record.get("content"), list):
                        content_list = record["content"]
                        if record.get("role") == "tool":
                            combined_text = "\n".join(
                                item.get("text", "") if isinstance(item, dict) else str(item)
                                for item in content_list
                                if item
                            )
                            record["content"] = combined_text
                        
                        elif record.get("role") == "assistant":
                            reasoning_texts = []
                            content_texts = []
                            for item in content_list:
                                if isinstance(item, dict):
                                    if item.get("type") == "think":
                                        think_text = item.get("think", "")
                                        if think_text:
                                            reasoning_texts.append(think_text)
                                    elif item.get("type") == "text":
                                        text = item.get("text", "")
                                        if text:
                                            content_texts.append(text)
                            
                            if content_texts:
                                record["content"] = "\n".join(content_texts)
                            else:
                                record["content"] = ""
                            
                            if reasoning_texts:
                                record["reasoning_content"] = "\n".join(reasoning_texts)
                        
                        else:
                            combined_text = "\n".join(
                                item.get("text", "") if isinstance(item, dict) else str(item)
                                for item in content_list
                                if item
                            )
                            record["content"] = combined_text
                    
                    messages.append(record)
                except json.JSONDecodeError:
                    logger.debug(f"Skipped invalid JSON line: {line[:50]}")
                    continue
            
            logger.info(f"✓ Extracted {len(messages)} messages from main context")
            
            sub_messages = await self._extract_subagent_contexts()
            if sub_messages:
                logger.info(f"✓ Found {len(sub_messages)} subagent(s)")
            
            return {
                "messages": messages,
                "sub_messages": sub_messages,
            }
        except Exception as e:
            logger.warning(f"Failed to extract trace: {e}", exc_info=True)
            return {"messages": [], "sub_messages": []}
    
    async def _extract_subagent_contexts(self) -> list:
        """Extract context from subagent sessions (context_sub*.jsonl files).
        
        Returns:
            List of dicts with format: [{"id": "context_sub.jsonl", "messages": [...]}, ...]
        """
        try:
            # Find all subagent context files (context_sub.jsonl, context_sub_1.jsonl, context_sub_2.jsonl, ...)
            # These are created via next_available_rotation when subagents are called
            find_subagent_cmd = (
                "find ~/.kimi/sessions -name 'context_sub*.jsonl' -type f 2>/dev/null | sort"
            )
            find_result = await self.container.execute(
                ["bash", "-c", find_subagent_cmd],
                timeout=120,
                check=False,
            )
            
            subagent_files = [f for f in find_result.get("stdout", "").strip().split("\n") if f.strip()]
            if not subagent_files:
                return []
            
            sub_messages = []
            for context_file in subagent_files:
                try:
                    read_cmd = f"cat {context_file}"
                    result = await self.container.execute(
                        ["bash", "-c", read_cmd],
                        timeout=120,
                        check=False,
                    )
                    
                    content = result.get("stdout", "").strip()
                    messages = []
                    for line in content.split("\n"):
                        if not line.strip():
                            continue
                        try:
                            record = json.loads(line)
                            
                            if isinstance(record.get("content"), list):
                                    content_list = record["content"]
                                    if record.get("role") == "tool":
                                        combined_text = "\n".join(
                                            item.get("text", "") if isinstance(item, dict) else str(item)
                                            for item in content_list
                                            if item
                                        )
                                        record["content"] = combined_text
                                    
                                    elif record.get("role") == "assistant":
                                        reasoning_texts = []
                                        content_texts = []
                                        
                                        for item in content_list:
                                            if isinstance(item, dict):
                                                if item.get("type") == "think":
                                                    think_text = item.get("think", "")
                                                    if think_text:
                                                        reasoning_texts.append(think_text)
                                                elif item.get("type") == "text":
                                                    text = item.get("text", "")
                                                    if text:
                                                        content_texts.append(text)
                                        
                                        if content_texts:
                                            record["content"] = "\n".join(content_texts)
                                        else:
                                            record["content"] = ""

                                        if reasoning_texts:
                                            record["reasoning_content"] = "\n".join(reasoning_texts)
                                    
                                    else:
                                        combined_text = "\n".join(
                                            item.get("text", "") if isinstance(item, dict) else str(item)
                                            for item in content_list
                                            if item
                                        )
                                        record["content"] = combined_text
                                
                                messages.append(record)
                        except json.JSONDecodeError:
                            continue
                    
                    if messages:
                        # Extract the filename as the subagent ID
                        subagent_id = Path(context_file).name
                        
                        sub_messages.append({
                            "id": subagent_id,
                            "messages": messages,
                        })
                except Exception as e:
                    logger.warning(f"Failed to read subagent context {context_file}: {e}")
                    continue
            
            return sub_messages
        except Exception as e:
            logger.debug(f"No subagent contexts found: {e}")
            return []

    async def _get_container_diff(self) -> str:
        try:
            base_commit = self.instance.get("base_commit", "HEAD")
            result = await self.container.execute(
                ["bash", "-c", f"cd {self.working_dir} && git add -A && git diff --no-color --cached {base_commit}"],
                timeout=300,
                check=False,
            )
            return result.get("stdout", "")
        except Exception as e:
            logger.warning("Failed to get git diff: {}", str(e))
            return ""
