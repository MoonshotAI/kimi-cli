from __future__ import annotations

from pydantic import BaseModel, Field


# 本模块定义 D-Mail（D 邮件）机制：向过去的检查点回传一条消息。
# DenwaRenji 只维护「待发送的 D-Mail」与「检查点计数」两份会话级状态，
# 由 KimiSoul 主循环与 SendDMail 工具通过共享实例协作完成回传。

# D-Mail：指向某个历史检查点、需要回传的消息内容。
class DMail(BaseModel):
    message: str = Field(description="The message to send.")
    checkpoint_id: int = Field(description="The checkpoint to send the message back to.", ge=0)
    # TODO: allow restoring filesystem state to the checkpoint


# DenwaRenji 状态校验失败时抛出的异常。
class DenwaRenjiError(Exception):
    pass


# D-Mail 的会话级状态容器（仅内存，不负责持久化）。
class DenwaRenji:
    def __init__(self):
        self._pending_dmail: DMail | None = None
        self._n_checkpoints: int = 0

    # 由 SendDMail 工具调用，校验并登记一条待回传的 D-Mail。
    def send_dmail(self, dmail: DMail):
        """Send a D-Mail. Intended to be called by the SendDMail tool."""
        if self._pending_dmail is not None:
            raise DenwaRenjiError("Only one D-Mail can be sent at a time")
        if dmail.checkpoint_id < 0:
            raise DenwaRenjiError("The checkpoint ID can not be negative")
        if dmail.checkpoint_id >= self._n_checkpoints:
            raise DenwaRenjiError("There is no checkpoint with the given ID")
        self._pending_dmail = dmail

    # 由 soul 调用，同步当前已创建的检查点数量。
    def set_n_checkpoints(self, n_checkpoints: int):
        """Set the number of checkpoints. Intended to be called by the soul."""
        self._n_checkpoints = n_checkpoints

    # 由 soul 调用，取出并清空待发送的 D-Mail。
    def fetch_pending_dmail(self) -> DMail | None:
        """Fetch a pending D-Mail. Intended to be called by the soul."""
        pending_dmail = self._pending_dmail
        self._pending_dmail = None
        return pending_dmail
