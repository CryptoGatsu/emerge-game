/**
 * How people talk to each other.
 *
 * A conversation used to be one of a dozen four-line scripts, chosen by
 * topic, and the same script came out of everybody's mouth. Now an exchange
 * is composed for the two people having it: an opening that knows what they
 * are to each other, a subject one of them has a real reason to raise — a
 * night gone hungry, a new child, a fight they saw, the thing the other one
 * told them last time — a reply in the listener's own voice, and a parting
 * that says where they are off to. Two blunt people and two warm ones do not
 * have the same talk about the same news.
 *
 * Nothing here reads the simulation directly: the simulation builds a small
 * brief for each speaker and this file turns two briefs into lines. That
 * keeps the writing in one place, and keeps it testable without a world.
 */

export type Trait = 'warm' | 'blunt' | 'dreamer' | 'worrier' | 'joker' | 'proud' | 'quiet' | 'curious' | 'grumbler' | 'steady';
export const TRAITS: Trait[] = ['warm', 'blunt', 'dreamer', 'worrier', 'joker', 'proud', 'quiet', 'curious', 'grumbler', 'steady'];

/** Two traits from a hash: the first is the louder one. */
export function traitsOf(hash: number): [Trait, Trait] {
  const a = Math.abs(hash) % TRAITS.length;
  const b = Math.floor(Math.abs(hash) / TRAITS.length) % (TRAITS.length - 1);
  return [TRAITS[a], TRAITS[b >= a ? b + 1 : b]];
}

export const TRAIT_LABELS: Record<Trait, string> = {
  warm: 'warm', blunt: 'blunt', dreamer: 'a dreamer', worrier: 'a worrier', joker: 'a joker',
  proud: 'proud', quiet: 'quiet', curious: 'curious', grumbler: 'a grumbler', steady: 'steady',
};

/** What has happened to somebody lately, as the simulation records it. */
export type EpisodeKind =
  | 'hungry' | 'unpaid' | 'roughSleep' | 'sawFight' | 'newFriend' | 'household' | 'child'
  | 'arrived' | 'mastered' | 'freed' | 'sick' | 'recovered' | 'hazard' | 'festival' | 'fellOut' | 'lost'
  | 'wantMet' | 'holiday' | 'snowman' | 'greatWork';
export interface Episode { day: number; kind: EpisodeKind; about?: string; detail?: string }

/**
 * Something a person wants and does not have.
 *
 * A being with a want is a being with a story: the thing they keep coming
 * back to when nothing else is pressing, the thing they say when they meet
 * somebody, and the thing that, when it comes, is worth a day's talk. It is
 * read off their state each morning — no roof, no trade, nobody to talk to —
 * and held until the state changes, so a want lasts days and is met or not.
 */
export type WantKind = 'roof' | 'trade' | 'mastery' | 'company' | 'rest' | 'purpose' | 'horizon';
export interface Want { kind: WantKind; since: number; about?: string }

/**
 * The want said as a thing: "a roof before winter".
 *
 * In the first person for their own mouth, in the third for the card, the
 * feed and anybody passing it on — "a trade of my own" is theirs to say and
 * nobody else's.
 */
export function wantWord(w: Want, person: 'first' | 'third' = 'first'): string {
  const own = person === 'first' ? 'my own' : 'their own';
  switch (w.kind) {
    case 'roof': return 'a roof before winter';
    case 'trade': return `a trade of ${own}`;
    case 'mastery': return `to be called a master ${w.about ?? 'at the work'}`;
    case 'company': return 'somebody to talk to';
    case 'rest': return 'a proper night\'s sleep';
    case 'purpose': return 'work that means something';
    case 'horizon': return 'to see what is over the ridge';
  }
}

/** A want met, kept on an episode as its kind, so each voice can say it in its own person. */
export function wantFrom(e: Episode): Want | null {
  const kind = e.about as WantKind | undefined;
  if (!kind || !['roof', 'trade', 'mastery', 'company', 'rest', 'purpose', 'horizon'].includes(kind)) return null;
  return { kind, since: e.day, about: e.detail };
}

