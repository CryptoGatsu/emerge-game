'use client';

/**
 * The Emerge client.
 *
 * Owns three things and keeps them deliberately separate:
 *
 *   1. the world, a mutable simulation object advanced on an animation frame
 *      loop and never stored in React state,
 *   2. the scene, a Pixi renderer that reads the world every frame,
 *   3. the interface, which re-renders a few times a second from a plain
 *      snapshot rather than from the simulation's clock.
 *
 * Keeping the world out of React state is what lets thirty citizens walk at
 * sixty frames a second without the interface re-rendering thirty times a
 * second alongside them.
 *
 * Before any of that, a player has to claim a plot. Nothing here boots until
 * they have.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addSettler, advance, carryCitizenTo, collectYield, constructBuilding, createWorld,
  demolishBuilding, dropCitizen, drawFromTreasury, fundTreasury, grantResource, marketReport,
  RESOURCE_LABELS, pickUpCitizen, renameCitizen, renameWorld, setWageRate, setWorldPrices,
  takeSales,
  type World,
} from '@/lib/simulation';
import { clearWorld, loadWorld, saveWorld, snapshotOf, worldFromSave, type SavedWorld } from '@/lib/world/save';
import { GOODWILL, claimGoodwill } from '@/lib/world/grants';
import { snapshot, type Snapshot } from '@/lib/hud';
import { EmergeScene, type PickTarget } from '@/lib/render/scene';
import {
  adoptRecord, clearClaimedWorld, loadClaimedWorld, loadPlayer, savePlayer, saveClaimedWorld,
  withClaim, withoutClaim,
  type ClaimedWorld, type PlayerRecord,
} from '@/lib/world/plots';
import {
  GIFT_POLL, HEARTBEAT_INTERVAL, collectGifts, departWorld, fetchWorld, heartbeat, publishWorld,
  releasePlot, sendGift, visitorId,
} from '@/lib/net/registry';
import { fetchMarket, syncMarket } from '@/lib/net/market';
import { publishName } from '@/lib/net/names';
import { useWallet } from './WalletPicker';
import { Notices, chatNoticesOn, setChatNotices, useNotices } from './Notices';
import {
  EARNING_PLOT_LIMIT, EMERGE_PER_GOLD, RENAME_CITIZEN_EMERGE, RENAME_COST_EMERGE, accrue, charge,
  liveToken, type VaultLedger,
} from '@/lib/chain/vault';
import { tokenBalance } from '@/lib/chain/emerge';
import { onChainClaimsLive, releaseOnChain, renameOnChain } from '@/lib/chain/registry';
import { spend } from '@/lib/chain/spend';
import { DIG_COST_EMERGE, drawPrize, prizeStory, type Prize } from '@/lib/chain/gacha';
import { Soundscape } from '@/lib/audio/soundscape';
import PlotSelect from './PlotSelect';
import Landing from './Landing';
import { Hud } from './Hud';
import { Panels, type PanelKey } from './Panels';

/**
 * Game hours per real second at 1x.
 *
 * A day takes about two and a half minutes. It used to be one, and at that rate
 * citizens crossed the settlement in seconds and read as sped-up footage rather
 * than as people going about a day. Everything in the simulation is expressed
 * in game hours, so slowing the clock slows walking, work and trade together
 * and nothing needed rebalancing to match.
 */
const HOURS_PER_SECOND = 0.15;

/** How often the settlement is written down, in milliseconds. */
const SAVE_INTERVAL = 15_000;
/** How often the interface refreshes from the world. */
const HUD_INTERVAL = 180;

/**
 * How often the owner puts their settlement up for visitors, in milliseconds.
 *
 * Slower than the local save: a visitor watching a world a minute behind is
 * indistinguishable from one watching it live, and a snapshot is tens of
 * kilobytes rather than a field update.
 */
const PUBLISH_INTERVAL = 45_000;

/**
 * How often the wallet's real token balance is re-read, in milliseconds.
 *
 * Only runs when a token contract is configured. Slow, because a balance
 * changes when the player does something rather than on its own, and every
 * read is an RPC call.
 */
const BALANCE_POLL = 30_000;

/**
 * How often the settlement checks in with the world market, in milliseconds.
 *
 * The index moves in half-minute steps on the server, so asking much faster
 * would be asking the same question twice. This is also the settlement's own
 * report going out — one call carries both — and a world that stopped calling
 * stops counting toward the world's prices within a few minutes.
 */
const MARKET_POLL = 40_000;

/**
 * How often the settlement's takings are totted up for a card, and the least
 * they may come to before one is worth showing.
 *
 * Long enough that the cards are an occasional piece of good news rather than
 * a ticker, and a floor so a settlement shifting two wheat does not interrupt
 * anybody. A busy town trades a few hundred Gold in this window.
 */
const SALE_NOTICE_INTERVAL = 50_000;
/*
 * Set from what settlements actually take rather than by eye. A town's first
 * days move twenty to twenty-five Gold in a window and a busy one a hundred
 * and fifty, so a floor of sixty — which is where this started — said nothing
 * at all for the first week, which is exactly when a new player most needs to
 * see that their people are working.
 */
const SALE_NOTICE_GOLD = 20;

