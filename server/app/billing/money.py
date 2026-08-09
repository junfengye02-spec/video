WALLET_UNITS_PER_CNY = 1_000_000
WALLET_UNITS_PER_FEN = WALLET_UNITS_PER_CNY // 100


def ceil_div(numerator: int, denominator: int) -> int:
    if (
        type(numerator) is not int
        or type(denominator) is not int
        or numerator < 0
        or denominator <= 0
    ):
        raise ValueError("invalid integer ratio")
    return (numerator + denominator - 1) // denominator


def provider_micro_to_charge_units(
    provider_cost_micro: int, multiplier_bps: int
) -> int:
    if (
        type(provider_cost_micro) is not int
        or type(multiplier_bps) is not int
        or provider_cost_micro < 0
        or multiplier_bps <= 0
    ):
        raise ValueError("invalid integer ratio")
    raw_units = ceil_div(provider_cost_micro * multiplier_bps, 10_000)
    return ceil_div(raw_units, WALLET_UNITS_PER_FEN) * WALLET_UNITS_PER_FEN
