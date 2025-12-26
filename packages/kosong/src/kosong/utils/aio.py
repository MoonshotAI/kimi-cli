import inspect
from collections.abc import Awaitable, Callable

type Callback[**Params, Return] = Callable[Params, Awaitable[Return] | Return]


async def callback[**Params, Return](
    fn: Callback[Params, Return], *args: Params.args, **kwargs: Params.kwargs
) -> Return:
    ret = fn(*args, **kwargs)
    if inspect.isawaitable(ret):
        return await ret
    return ret