/**
 * The speeds on offer.
 *
 * 6x is gone. Yield is paced by the wall clock, so a fast-forward never paid
 * anything extra — but it let a player watch a year go by in an afternoon and
 * skip the part they are actually being paid for, which is attending to the
 * place. What is left is ordinary time and a gentle nudge.
 */
export const SPEEDS = [1, 2] as const;
export type Speed = (typeof SPEEDS)[number];

/**
 * Somebody else's world, open in front of you.
 *
 * A visit is a real look at the settlement its owner built, restored from the
 * snapshot they published, rather than a world regenerated from the seed with
 * none of their people in it. It runs, because a still picture of a life
 * simulator is not worth visiting — but nothing here is yours: no building, no
 * treasury, no yield.
 */
export interface Visit {
  seed: number;
  worldName: string;
  region: string;
  owner: string;
  ownerName: string;
  /** When the owner last published. Shown, because a stale world should say so. */
  at: number;
  save: SavedWorld;
}

/**
 * Hand a settlement the goodwill Gold, once, if it has not had it.
 *
 * Called wherever a world of the player's own is opened — on first mount and
 * on switching plots — and never on a visit, because a visitor's copy of
 * somebody else's settlement is not a settlement to pay anything into.
 */
function makeGood(world: World, seed: number) {
  const gold = claimGoodwill(seed);
  if (gold > 0) fundTreasury(world, gold, `${gold.toLocaleString()} Gold arrived: ${GOODWILL.reason}`);
}