/** The want in the first person, as a thought: what they would say to nobody. */
export function wantLine(w: Want, roll: number): string {
  const pick = (a: string, b: string) => (roll % 2 === 0 ? a : b);
  switch (w.kind) {
    case 'roof': return pick('I want a roof over my head before the cold comes.', 'One more night under the sky. I am so tired of it.');
    case 'trade': return pick('I want a trade of my own. Something with my name on it.', 'Everybody here has work but me.');
    case 'mastery': return pick(`One day they will call me a master ${w.about ?? ''}. One day.`.replace('  ', ' '), 'Every day at the bench gets me closer.');
    case 'company': return pick('I would like somebody to talk to, some evenings.', 'It is quiet, being new here.');
    case 'rest': return pick('What I would give for one whole night\'s sleep.', 'My feet have not stopped in days.');
    case 'purpose': return pick('I want work that means something. This is not it.', 'There has to be more to it than this.');
    case 'horizon': return pick('One day I will go and see what is past the ridge.', 'I keep looking at the far shore.');
  }
}

/** What somebody has heard about somebody else: news that travelled. */
export interface Heard { about: string; kind: EpisodeKind; day: number; detail?: string }

/** How the two of them stand to each other. */
export type Relation = 'rivals' | 'spouse' | 'kin' | 'friends' | 'known' | 'strangers';

/** Everything the composer needs to know about one speaker. */
export interface Brief {
  name: string;
  /** Their trade, lower case, as it would be said: "baker". */
  trade: string;
  traits: [Trait, Trait];
  age: number;
  hungry: boolean;
  tired: boolean;
  /** Lately, newest last. */
  recent: Episode[];
  /** Where they mean to be later, said as a place: "the tavern", or null. */
  evening: string | null;
  /** The last thing they talked about with this same person, if they remember. */
  lastTalk: { topic: string; day: number } | null;
  /** What they want and do not have, if anything. */
  want?: Want | null;
  /** News about other people that reached them, newest last. */
  heard?: Heard[];
}

export interface TownBrief {
  name: string;
  day: number;
  season: string;
  weather: string;
  bread: boolean;
  resolution: string | null;
  showcase: { maker: string; title: string } | null;
  project: string | null;
  babies: number;
  festivalToday: boolean;
  /** Today's holiday by name, if it is one. */
  holiday: string | null;
  /** Snow lying deep enough to play in, and how many snowmen stand in it. */
  snow: boolean;
  snowmen: number;
  gatesClosed: boolean;
  arrivals: number;
}

export interface Exchange { topic: string; lines: string[] }

/* ------------------------------------------------------------------ *
 * The episodes, said out loud
 * ------------------------------------------------------------------ */

/** An episode in the first person, as the one it happened to would raise it. */
export function episodeLine(e: Episode, day: number): string {
  const ago = day - e.day;
  const when = ago <= 0 ? 'today' : ago === 1 ? 'yesterday' : `${ago} days back`;
  switch (e.kind) {
    case 'hungry': return ago <= 1 ? 'I went to bed hungry last night.' : `I went to bed hungry ${when}.`;
    case 'unpaid': return ago <= 1 ? 'The treasury could not pay me yesterday.' : `I went unpaid ${when}.`;
    case 'roughSleep': return 'I slept under the sky again.';
    case 'sawFight': return `I saw ${e.about ?? 'two of them'} come to blows in the square.`;
    case 'newFriend': return `${e.about ?? 'Somebody'} and I have got to be good friends.`;
    case 'household': return `${e.about ?? 'We'} and I have set up house together.`;
    case 'child': return `We have a new one at home. ${e.about ?? 'A little one'}.`;
    case 'arrived': return ago <= 1 ? 'I only came in on the road yesterday.' : `I only came in on the road ${when}.`;
    case 'mastered': return `They call me a ${e.about ?? 'master'} now.`;
    case 'freed': return 'I am out of the jail. Quieter for it.';
    case 'sick': return 'I have been poorly.';
    case 'recovered': return 'I am on my feet again.';
    case 'hazard': return `We came through the ${e.about ?? 'worst of it'}.`;
    case 'festival': return 'That festival was a day to remember.';
    case 'fellOut': return `${e.about ?? 'Somebody'} and I are not speaking.`;
    case 'lost': return `We buried ${e.about ?? 'somebody'} ${when}.`;
    case 'wantMet': { const w = wantFrom(e); return w ? `I have ${wantWord(w, 'first')} at last.` : 'I have what I wanted at last.'; }
    case 'holiday': return ago <= 1 ? `That was a good ${e.about ?? 'holiday'}.` : `${e.about ?? 'The holiday'} was ${when}. Already.`;
    case 'snowman': return ago <= 1 ? 'I built a snowman. It is still standing.' : 'I built a snowman the other day.';
    case 'greatWork': return ago <= 2 ? `They finished the ${e.about ?? 'great work'}. I watched them raise it.` : `We have the ${e.about ?? 'great work'} now.`;
  }
}

