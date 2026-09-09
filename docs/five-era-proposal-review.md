# Review of the five-era proposal

A player sent a long proposal covering eras, buildings, workforce, production, resources, civic buildings, a talent market, the military, territory war, the arena, land supply, recalculation of existing plots and an economy-wide rebalance. This is the review against what the game already has, what was built from it in v2.8, and what is held for v3.0 or left for a decision.

Legend: **have** the game already does it · **built** done in v2.8 · **3.0** belongs to the war release on the shelf · **no** would hurt the game as it is · **decide** a business call, not a code one.

## 1. Era system — mostly have

Five ages exist (Settlement, Township, Industrial, Modern, AI) and since v2.7 every building has a form per age with its own name, look, room, output, cost and upkeep. The proposal's "Tribal / Town / Industrial / Modern / AI" is the same ladder under other names.

- Keep the first age as the tutorial: **have**.
- Each age's own buildings, names, professions, production: **have** for buildings and production, **built** for professions (trade titles by age, §4.2).
- Redesign Lv.1–10 and era requirements so building count is not a gate: the era gates today count people and buildings weighed by age, plus specific civic buildings; the city level counts people and buildings. Replacing the count with something better (stewardship, days lived in the age, treasury depth) is reasonable, but it changes what every current plot qualifies for and belongs with §20. **decide**.

## 2. Building rules — partly have, one no

- Different models per age with a consistent silhouette per kind: **have** (v2.7 forms and per-era art).
- Old buildings stay until the player pulls them down and rebuilds: **no**, for now. The v2.7 advance rebuilds in place and keeps every building, because the previous fold-and-merge cost players half their towns and had to be made good. Buildings already carry their own era, so a per-building "raise into the age" button is possible later without another migration; that is the right shape for 3.0, not a change to spring on plots that just recovered.
- Housing named per age: **have** (cabin, townhouse, terrace, apartment block, habitat tower).
- One person, one bed: **have** since the population change (births and arrivals are bounded by beds).
- One house sleeps the workers of three buildings of its level: roughly **have** already through the forms' beds; not worth a rule.

## 3. Workforce table — breaks the game

Fifteen to twenty-three workers per building in the township, up to a hundred and eighteen in the AI age. Every person in Emerge is a walking agent with a route, a home, a memory and conversations. A modern-age plot with twenty workplaces would carry over a thousand agents; the client already had to be profiled to keep two hundred and fifty moving. The scale between ages is expressed through the forms' posts and output instead (a settlement farm takes two, an AI agri-tower thirty-two, with more from each pair of hands), which gives the same feeling without breaking the renderer. **no** as written; the intent is **have**.

## 4. Production buildings and professions — have + built

- Twelve production lines evolving by age: **have**; the names differ in places from the proposal's, and the forms file is where to change a name.
- Professions that change with the age without retraining: **built**. Every trade now has a title per age (farmer → farm worker → agricultural mechanic → agricultural technician → agriculture engineer, and so on), shown on the People panel, the card, the feed and over people's heads, in English and Chinese.

## 5. Resource evolution — no, with a reason

Renaming wheat to grain to industrial grain per age is attractive, but the market is one market shared by every plot in the world, priced by the good. Either the names become cosmetic per plot (and the same price history reads as "wheat" on one plot and "smart nutritional grain" on another) or the goods fragment and a township cannot sell to a settlement. Not adding new base resources is the right call and is **have**; the age-specific goods that exist (meals, steel) are real goods with real uses. **no** for the renaming.

## 6. Old-era products — have

Every good trades on the market at any age; nothing is stranded. The Build panel lists the current age's buildings only and greys nothing out from earlier ages; buildings the player owns are on the People panel's Buildings tab. **have**.

## 7. Civic buildings — have

No new civic categories; later ages already add their versions (Hospital, Research Campus, Guildhall, Data Centre). **have**.

## 8. Talent market — built

This was the most valuable idea in the proposal for the world the game is trying to be, and it is in v2.8 as **Notables**:

- From the township, a school, a clinic or hospital, a bank, a laboratory or research campus and the town hall each want a professional (teacher, physician, banker, researcher, administrator).
- Without one the building runs at three quarters; with one at full strength and more (competent +15%, accomplished +30%, renowned +50%). Nothing stops working.
- Professionals turn up on their own for the buildings the town has standing, most days one, renowned ones about one time in twelve, and stay three days. Rarer talent is rarer, as the proposal asks.
- Engaged for a fee, kept on a salary from the treasury; three days unpaid and they leave. Only civic talent is offered; ordinary workers are not.
- The People panel has a Notables tab; a building's card says who keeps it. Feed lines in both languages.
- The settlement age is untouched, as the proposal asks.

Not yet: the notable as a walking citizen with a home and conversations. The data is there for it; that is the immersive next step.

## 9–15. Military, troops, barracks, evolution, attributes, losses, equipment — 3.0

The war build on the shelf already has a base, training, era troops, invasions, occupation, battles, shields and map markers. The proposal's four-type counter cycle, barracks levels with a 200 × 1.5^(N−1) roster, timed recruitment and equipment queues, evolving old troops at half price, injuries treated at the clinic, and weapon and armour durability are all sound additions to that design and are the natural 3.0 backlog. None of it ships in 2.x, by decision.

## 16. Territory warfare — 3.0

Occupation with a share of the plot's token income (the proposal says up to 10%), a cap of ten occupied plots, one garrison per plot, counter-attacks, third parties, protection periods, cooldowns and public occupation status. The shelved build has occupation and shields already; the income share and the cap are the two pieces to be careful with, because they touch the vault's payouts. 3.0.

## 17–18. Arena seasons — decide

The arena today is a shared colosseum where citizens fight and players bet. The proposal wants a second thing: a weekly ladder of whole cities, simulated, ten challenges a day, challenge only upward, top ten get a seasonal bonus to income "that can exceed the normal cap". The ladder is buildable server-side. The bonus that exceeds the cap is the part to refuse: the daily ceiling is what keeps the vault solvent. A seasonal bonus inside the ceiling, or paid in Gold and prestige, is fine. **decide**, and if yes, 3.0.

## 19. Land supply — decide

Reduce claimable land to five plots, release five a day, do not accumulate, auction some. This is a revenue and community decision, not a code one. Technically it is a server-side release schedule on the registry and a claim guard, a day or two of work. Two cautions: plots already on the world map are visible and named, so "unopened" plots need to read as such on the map; and a daily drip with no accumulation punishes time zones. If you want it, say the numbers and it can be built.

## 20. Recalculating existing plots — no

Temporarily downgrading a plot that paid for its age until it meets new requirements, with free restoration later, would be read as a rollback by the players who paid 1M–4M $EMERGE to advance. The last two weeks of feedback were about buildings and progress disappearing; this would be the same thing on purpose. If requirements change, apply them to advances from now on and leave what was earned.

## 21–23. Economy-wide rebalance — decide, later

Right in principle: the numbers should be tuned as a whole from live data, not one price at a time. The proposal itself says to quantify after the framework is fixed. The framework is now fixed for 2.x; the data to tune on is the live ledger. Not something to do blind in a session.

## What v2.8 built from this

1. Notables (§8), as above.
2. Trade titles by age (§4.2).

Both verified in the harness and in the production build; see the 2.8 notes.
