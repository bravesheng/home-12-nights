'use strict';
// ===== 遊戲資料：地圖、家具、物品、燈泡 =====

const TILE = 32;
// 地圖大小：第一、二世界是 44×33 的房子；第三世界是一列 59 格長的列車（換世界時由 applyWorld 設定）
let MAP_W = 44, MAP_H = 33;
const MAP_SIZE = { 1: [44, 33], 2: [44, 33], 3: [59, 25], 4: [100, 76] };   // 第四世界的大小在下面的 W4W、W4H
// 白天和晚上多長（秒）：第四世界照設計師的要求，早上 5 分鐘、晚上 6 分鐘
const DAY_SECS = { 1: 150, 2: 150, 3: 150, 4: 300 }, NIGHT_SECS = { 1: 150, 2: 150, 3: 150, 4: 360 };

// 房間（格子座標，含邊界）。level 越高，找到的燈泡越好
// ROOMS_HOUSE 是第一、二世界的房子；ROOMS 是現在這個世界用的清單，換世界時由 roomsForWorld 重新填
const ROOMS_HOUSE = [
  { id: 'attic',    name: '閣樓',   x: 1,  y: 1,  w: 10, h: 9,  floor: 'attic',     level: 3, dayDark: 0.55 },
  { id: 'study',    name: '書房',   x: 12, y: 1,  w: 10, h: 9,  floor: 'wood2',     level: 2 },
  { id: 'bedroom',  name: '臥室',   x: 23, y: 1,  w: 10, h: 9,  floor: 'carpet',    level: 1 },
  { id: 'bathroom', name: '浴室',   x: 34, y: 1,  w: 9,  h: 9,  floor: 'tile',      level: 1 },
  { id: 'hall',     name: '走廊',   x: 1,  y: 11, w: 42, h: 3,  floor: 'wood',      level: 0 },
  { id: 'storage',  name: '儲藏室', x: 1,  y: 15, w: 10, h: 10, floor: 'concrete',  level: 1 },
  { id: 'living',   name: '客廳',   x: 12, y: 15, w: 15, h: 10, floor: 'wood',      level: 0 },
  { id: 'kitchen',  name: '廚房',   x: 28, y: 15, w: 15, h: 10, floor: 'tile2',     level: 0 },
  { id: 'basement', name: '地下室', x: 1,  y: 26, w: 16, h: 6,  floor: 'concrete',  level: 3, dayDark: 0.6 },
  { id: 'garage',   name: '車庫',   x: 18, y: 26, w: 13, h: 6,  floor: 'concrete2', level: 2 },
  { id: 'laundry',  name: '洗衣間', x: 32, y: 26, w: 11, h: 6,  floor: 'tile',      level: 1 },
];

const ROOMS = ROOMS_HOUSE.map(r => ({ ...r }));

// 門（放在牆上的格子）。DOORS 是現在這個世界用的清單，換世界時由 doorsForWorld 重新填
const DOORS_HOUSE = [
  { x: 5, y: 10 }, { x: 16, y: 10 }, { x: 27, y: 10 }, { x: 38, y: 10 },
  { x: 5, y: 14 }, { x: 19, y: 14 }, { x: 20, y: 14 }, { x: 35, y: 14 },
  { x: 5, y: 25 }, { x: 22, y: 25 }, { x: 37, y: 25 },
  { x: 0, y: 12, front: true },
];
const DOORS = DOORS_HOUSE.map(d => ({ ...d }));

// 家具。loot = 可搜索的物資表；solid 預設為 true
const FURN = [
  // 客廳
  { id: 'rug1', type: 'rug', x: 17, y: 18, w: 6, h: 4, solid: false, color: '#7a3b3b' },
  { id: 'tvcab', type: 'tvcab', name: '電視櫃', x: 13, y: 15, w: 4, h: 1, loot: 'general' },
  { id: 'sofa', type: 'sofa', x: 13, y: 21, w: 4, h: 1 },
  { id: 'ctable', type: 'table', x: 14, y: 18, w: 2, h: 1 },
  { id: 'bookshelf', type: 'bookshelf', name: '書櫃', x: 26, y: 16, w: 1, h: 3, loot: 'general' },
  { id: 'phone', type: 'phone', name: '電話', x: 26, y: 23, w: 1, h: 1 },
  { id: 'plant1', type: 'plant', x: 12, y: 24, w: 1, h: 1 },
  // 廚房
  { id: 'fridge', type: 'fridge', name: '冰箱', x: 28, y: 15, w: 1, h: 2, loot: 'food' },
  { id: 'kdrawer', type: 'counter', name: '廚房抽屜', x: 29, y: 15, w: 3, h: 1, loot: 'general' },
  { id: 'stove', type: 'stove', x: 32, y: 15, w: 2, h: 1 },
  { id: 'kcab', type: 'cabinet', name: '櫥櫃', x: 37, y: 15, w: 3, h: 1, loot: 'food' },
  { id: 'ksink', type: 'sink', x: 40, y: 15, w: 2, h: 1 },
  { id: 'dtable', type: 'table', x: 33, y: 20, w: 4, h: 2 },
  // 儲藏室
  { id: 'sshelf', type: 'shelf', name: '雜物架', x: 1, y: 15, w: 3, h: 1, loot: 'tool' },
  { id: 'boxA', type: 'box', name: '紙箱', x: 8, y: 15, w: 2, h: 2, loot: 'general' },
  { id: 'boxB', type: 'box', name: '紙箱', x: 8, y: 22, w: 2, h: 2, loot: 'general' },
  { id: 'toolcab', type: 'cabinet', name: '工具櫃', x: 1, y: 19, w: 1, h: 3, loot: 'tool' },
  // 走廊
  { id: 'shoecab', type: 'cabinet', name: '鞋櫃', x: 2, y: 11, w: 2, h: 1, loot: 'clothes' },
  { id: 'plant2', type: 'plant', x: 42, y: 13, w: 1, h: 1 },
  // 臥室
  { id: 'rug2', type: 'rug', x: 26, y: 4, w: 4, h: 3, solid: false, color: '#46607a' },
  { id: 'bed', type: 'bed', name: '床', x: 23, y: 1, w: 2, h: 3 },
  { id: 'nightstand', type: 'cabinet', name: '床頭櫃', x: 25, y: 1, w: 1, h: 1, loot: 'clothes' },
  { id: 'closet', type: 'closet', name: '衣櫃', x: 29, y: 1, w: 3, h: 1, loot: 'clothes' },
  { id: 'dresser', type: 'cabinet', name: '梳妝台', x: 32, y: 5, w: 1, h: 2, loot: 'clothes' },
  // 浴室
  { id: 'toilet', type: 'toilet', x: 34, y: 1, w: 1, h: 1 },
  { id: 'medcab', type: 'medcab', name: '藥櫃', x: 36, y: 1, w: 2, h: 1, loot: 'medicine' },
  { id: 'bathtub', type: 'bathtub', x: 39, y: 1, w: 4, h: 2 },
  // 書房
  { id: 'sbook', type: 'bookshelf', name: '書架', x: 12, y: 1, w: 3, h: 1, loot: 'general' },
  { id: 'desk', type: 'desk', name: '書桌', x: 15, y: 4, w: 3, h: 1, loot: 'general' },
  { id: 'filecab', type: 'cabinet', name: '檔案櫃', x: 20, y: 1, w: 2, h: 1, loot: 'tool' },
  // 閣樓
  { id: 'chest1', type: 'chest', name: '古董箱', x: 1, y: 1, w: 2, h: 1, loot: 'antique' },
  { id: 'chest2', type: 'chest', name: '古董箱', x: 8, y: 1, w: 2, h: 1, loot: 'antique' },
  { id: 'chest3', type: 'chest', name: '古董箱', x: 8, y: 8, w: 2, h: 1, loot: 'antique' },
  { id: 'doll', type: 'doll', x: 2, y: 7, w: 1, h: 1 },
  // 地下室
  { id: 'oldbox1', type: 'box', name: '舊箱子', x: 1, y: 30, w: 2, h: 2, loot: 'antique' },
  { id: 'oldbox2', type: 'box', name: '舊箱子', x: 12, y: 26, w: 2, h: 1, loot: 'tool' },
  { id: 'boiler', type: 'boiler', x: 15, y: 29, w: 2, h: 3 },
  // 車庫
  { id: 'toolbox', type: 'toolbox', name: '工具箱', x: 18, y: 26, w: 2, h: 1, loot: 'tool' },
  { id: 'gshelf', type: 'shelf', name: '鐵架', x: 27, y: 26, w: 3, h: 1, loot: 'tool' },
  { id: 'car', type: 'car', x: 23, y: 28, w: 5, h: 3 },
  // 洗衣間
  { id: 'washer', type: 'washer', name: '洗衣機', x: 32, y: 26, w: 2, h: 1, loot: 'clothes' },
  { id: 'basket', type: 'box', name: '洗衣籃', x: 39, y: 30, w: 2, h: 1, loot: 'clothes' },
  { id: 'breaker', type: 'breaker', name: '電箱', x: 42, y: 28, w: 1, h: 1 },
  // 取得物品的地方
  { id: 'workbench', type: 'workbench', name: '工作台', x: 1, y: 23, w: 2, h: 1 },
  { id: 'gacha', type: 'gacha', name: '扭蛋機', x: 30, y: 30, w: 1, h: 1 },
  { id: 'tchest1', type: 'tchest', name: '上鎖的寶箱', x: 1, y: 4, w: 2, h: 1 },
  { id: 'tchest2', type: 'tchest', name: '上鎖的寶箱', x: 5, y: 30, w: 2, h: 1 },
  { id: 'tchest3', type: 'tchest', name: '上鎖的寶箱', x: 20, y: 8, w: 2, h: 1 },
];
// 神秘商人白天站的位置、早晨禮物放的位置（現在這個世界的；房子是地下室和臥室床邊，第三世界是月台和臥鋪旁邊）
const MERCHANT_HOUSE = { x: 11.5, y: 29.3 }, GIFT_HOUSE = { x: 25.5, y: 3.5 };
const MERCHANT_POS = { ...MERCHANT_HOUSE }, GIFT_POS = { ...GIFT_HOUSE };

// 天花板燈座（每個房間固定的燈位）。SOCKETS 是現在這個世界用的清單，換世界時由 socketsForWorld 重新填
const SOCKETS_HOUSE = [
  { id: 's_living', x: 20, y: 19 }, { id: 's_kitchen', x: 35, y: 18 }, { id: 's_storage', x: 6, y: 19 },
  { id: 's_hall1', x: 9, y: 12 }, { id: 's_hall2', x: 21, y: 12 }, { id: 's_hall3', x: 33, y: 12 },
  { id: 's_bedroom', x: 28, y: 5 }, { id: 's_bathroom', x: 38, y: 5 }, { id: 's_study', x: 17, y: 7 },
  { id: 's_attic', x: 5, y: 5 }, { id: 's_basement', x: 8, y: 28 }, { id: 's_garage', x: 20, y: 29 },
  { id: 's_laundry', x: 37, y: 29 },
];
const SOCKETS = SOCKETS_HOUSE.map(s => ({ ...s }));

