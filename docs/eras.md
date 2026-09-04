# Era advancement — design and readiness audit

The plan this was built from, kept as a record. Everything in the "Order of
work" is done as of v1.5: the framework, categories and Township (v1.4), then
Industrial, Modern and AI (v1.5). Where the shipped game differs from the
table below, the game and the guide are right.

## The rule

An owner may advance their plot to the next era **once the plot has earned it**
and for **1,000,000 $EMERGE, burned**. Every era is a step in one direction;
there is no going back. The era is a property of the plot (the world save, the
published snapshot and the claim row, exactly like an expansion), so it follows
the land to any device and to a buyer.

Two gates, both required:

| Gate | Why |
|---|---|
| **Days lived** in the current era | Time is the one thing money cannot buy; the wall-clock-paced yield already works this way. |
| **Advancement made** in the current era | A settlement has to *be* something before it becomes the next thing. Each era has its own checklist, drawn from things the simulation already measures. |

The cost is the same at every step. The gates get steeper.

## The eras

Five, from where the game is now to where the name of the game points.

| # | Era | What it looks like | What arrives | Days | Advancement gate |
|---|---|---|---|---|---|
| 1 | **Settlement** (today) | Timber and thatch, hand tools, dirt lanes, everybody on foot | — | — | — |
| 2 | **Township** | Stone and brick, tiled roofs, cobbled streets, carts and horses, ferries across the water | Cart and horse on the roads; **ferry** across channels without a bridge; Chapel, Guildhall, Brewery, Printer; a Harbour on the shore | 60 | 40 people, 30 buildings, a Town Hall, a Bank, a School, and a Jail; treasury 20,000 Gold; no ruins standing |
| 3 | **Industrial** | Brick and iron, chimneys, gaslight, rail, steamboats | Factory, Foundry, Railway Station, Telegraph, Gasworks; **rail** between districts; **steamboat** on the water; coal as a resource; smog that touches happiness | 90 | 70 people, 50 buildings, Lab and Library built, 300 iron in the store, the outer belt expanded |
| 4 | **Modern** | Concrete, glass, tarmac, streetlights at night | **Cars and bikes** on the roads; **motorboats and a car ferry**; Bus Depot, Hospital, Supermarket, Office, Stadium, Power Plant; electricity as a utility; a proper night with lit windows | 120 | 110 people, 75 buildings, Hospital and Stadium, 600 Gold a day in trade, plot expanded |
| 5 | **AI** | Clean lines, light, gardens on roofs, quiet | Autonomous pods on the roads, drones, hydrofoils; Data Centre, Research Campus, Vertical Farm, Clinic becomes Med Bay; NPCs gain an "assistant" who takes chores; the settlement plans its own districts and asks the owner to approve them | 150 | 160 people, 100 buildings, Research Campus, Power Plant, plot expanded, stewardship score above 0.7 for 30 straight days |

Each era **keeps everything from the one before**: buildings stay, people stay,
the map stays. What changes is what can be built, how people move, and what
everything looks like.

## What a step actually changes

Read from the code. Every line below names the module that has to learn about
eras.

### 1. The world itself — `lib/simulation.ts`

- `World.era: 1 | 2 | 3 | 4 | 5` and `World.eraSince: number` (the day it was
  entered). Saved in `KEEP`, published, and read back like `expanded`.
- `advanceEra(world)` and `eraGate(world): { ready: boolean; missing: string[] }`
  so the panel can list what is still needed, the way the Plot Helper does.
- `BUILD_COSTS`, `TRADE_BUILD_COST` and `SELF_BUILD_COST` become era-aware: a
  building has a `minEra`, and the settlement's own builder (`adviseBuild`,
  the self-build path) only raises what the era allows.
- `JOBS` gains trades per era (miller and blacksmith stay; factory hand, rail
  worker, driver, nurse, engineer, technician arrive).
- **Pace.** People walk at one pace today (`pace = busy ? 1.8 : 1`). Vehicles
  are not new movers: a citizen who owns or boards one moves at the vehicle's
  pace along roads only, drawn as the vehicle. Township carts ×1.6, Industrial
  rail ×3 between stations, Modern bikes ×2.2 and cars ×4, AI pods ×4 with
  no stops. Road-only movement means the nav grid needs a "road" allow flag,
  which `lineClear`/`findDetour` already take as `allow`.
- **Water.** Islets are reachable only by bridge today (`connectedIslands`,
  `bridgeWorks`). A Harbour (Township) opens a ferry: any shore with a Harbour
  counts as connected without a bridge, and people crossing are drawn on a
  boat. Steamboat, motorboat and hydrofoil are the same mechanic at higher
  pace with new art. Bridges stay; they are still faster for short spans.
- **Hazards.** Fires matter more in Settlement, plague in Township and
  Industrial, floods everywhere; Industrial adds smog as a slow happiness
  drain that a Gasworks upgrade or the Modern era clears.
- **Yield.** Stewardship stays wall-clock paced and capped. An era raises the
  *quality* a settlement can reach, not the cap: `stewardshipScore` already
  rewards housing, food, work, mood and safety, and later eras make each of
  those easier to hold at scale.

### 2. Building categories — `components/Panels.tsx`, `lib/render/buildings.ts`

Twenty-five recipes today, one flat list. Categories, shown as tabs in the
Build panel and used by the self-builder:

| Category | Today | Later |
|---|---|---|
| **Homes** | House | Terrace, Apartment, Tower |
| **Food** | Farm, Fishery, Lodge, Forager, Mill, Bakery | Brewery, Cannery, Supermarket, Vertical Farm |
| **Materials** | Woodcutter, Quarry, Mine, Carpenter, Blacksmith, Tailor | Foundry, Factory, Sawmill, Fabrication Lab |
| **Civic** | Town Hall, Jail, Storage, Market, Bank | Guildhall, Chapel, Courthouse, Council |
| **Care & learning** | School, Clinic, Library, Lab | Hospital, University, Research Campus, Med Bay |
| **Leisure** | Tavern, Cafe, Studio | Theatre, Stadium, Park, Arcade |
| **Transport** | — | Harbour, Stables, Railway Station, Bus Depot, Garage, Pod Hub, Drone Port |
| **Utilities** | — | Gasworks, Power Plant, Water Works, Data Centre |

Each recipe gets `category` and `minEra`. The panel filters by era and groups
by category; the guide's building table follows the same data.

### 3. Art per era — `lib/render/buildings.ts`, `character.ts`, `citizenSprite.ts`, `tiles.ts`, `props.ts`

All art is procedural pixel art built at load into one atlas (`assets.ts`).
That is the good news: an era is a *palette and recipe set*, not a folder of
files.

- **Buildings.** `buildingArtKey(type, id, level)` already picks a variant per
  building. Add the era to the key. Each recipe gets an era-specific body: the
  same footprint, a different wall material, roof line and window pattern.
  Settlement timber → Township stone and tile → Industrial brick and iron →
  Modern concrete and glass → AI white composite and light strips. Buildings
  raised in an earlier era keep their look until the owner *improves* them,
  which is the existing upgrade path — so a Modern town still has an old stone
  chapel in the middle, which is right.
- **People.** `character.ts` draws bodies and `citizenSprite.ts` dresses them by
  trade. Add an era to `dressFor`: cloth and leather → wool coats and hats →
  caps, aprons and overalls → jackets, jeans, helmets on bikes → light suits
  with a soft glow at the collar. Same bodies, different clothes, so nobody's
  face changes when the era does.
- **Vehicles** are new sprites: cart, horse, ferry, locomotive and carriage,
  steamboat, bike, car (three colours), bus, motorboat, pod, drone, hydrofoil.
  Four facings each, two frames. Drawn in `props.ts`-style recipes and
  registered in the atlas.
- **Ground.** `tiles.ts` road tiles: dirt → cobble → setts with rails → tarmac
  with markings → smooth pale composite. Roads are a polyline already; only
  the tile art changes. Street lights are props placed along roads from
  Industrial on, lit at night.
- **Sound.** `soundscape.ts` layers per era: carts and hooves, steam and
  whistles, traffic and a distant siren, a near-silent hum.

### 4. Interface — `components/Hud.tsx`, `Panels.tsx`, `lib/hud.ts`

- Era name in the World Status panel, with days in the era.
- An **Era** card in the On-Chain panel: the current era, the next one, the
  gate checklist with what is still missing, and the button at 1,000,000
  $EMERGE when every line is met. Greyed with the reason otherwise.
- The Build panel gains category tabs and greys out buildings above the era.
- The world map marks each plot's era on its pin, so a visitor knows what they
  are walking into.
- A card and a feed line on advancing; the guide gets an Eras section with
  one picture per era.

### 5. Server — `lib/server/registry.ts`, `app/api/plots/route.ts`

- `Claim.era` and `Claim.eraAt`. `/api/plots` gains `advance: true` with the
  same burn verification as expansion, and refuses a step the gate does not
  allow: the server re-runs `eraGate` on the published snapshot rather than
  trusting the client, which is the same posture as the payout route.
- The published world carries `era` in its headline so the map can show it
  without reading every snapshot.

## Readiness audit — what exists, what is missing

| Feature | State today | Era work |
|---|---|---|
| World save and publish | Field list `KEEP`, published, regression-proof | Add `era`, `eraSince` |
| Claim row | `expandedAt`, `hand`, `hiring`, offers | Add `era`, `eraAt` |
| Burn-verified purchases | Survey and expansion use `verifyBurn` + `spendBurn` | Reuse for `advance` |
| Building recipes | 25, flat, one look each, upgrade level 1–3 | Category, `minEra`, era bodies |
| Trades | 12 working jobs, one building each | Era trades and their buildings |
| Movement | On foot, one pace, nav grid with `allow` flags | Road-only vehicle movement, vehicle sprites |
| Water | Bridges only (`connectedIslands`) | Harbour and ferry, then faster boats |
| Hazards | Fire, flood, earthquake, tornado, plague, rogues | Smog; era weighting |
| Yield | Wall-clock paced, capped, quality × attention | Unchanged rule; more room to reach quality |
| Art pipeline | Procedural atlas at load, keyed by type/id/level | Era in every key; five palettes |
| Sound | Procedural layers by weather and time | Per-era layers |
| Guide and notes | Wiki en/zh with figures, update notes | Eras section, pictures, notes entry |
| Tests | Headless harness + Playwright per feature | Gate tests headless; advance test in the browser |

## Order of work

1. **Data first.** `era` on the world, the claim and the snapshot; `eraGate`;
   the On-Chain card with the checklist and the charge. Nothing visible
   changes yet, but a plot can advance and the registry records it.
2. **Categories.** Recipe metadata, Build panel tabs, self-builder filter.
3. **Township.** New buildings, carts and horses on roads, the Harbour and
   ferry, Township art for buildings, clothes and roads. This is the template
   every later era follows.
4. **Industrial**, **Modern**, **AI** in turn, each a set of recipes, movers,
   art and sound on the same rails.
5. Guide, notes, translations, tests, and the X post, at each step rather
   than at the end.

Each era is a shippable release on its own. Township can go out as v1.4 with
the framework; the rest follow.
