# Emerge

**A new world. A life of its own.**

Emerge is a living-world simulation of autonomous AI beings. Citizens wake, commute,
work, trade, eat, socialise and go home; the settlement's economy, weather and seasons
turn around them. You don't control them — you observe them, and shape the world they
live in.

Browser-first, built with Next.js (App Router), React 19, TypeScript and Pixi.js v8.
Deployed on Vercel. The token layer targets **Robinhood Chain** with the ticker
**$EMERGE**.

## Architecture

The project keeps a hard line between the world's *brain*, its *body* and the *window*
you watch it through. That separation is what lets the art be replaced without touching
behaviour, and the behaviour be tuned without touching the art.

```
lib/simulation.ts     The brain. Logical citizen positions, needs, jobs, production,
                      market, gatherings, friendships and the daily cycle. Owns no
                      rendering concepts whatsoever.
lib/speech.ts         Contextual speech lines derived from citizen state.
lib/hud.ts            Turns the live world into a small snapshot the interface renders.

lib/world/iso.ts      The only place world units (0-100) become isometric pixels.
lib/world/terrain.ts  Deterministic map generation: river, waterfall, pond, highland
                      shelf, ploughed fields, curved stone paths rasterised from the
                      simulation's road graph, and a few thousand scattered props.

lib/render/           The body. Procedural pixel art, generated at boot:
  pixelCanvas.ts        drawing primitives
  palette.ts            the colour script
  tiles.ts              terrain diamonds, water, cliffs, distant-canopy backdrop
  props.ts              trees, rocks, flowers, fences, lanterns, stalls, bridge, well
  buildings.ts          isometric buildings with lit-window overlays and door metadata
  character.ts          tintable character part masks (3 directions x 11 frames)
  assets.ts             the texture registry and atlas packer
  citizenSprite.ts      one citizen's visible body
  scene.ts             The window. Pixi application, camera, depth sorting, weather,
                       time-of-day light, speech bubbles, picking, build placement.

lib/chain/emerge.ts   Robinhood Chain config, $EMERGE identity and wallet connection.

components/           EmergeClient (world loop + scene lifecycle), Hud, Panels.
```

### Three clocks, deliberately separate

- **Simulation** advances on an animation-frame loop at 0.4 game-hours per real second
  (one day a minute at 1x), mutating a single world object that never enters React state.
- **Rendering** interpolates each citizen's drawn position toward their logical one and
  runs walk cycles off distance travelled, so movement stays smooth at any tick rate.
- **Interface** re-renders from a plain snapshot roughly five times a second.

### Swapping in authored art

Every texture resolves by name through `AssetLibrary`. To replace the generated art with
an authored sprite sheet, load it, slice it, and call `overrideTexture(name, texture)` for
each frame. Neither the renderer nor the simulation needs to change. Names are documented
at the top of `lib/render/assets.ts`.

## Running it

```bash
npm install
npm run dev     # http://localhost:3000
npm run build   # production build
```

## Controls

| Input | Action |
| --- | --- |
| Drag | Pan the camera (clamped to the world) |
| Scroll | Zoom about the cursor |
| Click | Select a citizen or building |
| Space | Pause / resume |
| `1` `2` `3` | 1x, 2x, 6x simulation speed |
| Esc | Close panels, cancel placement, clear selection |

## Blockchain

Emerge is hybrid by design. The living world — movement, needs, production ticks, every
routine AI decision — stays off-chain so the settlement is always responsive. The chain
is reserved for ownership, the token economy and player actions that want verifiable
settlement. `lib/chain/emerge.ts` is a dependency-free EIP-1193 layer that the simulation
never calls, so no wallet or contract interaction can stall a frame.

Network details are read from the environment, so the same build can target a development
network or mainnet:

```
NEXT_PUBLIC_CHAIN_TARGET=testnet|mainnet
NEXT_PUBLIC_ROBINHOOD_CHAIN_ID=
NEXT_PUBLIC_ROBINHOOD_RPC_URL=
NEXT_PUBLIC_ROBINHOOD_EXPLORER=
NEXT_PUBLIC_EMERGE_TOKEN=
NEXT_PUBLIC_ROBINHOOD_TESTNET_CHAIN_ID=
NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC_URL=
NEXT_PUBLIC_ROBINHOOD_TESTNET_EXPLORER=
NEXT_PUBLIC_EMERGE_TOKEN_TESTNET=
```

Until these are set, the Connect panel says so plainly and lists the actions the economy
layer is designed around rather than pretending to be wired up.

## Where this still needs work

- Final sprites are generated procedurally; the pipeline is ready for authored art but the
  authored art does not exist yet.
- Inspire is a settlement-wide mood and purpose nudge; it wants deeper mechanics.
- Relationships track co-presence and friendship only — no rivalries, families across
  generations, or memory.
- No contracts are deployed; the chain layer is connection and configuration only.
