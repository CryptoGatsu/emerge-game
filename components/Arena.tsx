"use client";

/**
 * The colosseum.
 *
 * An island nobody owns and everybody can walk into, where citizens from real
 * settlements fight and the crowd bets on it. Every viewer is watching the same
 * bout at the same moment — the arena publishes one card on a three-minute
 * clock, and the fight itself is replayed here blow by blow from the record the
 * arena hands out when the bell goes.
 *
 * **The fight cannot be rigged and cannot be read early.** The arena draws a
 * secret when it makes a bout and publishes only its hash. Betting runs for two
 * minutes against that hash; then the secret is revealed and the fight is
 * computed from it. Nobody — including the house — can know the winner while
 * the money is going on, and anybody can check afterwards that the secret
 * matches the hash that was published beforehand. This panel does that check
 * itself, in the browser, and says so either way.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MAX_STAKE, MAX_STAKE_PER_DAY, offered, payout, refuse } from '@/lib/arena/betting';
import { enterFighter, fetchArena, type ArenaState, type Bout, type Fighter } from '@/lib/net/arena';
import { skillDays, skillLevel, vigourOf, type Citizen, type World, type WorkingJob } from '@/lib/simulation';

/** How often the card is re-read. Faster than a bout, slower than the clock. */
const POLL = 8_000;

/** What a blow looks like, so the same round always reads the same way. */
const MOVES = [
  'steps in and lands one',
  'catches them off balance',
  'drives them back',
  'gets under the guard',
  'swings and connects',
  'puts everything into it',
];

const clock = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** Check the arena kept its word: does the revealed secret match the promise? */
async function commitHolds(bout: Bout): Promise<boolean | null> {
  if (!bout.reveal || typeof crypto?.subtle?.digest !== 'function') return null;
  try {
    const bytes = new TextEncoder().encode(bout.reveal);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return hex === bout.commit;
  } catch {
    return null;
  }
}

function Corner({ fighter, side, odds, winner, health }: {
  fighter: Fighter; side: 'red' | 'blue'; odds: number;
  winner?: 'red' | 'blue'; health: number;
}) {
  const lost = winner && winner !== side;
  return (
    <div className={`corner ${side} ${winner === side ? 'won' : ''} ${lost ? 'lost' : ''}`}>
      <span className="corner-side">{side === 'red' ? 'RED CORNER' : 'BLUE CORNER'}</span>
      <b>{fighter.name}</b>
      <span className="corner-from">{fighter.job} of {fighter.worldName}</span>
      <div className="corner-health"><i style={{ width: `${health}%` }} /></div>
      <div className="corner-stats">
        <span>level {fighter.level}</span>
        <span>vigour {fighter.vigour}</span>
        {(fighter.won > 0 || fighter.lost > 0) && <span>{fighter.won}W {fighter.lost}L</span>}
      </div>
      <em className="corner-odds">{odds.toFixed(2)}&times;</em>
    </div>
  );
}