export default function EmergeClient() {
  // `undefined` means we have not looked in storage yet, which avoids flashing
  // the world map at a player who already owns a world.
  const [claimed, setClaimed] = useState<ClaimedWorld | null | undefined>(undefined);
  // The last world we rendered. Kept after the player leaves so the renderer,
  // its WebGL context and the generated texture atlas survive a trip back to
  // the world map instead of being torn down and rebuilt.
  const [mounted, setMounted] = useState<ClaimedWorld | null>(null);
  // The $EMERGE balance and everything bought with it belongs to the player,
  // not to whichever plot they happen to be standing on.
  const [player, setPlayer] = useState<PlayerRecord | null>(null);
  // Which world the yield being credited belongs to. Read inside the state
  // updater, where the current `claimed` is not in scope.
  const claimedSeedRef = useRef<number | null>(null);
  // Somebody else's settlement, when the player has gone to look at one.
  const [visit, setVisit] = useState<Visit | null>(null);
  // Whether this session has been past the front door. A player who owns a
  // world has, by definition.
  const [entered, setEntered] = useState(false);
  const { wallet } = useWallet();
  const address = wallet.address;

  useEffect(() => {
    const stored = loadClaimedWorld();
    setClaimed(stored);
    if (stored) { setMounted(stored); claimedSeedRef.current = stored.seed; setEntered(true); }
  }, []);

  /*
   * Holdings follow the wallet.
   *
   * What a player owns, what they are called and what they have to spend all
   * belong to the address that bought them, so the record is re-read whenever
   * the connected wallet changes — including on the first connection, where a
   * browsing session's chosen name and surveyed plots are carried across once
   * into an empty wallet record rather than being thrown away.
   */
  useEffect(() => {
    const record = address ? adoptRecord(address) : loadPlayer();
    // Write the opening record straight back. `loadPlayer` invents a name for
    // a player who has none, and until something else saved, that name was
    // re-invented on every reload — so the person you were in chat yesterday
    // was a stranger today.
    savePlayer(record, address);
    setPlayer(record);
  }, [address]);

  const addressRef = useRef<string | null>(address);
  addressRef.current = address;

  /*
   * The balance, when there is a real token to read it from.
   *
   * With a contract configured the wallet is the authority on what somebody
   * holds, not this browser: a locally stored number would drift the moment
   * they traded anywhere else, and it would still be sitting there after they
   * spent the lot. Without a contract this does nothing and the development
   * allocation stands, which is the state every panel is already labelled for.
   */
  useEffect(() => {
    if (!address || !liveToken()) return;
    let live = true;
    const read = async () => {
      const held = await tokenBalance(address);
      if (!live || held === null) return;
      setPlayer((prev) => {
        if (!prev || prev.ledger.balance === held) return prev;
        const next = { ...prev, ledger: { ...prev.ledger, balance: held } };
        savePlayer(next, address);
        return next;
      });
    };
    read();
    const timer = window.setInterval(read, BALANCE_POLL);
    return () => { live = false; window.clearInterval(timer); };
  }, [address]);

  const updatePlayer = useCallback((next: PlayerRecord) => {
    savePlayer(next, addressRef.current);
    setPlayer(next);
  }, []);

  /**
   * Credit a day's stewardship yield.
   *
   * Functional, because this is called from the sampling timer, which is set up
   * once at mount and would otherwise be adding to whichever ledger existed
   * then — every day's earnings landing on the same stale balance.
   */
  const earn = useCallback((emerge: number) => {
    if (!(emerge > 0)) return;
    setPlayer((prev) => {
      if (!prev) return prev;
      // Only the first four plots a player claimed pay. Beyond that a world is
      // theirs to play with and earns nothing, so a large wallet buys more to
      // watch rather than more income.
      const earning = [...prev.claims]
        .sort((a, b) => a.claimedAt - b.claimedAt)
        .slice(0, EARNING_PLOT_LIMIT)
        .some((c) => c.seed === claimedSeedRef.current);
      if (!earning) return prev;
      const next = { ...prev, ledger: accrue(prev.ledger, emerge) };
      savePlayer(next, addressRef.current);
      return next;
    });
  }, []);

  const enter = useCallback((world: ClaimedWorld) => {
    saveClaimedWorld(world);
    claimedSeedRef.current = world.seed;
    // A claim is a purchase, so it goes into the player's holdings and stays
    // there. `emerge.world.v1` only records which of them is open right now.
    setPlayer((prev) => {
      if (!prev) return prev;
      const next = withClaim(prev, world);
      savePlayer(next, addressRef.current);
      return next;
    });
    setVisit(null);
    setEntered(true);
    setClaimed(world);
    setMounted(world);
  }, []);

  /**
   * Go and look at somebody else's settlement.
   *
   * Nothing is shown until the relay actually hands over a world: a visit that
   * silently fell back to a freshly generated one would look exactly like a
   * successful visit and be a different place entirely.
   */
  const goVisit = useCallback(async (seed: number): Promise<string | null> => {
    const { world, reason } = await fetchWorld(seed);
    if (!world) return reason ?? 'That world is not published yet.';
    const save = world.snapshot as SavedWorld;
    if (!worldFromSave(save, seed, world.worldName)) {
      return 'That world could not be read. Its owner may be running an older version.';
    }
    setVisit({
      seed,
      worldName: world.worldName,
      region: world.worldName,
      owner: world.owner,
      ownerName: world.ownerName,
      at: world.at,
      save,
    });
    return null;
  }, []);

  const endVisit = useCallback(() => setVisit(null), []);

  /**
   * Back to the world map, still owning the place.
   *
   * This used to delete the claim, so a player who looked at the map had to buy
   * their own world back off the shelf.
   */
  const leave = useCallback(() => {
    clearClaimedWorld();
    setClaimed(null);
  }, []);

  /**
   * Give a plot up for good. The land goes back on the market.
   *
   * Where the title is on chain that is where it has to be given up: the token
   * is burned by its holder, and only then does the seed become claimable
   * again. Releasing it in the relay alone would leave the contract still
   * saying the plot is theirs, and the next person to claim it would pay and be
   * reverted.
   */
  const release = useCallback((seed: number) => {
    if (addressRef.current && onChainClaimsLive()) {
      // The signature is the release. Everything below is bookkeeping that
      // follows it, so a refused signature must leave the plot alone.
      void releaseOnChain(addressRef.current, seed);
    }
    clearClaimedWorld();
    clearWorld(seed);
    // And out of the registry, or the plot stays unavailable to everybody else
    // for ever while being owned by nobody.
    if (addressRef.current) releasePlot(seed, addressRef.current);
    setPlayer((prev) => {
      if (!prev) return prev;
      const next = withoutClaim(prev, seed);
      savePlayer(next, addressRef.current);
      return next;
    });
    setClaimed(null);
  }, []);

  if (claimed === undefined || !player) return <main className="stage" />;

  /*
   * The front door.
   *
   * Shown until somebody has both read what this is and connected a wallet.
   * A player already standing in a world does not see it again — coming back
   * to a settlement you own should not put a marketing page in the way — and a
   * connected wallet that has stepped out to the map goes straight there.
   */
  const wantsLanding = !claimed && !visit && (!address || !entered);

  return (
    <>
      {mounted && (
        <WorldView
          key="own"
          claimed={mounted}
          player={player}
          hidden={claimed === null || visit !== null}
          onLeave={leave}
          onRelease={() => release(mounted.seed)}
          onRename={enter}
          onPlayer={updatePlayer}
          onEarn={earn}
          onVisit={goVisit}
        />
      )}
      {/* A visit is its own scene. Keying it on the seed means walking from one
          world to another rebuilds it rather than leaving the previous
          settlement's people standing in the new one's streets. */}
      {visit && (
        <WorldView
          key={`visit-${visit.seed}`}
          claimed={{
            seed: visit.seed,
            name: visit.worldName,
            region: visit.region,
            price: 0,
            claimedAt: visit.at,
            owner: visit.owner,
            txHash: null,
          }}
          player={player}
          hidden={false}
          visit={visit}
          onLeave={endVisit}
          onRelease={endVisit}
          onRename={() => { /* not yours to rename */ }}
          onPlayer={updatePlayer}
          onEarn={() => { /* a visitor earns nothing */ }}
          onVisit={goVisit}
        />
      )}
      {wantsLanding && <Landing onEnter={() => setEntered(true)} />}
      {claimed === null && !visit && !wantsLanding && (
        <PlotSelect player={player} onPlayer={updatePlayer} onEnter={enter} onVisit={goVisit} />
      )}
    </>
  );
}

