from pathlib import Path
from typing import override

from kosong.tooling import CallableTool2, ToolError, ToolOk, ToolReturnValue

from gitrekt_cli.soul.denwarenji import DenwaRenji, DenwaRenjiError, DMail
from gitrekt_cli.tools.utils import load_desc

NAME = "SendDMail"


class SendDMail(CallableTool2[DMail]):
    name: str = NAME
    description: str = load_desc(Path(__file__).parent / "dmail.md")
    params: type[DMail] = DMail

    def __init__(self, denwa_renji: DenwaRenji) -> None:
        super().__init__()
        self._denwa_renji = denwa_renji

    @override
    async def __call__(self, params: DMail) -> ToolReturnValue:
        try:
            self._denwa_renji.send_dmail(params)
        except DenwaRenjiError as e:
            return ToolError(
                output="",
                message=f"Failed to send D-Mail. Error: {str(e)}",
                brief="Failed to send D-Mail",
            )
        return ToolOk(
            output="",
            message=(
                "If you see this message, the D-Mail was NOT sent successfully. "
                "This may be because some other tool that needs approval was rejected."
            ),
            brief="El Psy Kongroo",
        )
