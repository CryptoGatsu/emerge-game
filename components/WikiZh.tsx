'use client';

/**
 * 指南（中文版）。
 *
 * 与英文版一节对一节，每一个数字都从执行它的代码里读出，所以两个版本说的
 * 是同一套规则；改了游戏，这一页跟着改。
 */

import Link from 'next/link';
import { ACTIVE_CHAIN, TOKEN, tokenLive } from '@/lib/chain/emerge';
import { onChainClaimsLive } from '@/lib/chain/registry';
import {
  DAILY_EARN_CEILING, EARNING_PLOT_LIMIT, EMERGE_PER_GOLD, PROSPECT_COST_EMERGE,
  RENAME_CITIZEN_EMERGE, RENAME_COST_EMERGE, RENAME_PLAYER_EMERGE, WITHDRAW_BURN_RATE,
} from '@/lib/chain/vault';
import { DIG_COST_EMERGE } from '@/lib/chain/gacha';
import {
  BUILD_COSTS, BUILD_MATERIALS, HAZARD_LABELS, JOBS, LEDGER_LABELS, MAX_BUILDING_LEVEL,
  MOVE_SHARE, OUTPUT_PER_LEVEL, RESOURCE_LABELS, STEWARDSHIP_DAILY_CAP, UPGRADE_STEPS,
  UPKEEP_PER_LEVEL, WAGE_MAX, WAGE_MIN, WAGE_STANDARD, maintenanceCost, wageEffort,
  type HazardKind, type Resource,
} from '@/lib/simulation';
import { MAX_GIFT_GOLD } from '@/lib/limits';
import { BASE_PRICE, BIOME_KINDS_BY_INDEX, BIOME_PREMIUM, PRICE_SCALE } from '@/lib/world/price';
import { tj, tn } from '@/lib/i18n';
import { BrandLine } from './Brand';
import { LanguageSwitch } from './LanguageSwitch';

const n = (value: number) => value.toLocaleString();
const pct = (value: number) => `${Math.round(value * 100)}%`;

const PLOT_PRICES = [...BIOME_KINDS_BY_INDEX]
  .map((kind) => ({ kind, price: (BASE_PRICE + BIOME_PREMIUM[kind]) * PRICE_SCALE }))
  .sort((a, b) => a.price - b.price);

const CHARGES = [
  { what: '认领一块地', cost: `${n(PLOT_PRICES[0].price)} – ${n(PLOT_PRICES[PLOT_PRICES.length - 1].price)}`, note: '按生物群系' },
  { what: '勘测新土地', cost: n(PROSPECT_COST_EMERGE), note: '找到一个没人拥有过的种子' },
  { what: '给你的世界改名', cost: n(RENAME_COST_EMERGE), note: '' },
  { what: '给一位居民改名', cost: n(RENAME_CITIZEN_EMERGE), note: '用勘探得到的命名权则免费' },
  { what: '给自己改名', cost: n(RENAME_PLAYER_EMERGE), note: '第一次免费' },
  { what: '派出勘探队', cost: n(DIG_COST_EMERGE), note: '' },
];

const yieldFor = (score: number, attention: number) => Math.round(STEWARDSHIP_DAILY_CAP * score * attention);

const EXAMPLES = [
  { how: '经营良好，每天照看', score: 0.95, attention: 0.9 },
  { how: '经营尚可，大多数日子看一眼', score: 0.8, attention: 0.7 },
  { how: '两天没管', score: 0.8, attention: 0.08 },
  { how: '举步维艰又无人照看', score: 0.4, attention: 0.08 },
];

const INCOME: [keyof typeof LEDGER_LABELS, string][] = [
  ['exports', '按世界市场的价格卖出镇子多余的东西，加上集市日的收入。'],
  ['households', '工资回流。人们用领到的钱在摊位上买衣物、家具和工具。'],
  ['food', '饭钱。人人都要吃饭，人人自掏腰包。'],
  ['vault', '你自己存进来的，以及其他玩家赠送给你聚落的金币。'],
  ['arena', '竞技场赢回来的赌注。'],
];

const SPENDING: [keyof typeof LEDGER_LABELS, string][] = [
  ['wages', '每个工作的人每天都领工资。这是大多数聚落最大的一笔支出。'],
  ['imports', '按世界市场的价格买进镇子自己造不出的东西。'],
  ['upkeep', `每栋建筑立着就要花钱，从房屋每天 ${maintenanceCost('House')} 金币到市场每天 ${maintenanceCost('Market')} 金币。`],
  ['building', '你建造的东西，花金币，也从堆场花材料。'],
  ['works', '通往无人能到之地的桥，以及随之而来的路。'],
  ['vault', '金库门的另一半：你取回存款时离开金库的金币。'],
  ['arena', '竞技场输出去的赌注。长期看这是两条竞技场账目里更大的一条，这是有意设计的。'],
];

