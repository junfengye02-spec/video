export const WALLET_UNITS_PER_CNY = 1_000_000;

const cnyFormatter = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  currencyDisplay: "narrowSymbol",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatCnyUnits(units: number): string {
  return cnyFormatter.format(units / WALLET_UNITS_PER_CNY);
}
