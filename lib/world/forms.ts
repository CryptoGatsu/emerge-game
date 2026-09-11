/**
 * What each building becomes in each age.
 *
 * An era used to arrive as a coat of paint, one more post at every workplace
 * and one more level on the cap, and players said what that felt like: a
 * longer list, not a new age. So now every building has a *form* for each
 * era — its own name, its own look, its own room, its own output and, for the
 * trades whose goods change, its own recipe — and advancing the plot rebuilds
 * every building into the next form and merges pairs of the same kind into
 * one, so the land that was wall to wall with cabins and sheds is open again.
 *
 * The table is data with no imports beyond a type, so the server, the wiki
 * and the map can all read it. The multipliers are per era, the same for
 * every kind; the names, blurbs and recipes are per kind. A building's form
 * is decided by the era it was raised or rebuilt in (`Building.era`), which
 * is what its picture is drawn from as well.
 */

import type { Resource } from './goods';

/** The five ages, by index: settlement, township, industrial, modern, AI. */
export type FormEra = 1 | 2 | 3 | 4 | 5;

export interface EraForm {
  /** The name over the door in this age. */
  name: string;
  /** What it does, for the Build panel and the card. */
  blurb: string;
  /** Posts at a workplace before improvement; absent on anything that employs nobody. */
  posts?: number;
  /** Beds in a house before improvement. */
  beds?: number;
  /** What each pair of hands makes, as a multiple of the settlement form's. */
  output: number;
  /** Gold and materials to raise, as a multiple of the settlement form's. */
  cost: number;
  /** Upkeep a day, as a multiple of the settlement form's. */
  upkeep: number;
  /** What the building counts for toward the city level and the era gates. */
  worth: number;
  /** The most it can be improved in this age. */
  cap: number;
  /** A recipe of its own, when the age changes what the trade makes. */
  makes?: { output: Partial<Record<Resource, number>>; input?: Partial<Record<Resource, number>> };
}

/**
 * The multipliers by age. Room doubles each age while the rebuild halves the
 * count, so a plot keeps its posts and its beds through an advance and every
 * building raised afterwards holds twice what the last age's did on the
 * same ground.
 *
 * Upkeep rises faster than room, and that is the point of it. It used to rise
 * more slowly, which meant every age was cheaper to hold per head than the one
 * before: a town's income roughly quadrupled from the settlement to the AI age
 * while its upkeep barely kept pace, so a city that did nothing at all still
 * made money every day and players ended up sitting on hundreds of thousands
 * of Gold with nothing pressing to spend it on. A data centre is not a
 * woodcutter's hut with better lighting. The later the age, the more of the
 * day's takings it costs to keep the lights on, so a great city has to be
 * worked rather than parked.
 */
const ROOM = [1, 2, 4, 8, 16];
const OUTPUT = [1, 1.15, 1.35, 1.6, 1.9];
const COST = [1, 1.9, 3.6, 6.8, 13];
const UPKEEP = [1, 2.2, 4.6, 9.5, 19];
const WORTH = [1, 2, 4, 8, 16];
/** The improvement cap by age: three, then a level more every second age. */
const CAP = [3, 4, 4, 4, 5];

/** Posts at a settlement-age workplace: three at a mine, two elsewhere. */
export const BASE_POSTS: Record<string, number> = { Mine: 3 };
export const DEFAULT_POSTS = 2;
/** Beds in a cabin. */
export const BASE_BEDS = 3;

interface Lineage {
  names: [string, string, string, string, string];
  blurbs: [string, string, string, string, string];
  /** Recipes by age, for the trades whose goods change; an age without one keeps the last. */
  makes?: Partial<Record<FormEra, EraForm['makes']>>;
}

/**
 * The buildings a settlement starts with, and what each becomes. Everything
 * else — the chapels, factories, hospitals and campuses that arrive with an
 * age — keeps its one name and is dressed by the age like the rest.
 */