const WAGES = (Object.entries(JOBS) as [keyof typeof JOBS, { wage: number }][])
  .map(([job, recipe]) => ({ job, wage: recipe.wage }))
  .sort((a, b) => a.wage - b.wage);

const TRADE_BUILDINGS = (Object.entries(JOBS) as [keyof typeof JOBS, {
  wage: number; building: string;
  output: Partial<Record<Resource, number>>; input?: Partial<Record<Resource, number>>;
}][]).map(([job, recipe]) => ({
  job,
  type: recipe.building,
  wage: recipe.wage,
  makes: Object.entries(recipe.output).map(([r, k]) => `${k} ${tn(RESOURCE_LABELS[r as Resource])}`).join('、'),
  needs: Object.entries(recipe.input ?? {}).map(([r, k]) => `${k} ${tn(RESOURCE_LABELS[r as Resource])}`).join('、'),
}));

const CIVIC_BUILDINGS = [
  ['House', '住的地方。人比床多的聚落会有人露宿，露宿的人失温更快，也更不开心。'],
  ['Storage', '存放盈余的空间，也是应对歉收的准备的一部分。'],
  ['Market', '交易和吃饭的地方。聚落开局自带一个，不能拆。'],
  ['Tavern', '聚落聚会的地方。集会和宴席在这里举行，正是它们把邻居变成朋友。'],
  ['Bank', '账房。不花维护费。'],
  ['Town Hall', '聚落开会并做出决议的地方。'],
  ['Cafe', '露台上的桌子。每个人的陪伴每天都改善一点，没有酒馆时聚会也可以在这里办。'],
  ['School', '所有人学手艺快三分之一。对年轻聚落的产出来说，这是你能做的最好的一件事。'],
  ['Library', '每天给每个人一点学识和一点志向。'],
  ['Studio', '动手做东西的地方。志向在这里生长，而志向是让人坚守本行的东西。'],
  ['Lab', '更好的方法：每种手艺同一天多产一成。它还能预见火灾、枯萎病和狼群，抵得上一两口井。'],
  ['Clinic', '人们熬过本会要命的事。因衰老和困苦而死的人减少近一半。'],
] as const;

const STATUS = [
  ['人口', '这里活着的每个人，包括孩子。人们吃饱、有房、满足到愿意成家时它会增长；名声传开时也会：经营得好、有空屋顶的地块吸引路上的移民，咖啡馆、学校、诊所和升级过的房子吸引更多——每天最多三人。严冬或严重的灾害会让它下降。',
    '先盖房子再盖别的，并且升级它们：升级过的房子住更多人。再好的镇子，没有空屋顶也没人搬来。'],
  ['幸福', '每个人携带的六项指标的平均：吃得多饱、休息得多好、社交多少、穿得多好、志向多足、多暖和。',
    '最快的杠杆是工资。然后是：酒馆和长椅带来的陪伴，库存里的衣物，以及过冬的柴火。'],
  ['精力', '人们休息得多好。它一整天消耗，在床上恢复——在真正的房子里比露宿快得多。',
    '房子。有床的人恢复速度是没床的人的两倍多。'],
  ['气温', '真实的气温，随季节、天气和生物群系变化。低于大约十二度时，没有遮蔽的人开始失温。',
    '仓库里留着木料——是炉火而不是屋顶让房子暖和——并让人们穿上衣物。'],
  ['林地', '立着的树，以及有多少在长回来。伐木工砍的是真树，森林真的会变稀。',
    '能不管就不管。森林自己会长回来；要看的数字是它减少的速度是否快过再生。'],
  ['在工作 / 在户外', '此刻有多少人在干本行，多少人在外面。两者随一天变化：夜里没有人工作。',
    '白天工作人数偏低，说明某个行当缺建筑，或者金库付不起工资。'],
] as const;

const HAZARD_CAUSE: Record<HazardKind, string> = {
  fire: '炎热干燥的空气，加上挨得很近的建筑。',
  blight: '生长季，加上可以糟蹋的田地。',
  wolves: '寒夜，加上聚落边缘的林地。',
  flood: '暴风雨，加上会涨水的河。',
};

const HAZARD_ANSWER: Record<HazardKind, string> = {
  fire: '附近的水井，以及足够传水桶的人手。',
  blight: '一座粮仓和一季储备的食物。',
  wolves: '整夜燃着的火堆，以及人数。',
  flood: '离岸而建的建筑。',
};

