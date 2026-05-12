"use client";

interface Props {
  /** `weeks` columns, 7 rows. cells[w][d]. d=0 is the earliest day in the column. */
  cells: { date: string; count: number }[][];
  cellSize?: number;
  cellGap?: number;
  /** Two-stop color ramp `[low, high]`. */
  colorScale?: [string, string];
  className?: string;
}

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

function lerpHex(a: string, b: string, t: number): string {
  const r0 = parseInt(a.slice(1, 3), 16);
  const g0 = parseInt(a.slice(3, 5), 16);
  const b0 = parseInt(a.slice(5, 7), 16);
  const r1 = parseInt(b.slice(1, 3), 16);
  const g1 = parseInt(b.slice(3, 5), 16);
  const b1 = parseInt(b.slice(5, 7), 16);
  const r = Math.round(r0 + (r1 - r0) * t);
  const g = Math.round(g0 + (g1 - g0) * t);
  const bl = Math.round(b0 + (b1 - b0) * t);
  return `rgb(${r},${g},${bl})`;
}

export default function CalendarHeatmap({
  cells,
  cellSize = 11,
  cellGap = 2,
  colorScale = ["#1e293b", "#22c55e"],
  className = "",
}: Props) {
  const weeks = cells.length;
  if (weeks === 0) return null;

  const labelW = 14;
  const width = labelW + weeks * (cellSize + cellGap);
  const height = 7 * (cellSize + cellGap);

  let max = 0;
  for (const col of cells) for (const c of col) if (c.count > max) max = c.count;
  if (max === 0) max = 1;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      role="img"
      aria-label="Daily incident counts (last 12 weeks)"
    >
      {DAY_LABELS.map((d, row) => (
        <text
          key={`${d}-${row}`}
          x={0}
          y={row * (cellSize + cellGap) + cellSize - 1}
          fontSize={8}
          fill="var(--panel-text-muted)"
          opacity={row % 2 === 1 ? 1 : 0}
        >
          {d}
        </text>
      ))}
      {cells.map((col, w) =>
        col.map((cell, d) => {
          const t = cell.count === 0 ? 0 : 0.15 + 0.85 * (cell.count / max);
          return (
            <rect
              key={`${w}-${d}`}
              x={labelW + w * (cellSize + cellGap)}
              y={d * (cellSize + cellGap)}
              width={cellSize}
              height={cellSize}
              rx={2}
              fill={cell.count === 0 ? "var(--panel-input-bg)" : lerpHex(colorScale[0], colorScale[1], t)}
              opacity={cell.count === 0 ? 0.6 : 1}
            >
              <title>
                {cell.date}: {cell.count} incident{cell.count === 1 ? "" : "s"}
              </title>
            </rect>
          );
        })
      )}
    </svg>
  );
}