/** The same episode in the third person, for the card. */
export function episodeNote(e: Episode): string {
  switch (e.kind) {
    case 'hungry': return 'Went to bed hungry';
    case 'unpaid': return 'Went unpaid';
    case 'roughSleep': return 'Slept rough';
    case 'sawFight': return `Saw ${e.about ?? 'two people'} fight`;
    case 'newFriend': return `Made a friend in ${e.about ?? 'somebody'}`;
    case 'household': return `Set up house with ${e.about ?? 'somebody'}`;
    case 'child': return `Welcomed ${e.about ?? 'a child'}`;
    case 'arrived': return 'Arrived on the road';
    case 'mastered': return `Became a ${e.about ?? 'master'}`;
    case 'freed': return 'Let out of the jail';
    case 'sick': return 'Fell sick';
    case 'recovered': return 'Recovered';
    case 'hazard': return `Came through the ${e.about ?? 'danger'}`;
    case 'festival': return 'Danced at the festival';
    case 'fellOut': return `Fell out with ${e.about ?? 'somebody'}`;
    case 'lost': return `Lost ${e.about ?? 'somebody'}`;
    case 'wantMet': { const w = wantFrom(e); return w ? `Got ${wantWord(w, 'third')}` : 'Got what they wanted'; }
    case 'holiday': return e.about ?? 'A holiday';
    case 'snowman': return 'Built a snowman';
    case 'greatWork': return `Saw the ${e.about ?? 'great work'} finished`;
  }
}

/** The same news about a third person, as a rumour would carry it: "went to bed hungry". */
export function heardLine(h: Heard): string {
  const note = episodeNote({ day: h.day, kind: h.kind, about: h.detail });
  return note.charAt(0).toLowerCase() + note.slice(1);
}

/** Which way a piece of news cuts, which decides how the listener answers. */
type Cut = 'trouble' | 'good' | 'work' | 'weather' | 'town' | 'callback' | 'meeting';
const CUT: Record<EpisodeKind, Cut> = {
  hungry: 'trouble', unpaid: 'trouble', roughSleep: 'trouble', sawFight: 'trouble', sick: 'trouble', fellOut: 'trouble', lost: 'trouble',
  newFriend: 'good', household: 'good', child: 'good', mastered: 'good', freed: 'good', recovered: 'good', festival: 'good', hazard: 'good', arrived: 'good',
  wantMet: 'good', holiday: 'good', snowman: 'good', greatWork: 'good',
};

/* ------------------------------------------------------------------ *
 * Voices
 * ------------------------------------------------------------------ */

/**
 * How each kind of person answers each kind of news.
 *
 * {name} is the other person, {town} the settlement. The first line of each
 * pool is the plainest, so a voice never runs out of things to say.
 */
