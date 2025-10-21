from typing import TYPE_CHECKING, NamedTuple, Protocol, runtime_checkable

if TYPE_CHECKING:
    from kimi_cli.soul.wire import Wire


class ChatProviderNotSet(Exception):
    """Raised when the chat provider is not set."""

    pass


class MaxStepsReached(Exception):
    """Raised when the maximum number of steps is reached."""

    n_steps: int
    """The number of steps that have been taken."""

    def __init__(self, n_steps: int):
        self.n_steps = n_steps


class StatusSnapshot(NamedTuple):
    context_usage: float
    """The usage of the context, in percentage."""


@runtime_checkable
class Soul(Protocol):
    @property
    def name(self) -> str:
        """The name of the soul."""
        ...

    @property
    def model(self) -> str:
        """The LLM model used by the soul. Empty string indicates no LLM configured."""
        ...

    @property
    def status(self) -> StatusSnapshot:
        """The current status of the soul. The returned value is immutable."""
        ...

    async def run(self, user_input: str, wire: "Wire"):
        """
        Run the agent with the given user input.

        Args:
            user_input (str): The user input to the agent.
            wire (Wire): The wire to send events and requests to the UI loop.

        Raises:
            ChatProviderNotSet: When the chat provider is not set.
            ChatProviderError: When the LLM provider returns an error.
            MaxStepsReached: When the maximum number of steps is reached.
            asyncio.CancelledError: When the run is cancelled by user.
        """
        ...
