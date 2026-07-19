/** Parse a duration string ("10s", "5m", "2h", "500ms") into milliseconds. */
export function parseDuration(d: string): number {
  const m = d.match(/^(\d+)(ms|s|m|h)$/);
  if (!m) throw new Error(`invalid duration: ${d}`);
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms": return n;
    case "s": return n * 1000;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    default: throw new Error(`invalid duration unit: ${d}`);
  }
}