const REPLY: Record<Trait, Record<Cut, string[]>> = {
  warm: {
    trouble: ['Come to ours tonight, {name}. There is enough.', 'I am sorry. You should have said sooner.', 'Sit with me a minute. It helps.'],
    good: ['That is the best thing I have heard all week.', 'I am so glad, {name}.', 'You deserve it, every bit.'],
    work: ['You work too hard, you know.', 'Tell me if it gets too much.', 'You make it look easy. It is not.'],
    weather: ['Wrap up, then. I mean it.', 'Days like this are for being together.', 'Come in by the fire later.'],
    town: ['I hope it does us all some good.', 'People here look after each other. That is what I like.', 'We will see it through together.'],
    callback: ['I have been thinking about it since.', 'You remembered. That means a lot.', 'It stayed with me too.'],
    meeting: ['Well met, {name}. Truly.', 'Any friend of {town} is a friend of mine.', 'You must come by the house.'],
  },
  blunt: {
    trouble: ['Then eat earlier. The market shuts at dusk.', 'That is what happens. Deal with it.', 'Complaining will not fix it.'],
    good: ['Good. About time.', 'Fine. Do not let it go to your head.', 'Earned, then.'],
    work: ['Work is work.', 'Less talk, more done.', 'Everybody is tired. Get on with it.'],
    weather: ['Weather is weather.', 'It will do what it does.', 'Dress for it.'],
    town: ['We will see.', 'Talk is cheap in {town}.', 'Somebody had to say it.'],
    callback: ['I said what I said.', 'Still true.', 'You did not listen the first time.'],
    meeting: ['{name}. Right.', 'I know your face.', 'Keep out of my way in the yard and we will get on.'],
  },
  dreamer: {
    trouble: ['One day none of us will go without. I can see it.', 'Bad nights make the good mornings, {name}.', 'Think of what this place will be in ten years.'],
    good: ['I knew it. I dreamed something like it.', 'This is how it begins.', 'Imagine where that leads.'],
    work: ['I keep thinking of what we could build instead.', 'Somewhere past the ridge there is a better way to do it.', 'The work is only the start of it.'],
    weather: ['The light on the water was worth the walk.', 'I could watch this sky all day.', 'A day like this wants a song.'],
    town: ['{town} is going to be something. I feel it.', 'Wait until the roads reach the far shore.', 'This is the start of a story.'],
    callback: ['I made a song out of it, nearly.', 'I still think about that.', 'It has been in my head ever since.'],
    meeting: ['I have wondered about you, {name}.', 'Everybody here has a story. What is yours?', 'New faces mean new roads.'],
  },
  worrier: {
    trouble: ['That is the second time this week. It worries me.', 'What if it happens again?', 'Should we tell somebody? We should tell somebody.'],
    good: ['I am pleased. I only hope it lasts.', 'That is good. Do not jinx it.', 'Wonderful. Now mind you keep it.'],
    work: ['Are we behind? I feel like we are behind.', 'The stores looked low to me this morning.', 'Mind your hands on that.'],
    weather: ['I do not like the look of it.', 'Is the roof going to hold?', 'We should get the animals in.'],
    town: ['I hope they know what they are doing.', 'These things always cost more than they say.', 'And who pays for it?'],
    callback: ['I have not stopped thinking about it.', 'Did it come right in the end?', 'I worried about you after.'],
    meeting: ['Are you settling in? It is not easy here.', 'You will want to find a roof before winter.', 'Mind the water at the north end.'],
  },
  joker: {
    trouble: ['That is why you look so thin.', 'Cheer up. It could be raining. Oh.', 'I would lend you my supper but I ate it.'],
    good: ['Well look at you.', 'Drinks are on you, then.', 'Do not tell everybody or they will all want one.'],
    work: ['Working hard or hardly working?', 'My hands hurt just watching you.', 'Rest is for people with nothing to carry.'],
    weather: ['Lovely weather for ducks.', 'I ordered sun. This is not sun.', 'Snow again. Who is in charge of this?'],
    town: ['I give it a week.', 'That is the most exciting thing to happen since the last thing.', 'Somebody will write a song about it. Probably me.'],
    callback: ['I told everyone that story. Twice.', 'You are still on about that?', 'I have a better version now.'],
    meeting: ['Do not believe anything they tell you about me.', 'Welcome to {town}. Mind the mud.', 'I am the handsome one. You will have heard.'],
  },
  proud: {
    trouble: ['I have never gone without in my life. Plan better.', 'Trouble finds those who let it.', 'You will not hear me complain.'],
    good: ['I said you had it in you.', 'Not bad. Not as good as mine, but not bad.', 'Now you know what it takes.'],
    work: ['Nobody in {town} does it better than me.', 'You will know my work when you see it.', 'Standards, {name}. Standards.'],
    weather: ['Weather never stopped me.', 'A little wind. Please.', 'I have worked through worse.'],
    town: ['They should have asked me.', 'I would have done it differently.', 'It will be better for my part in it.'],
    callback: ['I was right, as it turned out.', 'You will recall I said so.', 'Of course I remember. I remember everything.'],
    meeting: ['You will know my name soon enough.', '{name}. I am the best {trade} this side of the water.', 'I do not need introductions.'],
  },
  quiet: {
    trouble: ['I am sorry.', 'That is hard.', 'Say if you need anything.'],
    good: ['Good.', 'That is good news.', 'I am glad.'],
    work: ['Yes.', 'It goes.', 'Same here.'],
    weather: ['It is.', 'Mm.', 'Better than yesterday.'],
    town: ['We will see.', 'Perhaps.', 'I heard.'],
    callback: ['I remember.', 'Yes. I thought about it.', 'It stayed with me.'],
    meeting: ['{name}.', 'Hello.', 'I have seen you about.'],
  },
  curious: {
    trouble: ['How did that happen? Tell me all of it.', 'Was it the stores, or the wages?', 'And what did you do then?'],
    good: ['How did it come about?', 'Tell me everything.', 'What was that like?'],
    work: ['How does the {trade} spend a day, really?', 'What is the hardest part of it?', 'I always wanted to see that done.'],
    weather: ['Where does the weather come from, do you think?', 'Have you ever seen it worse?', 'I wonder what it is doing over the water.'],
    town: ['Who decided that? I want to know how it works.', 'What happens next?', 'I want to see it for myself.'],
    callback: ['And did it turn out the way you thought?', 'I have wondered about that since.', 'Tell me the rest.'],
    meeting: ['Where did you come from, {name}?', 'What brought you to {town}?', 'What do you make of the place?'],
  },
  grumbler: {
    trouble: ['Nothing works in this town.', 'And nobody does anything about it.', 'Same as ever.'],
    good: ['Wait until it goes wrong.', 'Enjoy it while it lasts.', 'Hm. Nice for some.'],
    work: ['My back has had enough of it.', 'The tools are rubbish and the pay is worse.', 'Nobody thanks you.'],
    weather: ['Typical.', 'Of course it is.', 'It was better in my day.'],
    town: ['More talk.', 'I will believe it when I see it.', 'Who asked for that?'],
    callback: ['Still not sorted, I suppose.', 'Told you.', 'Nothing changes.'],
    meeting: ['Another one.', 'You will regret coming here.', 'Do not expect much.'],
  },
  steady: {
    trouble: ['One day at a time, {name}.', 'It will come right. It usually does.', 'We have had worse and we are still here.'],
    good: ['Well done. Keep at it.', 'That is how it should be.', 'Good news is good news.'],
    work: ['Steady does it.', 'Same tomorrow, and the day after.', 'The work is there. We do it.'],
    weather: ['It will pass.', 'Every season has its own.', 'Nothing a good coat will not fix.'],
    town: ['Give it time.', 'Things get done here, in the end.', 'Sensible enough.'],
    callback: ['I remember. It worked out.', 'Yes, and here we are.', 'Time sorts most things.'],
    meeting: ['Welcome, {name}. You will do fine.', 'Good to have another pair of hands.', 'Ask if you need anything.'],
  },
};

