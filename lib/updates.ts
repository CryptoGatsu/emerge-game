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
