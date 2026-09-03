/**
 * The charts, and the islands on them.
 *
 * Pure geometry and names, with no dependency on the simulation or the
 * renderer, because the server needs it too: the API route that hands out newly
 * surveyed land has to know how many plots a chart holds, and pulling
 * `lib/world/plots.ts` in for that would drag the whole world model into a
 * request handler.
 *
 * `lib/world/plots.ts` re-exports everything here, so nothing else had to move.
 */

export interface Island {
  name: string;
  /** Centre and radii on the map, normalised to 0-1. */
  x: number;
  y: number;
  rx: number;
  ry: number;
  /** How many plots this island has room for. */
  capacity: number;
  /** Noise offset, so no two islands share a coastline. */
  shape: number;
}

/**
 * The chain, laid out with real water between the islands.
 *
 * The gaps are wider than they look they need to be. Each coastline is an
 * ellipse pushed about a third of its radius by noise, so two islands whose
 * ellipses merely fail to touch will still grow into one another and land as a
 * single blob with three names printed on it.
 */
/**
 * The home chart, hand-placed so no two coastlines merge.
 *
 * Every other chart is this geometry mirrored and thinned, which is deliberate:
 * the gaps here were tuned by eye against the noise that roughens each coast,
 * and a freshly generated set of ellipses reliably produced two islands grown
 * into one blob with three names printed across it. Mirroring cannot introduce
 * an overlap that is not already here.
 */
const HOME_CHART: Island[] = [
  // Capacity is set by how much coast there actually is. A skerry a twentieth
  // of the map wide was carrying three settlements, whose markers landed within
  // thirty pixels of each other with a name on each — the crowding the player
  // saw. One island, one town, unless there is room for more.
  { name: 'Fernrest', x: 0.24, y: 0.43, rx: 0.20, ry: 0.31, capacity: 4, shape: 0 },
  { name: 'Kestrel Reach', x: 0.70, y: 0.20, rx: 0.16, ry: 0.16, capacity: 3, shape: 311 },
  { name: 'Saltmarch', x: 0.68, y: 0.76, rx: 0.16, ry: 0.17, capacity: 3, shape: 907 },
  { name: 'Ashen Skerry', x: 0.90, y: 0.47, rx: 0.05, ry: 0.10, capacity: 1, shape: 2203 },
  { name: 'Tidewick', x: 0.46, y: 0.86, rx: 0.09, ry: 0.08, capacity: 2, shape: 3391 },
  { name: 'Windrow Holm', x: 0.16, y: 0.90, rx: 0.10, ry: 0.07, capacity: 2, shape: 1451 },
  { name: 'Gale Rock', x: 0.47, y: 0.10, rx: 0.07, ry: 0.07, capacity: 1, shape: 4177 },
  { name: 'Farholt', x: 0.90, y: 0.87, rx: 0.06, ry: 0.09, capacity: 1, shape: 5051 },
];

/**
 * Names for the islands of charts past the first: eight per chart, in blocks,
 * so no name appears on two charts. Sharing a pool with a stride shorter than a
 * chart's island count put Grey Mull and Sable Isle on both Chart 2 and Chart
 * 3, which makes two different places look like the same one.
 */
const ISLAND_NAMES = [
  'Corrach', 'Brindle Holm', 'Stormward', 'Hallow Skerry', 'Lambert Rock', 'Netherhaigh',
  'Cold Sound', 'Marrowbank',
  'Quillhaven', 'Torrin', 'Grey Mull', 'Sable Isle', 'Wrackreach', 'Ossory',
  'Thrushmere', 'Barrenhead',
  'Fallowsound', 'Lorn', 'Kittiwake', 'Sunder Rock', 'Halloway', 'Verne',
  'Cape Alder', 'Drumcarrow',
  'Ferrishaw', 'Coldbarrow', 'Rimewatch', 'Anvil Rock', 'Mewstone', 'Salter Holm',
  'Larkspit', 'Undermere',
  'Hollowsound', 'Craigmar', 'Petrel Isle', 'Bleak Ness', 'Fastnet', 'Longhaven',
  'Turnstone', 'Cairnmuir',
  'Gannet Holm', 'Ravensbeck', 'Sorrel Isle', 'Blackstaff', 'Wending Rock', 'Harrowmere',
  'Gullcry', 'Dunmore',
  'Ashlar', 'Tarnwater', 'Kelpie Skerry', 'Northbarrow', 'Fenwick Holm', 'Sallow Ness',
  'Orrin', 'Grimsby Rock',
  'Heronmere', 'Stillcove', 'Brackenholm', 'Mirrorsound', 'Tallowhead', 'Crakemoor',
  'Wyvern Rock', 'Lindisfell',
  'Cormorant Isle', 'Slatehaven', 'Pinfold', 'Eastern Skerry', 'Marram Holm', 'Duskwater',
  'Selkie Rock', 'Haverfold',
  'Whinstone', 'Loamsound', 'Redmere', 'Tern Isle', 'Skarrow', 'Bellhaven',
  'Oxbow Rock', 'Wintermarch',
  'Ashridge', 'Coppermere', 'Saltcove', 'Feathercairn', 'Umberholm', 'Greylag Isle',
  'Kestrel Skerry', 'Endhaven',
];