function WorldView({ claimed, player, hidden, visit, onLeave, onRelease, onRename, onPlayer, onEarn, onVisit }: {
  claimed: ClaimedWorld;
  player: PlayerRecord;
  /** True while the world map is open over the top of a running world. */
  hidden: boolean;
  /** Set when this is somebody else's settlement, being looked at. */
  visit?: Visit | null;
  onLeave: () => void;
  /** Give this plot up entirely, rather than merely stepping out of it. */
  onRelease: () => void;
  onRename: (world: ClaimedWorld) => void;
  onPlayer: (record: PlayerRecord) => void;
  /** Credit stewardship yield the simulation has accrued. */
  onEarn: (emerge: number) => void;
  /** Go and look at somebody else's settlement. Resolves to a refusal, or null. */
  onVisit: (seed: number) => Promise<string | null>;
}) {
  const spectating = !!visit;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<World | null>(null);
  const sceneRef = useRef<EmergeScene | null>(null);
  const pausedRef = useRef(false);
  const speedRef = useRef<Speed>(1);
  const selectedRef = useRef<PickTarget>(null);
  // The sampling timer is set up once; this keeps it calling the current
  // callback rather than the one that existed at mount.
  const onEarnRef = useRef(onEarn);
  onEarnRef.current = onEarn;

  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [selected, setSelected] = useState<PickTarget>(null);
  const [hovered, setHovered] = useState<PickTarget>(null);
  const [panel, setPanel] = useState<PanelKey>(null);
  const [placing, setPlacing] = useState<string | null>(null);
  const [following, setFollowing] = useState<string | null>(null);
  const [view, setView] = useState<Snapshot | null>(null);
  const [woodland, setWoodland] = useState<{ standing: number; stumps: number; saplings: number; total: number } | null>(null);
  const soundRef = useRef<Soundscape | null>(null);
  const [sound, setSound] = useState(false);

  // The settlement as it was left, or a new one if there is nothing to read.
  // A visit reads the owner's published snapshot instead: their settlement, not
  // this browser's idea of what the seed grows.
  if (!worldRef.current) {
    worldRef.current = visit
      ? worldFromSave(visit.save, visit.seed, visit.worldName) ?? createWorld(visit.seed, visit.worldName)
      : loadWorld(claimed.seed, claimed.name) ?? createWorld(claimed.seed, claimed.name);
    if (!visit) makeGood(worldRef.current, claimed.seed);
  }

  /* -------------------------------------------------------------- *
   * Boot: renderer, simulation loop and HUD sampling
   * -------------------------------------------------------------- */

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !worldRef.current) return;

    const scene = new EmergeScene();
    sceneRef.current = scene;
    let frame = 0;

    scene
      .init(host, worldRef.current, {
        onHover: setHovered,
        onSelect: (target) => {
          selectedRef.current = target;
          setSelected(target);
        },
        onCarry: (id, phase, at) => {
          const live = worldRef.current;
          // A visitor may look and follow. Picking somebody up out of a
          // settlement that is not yours is not looking.
          if (!live || spectating) return;
          if (phase === 'start') pickUpCitizen(live, id);
          else if (phase === 'move') carryCitizenTo(live, id, at.x, at.y);
          else if (phase === 'drop') dropCitizen(live, id, at.x, at.y);
          else {
            // A tap, not a carry: put them back where they were standing.
            const c = live.citizens.find((x) => x.id === id);
            if (c) dropCitizen(live, id, c.x, c.y);
          }
        },
      })
      .then(() => {
        setReady(true);
        const live = worldRef.current;
        if (live) setView(snapshot(live, selectedRef.current));
      })
      .catch((error) => {
        console.error('Emerge: renderer failed to start', error);
      });

    let last = performance.now();
    const step = (now: number) => {
      frame = requestAnimationFrame(step);
      const dt = Math.min(0.12, (now - last) / 1000);
      last = now;
      // Read the ref every frame rather than closing over the world at mount.
      //
      // This effect runs once, so a captured world would be the one claimed
      // first, for the life of the session. Claiming a second plot swaps
      // `worldRef.current` and points the scene at the new world, but the loop
      // went on advancing the old one — so the new settlement stood perfectly
      // still until the page was reloaded.
      const live = worldRef.current;
      // The real seconds are passed alongside the game hours: the yield is paid
      // against the wall clock, so running at 2x shows the player more of the
      // settlement's life without paying them twice as much for it.
      if (live && !pausedRef.current) advance(live, dt * HOURS_PER_SECOND * speedRef.current, dt);
    };
    frame = requestAnimationFrame(step);

    // Write the settlement down every so often, and again the moment the tab
    // goes away — a phone backgrounding the page never runs another timer.
    //
    // Never during a visit: writing somebody else's settlement into this
    // browser's slot for that seed would overwrite the visitor's own world if
    // they ever claimed the same land, and would make a visit leave traces.
    const saveTimer = window.setInterval(() => {
      if (worldRef.current && !spectating) saveWorld(worldRef.current);
    }, SAVE_INTERVAL);
    const persist = () => { if (worldRef.current && !spectating) saveWorld(worldRef.current); };
    document.addEventListener('visibilitychange', persist);
    window.addEventListener('pagehide', persist);

    const hudTimer = window.setInterval(() => {
      const live = worldRef.current;
      if (live) {
        setView(snapshot(live, selectedRef.current));
        // The world is regenerated from its seed every time it is opened, so
        // the running total cannot live in it: drain what it has accrued into
        // the player's ledger, which is what persists. On a visit it is still
        // drained — so it cannot pile up — and then dropped, because watching
        // somebody else's settlement is not stewarding it.
        const earned = collectYield(live);
        if (earned > 0 && !spectating) onEarnRef.current(earned);
      }
      setWoodland(sceneRef.current?.woodland() ?? null);
    }, HUD_INTERVAL);

    return () => {
      persist();
      window.clearInterval(saveTimer);
      document.removeEventListener('visibilitychange', persist);
      window.removeEventListener('pagehide', persist);
      cancelAnimationFrame(frame);
      window.clearInterval(hudTimer);
      scene.destroy();
      sceneRef.current = null;
    };
    // `spectating` is fixed for the life of this component: the two cases are
    // rendered as separately keyed elements, so a change remounts rather than
    // re-running this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The soundscape follows the world's conditions, and only ever after the
  // player has asked for it: browsers will not start audio unprompted, and a
  // world that makes noise on its own is worse than a silent one.
  useEffect(() => {
    if (!sound) return;
    const scape = soundRef.current ?? new Soundscape();
    soundRef.current = scape;
    let cancelled = false;
    scape.start().catch(() => { /* refused, stay silent */ });
    const id = window.setInterval(() => {
      const world = worldRef.current;
      if (cancelled || !world) return;
      scape.update({
        hour: world.hour,
        weather: world.weather,
        activity: Math.min(1, world.citizens.filter((c) => !c.inside).length / 20),
      }, 0.25);
    }, 250);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      scape.stop().catch(() => { /* nothing to stop */ });
    };
  }, [sound]);

  useEffect(() => () => { soundRef.current?.destroy(); soundRef.current = null; }, []);

  const seedRef = useRef(claimed.seed);
  useEffect(() => {
    if (seedRef.current === claimed.seed) return;
    seedRef.current = claimed.seed;
    const scene = sceneRef.current;
    if (!scene) return;
    const next = loadWorld(claimed.seed, claimed.name) ?? createWorld(claimed.seed, claimed.name);
    makeGood(next, claimed.seed);
    worldRef.current = next;
    setSelected(null);
    setFollowing(null);
    scene.reset(next);
    setView(snapshot(next, null));
  }, [claimed.seed, claimed.name]);

  // The world keeps running behind the world map, but there is no reason to
  // spend frames drawing it while nobody can see it.
  useEffect(() => {
    const app = sceneRef.current?.app;
    if (!app?.renderer) return;
    if (hidden) app.stop(); else app.start();
  }, [hidden]);

  /* -------------------------------------------------------------- *
   * Who else is here, and putting this world up for them
   * -------------------------------------------------------------- */

  const [watching, setWatching] = useState(0);
  /**
   * How many people are playing Emerge at all.
   *
   * Null until the relay says, and never reset to nought by a failed beat: a
   * game that briefly claims nobody is playing looks dead, and looking dead is
   * worse than saying nothing.
   */
  const [online, setOnline] = useState<number | null>(null);
  const { wallet } = useWallet();

  /*
   * Say you are here, every so often, and read back how many others are.
   *
   * A heartbeat rather than a sign-in: nobody closes a tab politely, so the
   * only definition of "watching" that survives a killed browser is "said
   * something in the last minute".
   */
  useEffect(() => {
    // Not while this view is behind something else. A player looking at
    // somebody else's settlement still has their own mounted underneath, and
    // counting them as present in both would have them watching a world they
    // are demonstrably not looking at.
    if (hidden) { setWatching(0); return; }
    const seed = claimed.seed;
    const who = wallet.address ?? visitorId();
    let live = true;
    const beat = async () => {
      const here = await heartbeat(seed, who);
      if (!live) return;
      setWatching(here.watching);
      // Left alone when the relay could not say, rather than reset to nothing:
      // one missed beat should not make the game look empty.
      if (here.online !== null) setOnline(here.online);
    };
    beat();
    const timer = window.setInterval(beat, HEARTBEAT_INTERVAL);
    const leaving = () => departWorld(seed, who);
    window.addEventListener('pagehide', leaving);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener('pagehide', leaving);
      leaving();
    };
  }, [claimed.seed, wallet.address, hidden]);

  /*
   * Keep the relay's idea of this player's name current.
   *
   * Runs on the name and the wallet rather than on a timer, so a rename is
   * published the moment it happens and nothing is sent the rest of the time.
   * It is what lets chat show a person rather than an address — and what makes
   * a name a player paid to change actually appear.
   */
  useEffect(() => {
    void publishName(wallet.address ?? null, player.name);
  }, [wallet.address, player.name]);

  /*
   * Trade on the world's prices rather than our own.
   *
   * One call each way round: the settlement says what is in its stores, and
   * reads back the prices every settlement is trading at. It runs while
   * visiting somebody else's world too — the prices a visitor sees should be
   * the prices that world's own baker sees — but only an owner's stores are
   * reported, and the relay checks that against the registry rather than
   * taking our word for it.
   *
   * A failed call is left alone rather than clearing the prices. They carry
   * their own expiry, so a dropped request changes nothing and a relay that
   * stays down puts every settlement back on its own stores after a few
   * minutes, which is what the simulation does when it has never heard of a
   * world market at all.
   */
  useEffect(() => {
    const seed = claimed.seed;
    const mine = !spectating;
    let live = true;
    const poll = async () => {
      const world = worldRef.current;
      const result = mine && world
        ? await syncMarket(seed, marketReport(world))
        : await fetchMarket();
      if (live && result) setWorldPrices(result);
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, MARKET_POLL);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [claimed.seed, spectating]);

  /*
   * Put this settlement up so it can be visited.
   *
   * Only the owner publishes, and only with a wallet: the relay checks the
   * address against the registry, so an unsigned or borrowed snapshot is
   * refused there as well as here.
   */
  useEffect(() => {
    if (spectating || !wallet.address) return;
    const seed = claimed.seed;
    const owner = wallet.address;
    let live = true;
    const put = () => {
      const world = worldRef.current;
      if (!live || !world) return;
      publishWorld({
        seed,
        owner,
        ownerName: player.name,
        worldName: world.name,
        day: world.day,
        population: world.population,
        snapshot: snapshotOf(world),
      });
    };
    // The first one after a short delay, so a player passing through a world
    // does not push a snapshot for every plot they open.
    const first = window.setTimeout(put, 6_000);
    const timer = window.setInterval(put, PUBLISH_INTERVAL);
    return () => {
      live = false;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [claimed.seed, wallet.address, player.name, spectating]);

  /**
   * Burn $EMERGE to put Gold in the treasury of the world being visited.
   *
   * Charged here and queued there: the settlement on screen is a copy running
   * in this browser, so adding Gold to it would last exactly as long as the
   * visit. The owner's own client is the only thing that can put it into the
   * world that persists.
   */
  const gift = useCallback(async (gold: number): Promise<string | null> => {
    if (!visit || !wallet.address) return 'Connect a wallet to send Gold.';
    const cost = gold * EMERGE_PER_GOLD;
    const paid = await spend(player.ledger, cost, wallet.address);
    if (!paid.ok) return paid.refused;
    // The tokens are already gone; keep the receipt so the server can check it.
    onPlayer({ ...player, ledger: paid.ledger });

    /*
     * The registry verifies the burn against the chain, and the first ask
     * usually lands before the node has it, so keep asking while it settles.
     */
    let result = await sendGift({
      seed: visit.seed, gold, from: wallet.address, fromName: player.name,
      burnTx: paid.txHash ?? undefined,
    });
    for (let i = 1; i < 8 && !result.ok && result.settling; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      result = await sendGift({
        seed: visit.seed, gold, from: wallet.address, fromName: player.name,
        burnTx: paid.txHash ?? undefined,
      });
    }
    if (!result.ok) {
      return paid.txHash
        ? `${result.reason} Your payment ${paid.txHash.slice(0, 10)}… went through — keep it, and tell us if the Gold never lands.`
        : result.reason;
    }
    return null;
  }, [visit, wallet.address, player, onPlayer]);

  const [chatNotices, setChatNoticesOn] = useState(true);
  useEffect(() => { setChatNoticesOn(chatNoticesOn()); }, []);
  const toggleChatNotices = useCallback(() => {
    setChatNoticesOn((on) => { setChatNotices(!on); return !on; });
  }, []);

  const { notices, dismiss, announce } = useNotices({
    seed: claimed.seed,
    chatOpen: panel === 'chat',
    chatNotices,
    mine: { address: wallet.address, name: player.name },
    onOpenChat: () => setPanel('chat'),
  });

  /*
   * "Your people sold something."
   *
   * The reason this exists is that a settlement trading well looks exactly
   * like a settlement doing nothing: the goods leave the store, the Gold
   * arrives, and unless somebody is reading the feed none of it is visible.
   * A card every so often is the difference between a world that is running
   * and a world that is running *for you*.
   *
   * Tallied by the market and drained here rather than announced per sale —
   * trade happens every game hour, and a card each time would be a card every
   * few seconds. Nothing is shown below a threshold worth reading, and a
   * settlement with nothing to sell says nothing at all.
   */
  useEffect(() => {
    if (spectating) return;
    let live = true;
    const tick = () => {
      const world = worldRef.current;
      if (!live || !world || pausedRef.current) return;
      const sold = takeSales(world);
      if (sold.gold < SALE_NOTICE_GOLD || !sold.best) return;
      const good = RESOURCE_LABELS[sold.best].toLowerCase();
      announce({
        id: `sale-${world.day}-${Math.round(world.hour)}-${Math.round(sold.gold)}`,
        kind: 'sale',
        title: `${Math.round(sold.gold).toLocaleString()} Gold from the stalls`,
        body: sold.units > sold.bestUnits
          ? `Your people sold ${Math.round(sold.units)} goods, mostly ${good}.`
          : `Your people sold ${Math.round(sold.bestUnits)} ${good}.`,
      });
    };
    const timer = window.setInterval(tick, SALE_NOTICE_INTERVAL);
    return () => { live = false; window.clearInterval(timer); };
  }, [announce, spectating]);

  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { selectedRef.current = selected; sceneRef.current?.select(selected); }, [selected]);

  /* -------------------------------------------------------------- *
   * Player actions
   * -------------------------------------------------------------- */

  const focusOn = useCallback((target: PickTarget) => {
    setSelected(target);
    sceneRef.current?.focus(target);
    soundRef.current?.tick('select');
  }, []);

  const toggleFollow = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const target = selectedRef.current;
    if (!target || target.kind !== 'citizen') return;
    const next = scene.following === target.id ? null : target.id;
    scene.setFollow(next);
    setFollowing(next);
  }, []);

  // A hand on the camera cancels the follow inside the scene; mirror that here.
  useEffect(() => {
    if (!ready) return;
    const id = window.setInterval(() => {
      const live = sceneRef.current?.following ?? null;
      setFollowing((current) => (current === live ? current : live));
    }, 400);
    return () => window.clearInterval(id);
  }, [ready]);

  const beginBuild = useCallback((type: string, cost: number) => {
    const world = worldRef.current;
    const scene = sceneRef.current;
    if (!world || !scene || world.treasury < cost) return;
    setPanel(null);
    setPlacing(type);
    scene.startPlacement(type, (x, y) => {
      const building = constructBuilding(world, type, cost, x, y);
      setPlacing(null);
      if (building) {
        scene.syncBuildings();
        setSelected({ kind: 'building', id: building.id });
      }
      setView(snapshot(world, selectedRef.current));
    });
  }, []);

  /** Pull a building down. Half the materials come back; the Gold does not. */
  const demolish = useCallback((id: string) => {
    const world = worldRef.current;
    if (!world) return;
    const result = demolishBuilding(world, id);
    if (!result.ok) return;
    sceneRef.current?.syncBuildings();
    setSelected(null);
    selectedRef.current = null;
    setView(snapshot(world, null));
  }, []);

  const cancelBuild = useCallback(() => {
    sceneRef.current?.cancelPlacement();
    setPlacing(null);
  }, []);

  const refresh = useCallback(() => {
    const world = worldRef.current;
    if (world) setView(snapshot(world, selectedRef.current));
  }, []);

  /*
   * Gold other players have sent, put into the settlement that persists.
   *
   * Read-and-clear on the server, so a gift is applied once. Never on a visit:
   * the owner's client is the only one that may collect, and the relay checks
   * the address as well.
   */
  useEffect(() => {
    if (spectating || hidden || !wallet.address) return;
    const seed = claimed.seed;
    const owner = wallet.address;
    let live = true;
    const tick = async () => {
      const gifts = await collectGifts(seed, owner);
      const world = worldRef.current;
      if (!live || !world || !gifts.length) return;
      const arrived: { fromName: string; gold: number }[] = [];
      for (const g of gifts) {
        fundTreasury(world, g.gold, `Gift from ${g.fromName || 'a visitor'}`);
        arrived.push(g);
      }
      for (const g of arrived) {
        announce({
          id: `gift-${g.gold}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          kind: 'claim',
          title: 'A gift arrived',
          body: `${g.fromName || 'Somebody'} sent ${g.gold.toLocaleString()} Gold to your treasury.`,
        });
      }
      refresh();
    };
    const timer = window.setInterval(tick, GIFT_POLL);
    tick();
    return () => { live = false; window.clearInterval(timer); };
  }, [claimed.seed, wallet.address, spectating, hidden, refresh, announce]);

  /** Naming costs tokens, so refuse rather than rename for free. */
  const renameWorldFor = useCallback(async (next: string) => {
    const world = worldRef.current;
    if (!world) return;
    const paid = await spend(player.ledger, RENAME_COST_EMERGE, wallet.address);
    if (!paid.ok) return;
    renameWorld(world, next);
    // The name belongs to the token, not to this browser, so where there is a
    // token it is written there too and travels with the plot.
    if (wallet.address && onChainClaimsLive()) {
      void renameOnChain(wallet.address, claimed.seed, world.name);
    }
    onPlayer({ ...player, ledger: paid.ledger });
    onRename({ ...claimed, name: world.name });
    refresh();
  }, [claimed, onRename, onPlayer, player, refresh, wallet.address]);

  const renameCitizenFor = useCallback(async (id: string, next: string) => {
    const world = worldRef.current;
    if (!world) return;
    // Naming rights won from a dig are spent before the player's balance is
    // touched — holding one and being charged anyway would make the prize a lie.
    if (player.nameTokens > 0) {
      if (!renameCitizen(world, id, next)) return;
      onPlayer({ ...player, nameTokens: player.nameTokens - 1 });
      refresh();
      return;
    }
    const paid = await spend(player.ledger, RENAME_CITIZEN_EMERGE, wallet.address);
    if (!paid.ok) return;
    if (!renameCitizen(world, id, next)) return;
    onPlayer({ ...player, ledger: paid.ledger });
    refresh();
  }, [onPlayer, player, refresh, wallet.address]);

  /**
   * Send out a prospecting party.
   *
   * The cost is charged and burned before the draw, so a refused charge cannot
   * pay out, and the prize is applied to the world the player is standing in.
   */
  const dig = useCallback(async (): Promise<{ prize: Prize; story: string } | string> => {
    const world = worldRef.current;
    if (!world) return 'The settlement is still waking up. Try again in a moment.';
    const paid = await spend(player.ledger, DIG_COST_EMERGE, wallet.address);
    if (!paid.ok) return paid.refused ?? 'The party could not be paid for.';
    const prize = drawPrize();
    const story = prizeStory(prize);

    if (prize.gold) fundTreasury(world, prize.gold, 'Prospecting party');
    if (prize.resource) grantResource(world, prize.resource.key, prize.resource.amount);
    for (let i = 0; i < (prize.settlers ?? 0); i += 1) addSettler(world);

    onPlayer({
      ...player,
      ledger: paid.ledger,
      nameTokens: player.nameTokens + (prize.naming ?? 0),
    });
    refresh();
    return { prize, story };
  }, [onPlayer, player, refresh, wallet.address]);

  /**
   * Set what the settlement pays.
   *
   * Straight through to the simulation and then a refresh, because the whole
   * point is that a player moves the slider and watches the figures under it
   * change. Nothing is persisted separately: the rate lives on the world and
   * the world is saved on its own schedule.
   */
  const setWages = useCallback((rate: number) => {
    const world = worldRef.current;
    if (!world) return;
    if (setWageRate(world, rate)) refresh();
  }, [refresh]);

  /** Move Gold in or out of the treasury and persist the vault ledger. */
  const vault = useCallback((ledger: VaultLedger, goldDelta: number, note: string) => {
    const world = worldRef.current;
    if (!world) return;
    if (goldDelta > 0) fundTreasury(world, goldDelta, note);
    else if (goldDelta < 0 && !drawFromTreasury(world, -goldDelta, note)) return;
    onPlayer({ ...player, ledger });
    refresh();
  }, [onPlayer, player, refresh]);

  /** Put this plot up for resale, or take it back off the market. */
  const listPlot = useCallback((price: number | null) => {
    const listings = player.listings.filter((l) => l.seed !== claimed.seed);
    if (price !== null && price > 0) {
      listings.push({ seed: claimed.seed, region: claimed.region, price: Math.round(price), listedAt: Date.now() });
    }
    onPlayer({ ...player, listings });
  }, [claimed.region, claimed.seed, onPlayer, player]);

  const zoom = useCallback((factor: number) => sceneRef.current?.zoomBy(factor), []);
  const resetView = useCallback(() => sceneRef.current?.centreOn(50, 49, 1.05), []);
  const minimapJump = useCallback((u: number, v: number) => sceneRef.current?.minimapJump(u, v), []);
  const drawMinimap = useCallback((canvas: HTMLCanvasElement) => sceneRef.current?.drawMinimap(canvas), []);

  /* -------------------------------------------------------------- *
   * Keyboard
   * -------------------------------------------------------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'Space') { e.preventDefault(); setPaused((p) => !p); }
      else if (e.key === '1') setSpeed(1);
      else if (e.key === '2') setSpeed(2);
      else if (e.key === 'f' || e.key === 'F') toggleFollow();
      else if (e.key === 'Escape') { setPanel(null); cancelBuild(); setSelected(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancelBuild, toggleFollow]);

  const hoverInfo = useMemo(() => (hovered ? sceneRef.current?.describe(hovered) ?? null : null), [hovered]);

  return (
    <main className="stage" aria-hidden={hidden} style={hidden ? { visibility: 'hidden' } : undefined}>
      <div ref={hostRef} className="canvas-host" aria-label={`${claimed.name} settlement`} />

      {!ready && (
        <div className="boot">
          <div className="boot-mark">✦</div>
          <div className="boot-word">{claimed.name.toUpperCase()}</div>
          <p>Painting a world…</p>
        </div>
      )}

      {ready && view && (
        <>
          <Hud
            view={view}
            paused={paused}
            speed={speed}
            placing={placing}
            following={following}
            woodland={woodland}
            sound={sound}
            onToggleSound={() => setSound((on) => !on)}
            player={player}
            onRenameCitizen={renameCitizenFor}
            onDemolish={demolish}
            hover={hoverInfo}
            activePanel={panel}
            onTogglePause={() => setPaused((p) => !p)}
            onSpeed={setSpeed}
            onPanel={setPanel}
            onFocus={focusOn}
            onToggleFollow={toggleFollow}
            onClearSelection={() => setSelected(null)}
            onZoom={zoom}
            onResetView={resetView}
            onMinimapJump={minimapJump}
            drawMinimap={drawMinimap}
            onCancelBuild={cancelBuild}
            watching={watching}
            online={online}
            visiting={visit ?? null}
            onEndVisit={onLeave}
          />
          <Notices notices={notices} onDismiss={dismiss} />
          <Panels
            panel={panel}
            view={view}
            claimed={claimed}
            player={player}
            onClose={() => setPanel(null)}
            onBuild={beginBuild}
            onRenameWorld={renameWorldFor}
            onRenameCitizen={renameCitizenFor}
            onLeave={onLeave}
            onRelease={onRelease}
            onVault={vault}
            onWages={setWages}
            onList={listPlot}
            onPlayer={onPlayer}
            onDig={dig}
            onVisit={onVisit}
            spectating={spectating}
            visit={visit ?? null}
            onGift={gift}
            chatNotices={chatNotices}
            onToggleNotices={toggleChatNotices}
          />
        </>
      )}
    </main>
  );
}