/** How each kind of person takes the answer. */
const ACK: Record<Trait, string[]> = {
  warm: ['You are kind.', 'Thank you, {name}.', 'I knew you would say that.'],
  blunt: ['Fair.', 'Right.', 'We will see about that.'],
  dreamer: ['Maybe you are right.', 'I like the sound of that.', 'Yes. Maybe.'],
  worrier: ['I hope so.', 'If you say so.', 'I suppose.'],
  joker: ['Ha.', 'You would say that.', 'Very good.'],
  proud: ['Naturally.', 'As I thought.', 'Quite.'],
  quiet: ['Mm.', 'Yes.', 'Thank you.'],
  curious: ['Is that so?', 'Interesting.', 'I will remember that.'],
  grumbler: ['Hm.', 'We will see.', 'If you say so.'],
  steady: ['Aye.', 'Fair enough.', 'That is true.'],
};

/** How each kind of person takes their leave. {place} is where they are off to. */
const PART: Record<Trait, { going: string[]; staying: string[] }> = {
  warm: { going: ['I am for {place}. Walk with me?', 'Come and find me at {place} later.'], staying: ['Mind how you go, {name}.', 'Come by the house this week.'] },
  blunt: { going: ['{place}. Coming or not?', 'I am off to {place}.'], staying: ['Right. Go on, then.', 'That is enough talk.'] },
  dreamer: { going: ['I might wander to {place}. Or past it.', 'Off to {place}, unless the road has other ideas.'], staying: ['Watch the sky tonight.', 'Until next time, then.'] },
  worrier: { going: ['I should get to {place} before it is dark.', 'I had better go. {place}, then home.'], staying: ['Get home safe.', 'Do not stay out too late.'] },
  joker: { going: ['{place} calls. It knows my name.', 'Off to {place}. Do not miss me too much.'], staying: ['Try not to fall in the river.', 'Same time tomorrow, same nonsense.'] },
  proud: { going: ['I am expected at {place}.', 'They will be waiting for me at {place}.'], staying: ['You will hear of me.', 'Good day.'] },
  quiet: { going: ['{place}, then.', 'I am going to {place}.'], staying: ['Good night.', 'Take care.'] },
  curious: { going: ['I want to see what is happening at {place}.', 'Off to {place}. There is always something to learn there.'], staying: ['Tell me how it goes.', 'I want to hear the rest tomorrow.'] },
  grumbler: { going: ['{place}, I suppose. Not that it will be any good.', 'Off to {place}. Somebody has to.'], staying: ['Go on.', 'Whatever.'] },
  steady: { going: ['I am for {place}. Same as always.', 'Off to {place}. See you there, maybe.'], staying: ['Take it steady.', 'See you tomorrow.'] },
};