/** The first chart, kept as a name because the world map opens on it. */
export const HOME_CHART_INDEX = 0;

/**
 * How many berths on the home chart are already spoken for.
 *
 * The world map opens with nine plots on it, and they stand in the first nine
 * slots of chart zero. Anything surveyed there has to start after them.
 *
 * It lives here, in the module with no dependencies, because the relay is the
 * side that hands out slots and it had no way to know this. It gave the first
 * survey on the home chart slot zero — the slot the first opening plot is
 * standing in — so the new settlement was drawn at exactly the same point as an
 * existing one, one marker's label flat on top of another's, and the plot
 * underneath could be neither read nor tapped. Every survey after it did the
 * same, nine deep.
 *
 * `lib/world/plots.ts` asserts its catalogue is this long, so the two cannot
 * drift apart quietly.
 */
export const HOME_CHART_RESERVED = 9;

/**
 * How many charts a player can sail between.
 *
 * Not unlimited, because "somewhere else to look" stops meaning anything when
 * there is always somewhere else: with enough charts the world map becomes a
 * slot machine rather than a map. Twelve charts of seventeen berths is room for
 * about two hundred settlements, which is the size of world the game is
 * sized for.
 */
export const CHART_COUNT = 12;

/** How many plots the whole world has room for, across every chart. */
export function worldCapacity() {
  let total = 0;
  for (let chart = 0; chart < CHART_COUNT; chart++) total += chartCapacity(chart);
  return total;
}

/** A chart's name, as the world map prints it. */
export function chartName(chart: number) {
  return chart === HOME_CHART_INDEX ? 'The Home Chart' : `Chart ${chart + 1}`;
}

/**
 * The islands of one chart.
 *
 * Mirrored from the home chart along one or both axes, with fresh names and
 * fresh coastline noise, so no two charts read as the same water. Every chart
 * keeps all eight islands: the thinning that used to vary them cost the world
 * a fifth of its land, and the mirror and the noise are variety enough.
 */
export function islandsFor(chart: number): Island[] {
  if (chart === HOME_CHART_INDEX) return HOME_CHART;
  const flipX = (chart & 1) === 1;
  const flipY = (chart & 2) === 2;
  return HOME_CHART.map((island, i) => ({
    ...island,
    name: ISLAND_NAMES[((chart - 1) * 8 + i) % ISLAND_NAMES.length],
    x: flipX ? 1 - island.x : island.x,
    y: flipY ? 1 - island.y : island.y,
    shape: island.shape + chart * 613 + 97,
  }));
}

/** How many plots a chart has room for in total. */
export function chartCapacity(chart: number) {
  return islandsFor(chart).reduce((sum, island) => sum + island.capacity, 0);
}

/**
 * Which island a slot on a chart belongs to, and its place on it.
 *
 * A slot past the chart's capacity has no island: the caller is expected to
 * have refused the prospecting rather than crowding another marker onto the
 * last skerry, which is what the eight islands of the home chart were doing
 * with fifty-six plots on them.
 */
export function islandOf(slot: number, chart = HOME_CHART_INDEX): { island: Island; slot: number } | null {
  let remaining = slot;
  for (const island of islandsFor(chart)) {
    if (remaining < island.capacity) return { island, slot: remaining };
    remaining -= island.capacity;
  }
  return null;
}

