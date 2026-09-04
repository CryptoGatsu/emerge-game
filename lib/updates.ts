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
    version: '1.3',
    date: '2026-09-03',
    title: 'Your settlement can no longer be lost',
    notes: [
      'Published worlds are kept for over a year, not a day and a half, and the server refuses any copy of your world that goes backwards. Every device reads the furthest-along copy before it plays, and again whenever you come back to the tab.',
      'Hired hands: a player with no plot who holds 1,000 $EMERGE can take a job on a plot that is hiring and is paid a tenth of its stewardship, up to 2,500 a day, by the vault. Their shift counts as the owner\u2019s attention.',
      'Just watch: the front door opens the world map without a wallet. Spectators can visit any settlement and talk in chat, badged as spectators.',
      'Plot expansion: the land itself grows, a ring of new ground on every side, about half as much land again, for 500,000 $EMERGE, once per plot.',
      'The world map has a Home button and a Disconnect wallet button. The guide has pictures, and this list.',
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
    version: '1.3',
    date: '2026-09-03',
    title: '你的聚落再也不会丢失',
    notes: [
      '已发布的世界保存一年以上而不是一天半，服务器拒绝任何会让你的世界倒退的副本。每台设备在开始前都会读取进度最靠前的副本，回到标签页时再读一次。',
      '雇工：没有土地但持有 1,000 $EMERGE 的玩家可以在招工的地块接下工作，由金库支付其管理收益的十分之一，每天最多 2,500。上工算作地主的关注。',
      '先看看再说：首页不用钱包也能打开世界地图。观众可以拜访任何聚落、在聊天里说话，带着观众标记。',
      '扩建地块：土地本身变大，四周多出一圈新地，约多一半土地，花费 500,000 $EMERGE，每块地一次。',
      '世界地图上有了"主页"和"断开钱包"按钮。指南加了图片，还有这份更新记录。',
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