const LINEAGES: Record<string, Lineage> = {
  House: {
    names: ['Cabin', 'Townhouse', 'Terrace', 'Apartment Block', 'Habitat Tower'],
    blurbs: [
      'A timber cabin: three beds and a hearth.',
      'A stone townhouse over two floors. Twice the beds of a cabin.',
      'A brick terrace of flats with a stack at the end. Twice the beds of a townhouse.',
      'A concrete block of flats with a lift and a roof line. Twice the beds of a terrace.',
      'A composite tower with gardens on every tenth floor. Twice the beds of a block.',
    ],
  },
  Farm: {
    names: ['Farm', 'Estate Farm', 'Mechanised Farm', 'Agri Complex', 'Agri-Tower'],
    blurbs: [
      'Wheat and vegetables from the fields.',
      'Fields, an orchard wall and a flock: wheat, vegetables and a little wool.',
      'Steam ploughs and a threshing barn: the same fields, worked by more hands and machines.',
      'Glasshouses and irrigation. Crops through most of the winter.',
      'Crops in tiers under grow-light, tended by hands and drones. Twice the posts of the complex.',
    ],
    makes: {
      2: { output: { wheat: 10, vegetables: 5, wool: 1 } },
      4: { output: { wheat: 10, vegetables: 6, wool: 1 } },
    },
  },
  Woodcutter: {
    names: ['Woodcutter', 'Timber Yard', 'Sawmill', 'Lumber Mill', 'Forestry Hub'],
    blurbs: [
      'Timber from the surrounding forest.',
      'A yard with a saw pit. Timber from the forest, cut to size.',
      'A steam saw. Far more timber from the same wood.',
      'A lumber mill with kilns and a loading bay.',
      'Managed forest, felled and replanted by machine.',
    ],
  },
  Fishery: {
    names: ['Fishery', 'Fish Wharf', 'Trawler Dock', 'Fishing Port', 'Aqua Farm'],
    blurbs: [
      'Fish from the shore, so build it by the water. Bait costs Gold, and a snapped rod costs timber.',
      'A stone wharf with boats. Fish from the shore and a little way out.',
      'Steam trawlers at a dock. Fish from deep water.',
      'A fishing port with cold stores.',
      'Fish raised in tanks, all year, whatever the sea is doing.',
    ],
  },
  Lodge: {
    names: ['Lodge', 'Hunting Lodge', 'Game Reserve', 'Ranger Station', 'Bio Reserve'],
    blurbs: [
      'Hunters stalk the wild ground for game and hides. Arrows cost timber.',
      'A hunting lodge with kennels. Game and hides from the wild ground.',
      'A managed reserve: game bred as well as stalked.',
      'Rangers with rifles and a smokehouse.',
      'A bio reserve where the herds are tracked and culled by drone.',
    ],
  },
  Forager: {
    names: ['Forager', "Gatherers' Camp", 'Herb Garden', 'Greenhouse', 'Bio Garden'],
    blurbs: [
      'Berries and herbs gathered from the wild ground.',
      'A camp with drying racks. Berries and herbs from the wild ground.',
      'A walled herb garden and berry beds beside the wild ground.',
      'A greenhouse: berries and herbs through the winter.',
      'A bio garden growing berries and herbs under light.',
    ],
  },
  Quarry: {
    names: ['Quarry', 'Stone Pit', 'Blast Quarry', 'Aggregate Works', 'Extractor'],
    blurbs: [
      'Cut stone from the highland.',
      'A stone pit with a crane. Cut stone from the highland.',
      'Blasting and a crusher. Far more stone from the same face.',
      'An aggregate works with conveyors.',
      'An automated extractor that takes stone with almost nobody on the face.',
    ],
  },
  Mine: {
    names: ['Mine', 'Pit Mine', 'Deep Mine', 'Drill Mine', 'Auto Mine'],
    blurbs: [
      'Iron ore from deep in the ridge.',
      'A pit with a winding gear. Iron ore from deeper in the ridge.',
      'A deep mine with a steam pump and rails.',
      'A drill mine with a lift and ventilation.',
      'An automated mine, its galleries cut by machine.',
    ],
  },
  Mill: {
    names: ['Mill', 'Watermill', 'Steam Mill', 'Roller Mill', 'Auto Mill'],
    blurbs: [
      'Turns wheat into flour.',
      'A watermill. Turns wheat into flour, more of it.',
      'A steam mill. Turns wheat into flour, far more of it.',
      'A roller mill: flour by the sack.',
      'An automated mill that runs all night.',
    ],
  },
  Bakery: {
    names: ['Bakery', 'Bakehouse', 'Cannery', 'Food Plant', 'Synth Kitchen'],
    blurbs: [
      'Turns flour into bread.',
      'A bakehouse with three ovens. Turns flour into bread.',
      'Bread from the ovens, and meals put up in tins from flour and vegetables. A meal feeds better than a loaf.',
      'A food plant: meals from flour, vegetables and fish, by the crate.',
      'A synth kitchen that turns flour and vegetables into meals with almost nothing wasted.',
    ],
    makes: {
      3: { output: { bread: 8, meals: 3 }, input: { flour: 10, vegetables: 3, wood: 2.5 } },
      4: { output: { meals: 9 }, input: { flour: 8, vegetables: 4, fish: 1 } },
      5: { output: { meals: 11 }, input: { flour: 6, vegetables: 4 } },
    },
  },
  Carpenter: {
    names: ['Carpenter', 'Joinery', 'Furniture Works', 'Furniture Factory', 'Print Works'],
    blurbs: [
      'Turns wood into furniture.',
      'A joinery with a lathe. Turns wood into furniture.',
      'A furniture works with steam saws.',
      'A furniture factory with a finishing line.',
      'A print works that fabricates furniture layer by layer.',
    ],
  },
  Blacksmith: {
    names: ['Blacksmith', 'Smithy', 'Ironworks', 'Machine Works', 'Fabricator'],
    blurbs: [
      'Turns ore into tools.',
      'A smithy with two forges. Turns ore into tools.',
      'An ironworks: tools from the forge, and steel from the furnace.',
      'A machine works: tools and steel from the line.',
      'A fabricator that turns ore into tools and steel with a fraction of the ore.',
    ],
    makes: {
      3: { output: { tools: 4, steel: 2 }, input: { ironOre: 10, wood: 4 } },
      4: { output: { tools: 5, steel: 4 }, input: { ironOre: 12, wood: 3 } },
      5: { output: { tools: 6, steel: 6 }, input: { ironOre: 14, wood: 2 } },
    },
  },
  Tailor: {
    names: ['Tailor', 'Draper', 'Textile Mill', 'Fashion House', 'Loom Lab'],
    blurbs: [
      'Turns wool into clothing.',
      "A draper's. Turns wool into clothing.",
      'A textile mill with power looms.',
      'A fashion house with a cutting floor.',
      'A loom lab that weaves clothing to measure.',
    ],
  },
  Storage: {
    names: ['Storage', 'Warehouse', 'Goods Depot', 'Logistics Hub', 'Auto Depot'],
    blurbs: [
      'Somewhere to keep the surplus.',
      'A stone warehouse. Somewhere to keep the surplus.',
      'A goods depot on the rails.',
      'A logistics hub with loading docks.',
      'An automated depot that stacks itself.',
    ],
  },
  Barracks: {
    names: ['Barracks', 'Garrison', 'Armoury', 'Base', 'Drone Bay'],
    blurbs: [
      'A drill yard and a hall of spears. Militia are trained here.',
      'A stone garrison with an armoury. Men-at-arms are trained here.',
      'A brick armoury with a rifle range. Riflemen are trained here.',
      'A base with motor pool and radio mast. The armoured corps is trained here.',
      'A drone bay with its handlers. The drone corps is trained here.',
    ],
  },
  Tavern: {
    names: ['Tavern', 'Inn', 'Public House', 'Bar', 'Lounge'],
    blurbs: [
      'Where the settlement gathers.',
      'An inn with rooms over the bar. Where the town gathers.',
      'A public house on the corner. Where the town gathers.',
      'A bar with a terrace. Where the city gathers.',
      'A lounge with a view. Where the city gathers.',
    ],
  },
};

