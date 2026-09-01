export type Terrain = 'fertile' | 'forest' | 'mountain' | 'rocky' | 'coastal' | 'river';
export type Job = 'farmer' | 'woodcutter' | 'miner' | 'quarry' | 'miller' | 'baker' | 'carpenter' | 'blacksmith' | 'tailor' | 'unemployed';
export type Resource = 'wheat' | 'vegetables' | 'wood' | 'stone' | 'ironOre' | 'wool' | 'flour' | 'bread' | 'furniture' | 'tools' | 'clothing';

export interface Citizen { id: string; name: string; familyId: string; age: number; job: Job; hunger: number; rest: number; social: number; clothing: number; purpose: number; happiness: number; wage: number; x: number; y: number; }
export interface Family { id: string; name: string; members: string[]; homeId: string; wealth: number; }
export interface Building { id: string; type: string; x: number; y: number; workers: string[]; active: boolean; }
export interface MarketQuote { price: number; supply: number; demand: number; volume: number; trend: number; }
export interface World { id: string; seed: number; day: number; hour: number; terrain: Terrain[]; treasury: number; population: number; families: Family[]; citizens: Citizen[]; buildings: Building[]; resources: Record<Resource, number>; market: Record<Resource, MarketQuote>; lastEvents: string[]; }

const jobs: Record<Exclude<Job,'unemployed'>, { wage: number; output: Partial<Record<Resource, number>>; input?: Partial<Record<Resource, number>> }> = {
  farmer: { wage: 10, output: { wheat: 10, vegetables: 5 } }, woodcutter: { wage: 11, output: { wood: 12.5 } }, miner: { wage: 14, output: { ironOre: 3.33 } },
  quarry: { wage: 12, output: { stone: 9 } }, miller: { wage: 13, output: { flour: 10 }, input: { wheat: 10 } }, baker: { wage: 15, output: { bread: 10 }, input: { flour: 10, wood: 2.5 } },
  carpenter: { wage: 15, output: { furniture: 5 }, input: { wood: 10 } }, blacksmith: { wage: 18, output: { tools: 4 }, input: { ironOre: 8, wood: 4 } }, tailor: { wage: 16, output: { clothing: 4 }, input: { wool: 4 } },
};

const names = ['Avery','Carter','Maya','Noah','Elena','Theo','Iris','Miles','Lena','Jonah','Ruby','Owen','Nora','Eli','Clara','Finn','Milo','June','Ada','Leo','Mae','Sam','Wren','Kai','Rose','Jack','Lily','Ben','Anna','Max'];
const familyNames = ['Carter','Mason','Hayes','Bennett','Reed','Morgan','Brooks','Parker'];
const marketPrices: Record<Resource, number> = { wheat:2, vegetables:2.5, wood:3, stone:4, ironOre:7, wool:6, flour:5, bread:7, furniture:14, tools:20, clothing:18 };
const marketBuffers: Record<Resource, number> = { wheat:60, vegetables:40, wood:70, stone:30, ironOre:20, wool:15, flour:25, bread:40, furniture:10, tools:8, clothing:15 };
const terrainBonuses: Record<Terrain, Partial<Record<Job, number>>> = { fertile:{farmer:1.3}, forest:{woodcutter:1.3}, mountain:{miner:1.3}, rocky:{quarry:1.25}, coastal:{}, river:{farmer:1.15} };