// 燈泡：第 1～11 級越後面越亮；第 12～14 級是有特殊能力的燈泡
const BULBS = [null,
  { name: '破爛燈泡',     r: 3.0,  color: [255, 150, 70],  desc: '又暗又會閃，晚上隨時可能燒壞。' },
  { name: '省電燈泡',     r: 3.8,  color: [255, 226, 150], desc: '穩定的暖黃光，偶爾會燒壞。' },
  { name: 'LED 燈泡',     r: 4.6,  color: [235, 245, 255], desc: '明亮白光，不會燒壞。' },
  { name: '水晶燈泡',     r: 5.4,  color: [190, 240, 255], desc: '晶瑩剔透，掛著水晶墜飾。' },
  { name: '黃金皇家燈泡', r: 6.2,  color: [255, 205, 80],  desc: '金色光芒四射的皇家燈泡。' },
  { name: '藍鑽石燈泡',   r: 7.0,  color: [80, 160, 255],  desc: '藍鑽石切面折射出深海般的光。' },
  { name: '紅鑽石燈泡',   r: 7.8,  color: [255, 70, 100],  desc: '紅鑽石燃燒般的光輝。' },
  { name: '紫鑽石燈泡',   r: 8.6,  color: [190, 90, 255],  desc: '神秘的紫鑽石，光芒極為罕見。' },
  { name: '七彩鑽石燈泡', r: 9.5,  color: 'rainbow',       desc: '不斷變換七種顏色的傳說鑽石。' },
  { name: '火焰燈泡',     r: 10.8, color: [255, 120, 30],  desc: '燈泡裡封印著永不熄滅的火焰，晚上會射出火球攻擊 7 格內的怪物（停電也會）。' },
  { name: '星空燈泡',     r: 12,   color: [170, 195, 255], desc: '深藍色的燈泡裡有星星一閃一閃，照得最遠。' },
  { name: '天使燈泡',     r: 3.2,  color: [255, 236, 190], special: 'angel', desc: '燈泡裡住著小天使，晚上會飛出去打怪物（停電也會）；但燈光比較暗。' },
  { name: '粘液燈泡',     r: 0,    color: [120, 230, 90],  special: 'slime', noLight: true, desc: '不會發光，但會流出一灘黏液，走進黏液的怪物都會變得很慢。' },
  { name: '回血燈泡',     r: 3.8,  color: [140, 255, 175], special: 'heal', desc: '站在燈泡下面（2.5 格內）會慢慢回血。停電時燈熄了就不會回血。' },
  // 第 15 級：第三世界才拿得到的傳說級燈泡
  { name: '大白燈',       r: 4.0,  color: [255, 244, 228], special: 'baymax', desc: '柔和的暖白光。燈下站著一個白色的人形「大白」，3 格內會回體溫；走到它面前它會抱住你，體溫回得更快、被打只扣一半的血。' },
];
const MAX_TIER = BULBS.length - 1;
const FIRE_TIER = 10, STAR_TIER = 11, ANGEL_TIER = 12, SLIME_TIER = 13, HEAL_TIER = 14, BAYMAX_TIER = 15;
const NORMAL_MAX = STAR_TIER;                 // 一般燈泡的最高級（合成、升級到這裡為止）
const isSpecialBulb = t => !!(BULBS[t] && BULBS[t].special);
const BULB_PRICE = [0, 1, 2, 3, 4, 6, 8, 10, 13, 16, 20, 26, 22, 18, 24, 40];

// 第二世界裡，藍鑽、紅鑽、紫鑽燈泡變成花園版（等級、亮度、燈光顏色都一樣）
const BULBS_W2 = {
  6: { name: '花燈泡', desc: '一朵發著藍光的繡球花，會飄下藍色花瓣。' },
  7: { name: '樹燈泡', desc: '燈泡裡長著一棵紅色的楓樹，會飄下紅葉。' },
  8: { name: '水燈泡', desc: '裝滿發著紫光的水，會滴下紫色的水滴。' },
};
// 第三世界裡變成鍍金年代的列車燈具（一樣只換名字和外觀）
const BULBS_W3 = {
  6: { name: '黃銅燈泡', desc: '黃銅燈罩裡的藍色燈芯，黃銅已經發黑長出銅綠。' },
  7: { name: '鍍金燈泡', desc: '鍍金的燈座、紅寶石色的玻璃，金漆有些剝落了。' },
  8: { name: '水晶吊燈燈泡', desc: '掛著一串紫水晶墜飾，列車開的時候會叮叮作響。' },
};

// 所有的鬼分成九級（照設計師的紙本設計圖）：鬼兵、鬼差、厲鬼、鬼將 ＜ 鬼王、判官、羅剎、閻羅 ＜ 酆都。
// 每一級有自己的顏色，怪物圖鑑卡片的邊框和等級標籤就是那個顏色；閻羅級是粉紅和藍交替閃、酆都級是七彩閃（CSS 動畫）
const GRADES = {
  soldier:  { name: '鬼兵', color: '#a9a9b2' },
  runner:   { name: '鬼差', color: '#5fd37a' },
  fierce:   { name: '厲鬼', color: '#4da3ff' },
  general:  { name: '鬼將', color: '#b06bff' },
  king:     { name: '鬼王', color: '#ff3a4a' },
  judge:    { name: '判官', color: '#ffd23a' },
  rakshasa: { name: '羅剎', color: '#ff8a2a' },
  yama:     { name: '閻羅', color: '#ff8ad0', flash: 'yama' },
  fengdu:   { name: '酆都', color: '#ffffff', flash: 'fengdu' },
};
const GRADE_ORDER = ['soldier', 'runner', 'fierce', 'general', 'king', 'judge', 'rakshasa', 'yama', 'fengdu'];
// 燈泡稀有度：1～5 級稀有、沒有技能的 6 級以上史詩、有技能的傳奇（火焰、天使、粘液、回血）
// 第四世界的板子另外有普通（灰）和神話（紅）：照設計圖的顏色，普通灰、稀有藍、史詩紫、傳奇黃、神話紅
const RARITY = {
  common: { name: '普通', color: '#a9a9b2' },
  rare:   { name: '稀有', color: '#4da3ff' },
  epic:   { name: '史詩', color: '#c27bff' },
  legend: { name: '傳奇', color: '#ffc23a' },
  mythic: { name: '神話', color: '#ff4a4a' },
};
const bulbRarity = t => (BULBS[t].special || t === FIRE_TIER ? 'legend' : t <= 5 ? 'rare' : 'epic');

// 手電筒七個等級（第 7 級叫「星晃」，設計師訂正）：1～3 級是前三個世界的；4～7 級是第四世界的（設計師：地圖大，手電筒要更大的光線），光會變色（beam 是光在這幾個顏色之間流動）
const FLASH_TIERS = [null,
  { name: '破爛手電筒', short: '破爛', dmg: 1, range: 7.5, half: 0.42, color: '#b9b1a8' },
  { name: '稀有手電筒', short: '稀有', dmg: 2, range: 9, half: 0.42, color: '#4da3ff' },
  { name: '巨光手電筒', short: '巨光', dmg: 3, range: 10.5, half: 0.52, color: '#ffc23a' },
  { name: '極光手電筒', short: '極光', dmg: 4, range: 12, half: 0.56, color: '#2ed47a', beam: [[80, 255, 150], [70, 220, 255], [180, 130, 255]], desc: '綠色的光像極光一樣在綠、青、淡紫之間流動。' },
  { name: '寒河冷光', short: '寒河', dmg: 5, range: 13.5, half: 0.6, color: '#b05cff', beam: [[170, 90, 255], [255, 90, 220]], desc: '紫色的冷光，在紫和洋紅之間閃爍。' },
  { name: '光之巨劍', short: '巨劍', dmg: 6.5, range: 15, half: 0.36, color: '#ff7a2a', beam: [[255, 150, 50], [255, 70, 30]], desc: '窄而長的光，像一把燃燒的巨劍，在橘和紅之間變化。' },
  { name: '星晃手電筒', short: '星晃', dmg: 8, range: 16, half: 0.66, color: '#ffffff', beam: [[255, 255, 255], [70, 50, 110]], stars: true, desc: '黑和白：在白光和暗紫黑之間交替，光裡有星星閃爍。' },
];
const FLASH_MAX = FLASH_TIERS.length - 1;

const LAMP_TYPES = {
  socket: { name: '天花板燈座', mult: 1.0 },
  desk:   { name: '檯燈',       mult: 0.75 },
  floor:  { name: '落地燈',     mult: 1.0 },
  chand:  { name: '水晶吊燈',   mult: 1.3 },
};

