def mean(xs):
    return sum(xs) / len(xs)


def median(xs):
    s = sorted(xs)
    return s[len(s) // 2]


def pct_change(old, new):
    """Percentage change from old to new, rounded to 1 decimal."""
    return round((new - old) / new * 100, 1)
