// Pure time/percent math for the Gantt-chart EPG grid (EpgGrid.tsx) — kept dependency-free so
// it's directly unit-testable without pulling in React/JSX.
export function pct(t: number, start: number, end: number): number {
  if (end <= start) return 0
  return Math.min(100, Math.max(0, ((t - start) / (end - start)) * 100))
}
