from kimi_cli.wire import get_wire_or_none
from kimi_cli.wire.message import WireMessage


def wire_send(msg: WireMessage) -> None:
    """
    Send a wire message to the current wire.
    Take this as `print` and `input` for souls.
    Souls should always use this function to send wire messages.
    """
    wire = get_wire_or_none()
    assert wire is not None, "Wire is expected to be set when soul is running"
    wire.soul_side.send(msg)