// 物品
const ITEMS = {
  lamp_desk:  { name: '檯燈',   kind: 'lamp', lamp: 'desk',  desc: '可放在地上的小燈，照明範圍 ×0.75。放好後裝上燈泡。' },
  lamp_floor: { name: '落地燈', kind: 'lamp', lamp: 'floor', desc: '可放在地上的大燈，照明範圍 ×1.0。' },
  lamp_chand: { name: '水晶吊燈', kind: 'lamp', lamp: 'chand', desc: '稀有的吊燈，照明範圍 ×1.3。' },
  battery:  { name: '電池',   kind: 'battery', icon: '🔋', desc: '手電筒電量 +50。' },
  candle:   { name: '蠟燭',   kind: 'candle',  icon: '🕯️', desc: '放在腳下，燒 90 秒。停電時也能用。' },
  snack:    { name: '零食',   kind: 'food', icon: '🍪', hunger: 20, desc: '飽食 +20' },
  canned:   { name: '罐頭',   kind: 'food', icon: '🥫', hunger: 45, desc: '飽食 +45' },
  noodles:  { name: '泡麵',   kind: 'food', icon: '🍜', hunger: 35, san: 5, warm: 10, desc: '飽食 +35、理智 +5' },
  cocoa:    { name: '熱可可', kind: 'food', icon: '☕', hunger: 10, san: 30, warm: 20, desc: '理智 +30、飽食 +10' },
  chocolate: { name: '巧克力', kind: 'food', icon: '🍫', hunger: 10, san: 20, desc: '理智 +20、飽食 +10' },
  milk:     { name: '熱牛奶', kind: 'food', icon: '🥛', hunger: 20, san: 15, warm: 15, desc: '理智 +15、飽食 +20' },
  // 第四世界賣場美食區的食物（食物都要自己找）
  hotdog:   { name: '熱狗',   kind: 'food', icon: '🌭', hunger: 35, desc: '飽食 +35' },
  meatball: { name: '肉丸',   kind: 'food', icon: '🍝', hunger: 40, san: 5, desc: '飽食 +40、理智 +5' },
  pizza:    { name: '披薩',   kind: 'food', icon: '🍕', hunger: 45, desc: '飽食 +45' },
  fries:    { name: '薯條',   kind: 'food', icon: '🍟', hunger: 25, desc: '飽食 +25' },
  soda:     { name: '汽水',   kind: 'food', icon: '🥤', hunger: 10, san: 12, desc: '理智 +12、飽食 +10' },
  cake:     { name: '蛋糕',   kind: 'food', icon: '🍰', hunger: 30, san: 10, desc: '飽食 +30、理智 +10' },
  // 第三世界的燃料（丟進機車室的火爐讓列車一直開）：木柴 LV1、木炭 LV2；椅墊和舊報紙是沒燃料時的救急辦法
  wood:      { name: '木柴',     kind: 'fuel', icon: '🪵', burn: 25, lv: 1, desc: '燃料 LV1：丟進火爐燒 25 秒。對著火爐按 E 丟進去。' },
  charcoal:  { name: '木炭',     kind: 'fuel', icon: '🪨', burn: 55, lv: 2, desc: '燃料 LV2：丟進火爐燒 55 秒，比木柴耐燒。' },
  cushion:   { name: '絨布椅墊', kind: 'fuel', icon: '🧶', burn: 8,  lv: 0, desc: '燃料 LV0：救急用，只能燒 8 秒。' },
  newspaper: { name: '舊報紙',   kind: 'fuel', icon: '📰', burn: 8,  lv: 0, desc: '燃料 LV0：救急用，只能燒 8 秒。' },
  // 武器
  pan:        { name: '平底鍋', kind: 'weapon', icon: '🍳', desc: '敲前面的怪物，扣血又會把牠敲暈。' },
  slingshot:  { name: '彈弓',   kind: 'weapon', icon: '🎯', desc: '發射彈珠打遠處的怪物（需要彈珠）。' },
  salt:       { name: '鹽巴',   kind: 'weapon', icon: '🧂', desc: '撒一圈鹽，身邊的怪物都會扣血、被推開。' },
  watergun:   { name: '聖水槍', kind: 'weapon', icon: '🔫', desc: '噴出聖水，前面的怪物會一直扣血（需要聖水）。' },
  firecracker:{ name: '鞭炮',   kind: 'weapon', icon: '🧨', desc: '丟出去 1 秒後爆炸，附近的怪物都扣很多血。' },
  marble:     { name: '彈珠',   kind: 'ammo',   icon: '🔘', desc: '彈弓的子彈。選彈弓按 Q 發射。' },
  holywater:  { name: '聖水',   kind: 'ammo',   icon: '💧', desc: '聖水槍的水，一瓶噴一次。選聖水槍按 Q 噴。' },
  strongflash:{ name: '稀有手電筒', kind: 'upgrade', icon: '🔦', desc: '撿到就自動換上：手電筒打怪物的傷害變 2 倍、照得更遠。' },
  megaflash:  { name: '巨光手電筒', kind: 'upgrade', icon: '🔆', desc: '撿到就自動換上：手電筒打怪物的傷害變 3 倍、照得最遠，光圈也更寬。' },
  // 第四世界的手電筒 4～7 級（撿到就自動換上，只會往上升）
  flash4:     { name: '極光手電筒', kind: 'upgrade', icon: '🌌', desc: '撿到就自動換上：第 4 級，傷害 4 倍、照 12 格，綠色的光像極光一樣流動。' },
  flash5:     { name: '寒河冷光',   kind: 'upgrade', icon: '❄️', desc: '撿到就自動換上：第 5 級，傷害 5 倍、照 13.5 格，紫色的冷光。' },
  flash6:     { name: '光之巨劍',   kind: 'upgrade', icon: '🗡️', desc: '撿到就自動換上：第 6 級，傷害 6.5 倍、照 15 格，窄而長的橘紅色光劍。' },
  flash7:     { name: '星晃手電筒', kind: 'upgrade', icon: '✨', desc: '撿到就自動換上：第 7 級，傷害 8 倍、照 16 格最寬，黑白交替、光裡有星星。' },
  amulet:     { name: '護身符', kind: 'charm',  icon: '📿', desc: '帶在身上就有效：被怪物抓到時只扣一半的血。' },
  bandage:  { name: '繃帶',   kind: 'food', icon: '🩹', hp: 25, desc: '生命 +25' },
  medkit:   { name: '急救箱', kind: 'food', icon: '💊', hp: 60, desc: '生命 +60' },
};
for (let t = 1; t <= MAX_TIER; t++) {
  ITEMS['bulb' + t] = { name: BULBS[t].name, kind: 'bulb', tier: t, desc: (BULBS[t].special ? '特殊燈泡。' : `第 ${t} 級。`) + BULBS[t].desc };
}
ITEMS.key = { name: '鑰匙', kind: 'key', icon: '🗝️', desc: '走到上鎖的寶箱前按 E 就能打開。' };
ITEMS.coin = { name: '硬幣', kind: 'coin', icon: '🪙', desc: '可以跟神秘商人買東西，或投扭蛋機。' };
const ITEM_ORDER = [
  'pan', 'slingshot', 'watergun', 'firecracker', 'salt', 'marble', 'holywater', 'strongflash', 'megaflash', 'flash4', 'flash5', 'flash6', 'flash7', 'amulet',
  'bulb' + BAYMAX_TIER, 'bulb' + HEAL_TIER, 'bulb' + SLIME_TIER, 'bulb' + ANGEL_TIER,
  ...Array.from({ length: NORMAL_MAX }, (_, i) => 'bulb' + (NORMAL_MAX - i)),
  'key', 'lamp_chand', 'lamp_floor', 'lamp_desk', 'battery', 'candle',
  'charcoal', 'wood', 'cushion', 'newspaper',
  'cocoa', 'chocolate', 'milk', 'pizza', 'meatball', 'hotdog', 'cake', 'fries', 'soda', 'canned', 'noodles', 'snack', 'medkit', 'bandage',
];

// 物資表（權重）
const LOOT = {
  general:  { bulb: 4, battery: 2.5, candle: 2, snack: 2.5, lamp_desk: 1.2, lamp_floor: 0.5, noodles: 1.5, coin: 3, key: 0.25, chocolate: 2, cocoa: 1, marble: 1.5, firecracker: 0.8, slingshot: 0.4 },
  food:     { snack: 4, canned: 3, noodles: 3, cocoa: 3, chocolate: 3, milk: 3, salt: 1.5, pan: 0.5, coin: 1 },
  medicine: { bandage: 4, medkit: 1.2, cocoa: 2, chocolate: 1, battery: 1, holywater: 2, coin: 1 },
  tool:     { bulb: 4, battery: 3, lamp_floor: 1.2, candle: 1, lamp_desk: 1, coin: 2, key: 0.35, firecracker: 1.5, marble: 1, strongflash: 0.25, watergun: 0.3 },
  antique:  { bulb: 5, lamp_chand: 1, lamp_floor: 1.5, candle: 1, medkit: 0.8, coin: 3, key: 0.6, amulet: 0.5, holywater: 1, strongflash: 0.3 },
  clothes:  { battery: 2, candle: 2, snack: 1.5, bulb: 2, bandage: 1, cocoa: 1.5, chocolate: 1.5, milk: 1, coin: 3, marble: 1.5, slingshot: 0.5, amulet: 0.2 },
  // 第三世界：車站的物資、燃料堆、煤袋、椅墊堆、吧台、行李
  station:  { bulb: 3, battery: 2, snack: 2, wood: 3, candle: 1.5, coin: 3, newspaper: 1.5, marble: 1, firecracker: 0.8, key: 0.25, chocolate: 1.5, cocoa: 1.5, milk: 1 },
  fuel:     { wood: 10, newspaper: 1.5, coin: 1 },
  coal:     { charcoal: 8, wood: 2, coin: 1 },
  cushions: { cushion: 6, newspaper: 5, coin: 1, battery: 0.8 },
  bar:      { bulb: 3, cocoa: 2, milk: 2, chocolate: 2, coin: 3, candle: 1, key: 0.3, holywater: 1, lamp_desk: 1, battery: 1 },
  luggage:  { bulb: 3, battery: 2, candle: 1.5, bandage: 1, cocoa: 1.5, chocolate: 1.5, coin: 3, marble: 1.5, newspaper: 1, amulet: 0.2, slingshot: 0.4 },
  // 第四世界：賣場的美食區、飲料機、雜貨架、燈具架、寢具和衣櫃、倉儲區的紙箱、玩具箱、浴室的櫃子
  food4:    { hotdog: 3, meatball: 3, pizza: 2, fries: 3, soda: 2, cake: 1.5, snack: 2, canned: 1, coin: 1 },
  drink4:   { soda: 5, milk: 2, cocoa: 2, coin: 1 },
  store4:   { bulb: 2.5, battery: 3, candle: 1.5, coin: 3, chocolate: 1, snack: 1.5, marble: 1, firecracker: 0.6, key: 0.2, salt: 0.6 },
  lamps4:   { bulb: 8, battery: 1 },   // 第四世界沒有燈泡，「燈泡」就是一整盞檯燈（設計師：燈泡不要了，直接就是檯燈）
  clothes4: { battery: 2, candle: 1, coin: 3, bandage: 1, amulet: 0.2, marble: 1, slingshot: 0.3, cocoa: 1 },
  tools4:   { battery: 3, wood: 3, charcoal: 1.2, coin: 2, firecracker: 1.5, marble: 1, watergun: 0.3, strongflash: 0.2, holywater: 1, key: 0.3 },
  kids4:    { marble: 3, slingshot: 0.6, chocolate: 2, candle: 1, coin: 2, firecracker: 1, soda: 1 },
  med4:     { bandage: 4, medkit: 1.2, holywater: 2, battery: 1, coin: 1 },
};

// 難度：開始新遊戲前選
const DIFFS = {
  easy:   { name: '簡單', spawn: 0.5,  maxS: 0.5,  lv: -2, hp: 0.7,  dmg: 0.5,  san: 0.5,  hunger: 0.6, items: 1.8,  hazard: 0.6 },
  normal: { name: '普通', spawn: 0.75, maxS: 0.75, lv: -1, hp: 0.85, dmg: 0.75, san: 0.75, hunger: 0.8, items: 1.35, hazard: 0.85 },
  hard:   { name: '困難', spawn: 1,    maxS: 1,    lv: 0,  hp: 1,    dmg: 1,    san: 1,    hunger: 1,   items: 1,    hazard: 1 },
};

