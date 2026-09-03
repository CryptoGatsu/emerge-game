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
import { t, tj, useLocale } from '@/lib/i18n';

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
      <span className="corner-side">{side === 'red' ? t('RED CORNER') : t('BLUE CORNER')}</span>
      <b>{fighter.name}</b>
      <span className="corner-from">{t('{job} of {world}', { job: tj(fighter.job), world: fighter.worldName })}</span>
      <div className="corner-health"><i style={{ width: `${health}%` }} /></div>
      <div className="corner-stats">
        <span>{t('level {n}', { n: fighter.level })}</span>
        <span>{t('vigour {n}', { n: fighter.vigour })}</span>
        {(fighter.won > 0 || fighter.lost > 0) && <span>{fighter.won}W {fighter.lost}L</span>}
      </div>
      <em className="corner-odds">{odds.toFixed(2)}&times;</em>
    </div>
  );
}

export default function Arena({ world, seed, worldName, playerName, address, treasury, onStake, onCue, onClose }: {
  /** The player's own settlement, for picking a fighter out of it. */
  world: World | null;
  seed: number;
  worldName: string;
  playerName: string;
  address: string | null;
  treasury: number;
  /** Take a stake, or pay a win. Returns false when the treasury cannot cover it. */
  onStake: (gold: number, on: string) => boolean;
  /** Make a noise. The panel does not own the soundscape; the game does. */
  onCue: (kind: 'crowd' | 'blow' | 'win' | 'lose' | 'bell' | 'coin') => void;
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
  useLocale();

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

  /*
   * The arena, out loud.
   *
   * Driven off what is on screen rather than off the clock, so the thud lands
   * with the line that describes it. The crowd comes up once as the bell goes
   * and once when it is decided; the blows are one each; and a settled bout
   * plays win or lose depending on where the money went.
   */
  const heard = useRef(0);
  const rung = useRef<number | null>(null);
  useEffect(() => {
    if (shown.rounds.length > heard.current) onCue('blow');
    heard.current = shown.rounds.length;
  }, [shown.rounds.length, onCue]);
  useEffect(() => {
    if (!bout || rung.current === bout.id) return;
    if (phase === 'fighting') { rung.current = bout.id; onCue('crowd'); }
  }, [bout, phase, onCue]);

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
      onCue('win');
      setNotice(t('{who} won. {gold} Gold came back.', { who: bet.on === 'red' ? finished.red.name : finished.blue.name, gold: back.toLocaleString() }));
    } else {
      onCue('lose');
      setNotice(t('{who} went down. The stake is gone.', { who: bet.on === 'red' ? finished.red.name : finished.blue.name }));
    }
    setBet(null);
  }, [state, bet, onStake, onCue]);

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
    if (refusal) { setNotice(t(refusal)); return; }
    if (bet) { setNotice(t('You already have a bet on this bout.')); return; }
    const price = offered(on === 'red' ? bout.odds.red : bout.odds.blue);
    const who = on === 'red' ? bout.red.name : bout.blue.name;
    if (!onStake(gold, who)) { setNotice(t('Your treasury cannot cover that.')); return; }
    stakedToday.current += gold;
    onCue('coin');
    setBet({ boutId: bout.id, on, gold, odds: price });
    setNotice(t('{gold} Gold on {who} at {odds}×.', { gold: gold.toLocaleString(), who, odds: price.toFixed(2) }));
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
    setNotice(result.ok ? t('{name} is on the roster.', { name: c.name }) : result.error);
  }, [address, seed, worldName, playerName]);

  const mine = state?.roster.filter((f) => f.seed === seed) ?? [];

  return (
    <div className="overlay" onClick={onClose}>
      <section className="overlay-panel wide arena" onClick={(e) => e.stopPropagation()}>
        <header>
          <div>
            <h3>{t('The Colosseum')}</h3>
            <p className="muted">
              {t('An island nobody owns. Fighters come from real settlements, the bout is the same one for everybody watching, and the result cannot be known before the bell.')}
            </p>
          </div>
          <button className="panel-close" onClick={onClose} aria-label={t('Close')}>×</button>
        </header>

        <div className="overlay-body">
          {!state && <p className="muted">{t('Crossing to the island…')}</p>}

          {state && !bout && (
            <div className="arena-empty">
              <b>{t('No bout on the card.')}</b>
              <p className="muted">
                {t('The arena needs two fighters before it can run one. Send somebody from your own settlement and the next bell will pair them.')}
              </p>
            </div>
          )}

          {bout && (
            <>
              <div className={`arena-clock ${phase}`}>
                {phase === 'betting' && <><b>{t('Betting closes in {time}', { time: clock(bout.closesAt - now) })}</b><span>{t('Bout #{id}', { id: bout.id })}</span></>}
                {phase === 'fighting' && <><b>{t('Fighting')}</b><span>{t('{time} left', { time: clock(bout.endsAt - now) })}</span></>}
                {phase === 'settled' && <><b>{t('Bout over')}</b><span>{t('Next bell in {time}', { time: clock(bout.endsAt + (state?.boutMs ?? 180_000) - now) })}</span></>}
              </div>

              <div className="arena-ring">
                <Corner
                  fighter={bout.red} side="red" health={shown.red}
                  odds={offered(bout.odds.red)} winner={shown.done ? bout.winner : undefined}
                />
                <div className="arena-versus">
                  <span>{t('vs')}</span>
                  {bet && <em className="arena-bet">{t('{gold} on {side} at {odds}×', { gold: bet.gold.toLocaleString(), side: t(bet.on), odds: bet.odds.toFixed(2) })}</em>}
                </div>
                <Corner
                  fighter={bout.blue} side="blue" health={shown.blue}
                  odds={offered(bout.odds.blue)} winner={shown.done ? bout.winner : undefined}
                />
              </div>

              {phase === 'betting' && (
                <div className="arena-bet-row">
                  <label>
                    <span>{t('STAKE')}</span>
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
                  {shown.rounds.length === 0 && <p className="muted small">{t('They are circling…')}</p>}
                  {shown.rounds.map((r, i) => (
                    <p key={i} className={r.by}>
                      <b>{r.by === 'red' ? bout.red.name : bout.blue.name}</b> {t(MOVES[r.move % MOVES.length])} — {r.hit}
                    </p>
                  ))}
                  {shown.done && bout.winner && (
                    <p className="arena-result">
                      <b>{bout.winner === 'red' ? bout.red.name : bout.blue.name}</b> {t('takes it.')}
                    </p>
                  )}
                </div>
              )}

              <div className="arena-proof">
                <span className="eyebrow">{t('THE ARENA’S PROMISE')}</span>
                <code title={t('Published before a single bet was placed')}>{bout.commit.slice(0, 32)}…</code>
                <p className="muted small">
                  {verified === true && t('Checked in your browser: the revealed secret matches the hash published before betting opened. This bout was not rewritten.')}
                  {verified === false && t('The revealed secret does NOT match what was published. Do not trust this result.')}
                  {verified === null && t('The secret behind this bout is sealed until the bell. Nobody can know the winner while the money is going on — including the house.')}
                </p>
              </div>
            </>
          )}

          <h4>{t('Send a fighter')}</h4>
          {!world || !candidates.length ? (
            <p className="muted small">{t('You need a settlement of your own to enter somebody.')}</p>
          ) : (
            <>
              <p className="muted small">
                {t('Fitness is the person as your settlement made them — rested, fed, warm and clothed. Skill is the trade they have spent their life at. Neither is a hidden number.')}
              </p>
              <p className="muted small">
                {t('An entry is good for one bout. Whoever is drawn comes straight off the roster and goes home afterwards, so sending somebody back out is your call every time rather than something that happens to them.')}
              </p>
              <div className="arena-bench">
                {candidates.map((c) => {
                  const level = c.job === 'unemployed' ? 0 : skillLevel(skillDays(c, c.job as WorkingJob));
                  const id = `${seed}:${c.id}`;
                  const already = mine.some((f) => f.id === id);
                  // Somebody in the bout on now is not available to be sent
                  // anywhere: they are busy.
                  const fighting = !!bout && now < bout.endsAt && (bout.red.id === id || bout.blue.id === id);
                  return (
                    <button
                      key={c.id}
                      className="bench-card"
                      disabled={entering || already || fighting}
                      onClick={() => void send(c)}
                    >
                      <b>{c.name}</b>
                      <span>{t('level {n}', { n: level })} · {t('vigour {n}', { n: vigourOf(c) })}</span>
                      <em>{fighting ? t('in the ring') : already ? t('on the roster') : t('send')}</em>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {state && state.results.length > 0 && (
            <>
              <h4>{t('Recent bouts')}</h4>
              <div className="arena-history">
                {state.results.map((r) => (
                  <p key={r.id}>
                    <b>{r.winner}</b> <span className="muted">{t('of {world} beat', { world: r.winnerWorld })}</span> {r.loser}
                    {' '}<span className="muted">{t('of {world}', { world: r.loserWorld })}</span>
                  </p>
                ))}
              </div>
            </>
          )}

          {notice && <p className="arena-notice">{notice}</p>}
          <p className="muted small arena-rules">
            {t('Bets are with your own treasury at the odds shown, capped at {max} Gold a bout and {day} a day. They are not pooled against other players: Gold lives in your browser and the arena has no way to prove what anybody holds, so a pot would be a pot a dishonest client could take from honest ones. The fight is shared; the money stays at home.', { max: MAX_STAKE, day: MAX_STAKE_PER_DAY.toLocaleString() })}
          </p>
        </div>
      </section>
    </div>
  );
}
