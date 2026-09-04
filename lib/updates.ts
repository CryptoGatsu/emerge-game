/**
 * What changed, by version.
 *
 * Shown on the front page and in the guide, so a player does not have to find
 * the X account to learn what a new build does. Newest first. Written for the
 * player rather than the repository: what they can do now that they could not
 * before, and what was wrong that is not any more.
 */

export interface Update {
  version: string;
  /** ISO date of the release. */
  date: string;
  title: string;
  notes: string[];
}

export const UPDATES: Update[] = [
  {
    version: '2.5',
    date: '2026-09-10',
    title: 'The lodge, and plots you are not looking at',
    notes: [
      'Hunting is paid like every other trade. The stalking you can watch is the visible part of the day; the snares, the lines and the ground beyond the plot’s edge bring in the rest, so a lodge full of hunters no longer shares one herd of ten and reports 0 a day. An improved lodge and a full quiver raise the take as they should.',
      'Animals now spread over the whole of an expanded plot, and the Lodge’s card says how many are on the land and in reach.',
      'Attention is yours, not the plot’s. Acting on any of your plots keeps every plot you own attended, on this device, on another, and in what the vault judges. A plot you leave running earns at the shape you left it in, against the clock, whether or not it is open.',
      'The Town Hall can be built. It was in the Township’s conditions and in every list but the Build panel’s; it is on the Civic shelf now, for 480 Gold, 20 timber and 30 stone.',
      'Moving a building works on a phone. A tap places it where the finger is; before, the ghost only ever followed a mouse.',
      'A lived-in house can be pulled down. The family moves to another house with room, or sleeps rough until one is raised, and the card says so. The market, the bank and the town hall say why they cannot come down instead of hiding the button.',
      'A first day. A new settlement opens with a card that says what the game pays you for and gives five things to do — a person, a house, the Bank, an improvement, and coming back — each ticked off by doing it. Skip it any time.',
      'A leaderboard on the world map. Every city ranked by the level the vault judges it at, then by how well it is run, with its banner, era and GLD beside it. Tap a row to go and look.',
      'A pass over the phone: every panel by touch. The language switch no longer sits over the population pill in the world, and everything a finger has to hit is big enough to hit.',
    ],
  },
  {
    version: '2.4',
    date: '2026-09-09',
    title: 'The GLD dividend',
    notes: [
      'Every charge now splits three ways: 60% burned by the vault, 25% kept to pay withdrawals, 15% set aside in a dividend pool. Withdrawal holds split the same way.',
      'Each Monday the vault sends 30% of the pool to development, swaps the rest into GLD on Robinhood Chain, and books the GLD to holders: 55% to land, weighted by the level each plot is judged at and the days its owner was present that week; 15% to soft stakes.',
      'A soft stake is a registration, not a lock. Register once on the Bank’s DIVIDENDS card, and your lowest $EMERGE balance through the week counts, from 100,000 up to a cap of 5,000,000. Sell mid-week and the week is forfeited; nothing else changes.',
      'GLD waits under your wallet until you claim it, and the vault sends it. The pool, your land weight, your stake and your GLD are all on the card, and the settlements are on the public book.',
    ],
  },
  {
    version: '2.3',
    date: '2026-09-08',
    title: 'The flywheel, judged: every improvement counts, every charge feeds the vault, and the vault pays what it can see',
    notes: [
      'Every improvement does something, and the building’s card says what. Workplaces make 22% more per level as before; a house adds two beds; a school, library, lab, clinic, hospital, cafe, tavern, chapel and the rest do their job a quarter more strongly per level; a market sells exports for 5% more per level; a bank makes every building’s upkeep 5% cheaper per level; a town hall lifts stewardship quality 2% per level; an improved store counts half again toward readiness; stables, stations, depots and pod hubs move people 10% faster per level; an improved jail halves the odds again and stops a rogue sooner.',
      'Stewardship is now judged on the server. The level a plot is paid on is the smaller of what its published world shows and one level per three days its owner has actually been present, which the heartbeat records and the client cannot write. Its score is computed from the published world with the same function the settlement runs, and its attention from the owner’s last heartbeat. The payout route pays the lesser of what the client claims and that. Hands are paid a tenth of the plot’s judged ceiling.',
      'Prices, for a game where a plot can earn 250,000 a day: plots cost about three times what they did; a fresh plot’s ceiling starts at 40,000; a charter is four days of the plot’s own ceiling (160,000 for a new plot, 1,000,000 for a top city), the same bargain at every level; eras cost a million per step already taken, 1M, 2M, 3M, 4M; expansion is 1,000,000; renames, surveys and digs are doubled; a withdrawal holds back 10%, half burned and half kept; a hand needs 50,000 to be hired and the owner pays 10,000 to open the job; a resale carries a 5% registry fee into the vault.',
      'Bets in $EMERGE at the colosseum, beside the Gold ones. The stake goes into the vault, a win is paid by the vault at the odds shown, a loss stays. 50,000 a bout, 250,000 a day. The house edge is booked like every charge.',
      'Prestige. A monument in the square, 250,000, unique to the plot, lifts everyone a little each day and stands as long as the city does. A banner, 100,000, an emblem of your choosing over your name and on every world map.',
      'Rewards are paid against the clock whether or not the game is open. A player who saw 16,000 a day and received 8,800 had the tab closed for eleven hours: accrual used to run only while the page drew frames. Now the stretch since the last accrual is paid at the attention it actually had through it, up to a month at a time, and a stretch that comes to more than the day’s ceiling stays banked for tomorrow instead of being lost. The payout route allows a day’s grace after your last visit before attention starts to slide.',
    ],
  },
  {
    version: '2.2',
    date: '2026-09-07',
    title: 'The flywheel, one of each, and no more twenty-seven-building rogues',
    notes: [
      'The split on every charge is now three quarters burned and a quarter kept in the vault to pay withdrawals from. The Bank has a THE FLYWHEEL card showing the vault’s book: paid in by players, burned by the vault, kept for withdrawals, owed to the burn.',
      'Master builders: 120,000 $EMERGE puts a crew in the square for thirty days, and every building you raise and every improvement you pay for costs a quarter less Gold. Buying again adds the days on. On the On-Chain panel with the charter and the insurance.',
      'One of each. A town hall, a jail, a tavern, a school, a harbour: every building whose whole effect is that one stands is now unique to the plot. The Build panel marks the one you have as Built, the cursor refuses a second, and the settlement’s own builder never raises one. Houses, stores and every workplace with posts are still worth more of.',
      'Houses sleep 3, 5 and 7 by level. Improving a house adds two beds each time, and the house’s card says who sleeps there against the beds and what an improvement would add. That is what improving a house is for.',
      'The jail’s level is what counts now, not how many jails: a level-three jail cuts the chance of anybody turning to an eighth, and a rogue is stopped at the first building. Without a jail a rogue can bring down three at most; with one, three, two or one by its level; and any rogue still loose by morning is cornered by the whole settlement. A rogue at night now wakes the nearest people rather than having the town to themselves. This closes the twenty-seven-buildings report.',
    ],
  },
  {
    version: '2.1',
    date: '2026-09-07',
    title: 'Ten times the rewards, and charges that fund them',
    notes: [
      'Rewards are ten times what they were. A plot’s daily ceiling now runs from 60,000 $EMERGE at level one to 250,000 for a level-ten city in the AI era. Five plots earn instead of four, and a wallet can collect up to 1,000,000 a day across them. A single withdrawal can be up to 1,000,000.',
      'Every charge now goes into the vault instead of straight to the burn address. The vault burns half of it itself, from its own key, in one transaction for many charges; the other half stays in the vault to pay withdrawals from. Same one signature for you; what players spend is what players are paid from, and the vault can cover what it owes. The book is public at /api/vault: paid in, kept, owed to the burn, burned, with the burn transactions.',
      'Three more things to spend on, from the SUPPLIES card on the On-Chain panel, delivered the moment the payment settles: a party of five settlers (50,000, needs room in the houses), a shipment of 400 timber, 300 stone and 240 portions of food (40,000), and a restoration that rebuilds every ruin and finishes the bridge under way (100,000).',
      'Charters and insurance repriced for the new ceilings: 300,000 and 150,000.',
    ],
  },
  {
    version: '2.0',
    date: '2026-09-06',
    title: 'City levels, Gold with somewhere to go, and $EMERGE worth holding',
    notes: [
      'City levels. Every plot has a level, one to ten, read from its people and its buildings standing. Size earns the next level; Gold pays for the public works that confirm it, from 1,500 Gold at level two to 130,000 at level ten. The CITY card in the Bank shows the level, what the next one asks, and the button. An existing city is graded on what it already is, with nothing to pay for the levels it has grown into.',
      'Rewards run on the level. A plot’s daily ceiling runs from 6,000 $EMERGE at level one to 25,000 at level ten, times the era: a level-ten city in the AI era can earn up to 40,000 a day. A fresh claim earns a fraction of a developed city, so growing what you have is worth more than claiming another. The payout route reads the level from your published world, so the ceiling cannot be reached by editing a save.',
      'Gold has somewhere to go. Public works, festivals (Gold by the head for the whole town’s happiness, once a day), bridges you order yourself, and upkeep that rises a quarter per era a building was raised in. The treasury is for building a city with, not for counting.',
      'Charters: 100,000 $EMERGE burned for a fifth more on the plot’s ceiling for thirty days. Insurance: 50,000 $EMERGE burned so the plot takes half of whatever a fire, a quake, a flood or a rogue does, for thirty days. Both on the On-Chain panel, recorded on the claim row, and both add days on if bought again while one runs.',
      'No disaster can flatten a city. An earthquake or a tornado can damage at most a quarter of what stands (never fewer than three buildings). A player who came back to two buildings out of forty had not been set back, they had been given a reason to stop; that cannot happen now.',
      'Jails work. Every jail standing halves how often anybody turns, down to a tenth, and with a jail a rogue in a scuffle breaks free once in ten rather than once in three. Two jails in a town of a hundred and fifty now make a visible difference.',
      'Houses hold families. A house sleeps as many people as it has room for, three at level one and more with each improvement, so a newcomer who came alone shares a roof rather than taking a whole house for one bed. "One house, one person" is gone.',
      'Bridges by hand. The Build panel has a Bridge tool: tap land across the water and the crew stakes out the narrowest sound crossing to it, 600 Gold to start, timber and wages by the day. When the yard is short of timber the crew buys it in with Gold rather than standing idle, which is why some towns had stopped bridging.',
      'The era gate asks for a city level as well: level three for the township, five for industrial, seven for modern, nine for AI.',
    ],
  },
  {
    version: '1.6',
    date: '2026-09-05',
    title: 'People, training, and rewards that grow with the city',
    notes: [
      'A People panel in the bar. Every adult with their trade, their skill and where they work, the unemployed first, filterable by trade. Every trade with its workers against its posts and how many stand open. Every workplace with its crew and its posts, ruins flagged. No more guessing what a building is or which jobs you are missing.',
      'Targeted training. Retrain one person into any trade that has a workplace, or fill every open post in a trade at once with the people who can best be spared: the unemployed first, then anyone in a trade with more hands than posts, then the least skilled. 60 Gold a head. A trained person keeps the trade for forty days against the settlement\u2019s own reshuffling and starts with a head start in skill, doubled by a School.',
      'Rewards grow with the era. Each era a plot advances to lifts its daily stewardship ceiling by 15% of the base: a township can earn up to 15% more than a settlement, an AI-era city up to 60% more. The payout route reads the era from the claim row, which only the gated, burn-verified advance can raise.',
    ],
  },
  {
    version: '1.5',
    date: '2026-09-04',
    title: 'Every era, to the AI age',
    notes: [
      'The three remaining eras are built and open: Industrial, Modern and AI. A plot advances one step at a time, 1,000,000 $EMERGE burned per step, once it has earned it. The checklists are on the ERA card.',
      'Industrial: brick and iron, setts with rails on the roads, chimneys. A Railway Station puts every working adult on the rails, faster than carts; the ferry becomes a steamboat. Factory, Foundry, Telegraph and Gasworks. Smog hangs over the town and drains happiness until a Gasworks stands.',
      'Modern: concrete and glass, tarmac with markings, jackets and jeans. A Bus Depot puts people in cars, a third of them on bikes; the ferry becomes a motorboat. Hospital, Stadium, Supermarket, Office and Power Plant. The Hospital takes most of the risk out of a bad week.',
      'AI: white composite, light strips, gardens on the roofs, pale quiet roads. A Pod Hub puts everybody in autonomous pods, fastest of all; the ferry becomes a hydrofoil. Data Centre, Research Campus, Vertical Farm and Drone Port.',
      'Every building already standing is redrawn in the new era\u2019s style when you improve it, and keeps its old look until then. People change clothes and hats with the era: bonnets and tricorns, bowlers and goggles, caps and beanies, visors.',
      'Streets connect. A road reads its neighbours and runs unbroken into the next tile or the plaza; every other edge gets the era\u2019s kerb and pavement. Ruts on a dirt lane, rails on the setts, a dashed line down the tarmac, a light seam along the composite.',
      'Each era rebuilds a building in its own shape, not a new colour. The township raises mansard-roofed stone homes, steep gables and tall hipped halls; the industrial era long brick terraces with a stack, sawtooth glass roofs over the works and flat-topped blocks; the modern era stepped concrete homes, wide sheds and towers; the AI era rounded white pods with garden decks and domes of light.',
      'People ride what they ride. Every vehicle is drawn at their scale and in two layers, so a rider sits inside the car or the pod, astride the bike, on the box seat of a horse-drawn cart or in the tram, and in the boat. Boats appear only over water.',
    ],
  },
  {
    version: '1.4',
    date: '2026-09-04',
    title: 'Eras: the Township',
    notes: [
      'A plot can advance from the Settlement era to the Township era. It has to earn it first: sixty days in the era, forty people, thirty buildings standing, a Town Hall, a Bank, a School and a Jail, 20,000 Gold in the treasury and no ruins. Then 1,000,000 $EMERGE, burned, once per step. The ERA card in the On-Chain panel shows the checklist as it fills in.',
      'A township looks like one: stone walls and tiled roofs on everything raised or improved after the step, cobbled streets in place of dirt, and people in wool coats and hats. What was built before keeps its timber until you improve it.',
      'Six new buildings: Chapel, Guildhall, Brewery, Printer, Stables and Harbour. A Stables puts every working adult on a cart, faster than walking. A Harbour runs a ferry: people cross open water on a boat, and every island counts as reachable without a bridge.',
      'The Build panel is sorted into shelves: Homes, Food, Materials, Civic, Care and learning, Leisure, Transport and Utilities. Buildings from a later era are shown greyed with the era they belong to. The settlement\u2019s own builder only raises what its era allows.',
      'Three more eras are named and gated but not yet built: Industrial, Modern and AI. The checklist for each is already on the card, so a plot can start working toward it.',
    ],
  },
  {
    version: '1.3',
    date: '2026-09-03',
    title: 'Your settlement can no longer be lost',
    notes: [
      'Published worlds are kept for over a year, not a day and a half, and the server refuses any copy of your world that goes backwards. Every device reads the furthest-along copy before it plays, and again whenever you come back to the tab.',
      'Hired hands: a player with no plot who holds 1,000 $EMERGE can take a job on a plot that is hiring and is paid a tenth of its stewardship, up to 2,500 a day, by the vault. Their shift counts as the owner\u2019s attention.',
      'Just watch: the front door opens the world map without a wallet. Spectators can visit any settlement and talk in chat, badged as spectators.',
      'Plot expansion: the land itself grows, a ring of new ground on every side, about half as much land again, for 500,000 $EMERGE, once per plot.',
      'The world map has a Home button and a Disconnect wallet button. The guide has pictures, and this list.',
      'A soundtrack: six loops for the settlement by day, dusk, night, danger, the world map and visiting. Press the note to hear it.',
    ],
  },
  {
    version: '1.2',
    date: '2026-08-30',
    title: 'Two hundred plots, a plot market, and the wild',
    notes: [
      'Twelve charts and room for about two hundred settlements. Plots are sold player to player, wallet to wallet, and anybody can make an offer on any plot.',
      'Fishing, hunting and foraging. Fishers cast from the shore and buy bait; hunters stalk deer, boar and whatever the biome keeps; foragers bring in berries and herbs. All of it sells at the market.',
      'Earthquakes, tornados, floods and plagues you can spend Gold to fight; ruins you rebuild; people who turn rogue and have to be jailed or stopped by the settlement itself.',
      'The settlement builds what it needs from a full treasury. Trees can be cleared, and regrow on open ground when they are built over. Desert trees can be felled.',
      'Chinese, throughout the game and the guide. Better pathfinding, one deck per bridge, and settlers who keep arriving as a plot improves.',
    ],
  },
  {
    version: '1.1',
    date: '2026-08-20',
    title: 'The guide, the market and the colosseum',
    notes: [
      'A public guide that explains every system, including which parts settle on chain today and which do not.',
      'One market across every world, wages you set, and a card when your people sell something.',
      'The colosseum on its own island, with Gold bets on duels. Schools, labs, cafes, studios, clinics and libraries. Buildings can be moved and improved.',
      'A graphics overhaul toward the target style, redrawn citizens, and a plot helper that says what to build next and why.',
      'How many players are online, and a settlement that follows your wallet across devices.',
    ],
  },
];