export default function Arena({ world, seed, worldName, playerName, address, treasury, onStake, onClose }: {
  /** The player's own settlement, for picking a fighter out of it. */
  world: World | null;
  seed: number;
  worldName: string;
  playerName: string;
  address: string | null;
  treasury: number;
  /** Take a stake, or pay a win. Returns false when the treasury cannot cover it. */
  onStake: (gold: number, on: string) => boolean;
  onClose: () => void;
}) {
  const [state, setState] = useState<ArenaState | null>(null);
  const [tick, setTick] = useState(Date.now());
  const [notice, setNotice] = useState<string | null>(null);
  const [stake, setStake] = useState('50');
  const [entering, setEntering] = useState(false);

  /** The bet standing on the bout being fought, if any. */
  const [bet, setBet] = useState<{ boutId: number; on: 'red' | 'blue'; gold: number; odds: number } | null>(null);
  /** How much has gone on bouts today, so the daily cap means something. */
  const stakedToday = useRef(0);
  /** Bouts already paid, so a re-poll cannot pay a winning bet twice. */
  const settled = useRef(new Set<number>());
  const [verified, setVerified] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    const read = async () => {
      const next = await fetchArena();
      if (live && next) setState(next);
    };
    void read();
    const poll = window.setInterval(() => { void read(); }, POLL);
    const beat = window.setInterval(() => setTick(Date.now()), 250);
    return () => { live = false; window.clearInterval(poll); window.clearInterval(beat); };
  }, []);

  const bout = state?.bout ?? null;
  const skew = state?.skew ?? 0;
  const now = tick - skew;

  const phase: 'betting' | 'fighting' | 'settled' | 'empty' = !bout ? 'empty'
    : now < bout.closesAt ? 'betting'
      : now < bout.endsAt ? 'fighting' : 'settled';

  /*
   * The fight, replayed.
   *
   * The arena hands out every blow at once when the bell goes; the crowd should
   * see them land one at a time. So the round list is walked against the clock,
   * which also means somebody who opens the panel halfway through joins the
   * fight halfway through rather than seeing it from the start.
   */
  const shown = useMemo(() => {
    const rounds = bout?.rounds ?? [];
    if (!bout || !rounds.length) return { rounds: [] as typeof rounds, red: 100, blue: 100, done: false };
    // Walked against the clock rather than dumped at once: the arena hands over
    // every blow the moment betting closes, and the crowd should see them land
    // one at a time over the minute they are meant to fill. It also means
    // somebody who opens the panel halfway through joins the fight halfway
    // through, as they would if they had walked in.
    const fightMs = Math.max(1, bout.endsAt - bout.closesAt);
    const per = fightMs / (rounds.length + 1);
    const upto = Math.max(0, Math.min(rounds.length, Math.floor((now - bout.closesAt) / per)));
    const last = rounds[upto - 1];
    return {
      rounds: rounds.slice(0, upto),
      red: last ? last.redLeft : 100,
      blue: last ? last.blueLeft : 100,
      done: upto >= rounds.length,
    };
  }, [bout, now]);

  /* Pay a won bet once the bout that carried it is settled. */
  useEffect(() => {
    if (!bet) return;
    const finished = [state?.bout, state?.previous].find((b) => b?.id === bet.boutId && b?.winner);
    // Both are checked because a bout rolls out of `bout` and into `previous`
    // at the bell, and a poll can land on either side of that.
    if (!finished?.winner || settled.current.has(bet.boutId)) return;
    settled.current.add(bet.boutId);
    if (finished.winner === bet.on) {
      const back = payout(bet.gold, bet.odds);
      onStake(-back, `the ${bet.on} corner`);
      setNotice(`${bet.on === 'red' ? finished.red.name : finished.blue.name} won. ${back.toLocaleString()} Gold came back.`);
    } else {
      setNotice(`${bet.on === 'red' ? finished.red.name : finished.blue.name} went down. The stake is gone.`);
    }
    setBet(null);
  }, [state, bet, onStake]);

  /* Check the arena's promise on whatever bout has just been revealed. */
  useEffect(() => {
    // The bout on screen, and only that one. Checking whichever bout happened
    // to carry a reveal meant the panel announced "verified" underneath a bout
    // whose secret was still sealed, which is the opposite of what this block
    // exists to say.
    if (!bout?.reveal) { setVerified(null); return; }
    let live = true;
    void commitHolds(bout).then((held) => { if (live) setVerified(held); });
    return () => { live = false; };
  }, [bout?.id, bout?.reveal, bout?.commit]);

  const place = (on: 'red' | 'blue') => {
    if (!bout) return;
    const gold = Number(stake);
    const refusal = refuse(gold, treasury, stakedToday.current);
    if (refusal) { setNotice(refusal); return; }
    if (bet) { setNotice('You already have a bet on this bout.'); return; }
    const price = offered(on === 'red' ? bout.odds.red : bout.odds.blue);
    const who = on === 'red' ? bout.red.name : bout.blue.name;
    if (!onStake(gold, who)) { setNotice('Your treasury cannot cover that.'); return; }
    stakedToday.current += gold;
    setBet({ boutId: bout.id, on, gold, odds: price });
    setNotice(`${gold.toLocaleString()} Gold on ${who} at ${price.toFixed(2)}×.`);
  };

  /** Who this settlement could send. */
  const candidates = useMemo(() => {
    if (!world) return [] as Citizen[];
    return [...world.citizens]
      .filter((c) => c.age >= 16 && !c.carried)
      .sort((a, b) => vigourOf(b) - vigourOf(a))
      .slice(0, 5);
  }, [world]);

  const send = useCallback(async (c: Citizen) => {
    setEntering(true);
    const level = c.job === 'unemployed' ? 0 : skillLevel(skillDays(c, c.job as WorkingJob));
    const result = await enterFighter(address, {
      seed,
      citizenId: c.id,
      name: c.name,
      worldName,
      job: c.job,
      level,
      vigour: vigourOf(c),
      ownerName: playerName,
    });
    setEntering(false);
    setNotice(result.ok ? `${c.name} is on the roster.` : result.error);
  }, [address, seed, worldName, playerName]);

  const mine = state?.roster.filter((f) => f.seed === seed) ?? [];

  return (
    <div className="overlay" onClick={onClose}>
      <section className="overlay-panel wide arena" onClick={(e) => e.stopPropagation()}>
        <header>
          <div>
            <h3>The Colosseum</h3>
            <p className="muted">
              An island nobody owns. Fighters come from real settlements, the bout is the same one
              for everybody watching, and the result cannot be known before the bell.
            </p>
          </div>
          <button className="panel-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="overlay-body">
          {!state && <p className="muted">Crossing to the island…</p>}

          {state && !bout && (
            <div className="arena-empty">
              <b>No bout on the card.</b>
              <p className="muted">
                The arena needs two fighters before it can run one. Send somebody from your own
                settlement and the next bell will pair them.
              </p>
            </div>
          )}

          {bout && (
            <>
              <div className={`arena-clock ${phase}`}>
                {phase === 'betting' && <><b>Betting closes in {clock(bout.closesAt - now)}</b><span>Bout #{bout.id}</span></>}
                {phase === 'fighting' && <><b>Fighting</b><span>{clock(bout.endsAt - now)} left</span></>}
                {phase === 'settled' && <><b>Bout over</b><span>Next bell in {clock(bout.endsAt + (state?.boutMs ?? 180_000) - now)}</span></>}
              </div>

              <div className="arena-ring">
                <Corner
                  fighter={bout.red} side="red" health={shown.red}
                  odds={offered(bout.odds.red)} winner={shown.done ? bout.winner : undefined}
                />
                <div className="arena-versus">
                  <span>vs</span>
                  {bet && <em className="arena-bet">{bet.gold.toLocaleString()} on {bet.on} at {bet.odds.toFixed(2)}×</em>}
                </div>
                <Corner
                  fighter={bout.blue} side="blue" health={shown.blue}
                  odds={offered(bout.odds.blue)} winner={shown.done ? bout.winner : undefined}
                />
              </div>

              {phase === 'betting' && (
                <div className="arena-bet-row">
                  <label>
                    <span>STAKE</span>
                    <input
                      type="number" min={1} max={MAX_STAKE} value={stake}
                      onChange={(e) => setStake(e.target.value)}
                    />
                  </label>
                  <button className="bet red" disabled={!!bet} onClick={() => place('red')}>
                    {bout.red.name} · {offered(bout.odds.red).toFixed(2)}×
                  </button>
                  <button className="bet blue" disabled={!!bet} onClick={() => place('blue')}>
                    {bout.blue.name} · {offered(bout.odds.blue).toFixed(2)}×
                  </button>
                </div>
              )}

              {(phase === 'fighting' || phase === 'settled') && (
                <div className="arena-blows">
                  {shown.rounds.length === 0 && <p className="muted small">They are circling…</p>}
                  {shown.rounds.map((r, i) => (
                    <p key={i} className={r.by}>
                      <b>{r.by === 'red' ? bout.red.name : bout.blue.name}</b> {MOVES[r.move % MOVES.length]} — {r.hit}
                    </p>
                  ))}
                  {shown.done && bout.winner && (
                    <p className="arena-result">
                      <b>{bout.winner === 'red' ? bout.red.name : bout.blue.name}</b> takes it.
                    </p>
                  )}
                </div>
              )}

              <div className="arena-proof">
                <span className="eyebrow">THE ARENA&rsquo;S PROMISE</span>
                <code title="Published before a single bet was placed">{bout.commit.slice(0, 32)}…</code>
                <p className="muted small">
                  {verified === true && 'Checked in your browser: the revealed secret matches the hash published before betting opened. This bout was not rewritten.'}
                  {verified === false && 'The revealed secret does NOT match what was published. Do not trust this result.'}
                  {verified === null && 'The secret behind this bout is sealed until the bell. Nobody can know the winner while the money is going on — including the house.'}
                </p>
              </div>
            </>
          )}

          <h4>Send a fighter</h4>
          {!world || !candidates.length ? (
            <p className="muted small">You need a settlement of your own to enter somebody.</p>
          ) : (
            <>
              <p className="muted small">
                Fitness is the person as your settlement made them — rested, fed, warm and clothed.
                Skill is the trade they have spent their life at. Neither is a hidden number.
              </p>
              <div className="arena-bench">
                {candidates.map((c) => {
                  const level = c.job === 'unemployed' ? 0 : skillLevel(skillDays(c, c.job as WorkingJob));
                  const already = mine.some((f) => f.id === `${seed}:${c.id}`);
                  return (
                    <button key={c.id} className="bench-card" disabled={entering || already} onClick={() => void send(c)}>
                      <b>{c.name}</b>
                      <span>level {level} · vigour {vigourOf(c)}</span>
                      <em>{already ? 'on the roster' : 'send'}</em>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {state && state.results.length > 0 && (
            <>
              <h4>Recent bouts</h4>
              <div className="arena-history">
                {state.results.map((r) => (
                  <p key={r.id}>
                    <b>{r.winner}</b> <span className="muted">of {r.winnerWorld} beat</span> {r.loser}
                    {' '}<span className="muted">of {r.loserWorld}</span>
                  </p>
                ))}
              </div>
            </>
          )}

          {notice && <p className="arena-notice">{notice}</p>}
          <p className="muted small arena-rules">
            Bets are with your own treasury at the odds shown, capped at {MAX_STAKE} Gold a bout and
            {' '}{MAX_STAKE_PER_DAY.toLocaleString()} a day. They are not pooled against other
            players: Gold lives in your browser and the arena has no way to prove what anybody
            holds, so a pot would be a pot a dishonest client could take from honest ones. The
            fight is shared; the money stays at home.
          </p>
        </div>
      </section>
    </div>
  );
}