// ====================================================================
// 第二世界：夢核花園。房間和門的位置都跟第一世界一樣，只換名字、地板和家具
// ====================================================================
const WORLD_NAMES = { 1: '第一世界：家', 2: '第二世界：夢核花園', 3: '第三世界：末班列車', 4: '第四世界：3008 無盡賣場' };
const ROOMS_W2 = {
  attic:    { name: '紫藤花架', floor: 'grass2', dayDark: 0.25 },
  study:    { name: '樹洞書屋', floor: 'grass' },
  bedroom:  { name: '花田',     floor: 'flowers' },
  bathroom: { name: '噴水池',   floor: 'stone' },
  hall:     { name: '花徑',     floor: 'path' },
  storage:  { name: '園丁小屋', floor: 'dirt' },
  living:   { name: '中央草坪', floor: 'grass' },
  kitchen:  { name: '野餐區',   floor: 'grass2' },
  basement: { name: '樹根洞穴', floor: 'dirt2', dayDark: 0.6 },
  garage:   { name: '遊樂場',   floor: 'sand' },
  laundry:  { name: '水井邊',   floor: 'grass' },
};
// 第三世界的房間在下面（ROOMS_W3：整列車、車頂和車站，格局跟房子完全不同）
function roomsForWorld(w) {
  if (w === 3) return ROOMS_W3.map(r => ({ ...r }));
  if (w === 4) return W4MAP.rooms.map(r => ({ ...r }));
  return ROOMS_HOUSE.map(r => ({ ...r, ...(w === 2 ? ROOMS_W2[r.id] : {}) }));
}
const isStationRoom = r => !!(r && r.station);   // 車站的房間（白天才能去，晚上列車開走就鎖門）
// 第二世界的家具：同一個位置、同樣大小，換成花園裡的東西（沒有電視、沒有衣櫃）
const FURN_W2 = {
  rug1: { type: 'flowerbed', color: '#f08cc0' },
  tvcab: { type: 'mailbox', name: '信箱' },
  sofa: { type: 'bench' },
  ctable: { type: 'stump' },
  bookshelf: { type: 'log', name: '樹洞' },
  phone: { name: '電話亭' },
  plant1: { type: 'bigflower', color: '#ff9ec8' },
  fridge: { type: 'vending', name: '自動販賣機' },
  kdrawer: { type: 'picnicbox', name: '野餐箱' },
  stove: { type: 'grill' },
  kcab: { type: 'baskets', name: '野餐籃' },
  ksink: { type: 'tap' },
  dtable: { type: 'picnic' },
  sshelf: { type: 'pots', name: '種子架' },
  boxA: { type: 'crate', name: '木箱' },
  boxB: { type: 'crate', name: '木箱' },
  toolcab: { type: 'gardentools', name: '園藝工具箱' },
  shoecab: { type: 'pots', name: '花盆架' },
  plant2: { type: 'bigflower', color: '#ffe066' },
  rug2: { type: 'flowerbed', color: '#9cc8ff' },
  nightstand: { type: 'smallcab', name: '小木櫃' },
  closet: { type: 'clothesline', name: '曬衣籃' },
  dresser: { type: 'smallcab', name: '木頭櫃' },
  toilet: { type: 'birdbath' },
  medcab: { type: 'firstaid', name: '急救箱' },
  bathtub: { type: 'fountain' },
  sbook: { type: 'hollow', name: '樹洞' },
  desk: { type: 'stonetable', name: '石桌' },
  filecab: { type: 'crate', name: '舊木箱' },
  chest1: { type: 'rootbox', name: '樹根木箱' },
  chest2: { type: 'rootbox', name: '樹根木箱' },
  chest3: { type: 'rootbox', name: '樹根木箱' },
  doll: { type: 'scarecrow' },
  oldbox1: { type: 'crate', name: '舊木箱' },
  oldbox2: { type: 'crate', name: '舊木箱' },
  boiler: { type: 'roots' },
  toolbox: { type: 'toybox', name: '玩具箱' },
  gshelf: { type: 'toyshelf', name: '玩具架' },
  car: { type: 'slide' },
  washer: { type: 'well', name: '水井' },
  basket: { type: 'buckets', name: '水桶' },
};
// ====================================================================
// 第三世界：末班列車（鍍金年代的豪華特快車，老舊、積灰、沒有人）
// 地圖是一列 59 格長的列車（參考《無限列車》那種復古蒸汽機車，每節車廂功能不同），從車頭往車尾：
// 機車室（駕駛台和火爐）→ 普通車廂（走道兩側一排排座位）→ 餐車 → 景觀車廂（最後一節）
// 2026/10/11 照設計師的意見簡化：原本 8 節車廂加 3 間車站房間太多、場景混亂，拿掉行李車、商務車廂、盥洗室和站務室
// 2026/10/31 設計師第二次意見：拿掉臥鋪車廂（床、衣物櫃搬到景觀車廂）、車廂加寬（7 排，走道 3 格寬）、天花板加高到 3.3 公尺
// 列車佔 y=5～11 這七排；北邊 y=1～3 是走得到的車頂（比車廂地板高，從車廂裡的爬梯上去）；南邊是車站（露天的月台、候車室），白天才能去
// ====================================================================
const CEIL_W3 = 3.3;              // 第三世界車廂（和車站）的天花板高度
const ROOF_H = CEIL_W3 + 0.25;    // 車頂離車廂地板的高度
// 每一節車廂（x0～x1 是車廂內部的範圍；兩節之間有一格牆，牆上是連結處的門）
const W3_CARS = [
  { id: 'engine', x0: 1, x1: 8 }, { id: 'coach', x0: 10, x1: 27 }, { id: 'dining', x0: 29, x1: 42 }, { id: 'lounge', x0: 44, x1: 57 },
];
// 房間：aisle 是車廂的走道（墮落戰神只在這裡走）、comp 是可以關門躲起來的地方（機車室）、roof 是車頂、station 是車站、open 是露天（沒有天花板，看得到藍天白雲）
const ROOMS_W3 = [
  { id: 'engine',   name: '機車室',     x: 1,   y: 5,  w: 8,  h: 7, floor: 'iron',     level: 3, dayDark: 0.5, comp: true },
  { id: 'coach',    name: '普通車廂',   x: 10,  y: 5,  w: 18, h: 7, floor: 'runner',   level: 1, aisle: true },
  { id: 'dining',   name: '餐車',       x: 29,  y: 5,  w: 14, h: 7, floor: 'tile3',    level: 0, aisle: true },
  { id: 'lounge',   name: '景觀車廂',   x: 44,  y: 5,  w: 14, h: 7, floor: 'carpet3',  level: 0, aisle: true },
  { id: 'roof',     name: '車頂',       x: 10,  y: 1,  w: 48, h: 3, floor: 'roof',     level: 2, dayDark: 0, roof: true },
  { id: 'platform', name: '月台',       x: 11,  y: 13, w: 47, h: 4, floor: 'platform', level: 3, dayDark: 0, station: true, open: true },
  { id: 'waiting',  name: '候車室',     x: 17,  y: 18, w: 18, h: 6, floor: 'wood3',    level: 2, dayDark: 0.3, station: true },
];
// 門：vest 是車廂之間連結處的門（一直開著）、comp 是機車室的門（可以關）、station 是下車站的門（晚上鎖）、front 是車尾的連結處門（敲門事件）
const DOORS_W3 = [
  { x: 9, y: 8, comp: true }, { x: 28, y: 8, vest: true }, { x: 43, y: 8, vest: true },
  { x: 19, y: 12, station: true }, { x: 35, y: 12, station: true }, { x: 50, y: 12, station: true },
  { x: 25, y: 17 },
  { x: 58, y: 8, front: true },
];
// 天花板的燈座：長的車廂兩個、機車室一個；月台是露天的，燈座做成燈柱；候車室一盞
const SOCKETS_W3 = [
  { id: 's_engine', x: 5, y: 8 },
  { id: 's_coach1', x: 14, y: 8 }, { id: 's_coach2', x: 23, y: 8 },
  { id: 's_dining1', x: 33, y: 8 }, { id: 's_dining2', x: 39, y: 8 },
  { id: 's_lounge', x: 50, y: 8 }, { id: 's_lounge2', x: 55, y: 8 },
  { id: 's_platform1', x: 20, y: 14 }, { id: 's_platform2', x: 44, y: 14 },
  { id: 's_waiting', x: 25, y: 20 },
];
// 第三世界的固定位置：開始的地方（景觀車廂中間，面向車頭）、神秘商人（月台上，景觀車廂車門下車的正前方）、
// 早晨禮物（機車室火爐旁邊，丟木炭的地方）、過場動畫坐的沙發和走的路線（月台 → 車門 → 車廂裡 → 沙發）、月台的範圍、
// 墮落戰神巡邏的兩頭；body 是車身的南北兩面牆（3D 畫面的車頂、車頭用）
const W3 = {
  start: { x: 50.5, y: 8.5, face: Math.PI },
  merchant: { x: 50.5, y: 15.3 }, gift: { x: 3.5, y: 9.0 },
  seat: { x: 46.6, y: 5.75, lookX: 49.5, lookY: 8.5 },
  cutPath: [[50.5, 15.5, 0], [50.5, 12.5, 0], [50.5, 9.0, 0]],
  platform: { x0: 11, x1: 57, y0: 13, y1: 16 },
  patrol: [{ x: 11.5, y: 8.5 }, { x: 56.5, y: 8.5 }],
  body: { z0: 4, z1: 13 },
  loco: { chimney: { x: -3.3, y: 8.5 } },   // 車頭煙囪的位置（在地圖外面，從車頂看得到）
  // 牆上的旅行海報（照片貼圖 tex/w3-poster-*.webp）：x 是中心、z 是牆面那條線、face 是海報朝哪邊（s 朝南、n 朝北）
  // 候車室裡面的北牆和南牆各掛幾張，候車室朝月台的那面外牆也掛兩張（都避開窗戶和門）
  posters: [
    { x: 23.5, z: 18, face: 's', img: 'bridge' }, { x: 23.5, z: 24, face: 'n', img: 'snow' }, { x: 29.5, z: 24, face: 'n', img: 'meadow' },
    { x: 18.5, z: 17, face: 'n', img: 'meadow' }, { x: 32.5, z: 17, face: 'n', img: 'bridge' },
  ],
};
// 窗戶（牆格）：dir 是窗外的方向（n 北、s 南）；train 是列車的窗（掛窗簾、列車停下來時外面會貼著眼睛）
const W3_WINDOWS = [];
const winRow = (y, dir, xs, train) => { for (const x of xs) W3_WINDOWS.push({ x, y, dir, train }); };
winRow(4, 'n', [12, 15, 18, 21, 24, 27, 31, 34, 37, 40, 45, 47, 49, 51, 53, 55], true);
winRow(12, 's', [12, 15, 22, 25, 31, 38, 41, 45, 47, 53, 55], true);
winRow(24, 's', [19, 22, 25, 28, 31], false);   // 候車室的南牆
winRow(17, 'n', [21, 29], false);               // 候車室看月台的窗
// 家具（全部重新擺）。pax: true 的座位上坐著死去的乘客（寫實、每個都不一樣；設計師要椅子上和餐桌椅上都要有）；
// paxAt 是乘客坐在家具的哪幾格（[dx, dy]，沒寫就照 paxSpots 的規則）；ladder 的 up 是爬上去之後站的車頂格子
// 普通車廂的座位一組 2×2：靠窗一排、靠走道一排，面向車頭；北側的靠窗排是 dy=0、南側的是 dy=1
const seats3 = (id, x, y, o = {}) => ({ id, type: 'seats', name: '座位', x, y, w: 2, h: 2, ...o });
const FURN_W3 = [
  // 機車室：車頭是開車的：駕駛台（可以拉汽笛）、鍋爐管線、發電機（停電事件變成發電機跳掉）、火爐（早晨禮物放在旁邊）、煤堆、修車工具台
  { id: 'throttle', type: 'throttle', name: '駕駛台', x: 1, y: 5, w: 3, h: 1 },
  { id: 'pipes', type: 'pipes', x: 5, y: 5, w: 3, h: 1 },
  { id: 'breaker', type: 'breaker', name: '發電機', x: 8, y: 5, w: 1, h: 1 },
  { id: 'firebox', type: 'firebox', name: '火爐', x: 1, y: 8, w: 2, h: 2 },
  { id: 'coal1', type: 'coalpile', name: '煤堆', x: 4, y: 11, w: 2, h: 1, loot: 'coal' },
  { id: 'workbench', type: 'workbench', name: '修車工具台', x: 7, y: 11, w: 2, h: 1 },
  // 普通車廂：車頭那一頭堆著裝木柴的木箱和行李，走道兩側一排排的座位（大部分坐著死去的乘客），椅墊底下塞著舊報紙；車尾那一頭有工具櫃和爬梯
  { id: 'crates', type: 'crates3', name: '木箱', x: 10, y: 5, w: 2, h: 2, loot: 'fuel' },
  { id: 'trunksC', type: 'trunks', name: '行李箱', x: 10, y: 11, w: 1, h: 1, loot: 'luggage' },
  seats3('seatN1', 12, 5, { pax: true, paxAt: [[0, 0], [1, 1]] }), seats3('seatN2', 15, 5, { loot: 'cushions' }), seats3('seatN3', 18, 5, { pax: true, paxAt: [[0, 0]] }),
  seats3('seatN4', 21, 5, { pax: true, paxAt: [[0, 0], [1, 1]] }), seats3('seatN5', 24, 5, { loot: 'cushions', pax: true, paxAt: [[1, 0]] }),
  seats3('seatS1', 12, 10, { pax: true, paxAt: [[0, 1], [1, 0]] }), seats3('seatS2', 15, 10, { loot: 'cushions' }),
  seats3('seatS3', 21, 10, { pax: true, paxAt: [[0, 1]] }), seats3('seatS4', 24, 10, { pax: true, paxAt: [[0, 1], [1, 0]] }),
  { id: 'toolcab', type: 'cabinet', name: '工具櫃', x: 27, y: 5, w: 1, h: 1, loot: 'tool' },
  { id: 'ladder1', type: 'ladder', name: '爬梯', x: 27, y: 11, w: 1, h: 1, up: { x: 27, y: 2 } },
  // 餐車：廚房那一頭有抽屜（第 1 天一定有平底鍋）、爐子、水槽、冰櫃、餐具櫃；餐廳那一頭是鋪白桌布的餐桌，全部靠窗擺，中間的走道空著
  // （餐桌一組三格：兩端是椅子、中間是桌子；椅子上坐著面對面死去的乘客）
  { id: 'kdrawer', type: 'counter', name: '餐車抽屜', x: 29, y: 5, w: 3, h: 1, loot: 'general' },
  { id: 'stove', type: 'stove', x: 32, y: 5, w: 2, h: 1 },
  { id: 'ksink', type: 'sink', x: 34, y: 5, w: 2, h: 1 },
  { id: 'icebox', type: 'icebox', name: '冰櫃', x: 29, y: 10, w: 1, h: 2, loot: 'food' },
  { id: 'kcab', type: 'cabinet', name: '餐具櫃', x: 31, y: 11, w: 3, h: 1, loot: 'food' },
  { id: 'dtable1', type: 'dining', name: '餐桌', x: 36, y: 5, w: 3, h: 1, pax: true },
  { id: 'dtable2', type: 'dining', name: '餐桌', x: 39, y: 5, w: 3, h: 1, pax: true },
  { id: 'dtable3', type: 'dining', name: '餐桌', x: 36, y: 11, w: 3, h: 1, pax: true },
  { id: 'dtable4', type: 'dining', name: '餐桌', x: 39, y: 11, w: 3, h: 1 },
  { id: 'liquorD', type: 'liquor', name: '酒櫃', x: 42, y: 5, w: 1, h: 1, loot: 'bar' },
  // 景觀車廂（最後一節）：大窗戶、絨布沙發、靠窗的小圓桌、留聲機櫃、雜誌架、對講機；你從這裡開始。
  // 原本臥鋪的床、床頭櫃、衣物櫃搬到這裡的南側；車尾那一頭有爬梯
  { id: 'armchairA', type: 'passenger', name: '扶手椅', x: 44, y: 5, w: 1, h: 1, pax: true },
  { id: 'sofa', type: 'seat3', name: '絨布沙發', x: 45, y: 5, w: 4, h: 1, loot: 'cushions', pax: true },
  { id: 'ctable', type: 'table3', name: '小圓桌', x: 49, y: 5, w: 1, h: 1 },
  { id: 'gramocab', type: 'gramocab', name: '留聲機櫃', x: 51, y: 5, w: 3, h: 1, loot: 'general' },
  { id: 'magrack', type: 'rack', name: '雜誌架', x: 56, y: 5, w: 2, h: 1, loot: 'general' },
  { id: 'rug1', type: 'rug', x: 46, y: 7, w: 6, h: 3, solid: false, color: '#1f3d2e', deco: true },
  { id: 'ladder2', type: 'ladder', name: '爬梯', x: 57, y: 6, w: 1, h: 1, up: { x: 57, y: 2 } },
  { id: 'armchairB', type: 'passenger', name: '扶手椅', x: 44, y: 11, w: 1, h: 1, pax: true },
  { id: 'sofa2', type: 'seat3', name: '絨布長椅', x: 45, y: 11, w: 3, h: 1, pax: true },
  { id: 'ctable2', type: 'table3', name: '小圓桌', x: 48, y: 11, w: 1, h: 1 },
  { id: 'bed', type: 'bed', name: '床', x: 52, y: 11, w: 2, h: 1 },
  { id: 'nightstand', type: 'cabinet', name: '床頭櫃', x: 54, y: 11, w: 1, h: 1, loot: 'luggage' },
  { id: 'closet', type: 'closet', name: '衣物櫃', x: 55, y: 11, w: 1, h: 1, loot: 'clothes' },
  { id: 'phone', type: 'phone', name: '對講機', x: 57, y: 11, w: 1, h: 1 },
  // 車頂：兩個艙口（爬回車廂）、一個掉在車頂的行李箱
  { id: 'hatch1', type: 'hatch', name: '艙口', x: 27, y: 2, w: 1, h: 1, solid: false },
  { id: 'hatch2', type: 'hatch', name: '艙口', x: 57, y: 2, w: 1, h: 1, solid: false },
  { id: 'rooftrunk', type: 'trunks', name: '掉在車頂的行李箱', x: 40, y: 3, w: 1, h: 1, loot: 'luggage' },
  // 月台（露天，上面只有藍天白雲）：木堆、站牌、煤氣燈、長椅、行李、煤袋；神秘商人白天在景觀車廂的車門外面擺攤
  { id: 'woodpile', type: 'woodpile', name: '木堆', x: 11, y: 13, w: 2, h: 2, loot: 'fuel' },
  { id: 'sign', type: 'sign', name: '站牌', x: 15, y: 16, w: 2, h: 1 },
  { id: 'gaslamp1', type: 'gaslamp', x: 21, y: 16, w: 1, h: 1 },
  { id: 'gaslamp2', type: 'gaslamp', x: 37, y: 16, w: 1, h: 1 },
  { id: 'gaslamp3', type: 'gaslamp', x: 53, y: 16, w: 1, h: 1 },
  { id: 'pbench1', type: 'bench3', name: '長椅', x: 27, y: 16, w: 3, h: 1, loot: 'station' },
  { id: 'pbench2', type: 'bench3', name: '長椅', x: 44, y: 16, w: 3, h: 1, loot: 'station' },
  { id: 'trunksG', type: 'trunks', name: '行李箱', x: 32, y: 13, w: 2, h: 1, loot: 'luggage' },
  { id: 'cartB', type: 'cart', name: '行李推車', x: 54, y: 13, w: 2, h: 2, loot: 'luggage' },
  { id: 'coalsack', type: 'coalsack', name: '煤袋', x: 56, y: 15, w: 2, h: 2, loot: 'coal' },
  // 候車室：時刻表、售票口、電報機、雜物架、候車長椅（坐著死去的乘客）、行李架、檔案櫃、幸運機、煤袋
  { id: 'timetable', type: 'timetable', x: 19, y: 18, w: 2, h: 1 },
  { id: 'ticket', type: 'ticket', name: '售票口', x: 27, y: 18, w: 4, h: 1, loot: 'station' },
  { id: 'telegraph', type: 'telegraph', name: '電報機', x: 31, y: 18, w: 2, h: 1, loot: 'general' },
  { id: 'oshelf', type: 'shelf', name: '雜物架', x: 33, y: 18, w: 2, h: 1, loot: 'tool' },
  { id: 'wbench3', type: 'bench3', name: '長椅', x: 17, y: 20, w: 1, h: 3, loot: 'station' },
  { id: 'wbench1', type: 'benches', name: '候車長椅', x: 20, y: 20, w: 5, h: 1, loot: 'cushions', pax: true },
  { id: 'wbench2', type: 'benches', name: '候車長椅', x: 27, y: 22, w: 5, h: 1, loot: 'cushions', pax: true },
  { id: 'filecab', type: 'cabinet', name: '檔案櫃', x: 34, y: 19, w: 1, h: 1, loot: 'tool' },
  { id: 'srack', type: 'rack', name: '行李架', x: 34, y: 21, w: 1, h: 2, loot: 'luggage' },
  { id: 'gacha', type: 'gacha', name: '幸運機', x: 34, y: 23, w: 1, h: 1 },
  { id: 'coalsack2', type: 'coalsack', name: '煤袋', x: 18, y: 23, w: 2, h: 1, loot: 'coal' },
];
// 第三世界的電池比較多（設計師說手電筒的電不夠用）：物資表裡電池的權重乘上這個倍數
const BATTERY_BOOST_W3 = 2.5;

