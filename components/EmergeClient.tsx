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
  BUILD_COSTS, addSettler, advance, carryCitizenTo, collectYield, constructBuilding, createWorld,
  advanceEra, attendedFrom, demolishBuilding, dropCitizen, drawFromTreasury, eraGate, eraOf, expandPlot, fightHazard, fundTreasury, grantResource, marketReport, noteAttention, rebuildBuilding, setEra, setWalletAttention, trial, walletAttentionAt,
  RESOURCE_LABELS, moveBuilding, pickUpCitizen, renameCitizen, renameWorld, setWageRate,
  setWorldPrices, settleBout, stakeOnBout, takeSales, upgradeBuilding,
  type World, clearTrees, trainCitizen, trainTrade, type WorkingJob,
  dailyCeiling, holdFestival, raiseCity, setCover, startBridgeAt, applyBoon, boonCheck, type BoonKind, type CoverKind, buildDiscount, cityLevel, setBanner, returnYield, dismissCitizen, setGates, placementProblem, setKeep, type Resource } from '@/lib/simulation';
import { clearWorld, loadWorld, saveWorld, snapshotOf, worldFromSave, type SavedWorld } from '@/lib/world/save';
import { GOODWILL, claimGoodwill, markGoodwill } from '@/lib/world/grants';
import { fetchPlayerRecord, pushPlayerRecord } from '@/lib/net/player';
import { snapshot, type Snapshot } from '@/lib/hud';
import { EmergeScene, type PickTarget } from '@/lib/render/scene';
import {
  adoptRecord, clearClaimedWorld, loadClaimedWorld, loadPlayer, mergeRecords, savePlayer, saveClaimedWorld,
  withClaim, withoutClaim,
  type ClaimedWorld, type PlayerRecord,
} from '@/lib/world/plots';
import {
  ATTEND_INTERVAL, GIFT_POLL, HAND_PRESENT_MS, HEARTBEAT_INTERVAL, attendJob, collectGifts, departWorld, fetchClaims, fetchWorld,
  heartbeat, publishWorld, releasePlot, sendGift, visitorId, listPlot as listPlotOnRegistry, expandPlot as expandOnRegistry, advancePlot as advanceOnRegistry,
  coverPlot, boonPlot,
} from '@/lib/net/registry';
import { fetchMarket, syncMarket } from '@/lib/net/market';
import { publishName } from '@/lib/net/names';
import { disconnectWallet, useWallet } from './WalletPicker';
import { Notices, chatNoticesOn, setChatNotices, useNotices } from './Notices';
import { t, tn, tx } from '@/lib/i18n';
import {
  ADVANCE_COST_EMERGE, EARNING_PLOT_LIMIT, EMERGE_PER_GOLD, EXPAND_COST_EMERGE, HAND_DAILY_CEILING, HAND_SHARE, RENAME_CITIZEN_EMERGE, RENAME_COST_EMERGE, accrue, charge,
  liveToken, type VaultLedger, DAILY_EARN_CEILING, CHARTER_COST_EMERGE, INSURANCE_COST_EMERGE, BUILDERS_COST_EMERGE, BOON_COST_EMERGE, WALLET_DAILY_CEILING, advanceCost, charterCost, earnRoom } from '@/lib/chain/vault';
import { tokenBalance } from '@/lib/chain/emerge';
import { onChainClaimsLive, releaseOnChain, renameOnChain } from '@/lib/chain/registry';
import { spend } from '@/lib/chain/spend';
import { DIG_COST_EMERGE, drawPrize, prizeStory, type Prize } from '@/lib/chain/gacha';
import { Soundscape } from '@/lib/audio/soundscape';
import { moodFor, music } from '@/lib/audio/music';
import Arena from './Arena';
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

/** What the first-day card has seen the player do, kept under the wallet in this browser. */
interface FirstDayRecord { startedAt: number; person: boolean; house: boolean; bank: boolean; dismissed: boolean }
/** "Come back tomorrow" is done once most of a real day has passed since the first open. */
const FIRST_RETURN_MS = 20 * 3_600_000;
function readFirstDay(key: string): FirstDayRecord {
  const fresh: FirstDayRecord = { startedAt: Date.now(), person: false, house: false, bank: false, dismissed: false };
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) { window.localStorage.setItem(key, JSON.stringify(fresh)); return fresh; }
    const held = JSON.parse(raw) as Partial<FirstDayRecord>;
    return { ...fresh, ...held, startedAt: Number(held.startedAt) || fresh.startedAt };
  } catch { return fresh; }
}
function keepFirstDay(key: string, record: FirstDayRecord) {
  try { window.localStorage.setItem(key, JSON.stringify(record)); } catch { /* private mode */ }
}
/**
 * The wallet's last action on any of its plots, kept in this browser.
 *
 * Read when a world opens and written as it is saved, so a plot opened after
 * an hour spent on another is as attended as the one that was open. The
 * relay carries the same stamp between devices.
 */
const actedKey = (address: string) => `emerge:acted:${address.toLowerCase()}`;
function readActed(address: string): number {
  try { return Number(window.localStorage.getItem(actedKey(address))) || 0; } catch { return 0; }
}
function keepActed(address: string, at: number) {
  if (!(at > 0) || at <= readActed(address)) return;
  try { window.localStorage.setItem(actedKey(address), String(at)); } catch { /* private mode */ }
}
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

/** Hazards that get the danger track while they are still doing harm. */
const DIRE_KINDS = new Set(['fire', 'flood', 'earthquake', 'tornado', 'plague']);

/** Where a tab remembers that it walked in as a spectator. */
const SPECTATOR_KEY = 'emerge.spectator.v1';
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
  /**
   * This player is the plot's hired hand. The visit then pays: a share of what
   * the settlement's stewardship comes to while they have it open.
   */
  hand?: boolean;
}

/**
 * Hand a settlement the goodwill Gold, once, if it has not had it.
 *
 * Called wherever a world of the player's own is opened — on first mount and
 * on switching plots — and never on a visit, because a visitor's copy of
 * somebody else's settlement is not a settlement to pay anything into.
 */