/* ------------------------------------------------------------------ *
 * Openings
 * ------------------------------------------------------------------ */

function opener(a: Brief, b: Brief, rel: Relation, town: TownBrief, roll: number): string {
  const [t] = a.traits;
  const pick = (lines: string[]) => lines[roll % lines.length];
  switch (rel) {
    case 'spouse': return pick(['You are back early.', 'There you are, love.', 'I saved you some.', 'Did you get on all right today?']);
    case 'kin': return pick([`${b.name}. Is everyone home?`, 'There you are. I have been looking for you.', 'Have you eaten?', 'Mother asked after you.']);
    case 'friends': return pick(
      t === 'warm' ? [`${b.name}! Come here, let me look at you.`, `It has been days, ${b.name}.`]
        : t === 'joker' ? [`Look what the road dragged in.`, `${b.name}! Still alive, then.`]
          : t === 'blunt' ? [`${b.name}.`, `About time, ${b.name}.`]
            : [`Good to see you, ${b.name}.`, `${b.name}! It has been days.`]);
    case 'known': return pick([`Morning, ${b.name}.`, `${b.name}.`, `Good day, ${b.name}.`, `${b.name}, how goes it?`]);
    case 'rivals': return pick(['You have a nerve, showing your face.', 'I heard what you said about the yard.', 'Not here. Not today.']);
    case 'strangers':
    default: return pick(
      t === 'proud' ? [`You will know my work. ${a.name}, ${a.trade}.`, `${a.name}. The ${a.trade}. You will have heard.`]
        : t === 'quiet' ? [`${a.name}.`, 'Hello.']
          : t === 'curious' ? [`I do not know you. ${a.name}. Where are you from?`, `New face. I am ${a.name}, the ${a.trade}.`]
            : [`${b.trade ? b.trade[0].toUpperCase() + b.trade.slice(1) : 'Newcomer'}, is it? I do not think we have spoken. ${a.name}.`, `I am ${a.name}, the ${a.trade}. And you?`]);
  }
}

/* ------------------------------------------------------------------ *
 * Subjects
 * ------------------------------------------------------------------ */

interface Subject { topic: string; line: string; cut: Cut; asking?: boolean }

/**
 * What the opener has a reason to raise, in the order it would come to
 * mind: something that happened to the other one first — people ask after
 * each other — then something that happened to them, then the thing they
 * talked about last time, then the town, the work, the weather.
 */