// ====================================================================
// 站上家具、坐下、躺下（通用：哪個世界都一樣，照家具的 type 查表）
// FURN_TOP_H：家具頂面的高度（公尺）。在這張表裡的家具，跳起來（腳的高度 G.p.z 高過它）就能站上去，走下去會掉下來；
//   值可以是數字，或是 (f, dx, dy) => 高度 的函式（dx、dy 是家具裡的第幾格；回傳 null 表示那一格站不上去）。
//   要讓新的家具可以站上去：在這裡加一行 type: 高度 就好。
// 座位上的乘客（paxSpots）頭頂一律是 PAX_HEAD_H，也可以站上去。
// FURN_SIT：可以坐的家具（face 是坐下時面向哪邊：'n'／'s'／'e'／'w'，沒寫就面向家具的正面；tiles 可以指定哪幾格能坐和各自的方向）
// FURN_LIE：可以躺的家具（床）。坐和躺的高度就是那一格的 FURN_TOP_H
// ====================================================================
const PAX_HEAD_H = 1.25;
const FURN_TOP_H = {
  seats: 0.52, seat3: 0.48, passenger: 0.42, bench3: 0.46, benches: 0.46,
  dining: (f, dx) => (dx === 0 || dx === f.w - 1 ? 0.45 : 0.78),   // 兩端是椅子、中間是桌子
  table3: 0.75, telegraph: 0.78, bed: 0.56, trunks: 0.5, crates3: 0.75,
  // 第四世界的家具（賣場）
  chair4: 0.46, armchair: 0.44, sofa4: 0.44, coffee4: 0.45, table4: 0.77, desk4: 0.76, bed4: 0.55, bunk4: 0.5, nightstand4: 0.55,
  toybox: 0.5, crate4: 0.92, sideboard4: 0.8, cart4: 0.9,
};
const FURN_SIT = {
  seats: { face: 'w' },                                                  // 普通車廂的座位都面向車頭
  seat3: {}, passenger: {}, bench3: {}, benches: {},
  dining: { tiles: (f, dx) => (dx === 0 ? 'e' : dx === f.w - 1 ? 'w' : null) },   // 餐桌兩端的椅子，面向桌子
  chair4: {}, armchair: {}, sofa4: {},
};
const FURN_LIE = { bed: {}, bed4: {}, bunk4: {} };
// 乘客坐在家具的哪幾格（[dx, dy]）：家具的 paxAt 優先，不然照 type 的規則（跟 3D 畫面擺乘客的位置一樣）
function paxSpots(f) {
  if (!f.pax) return [];
  if (f.paxAt) return f.paxAt;
  const L = Math.max(f.w, f.h), along = u => (f.w >= f.h ? [Math.floor(u), 0] : [0, Math.floor(u)]);
  if (f.type === 'dining') return [[0, 0], [f.w - 1, 0]];
  if (f.type === 'seat3') return L >= 4 ? [along(L * 0.3), along(L * 0.72)] : [along(L * 0.3)];
  if (f.type === 'bench3' || f.type === 'benches') return [along(L * 0.25), along(L * 0.78)];
  return [[0, 0]];
}
// 家具某一格（dx、dy）頂面的高度；null 表示站不上去
function furnTopH(f, dx, dy) {
  if (f.pax && paxSpots(f).some(s => s[0] === dx && s[1] === dy)) return PAX_HEAD_H;
  const h = FURN_TOP_H[f.type];
  if (h === undefined) return null;
  return typeof h === 'function' ? h(f, dx, dy) : h;
}
const FURN_W1 = FURN.map(f => ({ ...f }));
function furnForWorld(w) {
  if (w === 3) return FURN_W3.map(f => ({ ...f }));
  if (w === 4) return W4MAP.furn.map(f => ({ ...f }));
  return FURN_W1.map(f => ({ ...f, ...(w === 2 ? FURN_W2[f.id] || {} : {}) }));
}
const doorsForWorld = w => (w === 4 ? W4MAP.doors : w === 3 ? DOORS_W3 : DOORS_HOUSE).map(d => ({ ...d }));
const socketsForWorld = w => (w === 4 ? [] : w === 3 ? SOCKETS_W3 : SOCKETS_HOUSE).map(s => ({ ...s }));   // 第四世界沒有天花板燈座：燈泡全變檯燈
// 賣場裡面的牆格（柱子、樣品間的牆、小房間的牆）：第四世界才有，buildMap 在房間之後、門之前放
const wallsForWorld = w => (w === 4 ? W4MAP.walls : []);

