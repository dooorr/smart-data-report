# -*- coding: utf-8 -*-
"""Mock FX rates for dashboard conversion (backend-only demo). Base: CNY."""

# How many CNY for 1 unit of foreign currency
MOCK_RATES_TO_CNY = {
    "CNY": 1.0,
    "USD": 7.25,
    "EUR": 7.85,
    "GBP": 9.15,
    "JPY": 0.048,
    "HKD": 0.93,
}

# UI 展示用（与 ISO 代码对应）
DISPLAY_SYMBOLS = {
    "CNY": "¥",
    "USD": "$",
    "EUR": "€",
    "GBP": "£",
    "JPY": "¥",
    "HKD": "HK$",
}


def display_symbol(ccy: str) -> str:
    c = (ccy or "CNY").upper()
    return DISPLAY_SYMBOLS.get(c, c + " ")


def get_mock_rates():
    """Return a shallow copy for API responses."""
    return dict(MOCK_RATES_TO_CNY)


def convert_amount(amount, from_ccy: str, to_ccy: str) -> float:
    """Convert scalar amount between currencies using mock CNY bridge."""
    if from_ccy == to_ccy:
        return float(amount)
    f = (from_ccy or "CNY").upper()
    t = (to_ccy or "CNY").upper()
    if f not in MOCK_RATES_TO_CNY or t not in MOCK_RATES_TO_CNY:
        return float(amount)
    # via CNY: amount_in_ccy = amount * rate(f); amount_out = amount_in_ccy / rate(t)
    in_cny = float(amount) * MOCK_RATES_TO_CNY[f]
    return in_cny / MOCK_RATES_TO_CNY[t]
