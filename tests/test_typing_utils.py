from kimi_cli.utils.typing import flatten_union


class A:
    pass


class B:
    pass


type Foo = A | B | int | str
type Bar = Foo | float


def test_flatten_union():
    assert flatten_union(Foo) == (A, B, int, str)
    assert flatten_union(A | B | int | str) == (A, B, int, str)
    assert flatten_union(Bar) == (A, B, int, str, float)
    assert flatten_union(Foo | float) == (A, B, int, str, float)