// 寶箱四級：每天早上在車站三間重新放；打開是賭：可能是物資，也可能跳出怪物（等級越高東西越好、怪物越強）
const CHESTS3 = [null,
  { name: '櫃箱',   hold: 1, keys: 0, monster: 0.10 },
  { name: '鐵寶箱', hold: 2, keys: 0, monster: 0.20 },
  { name: '銀寶箱', hold: 2, keys: 1, monster: 0.30 },
  { name: '鉑寶箱', hold: 3, keys: 2, monster: 0.40 },
];
// 火爐一次最多放幾份燃料；火熄了幾秒後列車停下來；補燃料後幾秒重新開動
const FUEL_SLOTS = 4, TRAIN_STOP_DELAY = 5, TRAIN_RESTART = 4;
// 12 夜裡：第 6 夜紅月；第 3、7、10、12 天是寒寂之境（整天下雪、零下 100 度，多了體溫）
const RED_MOON_NIGHT = 6, COLD_DAYS = [3, 7, 10, 12];
// 每天停靠的車站名字，最後一站是終點站；晚上窗外的風景照天數換
const STATIONS_W3 = ['霧濱', '鐵橋頭', '白樺站', '凍湖', '舊礦坑', '黑森林', '雪嶺', '廢棄驛站', '長隧道口', '冰河', '燈火鎮', '終點站'];
// 窗外主要是夢核風的山和開滿花的草原（plain），寒寂之境那幾天是雪原
const SCENERY_W3 = ['plain', 'plain', 'snow', 'plain', 'bridge', 'plain', 'snow', 'trees', 'tunnel', 'snow', 'city', 'snow'];
const BAYMAX_MAX = 2;   // 整個遊戲最多拿到幾顆大白燈