function subjects(a: Brief, b: Brief, rel: Relation, town: TownBrief): Subject[] {
  const out: Subject[] = [];
  const recentB = b.recent.filter((e) => town.day - e.day <= 3).slice(-2);
  const recentA = a.recent.filter((e) => town.day - e.day <= 3).slice(-2);
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

  if (rel !== 'strangers' && rel !== 'rivals') {
    for (const e of recentB) {
      const ask: Partial<Record<EpisodeKind, string>> = {
        hungry: `I heard you went to bed hungry, ${b.name}. Is that true?`,
        unpaid: 'Did they pay you in the end?',
        roughSleep: `Are you still sleeping out, ${b.name}?`,
        sawFight: 'You were there when it came to blows, I heard.',
        newFriend: `You and ${e.about ?? 'them'} are thick as thieves these days.`,
        household: `So you and ${e.about ?? 'them'} have set up house. Good.`,
        child: `How is the little one? ${e.about ?? 'The baby'}, is it?`,
        arrived: `How are you finding ${town.name}?`,
        mastered: `A ${e.about ?? 'master'} now, I hear. Is it true?`,
        freed: 'Out of the jail, then. How was it?',
        sick: 'Are you feeling any better?',
        recovered: 'Good to see you on your feet.',
        hazard: `Did the ${e.about ?? 'worst of it'} reach your end?`,
        festival: 'I saw you dancing at the festival.',
        fellOut: `You and ${e.about ?? 'them'} still not speaking?`,
        lost: `I was sorry to hear about ${e.about ?? 'your loss'}.`,
      };
      const line = ask[e.kind];
      if (line) out.push({ topic: `${b.name}'s ${e.kind === 'child' ? 'new child' : e.kind === 'lost' ? 'loss' : 'news'}`, line, cut: CUT[e.kind], asking: true });
    }
  }
  for (const e of recentA) {
    out.push({ topic: e.kind === 'sawFight' ? 'the fight in the square' : e.kind === 'child' ? `${a.name}'s new child` : `${a.name}'s ${CUT[e.kind] === 'trouble' ? 'trouble' : 'news'}`, line: episodeLine(e, town.day), cut: CUT[e.kind] });
  }
  // The thing they want comes up with anybody they know: it is what is on
  // their mind. Said as a wish, so the listener answers it as trouble or as
  // hope depending on who they are.
  if (a.want && rel !== 'strangers' && rel !== 'rivals') {
    out.push({ topic: `what ${a.name} wants`, line: `What I want is ${wantWord(a.want)}.`, cut: a.want.kind === 'horizon' || a.want.kind === 'mastery' ? 'good' : 'trouble' });
  }
  // News that reached them about somebody else, passed on. This is how a
  // settlement comes to know things: not because everybody saw them but
  // because somebody told somebody. The listener does not hear news about
  // themselves this way, and a rumour is dropped after a few days.
  for (const h of (a.heard ?? []).filter((h) => town.day - h.day <= 3 && h.about !== b.name).slice(-2)) {
    out.push({ topic: `${h.about}'s news`, line: `I heard ${h.about} ${heardLine(h)}.`, cut: CUT[h.kind] === 'trouble' ? 'trouble' : 'town' });
  }
  if (a.lastTalk && town.day - a.lastTalk.day <= 6 && rel !== 'strangers') {
    out.push({ topic: a.lastTalk.topic, line: `You remember what we said about ${a.lastTalk.topic}?`, cut: 'callback' });
  }
  if (town.festivalToday) out.push({ topic: 'the festival', line: 'A festival, today of all days. Are you going down?', cut: 'town' });
  if (town.holiday) out.push({ topic: town.holiday, line: `${town.holiday} today. Are you coming down to the square this evening?`, cut: 'town' });
  if (town.snow) out.push({ topic: 'the snow', line: town.snowmen > 0 ? 'Did you see the snowmen on the green? The children have been at it all morning.' : 'Snow like this, and the whole town out in it. I love a day like today.', cut: 'town' });
  if (town.resolution) out.push({ topic: 'the meeting', line: `They resolved ${town.resolution} at the meeting.`, cut: 'town' });
  if (town.showcase) out.push({ topic: 'the showcase', line: `Did you see ${town.showcase.maker}'s piece? “${town.showcase.title}”.`, cut: 'town' });
  if (town.project) out.push({ topic: town.project, line: `Have you seen how far along ${town.project.toLowerCase()} is?`, cut: 'town' });
  if (town.babies > 0) out.push({ topic: 'the children', line: town.babies === 1 ? 'There is a new one in the settlement.' : `${town.babies} little ones about the place now.`, cut: 'town' });
  if (town.gatesClosed) out.push({ topic: 'the gates', line: 'The gates are shut. Nobody new on the road.', cut: 'town' });
  if (town.arrivals > 0) out.push({ topic: 'the newcomers', line: town.arrivals === 1 ? 'Somebody new came in on the road today.' : `${town.arrivals} came in on the road today.`, cut: 'town' });
  if (a.trade && a.trade === b.trade) out.push({ topic: `the ${a.trade}'s work`, line: 'How did you get on today?', cut: 'work', asking: true });
  if (a.trade) out.push({ topic: `the ${a.trade}'s work`, line: `${cap(a.trade)}'s work never ends. My hands are finished.`, cut: 'work' });
  if (a.hungry) out.push({ topic: 'the stores', line: town.bread ? 'I have not eaten. Is there bread at the market still?' : 'I have not eaten, and the stores were bare when I looked.', cut: 'trouble' });
  if (a.tired) out.push({ topic: 'the long day', line: 'I have been up since before light.', cut: 'work' });
  const sky: Record<string, string> = {
    Clear: 'A fine day for it.', Cloudy: 'Flat grey light all day.', Rain: 'All this rain.',
    Storm: 'That wind is getting up.', Fog: 'Cannot see the far bank in this.', Snow: 'Cold enough to see your breath.',
  };
  out.push({ topic: 'the weather', line: sky[town.weather] ?? 'Some weather we are having.', cut: 'weather' });
  out.push({ topic: 'the season', line: `${town.season} always comes round faster than I expect.`, cut: 'weather' });
  return out;
}