export function mulberry32(seed: number) { return function() { let t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function createMarket(): Record<Resource, MarketQuote> {
  return Object.fromEntries((Object.keys(marketPrices) as Resource[]).map(r => [r, { price: marketPrices[r], supply: 0, demand: 0, volume: 0, trend: 0 }])) as Record<Resource, MarketQuote>;
}

export function createWorld(seed = Math.floor(Math.random()*2**31)): World {
  const rand = mulberry32(seed);
  const terrain = Array.from({length: 2}, () => (['fertile','forest','mountain','rocky','coastal','river'] as Terrain[])[Math.floor(rand()*6)]);
  const count = 20 + Math.floor(rand()*11);
  const families: Family[] = [];
  const citizens: Citizen[] = [];
  for (let i=0;i<Math.ceil(count/4);i++) { const id=`f${i}`; families.push({id,name:familyNames[i%familyNames.length],members:[],homeId:`h${i}`,wealth:0}); }
  for (let i=0;i<count;i++) { const family=families[i%families.length]; const age=i%5===0?8+Math.floor(rand()*8):18+Math.floor(rand()*42); const citizen: Citizen={id:`c${i}`,name:names[i%names.length],familyId:family.id,age,job:'unemployed',hunger:80+rand()*20,rest:70+rand()*30,social:60+rand()*40,clothing:70+rand()*30,purpose:50+rand()*50,happiness:75,wage:0,x:12+Math.floor(rand()*76),y:12+Math.floor(rand()*76)}; citizens.push(citizen); family.members.push(citizen.id); }
  const buildings: Building[] = [
    {id:'bank',type:'Bank',x:24,y:24,workers:[],active:true},{id:'market',type:'Market',x:29,y:24,workers:[],active:true},{id:'storage',type:'Storage',x:34,y:24,workers:[],active:true}
  ];
  families.forEach((f,i)=>buildings.push({id:f.homeId,type:'House',x:20+(i%4)*5,y:32+Math.floor(i/4)*5,workers:[],active:true}));
  return {id:`world-${seed.toString(36)}`,seed,day:1,hour:8,terrain,treasury:1000,population:count,families,citizens,buildings,resources:{wheat:60,vegetables:30,wood:50,stone:20,ironOre:10,wool:8,flour:0,bread:20,furniture:0,tools:5,clothing:10},market:createMarket(),lastEvents:['Your world has emerged.','The market is open. Buyers and sellers are placing orders.']};
}

export function tick(world: World, hours=1): World {
  const next: World = structuredClone(world); next.hour += hours;
  moveCitizens(next, hours);
  marketStep(next, hours);
  while(next.hour>=24){next.hour-=24; next.day++; daily(next);}
  for(const c of next.citizens){ c.rest=Math.max(0,c.rest-hours*2); c.social=Math.max(0,c.social-hours*0.4); c.hunger=Math.max(0,c.hunger-hours*0.8); c.purpose=c.job==='unemployed'?Math.max(0,c.purpose-hours*0.2):Math.min(100,c.purpose+hours*0.05); c.happiness=Math.max(0,Math.min(100,(c.hunger+c.rest+c.social+c.clothing+c.purpose)/5)); }
  return next;
}

function moveCitizens(world: World, hours: number) {
  const rand = mulberry32(world.seed + world.day * 997 + Math.floor(world.hour * 17));
  const market = world.buildings.find(b=>b.type==='Market');
  for(const c of world.citizens){
    if(c.age<16){ c.job='unemployed'; }
    let targetX=market?.x ?? 50, targetY=market?.y ?? 50;
    const home=world.buildings.find(b=>b.id===world.families.find(f=>f.id===c.familyId)?.homeId);
    if(c.rest<35 && home){targetX=home.x;targetY=home.y;}
    else if(c.hunger<35){targetX=market?.x ?? 50;targetY=market?.y ?? 50;}
    else if(c.job==='farmer'){const b=world.buildings.find(x=>x.type==='Farm');targetX=b?.x??18;targetY=b?.y??70;}
    else if(c.job==='woodcutter'){targetX=78;targetY=18;}
    else if(c.job==='miner'){targetX=84;targetY=72;}
    else if(c.job==='quarry'){targetX=68;targetY=80;}
    else if(c.job==='miller'){const b=world.buildings.find(x=>x.type==='Mill');targetX=b?.x??42;targetY=b?.y??50;}
    else if(c.job==='baker'){const b=world.buildings.find(x=>x.type==='Bakery');targetX=b?.x??52;targetY=b?.y??38;}
    else if(c.job==='carpenter'){const b=world.buildings.find(x=>x.type==='Carpenter');targetX=b?.x??38;targetY=b?.y??58;}
    else if(c.job==='blacksmith'){const b=world.buildings.find(x=>x.type==='Blacksmith');targetX=b?.x??62;targetY=b?.y??58;}
    else if(c.job==='tailor'){const b=world.buildings.find(x=>x.type==='Tailor');targetX=b?.x??30;targetY=b?.y??60;}
    else { targetX=(c.x + 50 + (rand()-.5)*24)%92+4; targetY=(c.y + 50 + (rand()-.5)*24)%92+4; }
    const dx=targetX-c.x, dy=targetY-c.y, dist=Math.hypot(dx,dy) || 1;
    const speed=(c.age<16?5:8)*hours;
    const wander=(rand()-.5)*3;
    if(dist<3){c.x=Math.max(4,Math.min(96,c.x+wander));c.y=Math.max(6,Math.min(94,c.y+wander));}
    else {const step=Math.min(dist,speed);c.x=Math.max(4,Math.min(96,c.x+dx/dist*step));c.y=Math.max(6,Math.min(94,c.y+dy/dist*step));}
  }
}

function marketStep(world: World, hours: number) {
  const resources=Object.keys(marketPrices) as Resource[];
  const events:string[]=[];
  let net=0;
  for(const r of resources){
    const quote=world.market[r];
    const stock=world.resources[r];
    const buffer=marketBuffers[r];
    const scarcity=Math.max(-1.5,Math.min(1.5,(buffer-stock)/Math.max(buffer,1)));
    const oldPrice=quote.price;
    quote.price=Math.max(0.5,Math.min(100,quote.price*(1+scarcity*0.035*hours)));
    quote.supply=Math.max(0,stock-buffer);
    quote.demand=Math.max(0,buffer-stock);
    quote.volume=0;
    quote.trend=quote.price-oldPrice;
    if(stock<buffer*0.65){
      const qty=Math.min(Math.max(1,Math.ceil((buffer-stock)*0.08*hours)), Math.max(0,buffer-stock));
      const cost=qty*quote.price;
      if(qty>0 && world.treasury>=cost){ world.resources[r]+=qty; world.treasury-=cost; quote.volume+=qty; net-=cost; if(qty>=2) events.push(`Market bought ${qty} ${RESOURCE_LABELS[r]} for ${cost.toFixed(0)} Gold.`); }
    } else if(stock>buffer*1.45){
      const qty=Math.min(Math.max(1,Math.ceil((stock-buffer)*0.06*hours)), stock-buffer);
      if(qty>0){const revenue=qty*quote.price;world.resources[r]-=qty;world.treasury+=revenue;quote.volume+=qty;net+=revenue;if(qty>=2)events.push(`Market sold ${qty} ${RESOURCE_LABELS[r]} for ${revenue.toFixed(0)} Gold.`);}
    }
  }
  if(events.length){world.lastEvents=[...events.slice(0,3),...world.lastEvents].slice(0,8);}
  void net;
}

function daily(world: World) {
  const events: string[]=[]; let wageCost=0;
  for(const c of world.citizens){ if(c.age<16){c.job='unemployed';c.wage=0;continue;} const need=Math.min(c.hunger,c.rest,c.social,c.clothing,c.purpose); if(c.job==='unemployed' || need<35) c.job=chooseJob(world,c); const wage=c.job==='unemployed'?0:jobs[c.job].wage; c.wage=wage; wageCost+=wage; c.hunger=Math.max(0,c.hunger-8); c.rest=Math.max(0,c.rest-5); c.social=Math.max(0,c.social-2); c.clothing=Math.max(0,c.clothing-1); }
  produce(world,events); consume(world,events); world.treasury-=wageCost; world.treasury-=world.buildings.filter(b=>b.active).reduce((s,b)=>s+maintenance(b.type),0);
  if(world.treasury<0){world.treasury=0;events.push('The treasury is empty. Nonessential work is shutting down.');}
  world.lastEvents=[...events,...world.lastEvents].slice(0,8); world.population=world.citizens.length;
}
function chooseJob(world: World,c: Citizen): Job { const available: Job[]=['farmer','woodcutter','miner','quarry','miller','baker','carpenter','blacksmith','tailor']; const scores=available.map(j=>({j,s:jobScore(world,j)})).sort((a,b)=>b.s-a.s); return scores[0].j; }
function jobScore(world:World,j:Job){const spec=world.terrain.map(t=>terrainBonuses[t][j]||1).reduce((a,b)=>a+b,0)/world.terrain.length; const demand=j==='farmer'?(world.resources.wheat+world.resources.vegetables<100?2:1):j==='woodcutter'?(world.resources.wood<100?2:1):j==='miner'?(world.resources.ironOre<40?2:1):1; return spec*demand;}
function produce(world:World,events:string[]){const counts:Record<string,number>={}; for(const c of world.citizens) counts[c.job]=(counts[c.job]||0)+1; for(const [job,count] of Object.entries(counts)){if(!(job in jobs))continue; const recipe=jobs[job as Exclude<Job,'unemployed'>]; const workers=Math.min(count, job==='miner'?3:2); const canInput=!recipe.input||Object.entries(recipe.input).every(([r,n])=>(world.resources as any)[r]>=n*workers); if(!canInput)continue; for(const [r,n] of Object.entries(recipe.input||{})) (world.resources as any)[r]-=(n as number)*workers; for(const [r,n] of Object.entries(recipe.output)) (world.resources as any)[r]+=(n as number)*workers*terrainMultiplier(world,job as Job); }
  if(counts.farmer) events.push(`${counts.farmer} farmers worked the fields.`); if(counts.woodcutter) events.push(`${counts.woodcutter} woodcutters worked the forest.`); }
function terrainMultiplier(world:World,job:Job){return world.terrain.reduce((s,t)=>s+(terrainBonuses[t][job]||1),0)/world.terrain.length;}
function consume(world:World,events:string[]){const foodNeed=world.citizens.reduce((s,c)=>s+(c.age<16?.5:.9),0); let bread=Math.min(world.resources.bread,foodNeed); world.resources.bread-=bread; let remaining=foodNeed-bread; let wheat=Math.min(world.resources.wheat,remaining); world.resources.wheat-=wheat; remaining-=wheat; let veg=Math.min(world.resources.vegetables,remaining); world.resources.vegetables-=veg; remaining-=veg; if(remaining>0) events.push('Food is running low. The AI is searching the market.'); }
function maintenance(type:string){return ({Bank:0,Market:15,Storage:3,House:1,Farm:3,Woodcutter:2,Quarry:4,Mine:6,Mill:5,Bakery:6,Carpenter:5,Blacksmith:8,Tailor:6,Tavern:7,'Town Hall':10} as Record<string,number>)[type]||2;}

export const RESOURCE_LABELS: Record<Resource,string>={wheat:'Wheat',vegetables:'Vegetables',wood:'Wood',stone:'Stone',ironOre:'Iron Ore',wool:'Wool',flour:'Flour',bread:'Bread',furniture:'Furniture',tools:'Tools',clothing:'Clothing'};
