export function aggregate(values, operation, quantile = 50) {
  if (!values.length) return 0;
  if (operation === 'count') return values.length;
  if (operation === 'sum') return values.reduce((a, b) => a + b, 0);
  if (operation === 'product') return values.reduce((a, b) => a * b, 1);
  if (operation === 'min') return values.reduce((a, b) => Math.min(a, b), Infinity);
  if (operation === 'max') return values.reduce((a, b) => Math.max(a, b), -Infinity);
  const sorted = [...values].sort((a, b) => a - b), position = (sorted.length - 1) * quantile / 100;
  const index = Math.floor(position), fraction = position - index;
  return sorted[index] + (sorted[Math.min(index + 1, sorted.length - 1)] - sorted[index]) * fraction;
}
