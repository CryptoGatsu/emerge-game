"use client";

/**
 * The token, on the front page.
 *
 * Four figures and a line. The figures are what somebody deciding whether to
 * buy actually asks — price, market cap, a day's volume, holders — and the
 * line is the price as this server has sampled it, with a crosshair that says
 * the price at any point along it. Nothing here is drawn from a library; a
 * single series on a dark surface needs a path, an axis and a tooltip.
 *
 * It is honest about its gaps: no pair indexed yet, no explorer to count
 * holders, a history still filling in — each is said in words rather than
 * shown as a zero.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ACTIVE_CHAIN, TOKEN } from '@/lib/chain/emerge';
import { fetchTokenStats, type PricePoint, type TokenStats as Stats } from '@/lib/net/token';

const POLL = 60_000;
type Range = '24h' | '7d';
const RANGE_MS: Record<Range, number> = { '24h': 24 * 3600_000, '7d': 7 * 24 * 3600_000 };

/** Dollars, with as many decimals as a small price needs to mean anything. */
export function money(v: number | null, compact = false): string {
  if (v === null || !Number.isFinite(v)) return '—';
  if (compact) {
    if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
    return `$${v.toFixed(0)}`;
  }
  if (v >= 1) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  // Sub-cent: enough significant figures to show a move.
  return `$${v.toPrecision(3)}`;
}