function makeGood(world: World) {
  const gold = claimGoodwill(world);
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
  const playerRef = useRef<PlayerRecord | null>(null);
  playerRef.current = player;
  // Which world the yield being credited belongs to. Read inside the state
  // updater, where the current `claimed` is not in scope.
  const claimedSeedRef = useRef<number | null>(null);
  // Somebody else's settlement, when the player has gone to look at one.
  const [visit, setVisit] = useState<Visit | null>(null);
  // Whether this session has been past the front door. A player who owns a
  // world has, by definition.
  const [entered, setEntered] = useState(false);
  /*
   * Somebody looking around without a wallet.
   *
   * Remembered for the tab, so a reload does not put the front door back in
   * front of a spectator who has already walked through it. Nothing else
   * about them is kept: a spectator owns nothing and earns nothing.
   */
  const [spectator, setSpectator] = useState(false);
  const { wallet } = useWallet();
  const address = wallet.address;

  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(SPECTATOR_KEY) === '1') { setSpectator(true); setEntered(true); }
    } catch { /* no storage */ }
  }, []);
  const spectate = useCallback(() => {
    try { window.sessionStorage.setItem(SPECTATOR_KEY, '1'); } catch { /* no storage */ }
    setSpectator(true);
    setEntered(true);
  }, []);
  /**
   * Let go of the wallet from the world map.
   *
   * The map stays open, as a spectator: disconnecting is not leaving, and a
   * player who wants the front page has a button for that beside this one.
   */
  const disconnectHere = useCallback(() => {
    disconnectWallet();
    try { window.sessionStorage.setItem(SPECTATOR_KEY, '1'); } catch { /* no storage */ }
    setSpectator(true);
    setEntered(true);
  }, []);
  /** Back to the front page from the world map. Nothing is forgotten but the way in. */
  const goHome = useCallback(() => {
    try { window.sessionStorage.removeItem(SPECTATOR_KEY); } catch { /* no storage */ }
    setSpectator(false);
    setEntered(false);
  }, []);

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
    if (!address) return;
    // And the copy the server holds for this wallet, from whichever device
    // wrote it last. Merged rather than adopted, so a plot bought here and a
    // name chosen there both survive.
    let live = true;
    void (async () => {
      const remote = await fetchPlayerRecord(address);
      if (!live || !remote) return;
      setPlayer((prev) => {
        const merged = mergeRecords(prev ?? record, remote);
        savePlayer(merged, address);
        return merged;
      });
    })();
    return () => { live = false; };
  }, [address]);

  // Whatever the record becomes, the server gets it a moment later. Debounced,
  // because the yield timer touches it several times a minute.
  useEffect(() => {
    if (!address || !player) return;
    const timer = window.setTimeout(() => { void pushPlayerRecord(address, player); }, 2500);
    return () => window.clearTimeout(timer);
  }, [address, player]);

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
  const earn = useCallback((emerge: number, ceiling = DAILY_EARN_CEILING): number => {
    if (!(emerge > 0)) return 0;
    // What the ledger will take today, worked out before the update so the
    // caller can keep the rest banked in the world rather than lose it.
    const current = playerRef.current;
    let accepted = 0;
    if (current) {
      const earningNow = [...current.claims].sort((a, b) => a.claimedAt - b.claimedAt).slice(0, EARNING_PLOT_LIMIT).some((c) => c.seed === claimedSeedRef.current);
      const plotsNow = Math.max(1, Math.min(EARNING_PLOT_LIMIT, current.claims.length));
      accepted = earningNow ? Math.min(emerge, earnRoom(current.ledger, Math.min(WALLET_DAILY_CEILING, ceiling * plotsNow))) : 0;
    }
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
      // The ceiling is the plot's own, from its city level and era, times the
      // plots that pay; the payout route judges the same from the published
      // copies, so this is a display of the rule and not the rule itself.
      const plots = Math.max(1, Math.min(EARNING_PLOT_LIMIT, prev.claims.length));
      const next = { ...prev, ledger: accrue(prev.ledger, emerge, Math.min(WALLET_DAILY_CEILING, ceiling * plots)) };
      savePlayer(next, addressRef.current);
      return next;
    });
    return accepted;
  }, []);

  /**
   * Credit a hired hand's share.
   *
   * A hand is paid a tenth of what the plot they attend accrues, up to a
   * hand's own ceiling, into the same ledger the vault pays from. There is no
   * claim to check against: the job is the server's row, and the vault reads
   * it again before paying anything out.
   */
  const handBank = useRef(0);
  const earnAsHand = useCallback((emerge: number): number => {
    if (!(emerge > 0)) return 0;
    // The yield arrives a token at a time, so a tenth of each would round to
    // nothing for ever. The fraction is banked and paid whole.
    handBank.current += emerge * HAND_SHARE;
    const share = Math.floor(handBank.current);
    if (!(share > 0)) return emerge;
    handBank.current -= share;
    setPlayer((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ledger: accrue(prev.ledger, share, HAND_DAILY_CEILING) };
      savePlayer(next, addressRef.current);
      return next;
    });
    return emerge;
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
    // Whether this is a visit or a shift: the registry says who works here.
    let hand = false;
    if (addressRef.current) {
      const { claims } = await fetchClaims();
      hand = claims.find((c) => c.seed === seed)?.hand?.address === addressRef.current.toLowerCase();
    }
    setVisit({
      seed,
      worldName: world.worldName,
      region: world.worldName,
      owner: world.owner,
      ownerName: world.ownerName,
      at: world.at,
      save,
      hand,
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

  /*
   * The map has its own track and the front door is silent; a world decides
   * for itself a few times a second, in its own view. Decided here, above the
   * early return below, because a hook after it would change the hook count
   * between renders.
   */
  const wantsLandingNow = !claimed && !visit && ((!address && !spectator) || !entered);
  const onMap = claimed === null && !visit && !wantsLandingNow;
  useEffect(() => {
    if (wantsLandingNow) music.want('none');
    else if (onMap) music.want('map');
  }, [wantsLandingNow, onMap]);

  if (claimed === undefined || !player) return <main className="stage" />;

  /*
   * The front door.
   *
   * Shown until somebody has both read what this is and connected a wallet.
   * A player already standing in a world does not see it again — coming back
   * to a settlement you own should not put a marketing page in the way — and a
   * connected wallet that has stepped out to the map goes straight there.
   */
  const wantsLanding = !claimed && !visit && ((!address && !spectator) || !entered);

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
          onEarn={visit.hand ? earnAsHand : () => 0}
          onVisit={goVisit}
        />
      )}
      {wantsLanding && <Landing onEnter={() => setEntered(true)} onSpectate={spectate} />}
      {claimed === null && !visit && !wantsLanding && (
        <PlotSelect player={player} onPlayer={updatePlayer} onEnter={enter} onVisit={goVisit} onHome={goHome} onDisconnect={disconnectHere} />
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
  /** Take earned tokens into the ledger; answers how many it took, so the rest can stay banked. */
  onEarn: (emerge: number, ceiling?: number) => number;
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
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

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
  // The note reads the remembered switch; the browser still needs a click
  // before anything actually plays, which the note is.
  useEffect(() => { setSound(music.enabled); }, []);

  // The settlement as it was left, or a new one if there is nothing to read.
  // A visit reads the owner's published snapshot instead: their settlement, not
  // this browser's idea of what the seed grows.
  if (!worldRef.current) {
    worldRef.current = visit
      ? worldFromSave(visit.save, visit.seed, visit.worldName) ?? createWorld(visit.seed, visit.worldName)
      : loadWorld(claimed.seed, claimed.name) ?? createWorld(claimed.seed, claimed.name);
    if (!visit) makeGood(worldRef.current);
    // A hand arriving is attention: their shift starts at full rate and
    // slides the same way an owner's does, so a tab left open all week
    // earns a hand about what it would earn an owner — very little.
    if (visit?.hand) noteAttention(worldRef.current);
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
      // Acting on another of the wallet's plots counts here as well, so
      // the settlement that is not open is never the neglected one.
      if (live && !spectating) attendedFrom(live, walletAttentionAt());
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
      if (!spectating && wallet.address) keepActed(wallet.address, walletAttentionAt());
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
        if (earned > 0 && (!spectating || visit?.hand)) {
          const accepted = onEarnRef.current(earned, dailyCeiling(live));
          // The ledger takes a day's ceiling a day; a stretch away that came
          // to more than that stays banked in the world for tomorrow.
          if (!spectating && accepted < earned) returnYield(live, earned - accepted);
        }
        // A danger that is still doing harm changes the music; a harmless
        // one, or one already fought down, does not.
        if (!hiddenRef.current) {
          const dire = live.hazards.some((h) => (h.severity ?? 0) > 0 && DIRE_KINDS.has(h.kind));
          music.want(moodFor(live.hour, dire, spectating));
        }
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
    makeGood(next);
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

  // A panel over the world is what the player is looking at. The world still
  // runs and still shows through, but drawing it sixty times a second behind
  // a chat window is what the chat window was paying for in lag: a dozen
  // frames a second is plenty for a dimmed backdrop.
  useEffect(() => {
    const app = sceneRef.current?.app;
    if (!app?.ticker) return;
    app.ticker.maxFPS = panel ? 12 : 0;
    return () => { if (app.ticker) app.ticker.maxFPS = 0; };
  }, [panel, ready]);

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
   * The first day. A record under the wallet of what the player has done so
   * far, kept in this browser; each flag is set by the thing itself — a
   * person selected, a building placed, the Bank opened — never by the card.
   */
  const firstKey = `emerge:firstday:${wallet.address?.toLowerCase() ?? 'guest'}`;
  const [firstDay, setFirstDay] = useState<FirstDayRecord | null>(null);
  useEffect(() => {
    if (visit) { setFirstDay(null); return; }
    setFirstDay(readFirstDay(firstKey));
  }, [firstKey, visit]);
  const markFirst = useCallback((flag: 'person' | 'house' | 'bank' | 'dismissed') => {
    setFirstDay((r) => {
      if (!r || r[flag]) return r;
      const next = { ...r, [flag]: true };
      keepFirstDay(firstKey, next);
      return next;
    });
  }, [firstKey]);
  useEffect(() => { if (selected?.kind === 'citizen') markFirst('person'); }, [selected, markFirst]);
  useEffect(() => { if (panel === 'bank') markFirst('bank'); }, [panel, markFirst]);

  /*
   * Say you are here, every so often, and read back how many others are.
   *
   * A heartbeat rather than a sign-in: nobody closes a tab politely, so the
   * only definition of "watching" that survives a killed browser is "said
   * something in the last minute".
   */
  // Attention is the wallet's, not the plot's. Whatever the player last did
  // on any of their plots, on this device, counts for this one too; the
  // frame loop brings the open world up to it.
  useEffect(() => {
    if (wallet.address && !spectating) setWalletAttention(readActed(wallet.address));
  }, [wallet.address, spectating]);

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
      // The wallet's last action goes with the beat and comes back as the
      // latest the relay has seen from any device, so a plot opened on the
      // phone is as attended as it was on the desktop.
      const acted = wallet.address && !spectating ? walletAttentionAt() : 0;
      const here = await heartbeat(seed, who, acted);
      if (!live) return;
      if (here.acted > 0 && wallet.address && !spectating) {
        setWalletAttention(here.acted);
        if (worldRef.current) attendedFrom(worldRef.current, walletAttentionAt());
      }
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
   * A hired hand at work says so, every so often.
   *
   * The owner's client reads it back and counts it as attention, which is the
   * whole of what a hand is for. Only while the page is actually in view —
   * a shift is watching the place, not leaving a tab open behind others.
   */
  useEffect(() => {
    if (!visit?.hand || !wallet.address) return;
    const seed = claimed.seed;
    const who = wallet.address;
    const clock = () => { if (document.visibilityState === 'visible') void attendJob(seed, who); };
    clock();
    const timer = window.setInterval(clock, ATTEND_INTERVAL);
    return () => window.clearInterval(timer);
  }, [claimed.seed, wallet.address, visit?.hand]);

  /*
   * And the owner's world counts a hand who is at work as attention.
   *
   * Read every couple of minutes from the registry rather than pushed, so it
   * works whether or not the owner is online — although only the owner's own
   * client accrues, so what a hand keeps up is the rate the owner gets when
   * they next look in, not a yield that ticks while nobody plays.
   */
  const handRef = useRef<string | null>(null);
  useEffect(() => {
    if (spectating || !wallet.address) return;
    const seed = claimed.seed;
    let live = true;
    const poll = async () => {
      const { claims } = await fetchClaims();
      if (!live) return;
      const row = claims.find((c) => c.seed === seed);
      const hand = row?.hand ?? null;
      const world = worldRef.current;
      // An expansion bought on another device: the registry row is the
      // record, and this world catches up with it here.
      if (row?.expandedAt && world && !world.expanded) {
        expandPlot(world);
        saveWorld(world);
        sceneRef.current?.reset(world);
        setView(snapshot(world, null));
      }
      // An era paid for on another device, likewise.
      if (row?.era && world && row.era > eraOf(world)) {
        setEra(world, row.era);
        saveWorld(world);
        sceneRef.current?.reset(world);
        setView(snapshot(world, null));
      }
      // A charter or insurance bought on another device.
      if (world && row?.charterUntil && (world.charterUntil ?? 0) < row.charterUntil) { setCover(world, 'charter', row.charterUntil); saveWorld(world); }
      if (world && row?.insuredUntil && (world.insuredUntil ?? 0) < row.insuredUntil) { setCover(world, 'insurance', row.insuredUntil); saveWorld(world); }
      if (world && row?.buildersUntil && (world.buildersUntil ?? 0) < row.buildersUntil) { setCover(world, 'builders', row.buildersUntil); saveWorld(world); }
      if (world && row?.banner && world.banner !== row.banner) { setBanner(world, row.banner); saveWorld(world); }
      if (hand && world && Date.now() - hand.lastSeen < HAND_PRESENT_MS) {
        world.stewardship.lastActionAt = Math.max(world.stewardship.lastActionAt, hand.lastSeen);
      }
      // A card when somebody takes the job, once.
      const who = hand?.address ?? null;
      if (who && handRef.current !== null && handRef.current !== who) {
        announce({
          id: `hand-${seed}-${who}`,
          kind: 'sync',
          title: t('You have a hired hand'),
          body: t('{who} took the job at {world}. While they are at work, the place counts as attended.', { who: hand?.name || who.slice(0, 10), world: world?.name ?? '' }),
          lifetime: 15_000,
        });
      }
      handRef.current = who ?? '';
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 120_000);
    return () => { live = false; window.clearInterval(timer); };
    // `announce` is stable for the life of the world.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimed.seed, wallet.address, spectating]);

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
   * Pick up where you left off, on any device — and never go backwards.
   *
   * The settlement is saved in this browser and published to the server for
   * visitors; the published copy is also what every other device continues
   * from. It is read when the world opens and, if it is further along than
   * what this browser has, it is the one that continues. Further along, not
   * more recent: progress is what must never be lost, and a day-one world
   * saved a minute ago is not progress over a day-twenty-six world saved
   * yesterday.
   *
   * The same read runs again whenever the tab comes back into view and
   * whenever the server refuses a publish as behind. A tab left open on a
   * desktop while the same player built for a week on their phone used to
   * wake up, save its stale copy over the phone's, and publish it; now the
   * server refuses that, the tab reads the later copy back, and continues
   * from it with a card saying so.
   */
  const syncedRef = useRef(false);
  const reconcile = useCallback(async () => {
    if (spectating) return;
    const owner = (wallet.address ?? claimed.owner ?? '').toLowerCase();
    const seed = claimed.seed;
    const { world: published } = await fetchWorld(seed);
    // Whether or not there was anything to adopt, the question has been
    // asked: publishing may start.
    if (seedRef.current === seed) syncedRef.current = true;
    if (!published || !owner || published.owner.toLowerCase() !== owner) return;
    const remote = worldFromSave(published.snapshot as SavedWorld, seed, claimed.name);
    const local = worldRef.current;
    if (!remote || !local || seedRef.current !== seed) return;
    const ahead = remote.day > local.day || (remote.day === local.day && remote.hour > local.hour + 0.5);
    // Said in the console as well as on a card, so a player asking why
    // their settlement jumped has the answer in front of them.
    console.info(`Emerge: the published copy of ${remote.name} is on day ${remote.day}; this browser has day ${local.day}.${ahead ? ' Continuing from the published copy.' : ''}`);
    if (!ahead) return;
    // A world that was published was opened by a client that made good on
    // it, whether or not it wrote that down: it is not owed the grant again.
    markGoodwill(remote);
    worldRef.current = remote;
    selectedRef.current = null;
    setSelected(null);
    setFollowing(null);
    sceneRef.current?.reset(remote);
    setView(snapshot(remote, null));
    saveWorld(remote);
    announce({
      id: `cloud-${seed}-${remote.day}`,
      kind: 'sync',
      title: t('Picked up where you left off'),
      body: t('{name} is on day {day}, as you last left it on another device.', { name: remote.name, day: remote.day }),
      lifetime: 20_000,
    });
    // `announce` is stable for the life of the world.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimed.seed, claimed.name, claimed.owner, wallet.address, spectating]);
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;

  useEffect(() => {
    if (spectating) return;
    syncedRef.current = false;
    void reconcile();
    const back = () => { if (document.visibilityState === 'visible') void reconcileRef.current(); };
    document.addEventListener('visibilitychange', back);
    return () => { document.removeEventListener('visibilitychange', back); };
  }, [reconcile, spectating]);

  /*
   * Put this settlement up so it can be visited, and so it is never lost.
   *
   * Only the owner publishes, and only with a wallet: the relay checks the
   * address against the registry, so an unsigned or borrowed snapshot is
   * refused there as well as here. Nothing goes up until the published copy
   * has been read once — a device that opened at day one must not overwrite
   * day forty in the seconds before it learns about it — and a publish the
   * relay refuses as behind is answered by reading that later copy back.
   */
  useEffect(() => {
    if (spectating || !wallet.address) return;
    const seed = claimed.seed;
    const owner = wallet.address;
    let live = true;
    const put = async (keepalive = false) => {
      const world = worldRef.current;
      if (!live || !world || !syncedRef.current) return;
      const result = await publishWorld({
        seed,
        owner,
        ownerName: player.name,
        worldName: world.name,
        day: world.day,
        hour: world.hour,
        population: world.population,
        snapshot: snapshotOf(world),
      }, keepalive);
      if (live && result.behind) void reconcileRef.current();
    };
    // The first one after a short delay, so a player passing through a world
    // does not push a snapshot for every plot they open.
    const first = window.setTimeout(() => { void put(); }, 6_000);
    const timer = window.setInterval(() => { void put(); }, PUBLISH_INTERVAL);
    // And the moment the page is put away. On a phone this is the only save
    // that reliably happens: the interval never gets another turn once the
    // app is in the background.
    const away = () => {
      if (document.visibilityState !== 'hidden') return;
      void put(true);
    };
    document.addEventListener('visibilitychange', away);
    window.addEventListener('pagehide', away);
    return () => {
      live = false;
      window.clearTimeout(first);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', away);
      window.removeEventListener('pagehide', away);
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
        title: t('{gold} Gold from the stalls', { gold: Math.round(sold.gold).toLocaleString() }),
        body: sold.units > sold.bestUnits
          ? t('Your people sold {n} goods, mostly {good}.', { n: Math.round(sold.units), good: tn(good) })
          : t('Your people sold {n} {good}.', { n: Math.round(sold.bestUnits), good: tn(good) }),
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

  /**
   * Clear trees off the plot.
   *
   * The cursor becomes a ring; a tap fells every standing tree inside it that
   * the treasury can pay for, the timber goes to the yard, and the ground
   * stays cleared for the days it takes the wood to grow back.
   */
  const beginClear = useCallback(() => {
    const world = worldRef.current;
    const scene = sceneRef.current;
    if (!world || !scene) return;
    setPanel(null);
    setPlacing('Clear trees');
    scene.startClearing((x, y, standing) => {
      setPlacing(null);
      const result = clearTrees(world, x, y, standing);
      if (result.felled === 0) soundRef.current?.tick('deny');
      else soundRef.current?.cue('hammer');
      setView(snapshot(world, selectedRef.current));
      return result.felled;
    });
  }, []);

  const beginBuild = useCallback((type: string, cost: number) => {
    const world = worldRef.current;
    const scene = sceneRef.current;
    if (!world || !scene || world.treasury < Math.round(cost * buildDiscount(world))) return;
    setPanel(null);
    setPlacing(type);
    scene.startPlacement(type, (x, y) => {
      const building = constructBuilding(world, type, cost, x, y);
      setPlacing(null);
      if (building) {
        scene.syncBuildings();
        setSelected({ kind: 'building', id: building.id });
        markFirst('house');
      } else {
        // Refused: say why, here, not only in the feed.
        soundRef.current?.tick('deny');
        const why = placementProblem(world, type, x, y) ?? t('The yard is short of materials for it.');
        announce({ id: `build-${Date.now()}`, kind: 'sync', title: t('Not built'), body: tx(why), lifetime: 8_000 });
      }
      setView(snapshot(world, selectedRef.current));
    });
  }, [markFirst]);

  /** Send somebody away for a few days' pay. */
  const dismissFor = useCallback((id: string) => {
    const world = worldRef.current;
    if (!world) return;
    const result = dismissCitizen(world, id);
    if (!result.ok) {
      soundRef.current?.tick('deny');
      announce({ id: `dismiss-${Date.now()}`, kind: 'sync', title: t('They stay'), body: tx(result.message), lifetime: 8_000 });
      return;
    }
    setSelected(null);
    sceneRef.current?.syncBuildings();
    soundRef.current?.tick('select');
    setView(snapshot(world, null));
  }, []);

  /** Set the stock the market keeps of a good. */
  const keepFor = useCallback((resource: string, amount: number) => {
    const world = worldRef.current;
    if (!world) return;
    setKeep(world, resource as Resource, amount);
    setView(snapshot(world, selectedRef.current));
  }, []);

  /** Open or close the gates to newcomers. */
  const gatesFor = useCallback((closed: boolean) => {
    const world = worldRef.current;
    if (!world) return;
    setGates(world, closed);
    setView(snapshot(world, selectedRef.current));
  }, []);

  /** Retrain one person into a trade, for Gold. */
  const trainFor = useCallback((id: string, job: string): string | null => {
    const world = worldRef.current;
    if (!world) return null;
    const result = trainCitizen(world, id, job as WorkingJob);
    if (!result.ok) { soundRef.current?.tick('deny'); return result.message; }
    soundRef.current?.cue('anvil');
    setView(snapshot(world, selectedRef.current));
    return null;
  }, []);

  /** Fill a trade's open posts with the people who can best be spared. */
  const trainTradeFor = useCallback((job: string, count: number): string | null => {
    const world = worldRef.current;
    if (!world) return null;
    const result = trainTrade(world, job as WorkingJob, count);
    if (!result.ok) { soundRef.current?.tick('deny'); return result.message; }
    soundRef.current?.cue('anvil');
    setView(snapshot(world, selectedRef.current));
    return null;
  }, []);

  /** Pay the public works and raise the city a level. */
  const raiseCityFor = useCallback((): string | null => {
    const world = worldRef.current;
    if (!world) return null;
    const result = raiseCity(world);
    if (!result.ok) { soundRef.current?.tick('deny'); return result.message; }
    soundRef.current?.cue('hammer');
    saveWorld(world);
    setView(snapshot(world, selectedRef.current));
    announce({ id: `city-${world.id}-${world.works?.level ?? 0}`, kind: 'claim', title: t('A level {n} city', { n: world.works?.level ?? 1 }), body: t('The public works are done and the plot earns like a bigger place. Keep it fed, housed and busy and the ceiling is yours.'), lifetime: 12_000 });
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A festival: Gold for the whole town's spirits. */
  const festivalFor = useCallback((): string | null => {
    const world = worldRef.current;
    if (!world) return null;
    const result = holdFestival(world);
    if (!result.ok) { soundRef.current?.tick('deny'); return result.message; }
    soundRef.current?.cue('bell');
    setView(snapshot(world, selectedRef.current));
    return null;
  }, []);

  /** Arm the bridge cursor: the next tap on far land stakes out a crossing. */
  const beginBridge = useCallback(() => {
    const world = worldRef.current;
    const scene = sceneRef.current;
    if (!world || !scene) return;
    setPanel(null);
    setPlacing('Bridge');
    scene.startBridging((x, y) => {
      setPlacing(null);
      const result = startBridgeAt(world, x, y);
      if (!result.ok) {
        soundRef.current?.tick('deny');
        announce({ id: `bridge-${Date.now()}`, kind: 'sync', title: t('No crossing'), body: result.message, lifetime: 8_000 });
      } else {
        soundRef.current?.cue('hammer');
      }
      setView(snapshot(world, selectedRef.current));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /** Raise a ruin again. Gold and materials, less than new. */
  const rebuild = useCallback((id: string) => {
    const world = worldRef.current;
    if (!world) return;
    const result = rebuildBuilding(world, id);
    announce({ id: `rebuild-${id}-${Date.now()}`, kind: 'danger', title: result.ok ? t('Rebuilt') : t('Not yet'), body: tx(result.message), lifetime: 7000 });
    if (!result.ok) return;
    sceneRef.current?.syncBuildings();
    setView(snapshot(world, selectedRef.current));
  }, []);

  /** Spend Gold against whatever is going wrong. */
  const fight = useCallback((id: string) => {
    const world = worldRef.current;
    if (!world) return;
    const result = fightHazard(world, id);
    announce({ id: `fight-${id}-${Date.now()}`, kind: 'danger', title: result.ok ? t('Gold well spent') : t('Not yet'), body: tx(result.message), lifetime: 9000 });
    if (result.ok) setView(snapshot(world, selectedRef.current));
  }, []);

  /**
   * Trouble on demand, for a test build only.
   *
   * `?trial=tornado` (or earthquake, flood, plague, fire, rogue) brings the
   * named thing on as soon as the world opens. Compiled out of the real
   * build: the flag is read at build time and is not set in production.
   */
  useEffect(() => {
    if (!ready || process.env.NEXT_PUBLIC_TRIALS !== '1') return;
    // A window on the running world for the browser tests, in a trial build only.
    (window as unknown as { __emerge?: { world: () => World | null; construct: (type: string, x: number, y: number) => unknown; map: () => unknown; spot: () => unknown; music: () => unknown; focus: (id: string, zoom?: number) => void; art: (key: string) => unknown; sprites: () => unknown; select: (id: string) => void; pick: (id: string) => void } }).__emerge = {
      world: () => worldRef.current,
      construct: (type, x, y) => {
        if (!worldRef.current) return null;
        const built = constructBuilding(worldRef.current, type, BUILD_COSTS[type] ?? 0, x, y);
        // What the Build panel does after a placement: give the new building its sprites.
        if (built) sceneRef.current?.syncBuildings();
        return built;
      },
      map: () => sceneRef.current?.mapSize() ?? null,
      spot: () => sceneRef.current?.spot ?? null,
      music: () => music.playing,
      // Put the camera on a citizen, close, for a screenshot of what they ride.
      focus: (id: string, zoom = 2.4) => { sceneRef.current?.focus({ kind: 'citizen', id }); sceneRef.current?.zoomBy(zoom); },
      art: (key: string) => sceneRef.current?.artInfo(key) ?? null,
      sprites: () => sceneRef.current?.spriteInfo() ?? null,
      // Open a building's card, as a tap on it would.
      select: (id: string) => { setSelected({ kind: 'building', id }); },
      pick: (id: string) => { setSelected({ kind: 'citizen', id }); },
    };
    const what = new URLSearchParams(window.location.search).get('trial');
    if (!what) return;
    const timer = window.setTimeout(() => {
      const world = worldRef.current;
      if (!world) return;
      trial(world, what as Parameters<typeof trial>[1]);
      setView(snapshot(world, selectedRef.current));
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [ready]);

  /* Cards when trouble starts: a disaster, or somebody turning rogue. */
  useEffect(() => {
    if (spectating) return;
    let live = true;
    const seen = new Set<string>();
    let rogueSeen: string | null = null;
    let primed = false;
    const tick = () => {
      const world = worldRef.current;
      if (!live || !world) return;
      for (const h of world.hazards) {
        if (seen.has(h.id)) continue;
        seen.add(h.id);
        if (!primed) continue;
        announce({
          id: `danger-${h.id}`,
          kind: 'danger',
          title: t('{what} — the settlement is in danger', { what: tn(h.label) }),
          body: tx(h.effect),
          lifetime: 16_000,
        });
      }
      const rogue = world.citizens.find((c) => c.rogue);
      if (rogue && rogue.id !== rogueSeen) {
        rogueSeen = rogue.id;
        if (primed) {
          announce({
            id: `rogue-${rogue.id}-${world.day}`,
            kind: 'danger',
            title: t('{name} has turned on the settlement', { name: rogue.name }),
            body: t('The others will have to stop them. You cannot.'),
            lifetime: 16_000,
          });
        }
      } else if (!rogue) rogueSeen = null;
      primed = true;
    };
    tick();
    const timer = window.setInterval(tick, 3000);
    return () => { live = false; window.clearInterval(timer); };
  }, [announce, spectating]);

  /** Which building is being carried to a new site, if any. */
  const [movingBuilding, setMovingBuilding] = useState<string | null>(null);

  /**
   * Pick a building up, or put it back down.
   *
   * This reuses the placement cursor the Build panel already has: the player
   * taps the ground and the building goes there, which is the same gesture as
   * raising a new one and so needs no explaining.
   */
  const moveBuildingTo = useCallback((id: string | null) => {
    const world = worldRef.current;
    const scene = sceneRef.current;
    if (!world || !scene) return;
    if (!id) {
      scene.cancelPlacement();
      setMovingBuilding(null);
      return;
    }
    const building = world.buildings.find((b) => b.id === id);
    if (!building) return;
    setPanel(null);
    setMovingBuilding(id);
    scene.startPlacement(building.type, (x, y) => {
      setMovingBuilding(null);
      const result = moveBuilding(world, id, x, y);
      if (!result.ok) {
        soundRef.current?.tick('deny');
        announce({ id: `move-${Date.now()}`, kind: 'sync', title: t('Not moved'), body: tx(result.message), lifetime: 8_000 });
        return;
      }
      scene.syncBuildings();
      soundRef.current?.cue('hammer');
      setView(snapshot(world, selectedRef.current));
    }, id);
  }, []);

  /** Spend Gold and materials to make a building better at its job. */
  const improveBuilding = useCallback((id: string) => {
    const world = worldRef.current;
    if (!world) return;
    const result = upgradeBuilding(world, id);
    if (!result.ok) { soundRef.current?.tick('deny'); return; }
    sceneRef.current?.syncBuildings();
    soundRef.current?.cue('anvil');
    setView(snapshot(world, selectedRef.current));
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
          title: t('A gift arrived'),
          body: t('{who} sent {gold} Gold to your treasury.', { who: g.fromName || t('Somebody'), gold: g.gold.toLocaleString() }),
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

  /**
   * Expand the plot: open the outer belt for building, once.
   *
   * Paid first, then recorded. The registry will not mark a plot expanded
   * without a burn it has read off the chain, so a dismissed wallet prompt
   * costs nothing and changes nothing — and a plot already expanded on
   * another device is answered with its row rather than charged twice.
   */
  const expandFor = useCallback(async (): Promise<string | null> => {
    const world = worldRef.current;
    if (!world || spectating) return null;
    if (world.expanded) return t('This plot is already expanded.');
    if (!wallet.address) return t('Connect a wallet to expand the plot.');
    const paid = await spend(player.ledger, EXPAND_COST_EMERGE, wallet.address);
    if (!paid.ok) return paid.refused;
    onPlayer({ ...player, ledger: paid.ledger });
    let result = await expandOnRegistry(claimed.seed, wallet.address, paid.txHash ?? undefined);
    // The chain takes a moment to show the burn; the registry says so, and is asked again.
    for (let i = 1; i < 10 && !result.ok && result.settling; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      result = await expandOnRegistry(claimed.seed, wallet.address, paid.txHash ?? undefined);
    }
    if (!result.ok) {
      return paid.txHash
        ? `${result.reason} ${t('Your payment {tx}… was accepted by the chain — keep it, and tell us if the expansion never arrives.', { tx: paid.txHash.slice(0, 10) })}`
        : result.reason;
    }
    expandPlot(world);
    saveWorld(world);
    // The land itself grew: the ground, the water and the camera's limits are
    // all rebuilt from the new extent.
    selectedRef.current = null;
    setSelected(null);
    sceneRef.current?.reset(world);
    refresh();
    announce({
      id: `expand-${claimed.seed}`,
      kind: 'claim',
      title: t('The plot is expanded'),
      body: t('The land has grown on every side. Pan out: there is new ground beyond the old edge, and the wood on it is yours to clear.'),
      lifetime: 14_000,
    });
    return null;
    // `announce` is stable for the life of the world.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimed.seed, onPlayer, player, refresh, spectating, wallet.address]);

  /**
   * Buy a charter or insurance for the plot: $EMERGE burned, the registry
   * told, and only then does the world carry it. Another device picks it up
   * from the claim row.
   */
  const coverFor = useCallback(async (kind: CoverKind): Promise<string | null> => {
    const world = worldRef.current;
    if (!world || spectating) return null;
    if (!wallet.address) return t('Connect a wallet first.');
    const cost = kind === 'charter' ? Math.max(CHARTER_COST_EMERGE, charterCost(cityLevel(world), eraOf(world))) : kind === 'insurance' ? INSURANCE_COST_EMERGE : BUILDERS_COST_EMERGE;
    const paid = await spend(player.ledger, cost, wallet.address);
    if (!paid.ok) return paid.refused;
    onPlayer({ ...player, ledger: paid.ledger });
    let result = await coverPlot(claimed.seed, wallet.address, kind, paid.txHash ?? undefined);
    for (let i = 1; i < 10 && !result.ok && result.settling; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      result = await coverPlot(claimed.seed, wallet.address, kind, paid.txHash ?? undefined);
    }
    if (!result.ok) {
      return paid.txHash
        ? `${result.reason} ${t('Your payment {tx}… was accepted by the chain — keep it, and tell us if it never arrives.', { tx: paid.txHash.slice(0, 10) })}`
        : result.reason;
    }
    setCover(world, kind, result.until);
    saveWorld(world);
    refresh();
    return null;
  }, [claimed.seed, onPlayer, player, refresh, spectating, wallet.address]);

  /**
   * Buy a boon: checked against the world first so nobody pays for settlers
   * with nowhere to sleep, then paid, then verified by the registry, and only
   * then delivered.
   */
  const boonFor = useCallback(async (kind: BoonKind, emblem?: string): Promise<string | null> => {
    const world = worldRef.current;
    if (!world || spectating) return null;
    const check = boonCheck(world, kind);
    if (!check.ok) return check.message;
    if (kind === 'banner' && !emblem) return t('Choose an emblem.');
    if (!wallet.address) return t('Connect a wallet first.');
    const paid = await spend(player.ledger, BOON_COST_EMERGE[kind], wallet.address);
    if (!paid.ok) return paid.refused;
    onPlayer({ ...player, ledger: paid.ledger });
    let result = await boonPlot(claimed.seed, wallet.address, kind, paid.txHash ?? undefined, emblem);
    for (let i = 1; i < 10 && !result.ok && result.settling; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      result = await boonPlot(claimed.seed, wallet.address, kind, paid.txHash ?? undefined, emblem);
    }
    if (!result.ok) {
      return paid.txHash
        ? `${result.reason} ${t('Your payment {tx}… was accepted by the chain — keep it, and tell us if it never arrives.', { tx: paid.txHash.slice(0, 10) })}`
        : result.reason;
    }
    const done = applyBoon(world, kind, emblem);
    if (!done.ok) return done.message;
    saveWorld(world);
    // A finished bridge changes the ground; ruins, settlers and a monument only the sprites.
    if (kind === 'restore') sceneRef.current?.reset(world);
    else sceneRef.current?.syncBuildings();
    soundRef.current?.cue(kind === 'settlers' ? 'bell' : 'hammer');
    refresh();
    return null;
  }, [claimed.seed, onPlayer, player, refresh, spectating, wallet.address]);

  /**
   * Advance the plot to the next era.
   *
   * The world is published first, because the registry judges the gate on
   * the published copy and not on this browser's word; then paid; then
   * recorded; and only then does this world change. A refusal at any step
   * leaves it as it was, and a dismissed wallet prompt costs nothing.
   */
  const advanceFor = useCallback(async (): Promise<string | null> => {
    const world = worldRef.current;
    if (!world || spectating) return null;
    const gate = eraGate(world);
    if (!gate.next) return t('This is as far as the eras go, for now.');
    if (!gate.open) return t('The {era} era is not built yet. It is coming.', { era: gate.next.name });
    if (!gate.ready) return t('The settlement has not earned the next era yet.');
    if (!wallet.address) return t('Connect a wallet to advance the plot.');
    const put = await publishWorld({
      seed: claimed.seed, owner: wallet.address, ownerName: player.name, worldName: world.name,
      day: world.day, hour: world.hour, population: world.population, snapshot: snapshotOf(world),
    });
    if (!put.ok && !put.behind) return t('The world could not be published, and the registry judges the step on the published copy. Try again in a moment.');
    const target = gate.next.id;
    const paid = await spend(player.ledger, advanceCost(target), wallet.address);
    if (!paid.ok) return paid.refused;
    onPlayer({ ...player, ledger: paid.ledger });
    let result = await advanceOnRegistry(claimed.seed, wallet.address, target, paid.txHash ?? undefined);
    for (let i = 1; i < 10 && !result.ok && result.settling; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      result = await advanceOnRegistry(claimed.seed, wallet.address, target, paid.txHash ?? undefined);
    }
    if (!result.ok) {
      return paid.txHash
        ? `${result.reason} ${t('Your payment {tx}… was accepted by the chain — keep it, and tell us if the era never arrives.', { tx: paid.txHash.slice(0, 10) })}`
        : result.reason;
    }
    if (!advanceEra(world)) setEra(world, target);
    saveWorld(world);
    // Publish again with the era on it, so another device reading the
    // published copy opens a township rather than waiting for the claims
    // poll to catch it up.
    void publishWorld({
      seed: claimed.seed, owner: wallet.address, ownerName: player.name, worldName: world.name,
      day: world.day, hour: world.hour, population: world.population, snapshot: snapshotOf(world),
    });
    selectedRef.current = null;
    setSelected(null);
    sceneRef.current?.reset(world);
    refresh();
    announce({
      id: `era-${claimed.seed}-${target}`,
      kind: 'claim',
      title: t('A new era'),
      body: t('{name} is a {era} now. {arrives}', { name: world.name, era: gate.next.name.toLowerCase(), arrives: tx(gate.next.arrives) }),
      lifetime: 16_000,
    });
    return null;
    // `announce` is stable for the life of the world.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimed.seed, onPlayer, player, refresh, spectating, wallet.address]);

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

  /**
   * Take a stake for a bout, or pay one back.
   *
   * One door in both directions, so the panel cannot pay itself without going
   * through the treasury: a negative amount is a win coming home, a positive
   * one is a stake going out. Both are booked under the arena, where the Bank
   * shows them.
   */
  const stakeAtArena = useCallback((gold: number, on: string) => {
    const world = worldRef.current;
    // Never on a visit: the treasury in front of a visitor is not theirs, and
    // betting out of it would be spending somebody else's Gold.
    if (!world || spectating) return false;
    if (gold < 0) {
      settleBout(world, -gold, `${(-gold).toLocaleString()} Gold came back from the colosseum.`);
      refresh();
      return true;
    }
    const took = stakeOnBout(world, gold, on);
    if (took) refresh();
    return took;
  }, [refresh, spectating]);

  /** Move Gold in or out of the treasury and persist the vault ledger. */
  const vault = useCallback((ledger: VaultLedger, goldDelta: number, note: string) => {
    const world = worldRef.current;
    if (!world) return;
    if (goldDelta > 0) fundTreasury(world, goldDelta, note);
    else if (goldDelta < 0 && !drawFromTreasury(world, -goldDelta, note)) return;
    onPlayer({ ...player, ledger });
    refresh();
  }, [onPlayer, player, refresh]);

  /**
   * Put this plot up for resale, or take it back off the market.
   *
   * The registry carries the listing, so every player sees it on the map and
   * a buyer can pay this wallet for it; the local record mirrors what the
   * registry accepted, and nothing when it refused.
   */
  const listPlot = useCallback((price: number | null) => {
    if (!wallet.address) return;
    void (async () => {
      const asked = price !== null && price > 0 ? Math.round(price) : null;
      const result = await listPlotOnRegistry(claimed.seed, wallet.address!, asked);
      if (!result.ok) return;
      const listings = player.listings.filter((l) => l.seed !== claimed.seed);
      if (asked) listings.push({ seed: claimed.seed, region: claimed.region, price: asked, listedAt: Date.now() });
      onPlayer({ ...player, listings });
    })();
  }, [claimed.region, claimed.seed, onPlayer, player, wallet.address]);

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
          <p>{t('Painting a world…')}</p>
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
            onToggleSound={() => { setSound((on) => { music.set(!on); return !on; }); }}
            player={player}
            onRenameCitizen={renameCitizenFor}
            onDemolish={demolish}
            onDismiss={dismissFor}
            onRebuild={rebuild}
            onFight={fight}
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
            movingBuilding={movingBuilding}
            onUpgradeBuilding={improveBuilding}
            onMoveBuilding={moveBuildingTo}
            watching={watching}
            online={online}
            visiting={visit ? { ...visit, hand: !!visit.hand } : null}
            onEndVisit={onLeave}
            firstDay={firstDay && !firstDay.dismissed && !spectating ? {
              cap: view.stewardship.cap,
              steps: [
                { key: 'person', done: firstDay.person },
                { key: 'house', done: firstDay.house },
                { key: 'bank', done: firstDay.bank },
                // Any building, houses included: the roster leaves houses out.
                { key: 'improve', done: !!worldRef.current?.buildings.some((b) => (b.level ?? 1) >= 2) },
                { key: 'return', done: Date.now() - firstDay.startedAt > FIRST_RETURN_MS },
              ],
            } : null}
            onFirstDayGo={(go) => {
              if (go === 'person') {
                // Somebody with a trade, out where they can be seen: the step
                // says everyone here has a trade, so show one who does.
                const people = worldRef.current?.citizens ?? [];
                const someone = people.find((c) => !c.inside && c.age >= 16 && c.job !== 'unemployed')
                  ?? people.find((c) => c.age >= 16) ?? people[0];
                if (someone) focusOn({ kind: 'citizen', id: someone.id });
              } else setPanel(go);
            }}
            onFirstDayDismiss={() => markFirst('dismissed')}
          />
          <Notices notices={notices} onDismiss={dismiss} />
          {panel === 'arena' && (
            <Arena
              world={spectating ? null : worldRef.current}
              seed={claimed.seed}
              worldName={claimed.name}
              playerName={player.name}
              address={wallet.address}
              treasury={view.treasury}
              ledger={player.ledger}
              onLedger={(ledger) => onPlayer({ ...player, ledger })}
              onStake={stakeAtArena}
              onCue={(kind) => soundRef.current?.cue(kind)}
              onClose={() => setPanel(null)}
            />
          )}
          <Panels
            panel={panel}
            view={view}
            claimed={claimed}
            player={player}
            onClose={() => setPanel(null)}
            onBuild={beginBuild}
            onTrain={trainFor}
            onTrainTrade={trainTradeFor}
            onGates={gatesFor}
            onKeep={keepFor}
            onClearTrees={beginClear}
            onBridge={beginBridge}
            onRaiseCity={raiseCityFor}
            onFestival={festivalFor}
            onCover={coverFor}
            onBoon={boonFor}
            onRenameWorld={renameWorldFor}
            onExpand={expandFor}
            onAdvance={advanceFor}
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