/** The kinds that have a form for every age, and so are rebuilt and merged on an advance. */
export const LINEAGE_TYPES = Object.keys(LINEAGES);

/** Lineage kinds a plot keeps one of: renamed by the age, never merged, one building in any count. */
const ONE_OF: ReadonlySet<string> = new Set(['Tavern', 'Barracks']);

/** The kinds that merge in pairs when the plot advances: homes, workplaces and stores. */
export const MERGES_ON_ADVANCE = new Set(LINEAGE_TYPES.filter((t) => !ONE_OF.has(t)));

const clampEra = (era: number): FormEra => Math.max(1, Math.min(5, Math.round(era))) as FormEra;

/**
 * The form a kind of building takes in an age. A kind with no lineage of its
 * own keeps its name, and its multipliers count from the age it belongs to,
 * so a chapel raised in the township and one raised in the modern age are
 * different buildings.
 */
export function formOf(type: string, era: number, ownEra = 1): EraForm {
  const e = clampEra(era);
  const step = Math.max(0, e - clampEra(ownEra));
  const line = LINEAGES[type];
  const i = e - 1;
  const form: EraForm = {
    name: line ? line.names[i] : type,
    blurb: line ? line.blurbs[i] : '',
    // A home or a workplace counts for the room it holds against a
    // settlement's; a chapel or a factory is one building in any age.
    output: OUTPUT[step], cost: COST[step], upkeep: UPKEEP[step], worth: line && !ONE_OF.has(type) ? WORTH[e - 1] : 1, cap: CAP[e - 1],
  };
  if (type === 'House') form.beds = BASE_BEDS * ROOM[i];
  if (line?.makes) {
    // The latest recipe at or before this age.
    for (let k = e; k >= 1; k--) {
      const m = line.makes[k as FormEra];
      if (m) { form.makes = m; break; }
    }
  }
  return form;
}

/** The name of a kind of building in an age. */
export const formName = (type: string, era: number) => formOf(type, era).name;

/** The settlement-age posts of a workplace kind, before the age multiplies them. */
export const basePosts = (type: string) => BASE_POSTS[type] ?? DEFAULT_POSTS;

/** Posts at a workplace of this kind in this age, before improvement. */
export const formPosts = (type: string, era: number) => basePosts(type) * ROOM[clampEra(era) - 1];

/** Every name a kind has had or will have, for the translator and the wiki. */
export function formNames(type: string): string[] {
  const line = LINEAGES[type];
  return line ? [...line.names] : [type];
}

/** The kind behind a form's name, or null for a name that is nobody's. */
export function typeOfForm(name: string): string | null {
  for (const [type, line] of Object.entries(LINEAGES)) if (line.names.includes(name)) return type;
  return null;
}
