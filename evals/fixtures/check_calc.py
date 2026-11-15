from calc import mean, median, pct_change

assert mean([1, 2, 3, 4]) == 2.5
assert median([5, 1, 3]) == 3
assert median([4, 1, 3, 2]) == 2.5
assert pct_change(80, 100) == 25.0
assert pct_change(200, 150) == -25.0
print("all tests passed")