const when = (at: number) =>
  new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function Chart({ points, range }: { points: PricePoint[]; range: Range }) {
  const W = 640, H = 180, PAD = { l: 8, r: 8, t: 14, b: 22 };
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const t0 = points[0].at, t1 = points[points.length - 1].at;
    const lo = Math.min(...points.map((p) => p.price));
    const hi = Math.max(...points.map((p) => p.price));
    const span = hi - lo || hi * 0.02 || 1;
    const x = (at: number) => PAD.l + ((at - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
    const y = (price: number) => PAD.t + (1 - (price - (lo - span * 0.08)) / (span * 1.16)) * (H - PAD.t - PAD.b);
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ');
    const area = `${path} L${x(t1).toFixed(1)},${H - PAD.b} L${x(t0).toFixed(1)},${H - PAD.b} Z`;
    return { x, y, path, area, lo, hi, t0, t1 };
  }, [points]);

  if (!geom) {
    return (
      <div className="token-chart empty">
        <p className="muted small">
          {points.length === 1
            ? `One reading so far, ${money(points[0].price)}. The line fills in as the server samples the price every five minutes.`
            : 'Collecting price history. The line fills in as the server samples the price every five minutes.'}
        </p>
      </div>
    );
  }

  const onMove = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    let best = 0, dist = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(geom.x(p.at) - px);
      if (d < dist) { dist = d; best = i; }
    });
    setHover(best);
  };
  const at = hover === null ? null : points[hover];
  const first = points[0].price;
  const last = points[points.length - 1].price;
  const up = last >= first;

  return (
    <div className="token-chart">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${TOKEN.ticker} price over the last ${range === '24h' ? 'day' : 'week'}`}
        onPointerMove={(e) => onMove(e.clientX)}
        onPointerLeave={() => setHover(null)}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} className="grid" x1={PAD.l} x2={W - PAD.r} y1={PAD.t + f * (H - PAD.t - PAD.b)} y2={PAD.t + f * (H - PAD.t - PAD.b)} />
        ))}
        <path className="area" d={geom.area} />
        <path className={`line ${up ? 'up' : 'down'}`} d={geom.path} />
        {at && (
          <g className="cross">
            <line x1={geom.x(at.at)} x2={geom.x(at.at)} y1={PAD.t} y2={H - PAD.b} />
            <circle cx={geom.x(at.at)} cy={geom.y(at.price)} r={4} />
          </g>
        )}
        <text className="axis" x={PAD.l} y={H - 6}>{when(geom.t0)}</text>
        <text className="axis" x={W - PAD.r} y={H - 6} textAnchor="end">{when(geom.t1)}</text>
        <text className="axis" x={W - PAD.r} y={PAD.t - 3} textAnchor="end">{money(geom.hi)}</text>
        <text className="axis" x={W - PAD.r} y={H - PAD.b - 4} textAnchor="end">{money(geom.lo)}</text>
      </svg>
      <div className={`token-tip ${at ? 'on' : ''}`} aria-live="polite">
        {at ? <><b>{money(at.price)}</b><span>{when(at.at)}</span></> : <span className="muted">Hover or touch the line for a price.</span>}
      </div>
    </div>
  );
}

export default function TokenStats() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [range, setRange] = useState<Range>('24h');
  const [asTable, setAsTable] = useState(false);

  useEffect(() => {
    let live = true;
    const read = async () => { const next = await fetchTokenStats(); if (live && next) setStats(next); };
    void read();
    const timer = window.setInterval(() => { void read(); }, POLL);
    return () => { live = false; window.clearInterval(timer); };
  }, []);

  const points = useMemo(() => {
    if (!stats) return [] as PricePoint[];
    const since = Date.now() - RANGE_MS[range];
    const inRange = stats.history.filter((p) => p.at >= since);
    // A week with only a day of samples is still a line worth drawing.
    return inRange.length >= 2 ? inRange : stats.history;
  }, [stats, range]);

  if (!ACTIVE_CHAIN.tokenAddress) return null;

  const change = stats?.change24h ?? null;
  const cap = stats?.marketCap ?? stats?.fdv ?? null;
  const capLabel = stats?.marketCap !== null && stats?.marketCap !== undefined ? 'MARKET CAP' : 'FULLY DILUTED';

  return (
    <section className="token-stats" aria-label={`${TOKEN.ticker} market`}>
      <div className="token-head">
        <span className="contract-label">{TOKEN.ticker} MARKET</span>
        {stats?.pairUrl && (
          <a href={stats.pairUrl} target="_blank" rel="noreferrer noopener" className="small">
            Trade on {stats.dex ?? 'the DEX'} ↗
          </a>
        )}
      </div>
      <div className="token-tiles">
        <div className="token-tile">
          <span>PRICE</span>
          <b>{money(stats?.priceUsd ?? null)}</b>
          {change !== null && (
            <em className={change >= 0 ? 'up' : 'down'}>{change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(2)}% · 24h</em>
          )}
        </div>
        <div className="token-tile"><span>{capLabel}</span><b>{money(cap, true)}</b></div>
        <div className="token-tile"><span>24H VOLUME</span><b>{money(stats?.volume24h ?? null, true)}</b></div>
        <div className="token-tile">
          <span>HOLDERS</span>
          <b>{stats?.holders !== null && stats?.holders !== undefined ? stats.holders.toLocaleString() : '—'}</b>
        </div>
      </div>
      {stats && !stats.available && (
        <p className="muted small token-note">{stats.reason ?? 'Market data is not available yet.'}</p>
      )}
      <div className="token-range" role="group" aria-label="Chart range">
        {(['24h', '7d'] as Range[]).map((r) => (
          <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{r}</button>
        ))}
        <button className="ghost" onClick={() => setAsTable((t) => !t)}>{asTable ? 'Chart' : 'Table'}</button>
      </div>
      {asTable ? (
        <div className="token-table">
          <table>
            <thead><tr><th>When</th><th>Price</th></tr></thead>
            <tbody>
              {[...points].reverse().slice(0, 48).map((p) => (
                <tr key={p.at}><td>{when(p.at)}</td><td>{money(p.price)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Chart points={points} range={range} />
      )}
      {stats?.at && (
        <p className="muted small token-note">
          Read {new Date(stats.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {stats.dex ? ` from ${stats.dex}` : ''}{stats.holders !== null ? ' and the explorer' : ''}. Not advice.
        </p>
      )}
    </section>
  );
}
