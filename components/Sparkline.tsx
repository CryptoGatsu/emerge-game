'use client';

/** A price line, small enough to sit inside a table row. */
export function Sparkline({ values, width, height, subtle = false }: {
  values: number[]; width: number; height: number; subtle?: boolean;
}) {
  if (values.length < 2) {
    return <svg width={width} height={height} className="sparkline" aria-hidden />;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * (height - 2) - 1).toFixed(1)}`);
  const rising = values[values.length - 1] >= values[0];
  const stroke = subtle ? (rising ? '#5fae4c' : '#a8654f') : (rising ? '#8bf16b' : '#e0785f');

  return (
    <svg width={width} height={height} className="sparkline" aria-hidden>
      {!subtle && (
        <polygon
          points={`0,${height} ${points.join(' ')} ${width},${height}`}
          fill={rising ? 'rgba(139,241,107,0.12)' : 'rgba(224,120,95,0.12)'}
        />
      )}
      <polyline points={points.join(' ')} fill="none" stroke={stroke} strokeWidth={subtle ? 1 : 1.6} />
    </svg>
  );
}
