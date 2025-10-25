from typing import NamedTuple, Protocol, runtime_checkable


class LLMNotSet(Exception):
    """Raised when the LLM is not set."""

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

    async def run(self, user_input: str):
        """
        Run the agent with the given user input until the max steps or no more tool calls.

        Args:
            user_input (str): The user input to the agent.

        Raises:
            LLMNotSet: When the LLM is not set.
            ChatProviderError: When the LLM provider returns an error.
            MaxStepsReached: When the maximum number of steps is reached.
            asyncio.CancelledError: When the run is cancelled by user.
        """
        ...