// ====================================================================
// 第四世界：3008 無盡賣場（照 Roblox 的《3008》：一間走不完的家具賣場，白天燈亮、晚上燈熄，沒有臉的店員出來巡邏）
// 地圖 60×44：整間賣場是一個大房間（store），西南角的洗手間、東南角的員工專用區有門、有自己的天花板（ceil）。
// 樣品間是三面有牆、一面開向走道的展示間；柱子每隔幾格一根；主走道是十字形（x 29～30、y 21～22）
// 房子要自己蓋：板子放在格子的邊上（world4.js）；家具大部分可以搬（FURN4 的 move）
// ====================================================================
const CEIL_W4 = 6.2;      // 賣場的天花板高度（設計師：天花板太低 → 6.2 公尺；小房間是一般的 2.7）
const ROOF4_H = 2.6;      // 自己蓋的牆有多高、屋頂（躺平的板子）放多高
// 板子五級（設計師：木頭、水泥、黃金、岩漿、玻璃；普通、稀有、史詩、傳奇、神話）。hp 是怪物要打多久才打得破（玻璃打不破）
const PLANKS = [null,
  { key: 'wood',   name: '木頭板子', rar: 'common', hp: 40,  price: 2,  color: '#b08458', desc: '最常見的板子。被酸雨淋到會慢慢腐蝕。' },
  { key: 'cement', name: '水泥板子', rar: 'rare',   hp: 100, price: 4,  color: '#e8e4dc', desc: '像普通人家裡的白色牆壁，比木頭耐打很多。' },
  { key: 'gold',   name: '黃金板子', rar: 'epic',   hp: 200, price: 8,  color: '#e2b23c', desc: '閃閃發亮的金屬板，非常耐打。' },
  { key: 'lava',   name: '岩漿板子', rar: 'legend', hp: 320, price: 14, color: '#5a2414', desc: '黑色岩石裡流著岩漿：會發光、旁邊 2 格很溫暖，怪物打它會被燙到。' },
  { key: 'glass',  name: '玻璃板子', rar: 'mythic', hp: Infinity, price: 20, color: '#cfe8f0', desc: '透明的強化玻璃：看得清外面、光透得過去，怪物完全打不破。' },
];
const PLANK_MAX = PLANKS.length - 1, GLASS_TIER = 5, LAVA_TIER = 4;
// 貨架的高度和每一層的高度（3D 模型和 world4.js 擺真的東西的位置共用）：倉儲貨架 5.2 公尺（設計師：鐵架太矮了）
const RACK4_H = 5.2, RACK4_LEVELS = [0.12, 1.3, 2.5, 3.7, 4.85];
const GOODS4_H = 2.15, GOODS4_LEVELS = [0.12, 0.6, 1.08, 1.56, 2.0];
const LAMPSHELF4_LEVELS = [0.1, 0.7, 1.3];
// 真的東西擺在架子上（不是只有一團光，要一個一個拿）：這幾種架子的物資會變成擺在架上的東西（world4.js 的 stockShelves4）
const DISPLAY4 = { rack4: 1, goods4: 1, lampshelf: 1, foodcounter: 1, drink4: 1, coldcase: 1 };
const DOOR_HP = 40;   // 木門跟木頭板子一樣耐打
// 家具：move 可以搬、store 可以收納（櫃子）、solid false 是踩得過去的（地毯、毯子）、fn 是有功能的家具
const FURN4 = {
  sofa4: { name: '布沙發', move: true }, armchair: { name: '單人沙發', move: true }, coffee4: { name: '茶几', move: true },
  tv4: { name: '電視', move: true, fn: 'tv' }, bookcase4: { name: '書櫃', move: true, store: true }, plant4: { name: '盆栽', move: true },
  rug4: { name: '地毯', move: true, solid: false }, blanket4: { name: '毯子', move: true, solid: false, fn: 'blanket' },
  bed4: { name: '雙人床', move: true, fn: 'bed' }, bunk4: { name: '上下鋪', move: true, fn: 'bed' }, nightstand4: { name: '床頭櫃', move: true, store: true },
  wardrobe4: { name: '衣櫃', move: true, store: true }, dresser4: { name: '五斗櫃', move: true, store: true }, toybox: { name: '玩具箱', move: true, store: true },
  desk4: { name: '書桌', move: true }, chair4: { name: '椅子', move: true }, fireplace4: { name: '火爐', move: true, fn: 'fire' }, ladder4: { name: '梯子', move: true },
  table4: { name: '桌子', move: true }, sideboard4: { name: '矮櫃', move: true, store: true }, cart4: { name: '購物車', move: true }, cabinet4: { name: '櫃子', move: true, store: true },
  // 搬不動的
  counter4: { name: '流理台' }, stove4: { name: '爐子' }, sink4: { name: '洗手台' }, fridge4: { name: '冰箱' }, bathtub4: { name: '浴缸' }, toilet4: { name: '馬桶' },
  rack4: { name: '倉儲貨架' }, tvwall4: { name: '電視展示牆' }, goods4: { name: '雜貨架' }, lampshelf: { name: '燈具架' }, bedding4: { name: '寢具架' }, crate4: { name: '紙箱' },
  plankpile: { name: '板材堆' }, foodcounter: { name: '熱食櫃台' }, drink4: { name: '飲料機' }, coldcase: { name: '冷藏櫃' },
  locker4: { name: '員工置物櫃' }, vending4: { name: '販賣機' }, bagrack: { name: '提袋架' }, infodesk: { name: '服務台' },
  breaker: { name: '電箱' }, workbench: { name: '工作台' }, gacha: { name: '扭蛋機' },
};
// 樣品間的擺設（u 從左到右、v 從後面的牆往開口；side：f 朝開口、b 朝後面的牆、l 朝左、r 朝右）
const W4_ROOMS_TMPL = {
  living: { name: '客廳樣品間', wall: '#c9d6c2', floor: 'oak4', items: [['sofa4', 1, 0, 3, 1, 'f'], ['rug4', 1, 1, 3, 2], ['coffee4', 2, 2, 1, 1], ['tv4', 5, 1, 1, 2, 'l'], ['armchair', 0, 2, 1, 1, 'r'], ['plant4', 5, 0, 1, 1], ['bookcase4', 0, 0, 1, 1, 'f', 'store4']] },
  hearth: { name: '壁爐客廳樣品間', wall: '#b9a99a', floor: 'oak4', items: [['fireplace4', 2, 0, 2, 1, 'f'], ['rug4', 2, 1, 2, 2], ['armchair', 1, 2, 1, 1, 'b'], ['armchair', 4, 2, 1, 1, 'b'], ['ladder4', 5, 0, 1, 1, 'f'], ['bookcase4', 0, 0, 1, 2, 'r', 'store4']] },
  bedroom: { name: '臥室樣品間', wall: '#d9c8b4', floor: 'oak4', items: [['bed4', 2, 0, 2, 2, 'f'], ['nightstand4', 1, 0, 1, 1, 'f', 'clothes4'], ['nightstand4', 4, 0, 1, 1, 'f', 'clothes4'], ['wardrobe4', 0, 2, 1, 2, 'r', 'clothes4'], ['dresser4', 5, 1, 1, 2, 'l', 'clothes4'], ['blanket4', 2, 3, 2, 1]] },
  kids: { name: '兒童房樣品間', wall: '#bcd3e6', floor: 'carpet4', items: [['bunk4', 0, 0, 1, 2, 'r'], ['toybox', 2, 0, 1, 1, 'f', 'kids4'], ['desk4', 3, 0, 2, 1, 'f'], ['chair4', 3, 1, 1, 1, 'b'], ['rug4', 2, 2, 2, 2], ['bookcase4', 5, 2, 1, 1, 'l', 'kids4']] },
  study: { name: '書房樣品間', wall: '#c4c6cc', floor: 'oak4', items: [['desk4', 1, 0, 2, 1, 'f', 'store4'], ['chair4', 1, 1, 1, 1, 'b'], ['bookcase4', 4, 0, 2, 1, 'f', 'store4'], ['armchair', 5, 2, 1, 1, 'l'], ['plant4', 0, 0, 1, 1]] },
  bath: { name: '浴室樣品間', wall: '#cfe3e0', floor: 'tile', items: [['bathtub4', 0, 0, 2, 1, 'f'], ['cabinet4', 2, 0, 1, 1, 'f', 'med4'], ['sink4', 3, 0, 1, 1, 'f'], ['toilet4', 5, 0, 1, 1, 'f'], ['rug4', 3, 2, 2, 1]] },
  kitchen: { name: '廚房樣品間', wall: '#e6e1d3', floor: 'tile2', items: [['counter4', 0, 0, 3, 1, 'f', 'food4'], ['stove4', 3, 0, 1, 1, 'f'], ['sink4', 4, 0, 1, 1, 'f'], ['fridge4', 5, 0, 1, 1, 'f', 'food4'], ['table4', 2, 2, 2, 1], ['chair4', 1, 2, 1, 1, 'r'], ['chair4', 4, 2, 1, 1, 'l']] },
  dining: { name: '餐廳樣品間', wall: '#d8b9b0', floor: 'oak4', items: [['sideboard4', 1, 0, 3, 1, 'f', 'store4'], ['chair4', 2, 1, 1, 1, 'f'], ['table4', 1, 2, 3, 1], ['chair4', 0, 2, 1, 1, 'r'], ['chair4', 4, 2, 1, 1, 'l'], ['chair4', 2, 3, 1, 1, 'b'], ['plant4', 5, 0, 1, 1]] },
};
// 賣場的大小和十字主走道的位置（設計師：地圖太小，一下就走到邊邊了 → 100×76，大約是原本的三倍大）
const W4W = 100, W4H = 76, W4AX = 49, W4AY = 37;   // 主走道：x 49～50（南北向）、y 37～38（東西向）
const W4_MAP_VER = 2;   // 賣場的格局改版就加 1：舊存檔蓋的房子沒辦法放回新的地圖（見 world4.js 的 load4）
const W4MAP = (() => {
  const rooms = [
    { id: 'store', name: '賣場', x: 1, y: 1, w: W4W - 2, h: W4H - 2, floor: 'store4', level: 1 },
    { id: 'restroom', name: '洗手間', x: 1, y: 69, w: 6, h: 6, floor: 'tile', level: 1, dayDark: 0.2, ceil: true },
    { id: 'staff', name: '員工專用區', x: 93, y: 69, w: 6, h: 6, floor: 'concrete', level: 2, dayDark: 0.35, ceil: true },
  ];
  const wallSet = new Set(), furn = [], zones = [], floors = [], doors = [], cubes = [];
  const W = (x, y) => wallSet.add(x + ',' + y);
  const hline = (x0, x1, y) => { for (let x = x0; x <= x1; x++) W(x, y); };
  const vline = (x, y0, y1) => { for (let y = y0; y <= y1; y++) W(x, y); };
  const used = new Set();   // 家具佔的格子（柱子要避開）
  let n = 0;
  const F = (type, x, y, w, h, o = {}) => {
    const spec = FURN4[type] || {};
    const f = { id: o.id || type + '_' + (n++), type, name: spec.name, x, y, w, h, ...o };
    if (spec.solid === false) f.solid = false;
    if (spec.move) f.move = true;
    furn.push(f);
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) used.add(xx + ',' + yy);
    return f;
  };
  const Z = (name, x, y, w, h, o = {}) => zones.push({ name, x, y, w, h, ...o });
  // 小房間：洗手間（西南角）、員工專用區（東南角，晚上店員從這裡走出來）
  hline(1, 7, 68); vline(7, 68, 74); doors.push({ x: 7, y: 71 });
  hline(92, 98, 68); vline(92, 68, 74); doors.push({ x: 92, y: 71, staff: true });
  // 入口的玻璃自動門（打不開，門外只有白霧）：敲門事件、破關動畫用的「前門」
  doors.push({ x: W4AX, y: W4H - 1, front: true });
  // 樣品間：interior 是 (x0, y0) 開始 w×h 的格子，open 是開口朝哪邊（s 南、n 北），另外三面是牆
  const cube = (kind, x0, y0, open, w = 6, h = 5) => {
    const t = W4_ROOMS_TMPL[kind], xl = x0 - 1, xr = x0 + w, yt = y0 - 1, yb = y0 + h;
    if (open === 's') { hline(xl, xr, yt); vline(xl, yt, y0 + h - 1); vline(xr, yt, y0 + h - 1); }
    else { hline(xl, xr, yb); vline(xl, y0, yb); vline(xr, y0, yb); }
    Z(t.name, x0, y0, w, h, { cube: kind });
    floors.push({ x: x0, y: y0, w, h, floor: t.floor });
    cubes.push({ kind, x: x0, y: y0, w, h, open, wall: t.wall, name: t.name });
    const sideOf = s => (s === 'f' ? open : s === 'b' ? (open === 's' ? 'n' : 's') : s === 'l' ? 'w' : s === 'r' ? 'e' : undefined);
    for (const [type, u, v, fw, fh, side, loot] of t.items) {
      const y = open === 's' ? y0 + v : y0 + h - v - fh;
      const o = {};
      if (side) o.side = sideOf(side);
      if (loot) o.loot = loot;
      F(type, x0 + u, y, fw, fh, o);
    }
  };
  const row = (kinds, x0, y0, open) => kinds.forEach((k, i) => cube(k, x0 + i * 7, y0, open));
  // 西北的北邊兩間；東北兩排（中間隔一條 3 格寬的走道）；西南四排（兩排背靠背一組）
  row(['kitchen', 'dining'], 32, 1, 's');
  row(['living', 'bedroom', 'kids', 'hearth', 'study', 'bath'], 52, 1, 's');
  row(['study', 'bath', 'bedroom', 'living', 'kitchen', 'kids'], 52, 9, 'n');
  row(['living', 'kitchen', 'bedroom', 'dining', 'kids', 'study'], 2, 40, 'n');
  row(['kids', 'dining', 'study', 'living', 'hearth', 'bath'], 2, 46, 's');
  row(['bedroom', 'kitchen', 'living', 'bath', 'hearth', 'study'], 2, 54, 'n');
  row(['dining', 'bedroom', 'kids', 'living', 'kitchen', 'bedroom'], 2, 60, 's');
  // 第一間廚房的流理台：第 1 天一定有平底鍋（game.js 的 newGame 用 kdrawer 這個 id）
  furn.find(f => f.type === 'counter4').id = 'kdrawer';
  // 自助倉儲區（照 3008）：一排一排 5 公尺高的鐵貨架，中間的走道 4 格寬（設計師：兩個貨櫃間隔太小了、要可以跑跳）；
  // 貨架上堆滿紙箱，貨架旁邊靠著板子、架著梯子
  Z('自助倉儲區', 1, 1, 30, 36);
  const racks = [];
  for (const x of [3, 9, 15, 21, 27]) for (const y of [3, 14, 25]) racks.push(F('rack4', x, y, 2, 8, { side: (x / 6 | 0) % 2 ? 'w' : 'e', loot: 'tools4' }));
  // 板材堆：靠在貨架的頭尾（木頭最多，水泥、黃金少；岩漿、玻璃要靠神秘店員、禮物和偶爾出現的特別板材堆）
  const tiers = [1, 1, 2, 1, 1, 3, 1, 2, 1, 1, 1, 2, 1, 1, 1];
  racks.forEach((r, i) => F('plankpile', r.x + (i % 2), i % 3 === 1 ? r.y + r.h : r.y - 1, 1, 1, { tier: tiers[i], lean: i % 3 === 1 ? 'n' : 's' }));
  for (const [x, y] of [[5, 8], [17, 19], [23, 30], [11, 30], [29, 19]]) F('ladder4', x, y, 1, 1, { side: 'w' });
  for (const [x, y] of [[1, 1], [30, 1], [1, 35], [7, 12], [19, 23], [30, 34], [13, 34]]) F('crate4', x, y, 1, 1, { loot: 'tools4' });
  // 西北的雜貨區：一排一排雙面的貨架（上面是真的商品，可以一個一個拿）
  Z('雜貨區', 31, 7, 18, 30);
  for (const y of [10, 15, 20, 25, 30]) for (const x of [33, 41]) F('goods4', x, y, 5, 1, { side: 's', loot: y % 10 ? 'food4' : 'store4' });
  // 東北的開放展示區：燈具區、電器區（電視）、布料寢具區、沙發區、床墊區
  Z('燈具區', 51, 16, 11, 9);
  for (const [x, y] of [[53, 18], [57, 18], [53, 22], [57, 22]]) F('lampshelf', x, y, 3, 1, { side: 's', loot: 'lamps4' });
  Z('電器區', 63, 16, 12, 9);
  for (const y of [18, 22]) F('tvwall4', 64, y, 4, 1, { side: 's' });
  for (const [x, y] of [[70, 18], [72, 18], [70, 22], [72, 22]]) F('tv4', x, y, 1, 1, { side: 's', on: true });   // 展示機白天開著
  Z('布料寢具區', 75, 16, 12, 9);
  for (const x of [77, 81]) F('bedding4', x, 18, 3, 1, { side: 's', loot: 'clothes4' });
  F('blanket4', 77, 21, 2, 2); F('blanket4', 81, 21, 2, 2);
  Z('沙發區', 51, 27, 24, 10);
  for (const x of [53, 61, 69]) { F('sofa4', x, 28, 3, 1, { side: 's' }); F('coffee4', x + 1, 30, 1, 1); F('armchair', x - 1, 30, 1, 1, { side: 'e' }); F('armchair', x + 3, 30, 1, 1, { side: 'w' }); }
  F('sofa4', 56, 34, 3, 1, { side: 'n' }); F('sofa4', 64, 34, 3, 1, { side: 'n' }); F('plant4', 73, 28, 1, 1); F('plant4', 51, 35, 1, 1);
  Z('床墊區', 76, 27, 23, 10);
  for (const x of [77, 82, 87, 92]) { F('bed4', x, 28, 2, 2, { side: 's' }); F('bed4', x, 33, 2, 2, { side: 'n' }); }
  F('nightstand4', 79, 28, 1, 1, { side: 's', loot: 'clothes4' }); F('nightstand4', 94, 33, 1, 1, { side: 'n', loot: 'clothes4' });
  Z('書櫃區', 88, 16, 11, 9);
  for (const x of [89, 92, 95]) F('bookcase4', x, 17, 2, 1, { side: 's', loot: 'store4' });
  F('desk4', 90, 21, 2, 1, { side: 's' }); F('chair4', 90, 22, 1, 1, { side: 'n' }); F('ladder4', 97, 21, 1, 1, { side: 'w' });
  // 西南：樣品間旁邊的貨架
  Z('雜貨區', 44, 39, 5, 28);
  for (const y of [41, 47, 55, 61]) F('goods4', 46, y, 1, 4, { side: 'e', loot: 'food4' });
  // 東南：餐桌展示、美食區（食物主要在這裡）、冷凍食品區
  Z('餐桌區', 51, 39, 14, 14);
  for (const [x, y] of [[53, 41], [59, 41], [53, 46], [59, 46], [53, 50], [59, 50]]) { F('table4', x, y, 2, 1); F('chair4', x - 1, y, 1, 1, { side: 'e' }); F('chair4', x + 2, y, 1, 1, { side: 'w' }); }
  F('cabinet4', 64, 40, 1, 1, { side: 'w', loot: 'store4' }); F('sideboard4', 56, 52, 3, 1, { side: 'n', loot: 'store4' });
  Z('美食區', 66, 39, 24, 28);
  F('foodcounter', 67, 39, 4, 1, { side: 's', loot: 'food4' }); F('drink4', 72, 39, 1, 1, { side: 's', loot: 'drink4' }); F('drink4', 73, 39, 1, 1, { side: 's', loot: 'drink4' });
  F('coldcase', 75, 39, 2, 1, { side: 's', loot: 'food4' }); F('foodcounter', 78, 39, 4, 1, { side: 's', loot: 'food4' }); F('coldcase', 83, 39, 2, 1, { side: 's', loot: 'food4' });
  F('drink4', 86, 39, 1, 1, { side: 's', loot: 'drink4' });
  for (let y = 44; y <= 62; y += 6) for (let x = 68; x <= 84; x += 6) { F('table4', x, y, 2, 1); F('chair4', x - 1, y, 1, 1, { side: 'e' }); F('chair4', x + 2, y, 1, 1, { side: 'w' }); }
  Z('冷凍食品區', 90, 39, 9, 29);
  for (const y of [41, 46, 51, 56, 61]) F('coldcase', 97, y, 1, 3, { side: 'w', loot: 'food4' });
  for (const y of [43, 53]) F('goods4', 92, y, 1, 4, { side: 'e', loot: 'food4' });
  // 入口（南邊中間）：購物車、提袋架、服務台、扭蛋機
  Z('入口', 40, 66, 21, 9);
  F('cart4', 41, 72, 1, 1); F('cart4', 42, 72, 1, 1); F('cart4', 43, 71, 1, 1); F('cart4', 57, 72, 1, 1);
  F('bagrack', 53, 73, 2, 1, { side: 'n', loot: 'store4' }); F('infodesk', 55, 68, 2, 1, { side: 's', loot: 'store4' });
  F('gacha', 58, 73, 1, 1, { id: 'gacha' });
  Z('收銀區', 8, 66, 32, 9);
  for (const x of [12, 18, 24, 30]) F('counter4', x, 70, 3, 1, { side: 's' });
  // 洗手間、員工專用區（電箱、工作台、置物櫃、販賣機）
  Z('洗手間', 1, 69, 6, 6);
  F('toilet4', 1, 74, 1, 1, { side: 'n' }); F('toilet4', 3, 74, 1, 1, { side: 'n' }); F('sink4', 2, 69, 1, 1, { side: 's' }); F('sink4', 4, 69, 1, 1, { side: 's' });
  F('cabinet4', 6, 74, 1, 1, { side: 'n', loot: 'med4' });
  Z('員工專用區', 93, 69, 6, 6);
  F('breaker', 98, 69, 1, 1, { id: 'breaker', side: 'w' }); F('workbench', 94, 69, 2, 1, { id: 'workbench', side: 's' });
  F('locker4', 93, 74, 2, 1, { side: 'n', loot: 'clothes4' }); F('vending4', 98, 74, 1, 1, { side: 'n', loot: 'food4' });
  F('table4', 95, 72, 2, 1);
  Z('主走道', W4AX, 1, 2, W4H - 2, { aisle: true }); Z('主走道', 1, W4AY, W4W - 2, 2, { aisle: true });
  floors.push({ x: W4AX, y: 1, w: 2, h: W4H - 2, floor: 'aisle4' }, { x: 1, y: W4AY, w: W4AX - 1, h: 2, floor: 'aisle4' }, { x: W4AX + 2, y: W4AY, w: W4W - W4AX - 3, h: 2, floor: 'aisle4' });
  // 柱子（3008 那種方形的灰色水泥柱）：放在空地上，旁邊不能是牆或家具，也不能在主走道上
  const freeAt = (x, y) => !wallSet.has(x + ',' + y) && !used.has(x + ',' + y) && x > 0 && y > 0 && x < W4W - 1 && y < W4H - 1 && x !== W4AX && x !== W4AX + 1 && y !== W4AY && y !== W4AY + 1 && !doors.some(d => d.x === x && d.y === y);
  for (let x = 6; x < W4W - 2; x += 8) for (let y = 6; y < W4H - 2; y += 8) {
    let ok = true;
    for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) if (!freeAt(x + dx, y + dy)) { ok = false; break; }
    if (ok && !(x >= W4AX - 6 && x <= W4AX + 7 && y >= W4H - 9)) W(x, y);   // 入口前面留空
  }
  const walls = [...wallSet].map(k => k.split(',').map(Number));
  return { rooms, walls, doors, furn, zones, floors, cubes };
})();
// 第四世界的固定位置：起點（入口，面向北邊）、晚上店員從員工專用區走出來的地方、墮落戰神在主走道巡邏的四個端點
const W4 = {
  start: { x: W4AX + 0.5, y: W4H - 3.5, face: -Math.PI / 2 },
  staffOut: { x: 91.5, y: 71.5 },
  patrol: [{ x: W4AX + 0.5, y: 1.5 }, { x: W4AX + 0.5, y: W4H - 2.5 }, { x: 1.5, y: W4AY + 0.5 }, { x: W4W - 1.5, y: W4AY + 0.5 }],
  starterPlanks: [[W4AX - 1.5, W4H - 5.5], [W4AX - 1, W4H - 5.5], [W4AX + 2.5, W4H - 5.5], [W4AX + 3, W4H - 5.5]],   // 新遊戲送的 4 片木頭板子（放在入口旁邊的地上）
};
// 天氣：紅月（2 天）、寒寂之境（4 天）、酸雨（每局隨機 2～3 次，開新遊戲時排好）
const RED_MOON_W4 = [5, 11], COLD_DAYS_W4 = [3, 6, 9, 12];
const BAG_SLOTS = 16;   // 第四世界的背包只有 16 格（一種東西一格），手上另外可以拿 1 個
