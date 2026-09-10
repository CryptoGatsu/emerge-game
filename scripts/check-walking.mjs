/**
 * Every route the pathfinder hands back must be walkable.
 *
 * A detour is a list of points to walk to in turn. If any leg of it crosses
 * water or a wall, the walker is shoved back by the overlap rule, never
 * arrives, and stands about — which is what a plot with people piled in one
 * spot and empty buildings looks like from the outside. The bug that did
 * this was invisible on a base plot, whose grid starts at the origin, and
 * broke about half the routes on an expanded plot, whose grid starts at
 * -12.5: cells came back as world points without the grid's corner added.
 *
 * So this asks for hundreds of routes across several seeds, on base and
 * expanded plots alike, and checks each one leg by leg. Run it after
 * touching lib/world/nav.ts:
 *
 *   node scripts/check-walking.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = mkdtempSync(join(tmpdir(), 'emerge-walk-'));
try {
  execFileSync('npx', ['tsc', 'lib/simulation.ts', '--outDir', out, '--module', 'commonjs',
    '--target', 'es2020', '--moduleResolution', 'node', '--skipLibCheck', '--esModuleInterop'],
    { stdio: 'pipe' });
} catch {
  // tsc reports type errors from files this does not run; the emit is what matters.
}

const { createWorld, advance, waterOf } = await import(join(out, 'simulation.js'));
const NAV = await import(join(out, 'world', 'nav.js'));

let failures = 0;
const say = (label, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

for (const seed of [1120, 1020, 1365]) {
  for (const expanded of [false, true]) {
    let world = createWorld(seed, 'Probe');
    if (expanded) world.expanded = true;
    // A settlement with something standing in it: empty ground needs no detours.
    for (let d = 0; d < 30; d++) {
      world.gold = Math.max(world.gold, 200_000);
      for (let h = 0; h < 24; h++) world = advance(world, 1);
    }
    const water = waterOf(world);
    const extent = expanded
      ? { x0: -12.5, y0: -12.5, x1: 112.5, y1: 112.5 }
      : { x0: 0, y0: 0, x1: 100, y1: 100 };
    const obstacles = world.buildings.map((b) => ({ x: b.x, y: b.y, r: 2.2, id: b.id }));
    const grid = NAV.buildNavGrid(water, world.layout, obstacles, 'check', extent);
    const n = grid.n;
    const open = [];
    for (let i = 0; i < n * n; i++) if (!grid.blocked[i]) open.push(i);
    const from = open[0];
    const fx = (from % n) + extent.x0 + 0.5, fy = ((from / n) | 0) + extent.y0 + 0.5;

    let routes = 0, crossing = 0, adrift = 0, offPlot = 0;
    for (let k = 0; k < open.length; k += Math.max(1, Math.floor(open.length / 250))) {
      const cell = open[k];
      const tx = (cell % n) + extent.x0 + 0.5, ty = ((cell / n) | 0) + extent.y0 + 0.5;
      if (Math.hypot(tx - fx, ty - fy) < 5) continue;
      const route = NAV.findDetour(grid, fx, fy, tx, ty, -1);
      if (!route) continue;
      routes++;
      let px = fx, py = fy, blocked = false;
      for (const [wx, wy] of route) {
        if (wx < extent.x0 || wx > extent.x1 || wy < extent.y0 || wy > extent.y1) offPlot++;
        if (!NAV.lineClear(grid, px, py, wx, wy, -1)) blocked = true;
        px = wx; py = wy;
      }
      if (blocked) crossing++;
      if (Math.hypot(px - tx, py - ty) > 0.6) adrift++;
    }
    const where = `seed ${seed}${expanded ? ', expanded' : ''}`;
    say(`${where}: routes were found`, routes > 50, `${routes} routes`);
    say(`${where}: no route crosses water or a wall`, crossing === 0, `${crossing} of ${routes}`);
    say(`${where}: every route ends where it was asked to`, adrift === 0, `${adrift} of ${routes}`);
    say(`${where}: no waypoint lands off the plot`, offPlot === 0, `${offPlot} waypoints`);
  }
}

rmSync(out, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed.` : '\nAll good.');
process.exit(failures ? 1 : 0);