/* ------------------------------------------------------------------ *
 * The exchange
 * ------------------------------------------------------------------ */

const fill = (line: string, vars: Record<string, string>) => line.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

/**
 * Compose an exchange between two people. `roll` is any stable number the
 * caller has (hashes and the day), so the same pair says something else
 * tomorrow and the same thing for as long as the bubble is up.
 */
export function compose(a: Brief, b: Brief, rel: Relation, town: TownBrief, roll: number): Exchange {
  const vars = (self: Brief, other: Brief) => ({ name: other.name, town: town.name, trade: self.trade || 'hand', place: self.evening ?? 'home' });
  const [ta] = a.traits;
  const [tb] = b.traits;

  // People who cannot stand each other are not making small talk.
  if (rel === 'rivals') {
    const spats: string[][] = [
      ['You have a nerve, showing your face.', 'It is a small settlement. I go where I like.', 'Not where I am, you do not.', 'Then move.'],
      ['I heard what you said about the yard.', 'I said what everybody is thinking.', 'Say it to me next time, then.', 'I just did.'],
      ['Keep your people off my side of the lane.', 'Your side. Listen to yourself.', 'I mean it.', 'So do I.'],
    ];
    return { topic: 'an old grievance', lines: spats[roll % spats.length] };
  }

  // Urgent weather: nobody discusses the price of wool in a blizzard.
  if (town.weather === 'Storm' || town.weather === 'Snow') {
    const snow = town.weather === 'Snow';
    return {
      topic: 'the weather',
      lines: [
        snow ? 'Cold enough to see your breath out here.' : 'That wind is getting up.',
        fill(REPLY[tb].weather[roll % 3], vars(b, a)),
        'Have you enough firewood put by?',
        'Enough for a week. Come round if you run short.',
      ],
    };
  }

  const options = subjects(a, b, rel, town);
  // The first few are the personal ones and deserve most of the weight.
  const weighted: Subject[] = [];
  options.forEach((s, i) => { const w = i < 2 ? 4 : i < 4 ? 3 : s.cut === 'weather' ? 1 : 2; for (let k = 0; k < w; k++) weighted.push(s); });
  const subject = weighted[roll % weighted.length];

  const lines: string[] = [];
  const intro = rel === 'strangers';
  lines.push(opener(a, b, rel, town, roll));
  if (intro) {
    // A stranger answers the introduction before anything else is raised.
    lines.push(fill(REPLY[tb].meeting[roll % 3], vars(b, a)));
  }
  lines.push(subject.line);
  // The listener's answer: in their own voice, to the kind of thing it is. A
  // question about their own news gets an answer about it before the voice.
  if (subject.asking) {
    const answer: Record<Cut, string[]> = {
      trouble: ['It is true. It was a bad night.', 'Not the first time, either.', 'I would rather not talk about it.'],
      good: ['It is true. I still cannot quite believe it.', 'It is. Ask me how I feel about it.', 'Yes. It has changed everything.'],
      work: ['Slow start, then it came right after noon.', 'Better than yesterday.', 'The same as ever.'],
      weather: ['Well enough.', 'I have seen worse.', 'It is what it is.'],
      town: ['I was there.', 'I heard.', 'So they say.'],
      callback: ['I remember.', 'Yes.', 'How could I forget.'],
      meeting: ['Well enough.', 'Finding my feet.', 'It will do.'],
    };
    lines.push(answer[subject.cut][(roll >> 2) % 3]);
    lines.push(fill(REPLY[ta][subject.cut][(roll >> 3) % 3], vars(a, b)));
  } else {
    lines.push(fill(REPLY[tb][subject.cut][(roll >> 2) % 3], vars(b, a)));
    if ((roll >> 4) % 3 !== 0) lines.push(fill(ACK[ta][(roll >> 5) % 3], vars(a, b)));
  }
  // Whoever speaks last parts; if that is a, b answers with their own parting.
  const closer = lines.length % 2 === 0 ? b : a;
  const part = closer.evening ? PART[closer.traits[0]].going : PART[closer.traits[0]].staying;
  lines.push(fill(part[(roll >> 6) % part.length], vars(closer, closer === a ? b : a)));

  // A line that opens on a filled slot ('the square, I suppose') starts
  // with a small letter; every line is a sentence.
  return { topic: subject.topic, lines: lines.map((l) => l.charAt(0).toUpperCase() + l.slice(1)) };
}