export const UPDATES_ZH: Update[] = [
  {
    version: '2.5',
    date: '2026-09-10',
    title: '猎人小屋，和你没在看的地块',
    notes: [
      '狩猎现在和其他行业一样计产。屏幕上能看到的追猎只是一天的可见部分；陷阱、绳套和地块边缘之外的猎场带回其余部分，所以满员的猎人小屋不再十个猎人分一群猎物、报出"每天 0"。升级的小屋和满满的箭筒会如期提高收获。',
      '动物现在会分布在整块扩展后的土地上，猎人小屋的卡片会写明地上有多少猎物、多少在可及范围内。',
      '注意力属于你，而不是地块。在任何一块地上做点什么，你名下的每块地都算被照看，本设备、其他设备和金库的裁定都一样。你留着运转的地块按你离开时的样子继续按时钟计收，开着与否都一样。',
      '市政厅可以建了。它在城镇时代的条件里、在每张清单上，唯独不在建造面板里；现在在"公共"一栏，480 金币、20 木材、30 石料。',
      '手机上可以搬建筑了。点一下就放在手指的位置；以前的虚影只跟着鼠标走。',
      '有人住的房子可以拆了。这家人会搬到有空位的房子，没有的话就露宿到新房建起，卡片上会说明。市场、银行和市政厅则会说明为什么不能拆，而不是把按钮藏起来。',
      '第一天。新聚落打开时会有一张卡片，说明游戏为什么付你钱，并给出五件事——一个人、一座房子、银行、一次升级、明天再来——做了就自动打勾。随时可以跳过。',
      '世界地图上的排行榜。每座城市按金库裁定的等级排名，再按经营好坏排，旁边是它的旗帜、时代和 GLD。点一行就去看看。',
      '手机上过了一遍：每个面板都用手指点过。语言切换不再压在世界里的人口标签上，手指要点的东西都够大了。',
    ],
  },
  {
    version: '2.4',
    date: '2026-09-09',
    title: 'GLD 分红',
    notes: [
      '每笔收费现在三分：60% 由金库销毁，25% 留作提现，15% 进入分红池。提现扣留部分同样分配。',
      '每周一金库把分红池的 30% 送往开发，其余在 Robinhood Chain 上兑换成 GLD，并记到持有者名下：55% 归土地，按每块地被裁定的等级和主人当周在场天数加权；15% 归软质押。',
      '软质押是登记，不是锁仓。在银行的"分红"卡片登记一次，你整周的最低 $EMERGE 余额即计入，100,000 起，上限 5,000,000。周中卖出即放弃本周；其他一切不变。',
      'GLD 记在你的钱包名下，直到你领取，由金库发送。分红池、你的土地权重、你的质押和你的 GLD 都在卡片上，结算记录在公开账本上。',
    ],
  },
  {
    version: '2.3',
    date: '2026-09-08',
    title: '飞轮经过裁定：每次升级都有意义，每笔收费都进金库，金库只付它看得见的',
    notes: [
      '每次升级都有效果，建筑卡片会写明。工作场所仍是每级多 22% 产出；房子多两张床；学校、图书馆、实验室、诊所、医院、咖啡馆、酒馆、教堂等每级效果增强四分之一；市场每级出口多卖 5%；银行每级让所有建筑维护费便宜 5%；市政厅每级提高经营质量 2%；升级后的仓库在防备中算一个半；马厩、车站、公交站和出行舱站每级让人快 10%；升级后的监狱几率再减半并更早制止暴徒。',
      '经营收益现在由服务器裁定。地块按较小者计等级：发布的世界显示的等级，或主人实际在场每三天一级——在场由心跳记录，客户端无法伪造。评分用聚落同一个函数从发布的世界算出，关注度取自主人最近一次心跳。支付接口按客户端申报与服务器裁定中较小者支付。雇工按地块裁定上限的十分之一支付。',
      '为一块地每天可赚 250,000 的游戏重新定价：地块价格约为原来的三倍；新地块上限从 40,000 起；特许状为地块自身上限的四天（新地块 160,000，顶级城市 1,000,000），各等级同样划算；时代每已走一步一百万，即 1M、2M、3M、4M；扩建 1,000,000；改名、勘测和勘探翻倍；提现扣留 10%，一半销毁一半留存；雇工须持有 50,000，雇主开放职位付 10,000；转售收取 5% 登记费进入金库。',
      '竞技场可用 $EMERGE 下注，与金币并列。赌注进入金库，赢家由金库按显示赔率支付，输了留在金库。每场 50,000，每天 250,000。庄家优势按收费方式记账。',
      '声望。广场上的纪念碑，250,000，每块地一座，每天让所有人略微开心，城在碑在。旗帜，100,000，自选徽记，飘在你的名字上和每张世界地图上。',
      '收益无论游戏是否打开都按时钟支付。一位玩家看到"每天 16,000"却只收到 8,800，是因为标签页关了十一个小时：累积过去只在页面绘制帧时进行。现在自上次累积以来的时段按当时的关注度支付，一次最多一个月；超过当日上限的部分留到明天而不是丢失。支付接口在你最后一次访问后给一天宽限，之后关注度才开始下滑。',
    ],
  },
  {
    version: '2.2',
    date: '2026-09-07',
    title: '飞轮、每样一座，再也没有毁掉二十七栋楼的暴徒',
    notes: [
      '每笔收费的分配改为四分之三销毁、四分之一留在金库用于支付提现。银行新增"飞轮"卡片，显示金库账本：玩家付入、金库已销毁、留作提现、待销毁。',
      '建筑大师：120,000 $EMERGE 让一队工匠在广场驻扎三十天，你建造的每栋建筑和支付的每次升级都少花四分之一金币。再买会累加天数。在"链上"面板，与特许状和保险并列。',
      '每样一座。市政厅、监狱、酒馆、学校、港口：所有"有一座就起作用"的建筑现在每块地只能有一座。建造面板把已有的标为"已建"，光标拒绝第二座，聚落自建也不会再盖。房屋、仓库和所有有岗位的工作场所仍然多多益善。',
      '房子按等级住 3、5、7 人。每次升级房子多两张床，房子的卡片会显示住了几人、共几张床，以及升级后有几张。这就是升级房子的意义。',
      '现在算的是监狱的等级而不是数量：三级监狱把有人作乱的几率降到八分之一，暴徒在第一栋楼前就被制止。没有监狱时一个暴徒最多毁三栋；有监狱时按等级为三、二、一栋；天亮时仍在逃的暴徒会被全聚落围住。夜里的暴徒现在会惊醒附近的人，而不是独占整座镇子。这关闭了"二十七栋楼"的反馈。',
    ],
  },
  {
    version: '2.1',
    date: '2026-09-07',
    title: '十倍的收益，以及为它买单的收费',
    notes: [
      '收益是原来的十倍。地块的每日上限从一级的 60,000 $EMERGE 到人工智能时代十级城市的 250,000。五块地可以赚而不是四块，一个钱包每天最多可收取 1,000,000。单笔提现最多 1,000,000。',
      '每一笔收费现在进入金库，而不是直接到销毁地址。金库用自己的密钥销毁其中一半，多笔收费合并为一笔交易；另一半留在金库用于支付提现。你仍然只签一次名；玩家花掉的就是支付玩家的来源，金库付得起它欠的。账本公开在 /api/vault：收入、留存、待销毁、已销毁，以及销毁交易。',
      '"链上"面板新增"补给"卡片，三样东西付款到账即送达：一队五名移民（50,000，房子要有空位）、一批 400 木材、300 石料和 240 份食物的货物（40,000）、一次重建全部废墟并完成在建桥梁的修复（100,000）。',
      '特许状和保险按新上限重新定价：300,000 和 150,000。',
    ],
  },
  {
    version: '2.0',
    date: '2026-09-06',
    title: '城市等级、有去处的金币，以及值得持有的 $EMERGE',
    notes: [
      '城市等级。每块地都有一个等级，一到十级，由人口和完好建筑数决定。规模让你有资格升级，金币支付确认升级的公共工程：二级 1,500 金币，十级 130,000 金币。银行里的"城市"卡片显示等级、下一级的要求和按钮。已有的城市按现状评级，已经长到的等级不用付钱。',
      '收益随等级走。地块的每日上限从一级的 6,000 $EMERGE 到十级的 25,000，再乘以时代：人工智能时代的十级城市每天最多可赚 40,000。新认领的地块只能赚到成熟城市的零头，所以把手里的地块发展好比再认领一块更值。支付接口从你发布的世界读取等级，改存档得不到更高的上限。',
      '金币有了去处。公共工程、节庆（按人头收费，让全城更快乐，每天一次）、你自己下令修的桥，以及按建筑所建时代每个时代增加四分之一的维护费。金库是用来建设城市的，不是用来数的。',
      '特许状：销毁 100,000 $EMERGE，地块收益上限提高五分之一，为期三十天。保险：销毁 50,000 $EMERGE，火灾、地震、洪水或暴徒造成的损失减半，为期三十天。两者都在"链上"面板购买，记录在地块记录上，有效期内再买会累加天数。',
      '没有灾难能夷平一座城。地震或龙卷风最多损坏现存建筑的四分之一（最少三栋）。有玩家回来时四十栋建筑只剩两栋——那不是挫折，而是放弃的理由；现在不会再发生。',
      '监狱有用了。每座监狱把有人作乱的几率减半，最低到十分之一；有监狱时，扭打中的作乱者十次只有一次挣脱，而不是三次一次。一百五十人的镇子里两座监狱现在有明显的区别。',
      '房子住得下一家人。一栋房子按容量住人，一级三人，每次升级更多，所以独自到来的新人会与人合住，而不是一个人占一整栋。"一栋房子只住一个人"的问题没有了。',
      '手动架桥。建造面板新增"桥梁"工具：点击水对岸的陆地，工队就会勘定通往那里最窄的可靠渡口，开工 600 金币，木材和工钱按天计。料场木材不够时，工队会用金币买进而不是停工——这正是一些镇子不再架桥的原因。',
      '时代门槛也要求城市等级：城镇三级、工业五级、现代七级、人工智能九级。',
    ],
  },
  {
    version: '1.6',
    date: '2026-09-05',
    title: '居民、培训，以及随城市成长的收益',
    notes: [
      '操作栏新增"居民"面板。每位成年人的行当、技能和工作地点，无业者排在最前，可按行当筛选。每个行当的在岗人数对比岗位数，以及有多少空缺。每个工作场所的在岗人员与岗位，废墟有标记。不用再猜某栋建筑是什么、缺哪些工作。',
      '定向培训。把一个人培训成任何有工作场所的行当，或一次填满某个行当的全部空缺，由最能腾出的人担任：先是无业者，再是人手多于岗位的行当，再是技能最低的人。每人 60 金币。受训者四十天内不会被聚落自行调岗，并带着技能起点，有学校则翻倍。',
      '收益随时代增长。地块每推进一个时代，每日管理收益上限提高基础值的 15%：城镇比聚落最多多 15%，人工智能时代的城市最多多 60%。支付接口从地块记录读取时代，而该记录只有经过门槛与销毁验证的推进才能提高。',
    ],
  },
  {
    version: '1.5',
    date: '2026-09-04',
    title: '所有时代，直到人工智能时代',
    notes: [
      '剩下的三个时代已经建成并开放：工业、现代和人工智能。地块一次推进一步，每步销毁 1,000,000 $EMERGE，须先达成条件。清单在"时代"卡片上。',
      '工业：砖与铁、带铁轨的石板路、烟囱。火车站让每个上班的成年人乘铁路，比马车快；渡船变成蒸汽船。工厂、铸造厂、电报局和煤气厂。烟雾笼罩镇子、消耗幸福，直到建起煤气厂。',
      '现代：混凝土与玻璃、带标线的柏油路、夹克和牛仔裤。公交车站让人们开上汽车，三分之一骑自行车；渡船变成摩托艇。医院、体育场、超市、写字楼和发电厂。医院拿掉糟糕一周的大部分风险。',
      '人工智能：白色复合材料、灯带、屋顶花园、安静的浅色道路。出行舱站让每个人坐上自动驾驶舱，最快；渡船变成水翼船。数据中心、研究园区、垂直农场和无人机港。',
      '已有的每栋建筑在你升级它时按新时代的样式重绘，在那之前保留旧貌。人们随时代换装换帽：软帽和三角帽、圆顶礼帽和护目镜、棒球帽和毛线帽、面罩。',
      '街道相连。道路会读取相邻格：与下一格或广场相接处路面不间断，其余每条边都有该时代的路缘和人行道。泥路上的车辙、石板路上的铁轨、柏油路中间的虚线、复合路面上的光缝。',
      '每个时代按自己的形状重建建筑，而不是换个颜色。城镇建起孟莎顶石屋、陡峭的山墙和高大的四坡顶大厅；工业时代是带烟囱的长排砖屋、作坊上的锯齿玻璃顶和平顶砖楼；现代是退台式混凝土住宅、宽大的厂棚和高楼；人工智能时代是带花园平台的圆角白色舱体和光之穹顶。',
      '人们真的在骑乘。每种交通工具都按人物比例绘制、分两层，骑手坐在汽车或出行舱里、跨在自行车上、坐在马车的车座上或有轨车厢里，也坐在船里。船只只出现在水面上。',
    ],
  },
  {
    version: '1.4',
    date: '2026-09-04',
    title: '时代：城镇',
    notes: [
      '地块可以从聚落时代推进到城镇时代。必须先达成条件：在本时代满六十天、四十人、三十栋建筑、有镇公所、银行、学校和监狱、金库 20,000 金币、没有废墟。然后花 1,000,000 $EMERGE，销毁，每一步一次。"链上"面板的"时代"卡片会逐项显示清单。',
      '城镇看起来就是城镇：推进之后新建或升级的建筑都是石墙瓦顶，泥路变成石板街，人们穿上羊毛外套、戴上帽子。之前建的保留木结构，直到你升级它。',
      '六种新建筑：礼拜堂、行会大厅、酿酒坊、印刷所、马厩和港口。马厩让每个上班的成年人坐上马车，比步行快。港口开通渡船：人们乘船过水，每座岛无需桥梁即可到达。',
      '建造面板按货架分类：住房、食物、材料、市政、照护与学习、休闲、交通和公用。后一个时代的建筑灰显并标出所属时代。聚落自建只会建当前时代允许的东西。',
      '另外三个时代已经命名并设好门槛，但尚未建成：工业、现代和人工智能。每个的清单已经在卡片上，地块可以提前朝它努力。',
    ],
  },
  {
    version: '1.3',
    date: '2026-09-03',
    title: '你的聚落再也不会丢失',
    notes: [
      '已发布的世界保存一年以上而不是一天半，服务器拒绝任何会让你的世界倒退的副本。每台设备在开始前都会读取进度最靠前的副本，回到标签页时再读一次。',
      '雇工：没有土地但持有 1,000 $EMERGE 的玩家可以在招工的地块接下工作，由金库支付其管理收益的十分之一，每天最多 2,500。上工算作地主的关注。',
      '先看看再说：首页不用钱包也能打开世界地图。观众可以拜访任何聚落、在聊天里说话，带着观众标记。',
      '扩建地块：土地本身变大，四周多出一圈新地，约多一半土地，花费 500,000 $EMERGE，每块地一次。',
      '世界地图上有了"主页"和"断开钱包"按钮。指南加了图片，还有这份更新记录。',
      '配乐：白天的聚落、黄昏、夜晚、危险、世界地图和拜访，六段循环。按音符键即可听到。',
    ],
  },
  {
    version: '1.2',
    date: '2026-08-30',
    title: '两百块地、地块市场与荒野',
    notes: [
      '十二张海图，约两百个聚落的空间。地块在玩家之间钱包对钱包出售，任何人都可以对任何地块出价。',
      '捕鱼、狩猎与采集。渔夫在岸边下竿并购买鱼饵；猎人追踪鹿、野猪和各生物群系的动物；采集者带回浆果和草药。这些都能在市场卖出。',
      '地震、龙卷风、洪水和瘟疫，可以花金币对抗；废墟可以重建；有人会变成暴徒，必须由聚落自己关进监狱或制止。',
      '金库充裕时聚落会自己建造所需。树可以清除，被建筑覆盖的空地上会重新长树。沙漠的树也能砍。',
      '游戏和指南全部有了中文。更好的寻路、每座桥一整块桥面，以及随着地块改善不断到来的移民。',
    ],
  },
  {
    version: '1.1',
    date: '2026-08-20',
    title: '指南、市场与竞技场',
    notes: [
      '一份解释每个系统的公开指南，包括今天哪些部分在链上结算、哪些不是。',
      '所有世界共用一个市场，工资由你设定，居民卖出东西时会有提示卡。',
      '自己岛上的竞技场，可以用金币押注决斗。学校、实验室、咖啡馆、画室、诊所和图书馆。建筑可以搬动和改良。',
      '向目标风格靠拢的画面全面升级、重绘的居民，以及一位告诉你下一步该建什么、为什么的地块助手。',
      '显示在线玩家数，聚落跟着你的钱包跨设备走。',
    ],
  },
];