const SECTIONS = [
  ['start', '入门'],
  ['land', '土地与所有权'],
  ['costs', '各项费用'],
  ['earning', '赚取 $EMERGE'],
  ['economy', '聚落自己的钱'],
  ['vault', '存款与取款'],
  ['buildings', '建筑'],
  ['status', '读懂你的聚落'],
  ['danger', '可能出的岔子'],
  ['world', '世界本身'],
  ['arena', '竞技场'],
  ['together', '其他玩家'],
  ['honest', '哪些已定，哪些未定'],
] as const;

export function WikiZh() {
  const landOnChain = onChainClaimsLive();
  const live = tokenLive();
  const T = TOKEN.ticker;

  return (
    <main className="wiki" lang="zh-CN">
      <div className="wiki-inner">
        <header className="wiki-head">
          <Link href="/" className="wiki-home"><BrandLine size={40} /></Link>
          <LanguageSwitch className="wiki-lang" />
          <h1>Emerge 是怎么运作的</h1>
          <p className="wiki-lede">
            一个由自主居民组成的活的世界，你在其中拥有土地、塑造它，但不指挥它。
            这里是全部：你能做什么、每样东西多少钱、钱怎么流动，以及——大多数这类页面略过的部分——今天哪些已经在链上结算，哪些还没有。
          </p>
          <nav className="wiki-nav">
            {SECTIONS.map(([id, label]) => (
              <a key={id} href={`#${id}`}>{label}</a>
            ))}
          </nav>
        </header>

        <section id="start">
          <h2>入门</h2>
          <ol className="wiki-steps">
            <li><b>连接钱包。</b>MetaMask 或 Trust Wallet，在 {ACTIVE_CHAIN.label}{ACTIVE_CHAIN.chainId ? `（链 ${ACTIVE_CHAIN.chainId}）` : ''} 上。如果你装了不止一个钱包，选你想用的那个——游戏会问，而不是猜。</li>
            <li><b>登录。</b>对一句普通的话做一次免费签名，一天有效。它不是交易，不移动任何东西；它证明钱包是你的，这样别人就不能以你的名义花钱、认领或发言。</li>
            <li><b>认领一块地。</b>在世界地图上挑一块。你用 {T} 支付，它被销毁，地就是你的。</li>
            <li><b>然后先看一会儿。</b>没有什么需要立刻做。不管你在不在，聚落都在运行。</li>
          </ol>
          <p className="wiki-note">你拥有的一切都记在钱包地址名下，而不是浏览器。在另一台设备上连接同一个钱包，你的世界就在那里。</p>
        </section>

        <section id="land">
          <h2>土地与所有权</h2>
          <p>一块地就是一个种子。生成它的河流、山丘和林地的那个数字，也是识别它的数字，所以没有两块地是同一片土地，你买之前看到的地面就是你得到的地面。</p>
          <p><b>每块地永远只有一个主人。</b>认领只写一次，不能覆盖；两个人在同一瞬间抢同一块地，恰好一人得到，另一人在付款前被拒绝。你的土地记在钱包地址名下，所以清掉浏览器、换设备、几个月后回来，它都还在。</p>
          <p><b>付清之前什么都不记录。</b>登记处在写下地契之前会从链上读你的销毁——钱包对、金额对、已确认、没有花在别的事上。没有办法不付钱拿到地，也没有办法付了钱拿不到。</p>
          <p><b>转售是玩家对玩家。</b>你挂牌出售的地块会带着价格出现在所有人的地图上。买家直接用 {T} 付到你的钱包——普通转账，不销毁，游戏不抽成——登记处从链上读到这笔从对方钱包到你钱包、不少于你要价的转账后，把地块转给对方。聚落随土地一起交接。整个世界在十二张海图上有大约两百块地的容量，地图上会显示已认领多少、还剩多少。</p>
          {!landOnChain && (
            <div className="wiki-callout">
              <b>土地保存在我们的登记处，还不是你钱包里的代币。</b>
              <p>土地合约尚未部署。所有权对每个玩家都生效，并与你的地址绑定，但它是我们保管的记录，而不是你独立于我们持有的链上地契。合约上线后，一块地会变成编号为其种子的 ERC-721 代币，认领会迁移过去。在这里直说，因为区别是真实的，你应该知道自己拿的是哪一种。</p>
            </div>
          )}
          <h3>一块地多少钱</h3>
          <p>只由种子决定，按土地支持的东西定价：</p>
          <table className="wiki-table">
            <thead><tr><th>生物群系</th><th>价格</th></tr></thead>
            <tbody>
              {PLOT_PRICES.map(({ kind, price }) => (
                <tr key={kind}><td>{tn(kind)}</td><td className="num">{n(price)} {T}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="wiki-note">你可以持有任意多块地。只有最先认领的 {EARNING_PLOT_LIMIT} 块赚钱——见下文。</p>
        </section>

        <section id="costs">
          <h2>各项费用</h2>
          <p><b>每一笔收费都被销毁。</b>不是付给我们，不是被任何人收走，不是存在某个金库里——是销毁，所以供应量每次都下降。项目没有抽成的地址，因为没有抽成。</p>
          <table className="wiki-table">
            <thead><tr><th>动作</th><th>费用</th><th /></tr></thead>
            <tbody>
              {CHARGES.map((row) => (
                <tr key={row.what}><td>{row.what}</td><td className="num">{row.cost}</td><td className="muted">{row.note}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="wiki-note">建造、拆除、搬动人，以及聚落内部的其他一切花的是金币，不是 {T}。金币是聚落自己的钱，永远不会离开它。</p>
        </section>

        <section id="earning">
          <h2>收益</h2>
          <p>你不是因为持有土地而获得报酬，而是因为把它经营好，费率每天根据聚落的状态重新计算。这一节讲的是进入<em>你钱包</em>的 {T}；居民赚的金币是另一回事，<a href="#economy">下面有单独一节</a>。</p>
          <div className="wiki-formula">
            <code>每日收益 = {n(STEWARDSHIP_DAILY_CAP)} × 质量 × 关注</code>
            <span>每块地，每个真实日</span>
          </div>
          <p><b>质量</b>是这个地方实际的状况——有房（25%）、有饭（25%）、有活（20%）、满足（20%）、安全（10%）。<b>关注</b>是你最近有没有做什么：刚做过就是满值，沉默大约一天半后滑到 {pct(0.08)} 的底线。没人碰的世界只能赚到经营中的世界的一小部分。</p>
          <table className="wiki-table">
            <thead><tr><th>状况</th><th>一块地</th><th>{EARNING_PLOT_LIMIT} 块地</th></tr></thead>
            <tbody>
              {EXAMPLES.map((row) => (
                <tr key={row.how}>
                  <td>{row.how}</td>
                  <td className="num">{n(yieldFor(row.score, row.attention))}</td>
                  <td className="num">{n(yieldFor(row.score, row.attention) * EARNING_PLOT_LIMIT)}</td>
                </tr>
              ))}
              <tr className="wiki-total"><td>绝对上限</td><td className="num">{n(STEWARDSHIP_DAILY_CAP)}</td><td className="num">{n(DAILY_EARN_CEILING)}</td></tr>
            </tbody>
          </table>
          <p className="wiki-note">所有数字都是每个真实日的 {T}。只有你最先的 {EARNING_PLOT_LIMIT} 块地付钱，每个钱包每天 {n(DAILY_EARN_CEILING)} 是硬上限——再多的钱也买不过去。这是有意的：上限就是阻止游戏变成资本换代币机器的东西。</p>
          {!landOnChain && (
            <div className="wiki-callout warn">
              <b>经营收益还不能提取。</b>
              <p>你的世界在累积收益，银行也显示它，但把它收取到钱包的功能在土地合约部署前是关闭的。支付经营收益需要一种证明钱包真的持有土地的办法——否则任何人都可以批量生成地址，一分钱不花就在每个地址上领每日上限。这个检查存在之前，门宁可关着，也不能开着被人钻空子。</p>
              <p><b>其他一切都已上线。</b>认领、销毁、你自己 {T} 的存取今天都能用。如果你是冲着收益来的，那是唯一值得等的东西，我们宁愿现在告诉你，而不是在你为此买了地之后。</p>
            </div>
          )}
        </section>

        <section id="economy">
          <h2>聚落自己的钱</h2>
          <p>Emerge 里有两种钱，各司其职。<b>{T}</b> 是你的：它在你钱包里，用来买地，每笔收费销毁它。<b>金币</b>是镇子的：付给住在那里的人，买他们造不出的东西。你的居民一整天赚它、花它、领它，不管你看不看。</p>
          <h3>聚落怎么赚钱</h3>
          <p>四条路，其中三条靠镇民而不是你：</p>
          <table className="wiki-table">
            <thead><tr><th>进账</th><th /></tr></thead>
            <tbody>
              {INCOME.map(([line, what]) => (
                <tr key={`in-${line}`}><td className="ledger">{tn(LEDGER_LABELS[line])}</td><td className="muted">{what}</td></tr>
              ))}
            </tbody>
          </table>
          <p><b>这是一个循环，不是水龙头。</b>金库早上付工资；领了钱的人白天在摊位上买面包、衣服和家具；这些钱大多以家庭消费和食物销售回到金库。产出多于消耗的聚落一天下来是盈余，反之是亏损，当晚你就能在银行里看到。</p>
          <h3>它付出什么</h3>
          <table className="wiki-table">
            <thead><tr><th>出账</th><th /></tr></thead>
            <tbody>
              {SPENDING.map(([line, what]) => (
                <tr key={`out-${line}`}><td className="ledger">{tn(LEDGER_LABELS[line])}</td><td className="muted">{what}</td></tr>
              ))}
            </tbody>
          </table>
          <p>工资是大头，按人按天计：</p>
          <table className="wiki-table">
            <thead><tr><th>行当</th><th>日工资</th></tr></thead>
            <tbody>
              {WAGES.map(({ job, wage }) => (
                <tr key={job}><td>{tj(job)}</td><td className="num">{wage} 金币</td></tr>
              ))}
            </tbody>
          </table>
          <p className="wiki-note">金库付不起全部工资时，每个人按比例领一份，动态里会说明。没有人因此被解雇，但人们变穷了，穷人买得少，聚落就是这样把自己说进萧条的。</p>
          <h3>你付他们多少</h3>
          <p>你在银行里设定工资，从市价的 {pct(WAGE_MIN)} 到 {pct(WAGE_MAX)}。这是一个两头都有代价、没有免费档位的旋钮。</p>
          <table className="wiki-table">
            <thead><tr><th>你付</th><th>工作量</th><th>结果</th></tr></thead>
            <tbody>
              {[WAGE_MIN, 0.75, WAGE_STANDARD, 1.3, WAGE_MAX].map((rate) => (
                <tr key={rate}>
                  <td className="num">{pct(rate)}</td>
                  <td className="num">{pct(wageEffort(rate))}</td>
                  <td className="muted">
                    {rate < WAGE_STANDARD
                      ? '人们干得少、没了心气。长期下来镇子比正常付薪时更小更穷。'
                      : rate > WAGE_STANDARD
                        ? '更幸福、增长中的聚落，费用从金库出。它不会靠货物把自己赚回来。'
                        : '人们按预期工作，志向保持平稳。'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="wiki-note">这些数字不是猜的——曲线是把八个聚落在每一档下各跑一百五十天定下来的。早先的版本给慷慨的工资很大的产出加成，多出的货物卖掉后不止抵消了多付的工资，慷慨就成了免费的。现在不是了。</p>
          <h3>为什么世界市场关系到你的账目</h3>
          <p>出口和进口都按共享市场定价，所以你的土地<em>擅长什么</em>现在值真金白银。坐拥一种所有世界都稀缺的东西的聚落卖得贵；不得不买进大家都缺的东西的聚落买得贵。九种生物群系支持不同的行当，这就是为什么地块的生物群系是一个经济决定，而不只是颜色。</p>
          <p>你的居民也看得懂。当世界为金属付高价时，更多人去采矿打铁——除非镇子在挨饿，那时他们会去种地，因为先得把自己喂饱。</p>
          <div className="wiki-callout">
            <b>金币不是第二扇取款门。</b>
            <p>这是诚实的部分，也是游戏之所以有经济的原因。你的聚落赚的金币留在聚落里。它不能兑换成 {T}：金库愿意付给你的以链上显示你存入的为上限，所以再富的金库也变不成代币，不管镇子经营得多好。</p>
            <p>放金币出去试过，它毁了一切——世界变成了印代币的机器，其他什么都不重要了。经营好一个地方的回报是有上限的经营收益，以及这个地方本身变大。</p>
          </div>
        </section>

        <section id="vault">
          <h2>存款与取款</h2>
          <p>金币为你的聚落供血；{T} 是它背后的代币。你可以把自己的钱双向移动。</p>
          <table className="wiki-table">
            <tbody>
              <tr><td>汇率</td><td className="num">{n(EMERGE_PER_GOLD)} {T} = 1 金币</td></tr>
              <tr><td>存款手续费</td><td className="num">无</td></tr>
              <tr><td>取款</td><td className="num">扣留并销毁 {pct(WITHDRAW_BURN_RATE)}</td></tr>
              <tr><td>赠送给另一个世界</td><td className="num">一次最多 {n(MAX_GIFT_GOLD)} 金币</td></tr>
            </tbody>
          </table>
          <p><b>存款是唯一不销毁的东西</b>，原因很明显：那是你自己的钱，取款这扇门必须能把它退回来。存款进入金库，只有链确认它到达后才记账——而且是从你的钱包，具体到地址，所以没人能冒领你的存款。</p>
          <p><b>取款是自动的。</b>按下取款，金库当场签署一笔转到你钱包的转账；银行把交易给你，你可以自己核对。没有人审批，也没有人能决定不付。你能取出的就是链上显示你存入的——所以在每台设备上都是同一个数字，没有人能取出超过存入的量。</p>
          <p className="wiki-note">聚落自己赚的金币不可取出——见<a href="#economy">聚落自己的钱</a>。从金库出来的是你放进去的，加上开放后的经营收益。</p>
        </section>

        <section id="buildings">
          <h2>建筑</h2>
          <p>你不能命令任何人，所以建筑是你表达聚落需要什么的方式。盖一栋，就会有人决定那是自己的——如果它空着，那是立刻。每栋容纳<b>两名工人</b>，矿井三名。</p>
          <p>一切都花金币<em>和</em>堆场里的材料，所以你能盖什么取决于伐木工砍了多少、采石场切了多少。每栋建筑立着就每天花金币，立多久花多久。</p>
          <p><b>聚落会自己建造。</b>当金库持有一栋建筑价格的两倍、外加两周的工资和维护费，且堆场有木料和石头时，它会不经吩咐就盖起短缺的东西：先给露宿的人一个屋顶，库存薄了就盖农场或伐木小屋，然后是地块助手本来会建议你的下一样——仓库、咖啡馆、学校、诊所、实验室、土地支持的手艺。每天最多一栋，动态会说它建了什么、为什么。</p>
          <h3>手艺</h3>
          <p>九种手艺把土地变成货物，每一种都是链条上的一环：</p>
          <table className="wiki-table">
            <thead><tr><th>建筑</th><th>建造</th><th>维护</th><th>日产</th><th>消耗</th><th>工资</th></tr></thead>
            <tbody>
              {TRADE_BUILDINGS.map((b) => {
                const need = BUILD_MATERIALS[b.type] ?? { wood: 10, stone: 4 };
                return (
                  <tr key={b.type}>
                    <td>{tn(b.type)}</td>
                    <td className="num">{(BUILD_COSTS[b.type] ?? 250).toLocaleString()}金<em className="matter"> · {need.wood}木 {need.stone}石</em></td>
                    <td className="num">{maintenanceCost(b.type)}金</td>
                    <td>{b.makes}</td>
                    <td className="muted">{b.needs || '—'}</td>
                    <td className="num">{b.wage}金</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="wiki-note">每名工人每天，尚未计入土地、季节、天气和你付的工资。肥沃土地上的农场比沙地上的同一座农场长得多；冬天的农场比夏天少；一切都乘以你设定的工资。“消耗”是这个行当吃掉的东西——没有面粉的面包师什么也烤不出来，不管你有多少面包师。</p>
          <h3>其他建筑</h3>
          <table className="wiki-table">
            <thead><tr><th>建筑</th><th>建造</th><th>维护</th><th>用途</th></tr></thead>
            <tbody>
              {CIVIC_BUILDINGS.map(([type, what]) => (
                <tr key={type}>
                  <td>{tn(type)}</td>
                  <td className="num">{(BUILD_COSTS[type] ?? 250).toLocaleString()}金<em className="matter"> · {(BUILD_MATERIALS[type] ?? { wood: 10 }).wood}木 {(BUILD_MATERIALS[type] ?? { stone: 4 }).stone}石</em></td>
                  <td className="num">{maintenanceCost(type)}金</td>
                  <td className="muted">{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>搬迁与升级</h3>
          <p>建筑卡上除了它的行当还有两个按钮。<b>搬迁</b>把它拎起来并激活放置光标：点地面它就过去，费用是<b>建造价的 {Math.round(MOVE_SHARE * 100)}%</b>。路会修到新地点，正走向旧地点的人会被安排去别处。搬迁除了金币什么都不损失。放置任何东西——不管是搬的还是新的——只有一条规则：它必须<b>与邻居之间留出可以走人的空隙</b>。两栋挨在一起的建筑会形成谁也过不去的缝，光标会拒绝这个位置并说明原因。</p>
          <p><b>升级</b>花金币和材料让建筑升一级，最高 <b>{MAX_BUILDING_LEVEL}</b> 级。第一步花原价的 {Math.round(UPGRADE_STEPS[0] * 100)}%，第二步 {Math.round(UPGRADE_STEPS[1] * 100)}%，金币和木料石头都要——所以顶级是一个决定，不是走过场。每一级<b>约多产 {Math.round(OUTPUT_PER_LEVEL * 100)}%</b>，<b>维护费多 {Math.round(UPKEEP_PER_LEVEL * 100)}%</b>。它不会容纳更多工人——但看得出来：二级有灯笼和旗帜，三级有玻璃附楼、更高的框架和沿檐的金饰。升级过的作坊有人有料就值回票价；闲置的升级建筑只是每天更大的一张账单。</p>
          <p className="wiki-note">除了市场、银行和镇公所——它们撑着整个聚落——以及还有人住的房子，任何建筑都可以从卡片上拆除。拆除回收<b>一半的木料和石头</b>进堆场。金币没了；你得到的是停掉的维护费，而那通常就是拆它的目的。</p>
        </section>

        <section id="status">
          <h2>读懂你的聚落</h2>
          <p>角落里的面板是聚落的生命体征。这些都不是给你的分数——每一项都从住在那里的人身上量出来，每一项你都能做点什么。</p>
          <table className="wiki-table">
            <thead><tr><th>指标</th><th>它是什么</th><th>怎么改变它</th></tr></thead>
            <tbody>
              {STATUS.map(([label, what, how]) => (
                <tr key={label}><td>{label}</td><td className="muted">{what}</td><td>{how}</td></tr>
              ))}
            </tbody>
          </table>
          <p><b>幸福是付钱的那一项。</b>它占经营评分的五分之一，也是你最能直接把握的五分之一——另外四项是住房、食物、工作和安全，全是建筑和准备。</p>
          <p className="wiki-note">每个人分别携带全部六项需求，点任何一个人就能读到。平均幸福度不错的聚落里，仍然可能有人又冷又孤单、正打算换行。</p>
        </section>

        <section id="danger">
          <h2>可能出的岔子</h2>
          <p>四件事，没有一件是随机惩罚：每一件都需要特定的条件，每一件都有应对的办法。落在有准备的聚落上的灾害几乎不花什么；落在没准备的聚落上的，可能带走一栋建筑、一季收成，或者一条人命。</p>
          <table className="wiki-table">
            <thead><tr><th>麻烦</th><th>由什么引起</th><th>用什么应对</th></tr></thead>
            <tbody>
              {(Object.keys(HAZARD_LABELS) as HazardKind[]).map((kind) => (
                <tr key={kind}><td>{tn(HAZARD_LABELS[kind])}</td><td className="muted">{HAZARD_CAUSE[kind]}</td><td>{HAZARD_ANSWER[kind]}</td></tr>
              ))}
            </tbody>
          </table>
          <p><b>可能出的岔子</b>面板以百分比显示你对每一种的准备程度，<em>在</em>事情发生之前。这就是它的全部意义：准备度是在平静的一周里建起来的，不是事后读的。</p>
          <p className="wiki-note">准备度不是购买来的。它从实际存在的东西里数出来——够得着的水井和附近醒着的人，储备的食物和存放它的地方，寒夜里燃着的火堆，离水而建的建筑。安全占经营评分的十分之一，所以从不准备的聚落会被悄悄少付一点。</p>
        </section>

        <section id="world">
          <h2>世界本身</h2>
          <p>你地块上的每个居民都有自己的饥饿、精力、手艺、友谊和积怨。他们醒来、劳作、争吵、相爱、养育孩子、埋葬死者，不管你看不看。<b>你不能命令任何人。</b>你可以给他们盖一间作坊，看着有人决定那是自己的。</p>
          <p>你真正控制的是这个地方：注资金库、盖房子和作坊、拆掉不管用的、修路和桥到没人能到的土地。八个人的营地变成三十人的镇子，是因为你做的决定，或者没有。</p>
          <p>季节更替，天气降临，糟糕的冬天食物短缺，沙漠里没有农场的聚落会像你预料的那样挣扎。九种生物群系，各自支持不同的行当——这就是它们价格不同的原因。</p>
        </section>

        <section id="arena">
          <h2>竞技场</h2>
          <p>一座没有主人、任何人都能走进去的岛，不管有没有土地。玩家派出一位居民；竞技场把两人配对，每三分钟打一场，所有观众在同一时刻看到同一场比赛。</p>
          <h3>派人</h3>
          <p>竞技场面板列出你聚落里最适合上场的五个人。体魄不是隐藏的战斗属性——它是休息、食物、温暖和衣物，所以想要好斗士就得经营好聚落。技艺是他一生从事的手艺。力量只决定<em>击中的频率</em>，从不决定力度，所以哪怕一边倒的配对也值得看。</p>
          <p><b>一次报名只管一场。</b>被抽中的人在配对时就从名单上移除，铃响后回家。再派他出场是你每次重新做的决定，不是一直发生在他身上的事。</p>
          <h3>下注</h3>
          <p>每场比赛前两分钟开放下注；最后一分钟是比赛。押注从聚落的金库出，赢的回到金库，记在银行的日账里，所以你能清楚看到竞技场花了你多少。赔率由比赛本身测出——对这一配对模拟几千场——所以给你的价格不可能与实际发生的脱节。庄家留有抽水，长期看竞技场拿走的比付出的多。</p>
          <p className="wiki-note"><b>结果无法提前知道，也无法操纵。</b>竞技场开赛时抽一个秘密，只公布它的哈希。下注以该哈希为准；下注截止的那一刻秘密公开，比赛由它算出。没有人，包括庄家，能在下注期间知道赢家——事后任何人都可以核对秘密是否与事先公布的哈希一致。竞技场面板会在你的浏览器里自己做这个核对，并告诉你结果。</p>
          <p className="wiki-note">竞技场的金币是金币，不是 {T}。在竞技场赢钱让你的聚落更富；它不铸造任何东西，也不能作为代币取出。</p>
        </section>

        <section id="together">
          <h2>其他玩家</h2>
          <p>所有人认领过的每一块地都在同一张共享地图上。你可以拜访别人建的聚落——点标记，或在聊天里点某人的名字——看到他们最后离开时的世界。</p>
          <p>拜访就是拜访：你可以观看、跟着人走，但不能建造、拆除或在那里赚钱。你也看不到他们的金库。访客唯一能做的是<b>往看着顺眼的聚落里放金币</b>，一次最多 {n(MAX_GIFT_GOLD)} 金币，按通常汇率以 {T} 支付。</p>
          <p>聊天有一个全局频道和一个你所在世界的频道。以钱包发出的消息由该钱包签名——所以名字旁有徽章的真的就是那个地址，别人冒充不了。</p>
        </section>

        <section id="honest">
          <h2>哪些已定，哪些未定</h2>
          <p>关于任何这类游戏，有用的问题是：哪些部分由链强制执行，哪些部分是一家公司的承诺。这里是完整的答案。</p>
          <table className="wiki-table status">
            <tbody>
              <tr><td>{T} 余额</td><td className={live ? 'yes' : 'no'}>{live ? '链上' : '本地开发构建'}</td><td className="muted">从你的钱包读取</td></tr>
              <tr><td>收费与销毁</td><td className={live ? 'yes' : 'no'}>{live ? '链上' : '本地'}</td><td className="muted">由你签名，供应量下降</td></tr>
              <tr><td>存款</td><td className={live ? 'yes' : 'no'}>{live ? '链上' : '本地'}</td><td className="muted">确认后才记账</td></tr>
              <tr><td>取款</td><td className={live ? 'yes' : 'no'}>{live ? '链上，自动' : '本地'}</td><td className="muted">金库签名，你拿到交易哈希</td></tr>
              <tr>
                <td>土地所有权</td>
                <td className={landOnChain ? 'yes' : 'partial'}>{landOnChain ? '链上（ERC-721）' : '我们的登记处'}</td>
                <td className="muted">{landOnChain ? '你钱包里的一枚代币' : '强制执行，绑定你的地址，还不是代币'}</td>
              </tr>
              <tr>
                <td>经营收益</td>
                <td className={landOnChain ? 'yes' : live ? 'partial' : 'no'}>{landOnChain ? '链上' : live ? '已支付' : '尚未'}</td>
                <td className="muted">{landOnChain ? '从金库支付' : live ? '从金库支付给我们土地记录上的钱包' : '等待代币上线'}</td>
              </tr>
              <tr><td>模拟</td><td className="partial">链下</td><td className="muted">在你的浏览器里运行，只有这样才够流畅</td></tr>
              <tr><td>你的聚落</td><td className="partial">已保存</td><td className="muted">在这个浏览器和我们的服务器上；在另一台设备打开时，更靠后的那份继续</td></tr>
            </tbody>
          </table>
          <p className="wiki-note">两件事值得说清楚。金币和聚落里的一切都是游戏状态，不是钱——走出游戏的唯一一扇门是取回你存入的东西。土地记录保存在我们运营的数据库里：别的玩家拿不走你的地，但在合约上线之前，它是我们的承诺，而不是链的。</p>
        </section>

        <footer className="wiki-foot">
          <Link href="/" className="wiki-back">返回游戏</Link>
          <p className="muted small">这一页上的每个数字都从执行它的代码里读出，所以不会与游戏的实际行为脱节。</p>
        </footer>
      </div>
    </main>
  );
}
