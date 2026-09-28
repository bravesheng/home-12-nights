'use strict';
// ===== 遊戲資料：地圖、家具、物品、燈泡 =====

const TILE = 32;
const MAP_W = 44, MAP_H = 33;

// 房間（格子座標，含邊界）。level 越高，找到的燈泡越好
const ROOMS = [
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

// 門（放在牆上的格子）
const DOORS = [
  { x: 5, y: 10 }, { x: 16, y: 10 }, { x: 27, y: 10 }, { x: 38, y: 10 },
  { x: 5, y: 14 }, { x: 19, y: 14 }, { x: 20, y: 14 }, { x: 35, y: 14 },
  { x: 5, y: 25 }, { x: 22, y: 25 }, { x: 37, y: 25 },
  { x: 0, y: 12, front: true },
];

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
const MERCHANT_POS = { x: 11.5, y: 29.3 };   // 神秘商人白天站在地下室
const GIFT_POS = { x: 25.5, y: 3.5 };        // 早晨禮物放在臥室床邊

// 天花板燈座（每個房間固定的燈位）
const SOCKETS = [
  { id: 's_living', x: 20, y: 19 }, { id: 's_kitchen', x: 35, y: 18 }, { id: 's_storage', x: 6, y: 19 },
  { id: 's_hall1', x: 9, y: 12 }, { id: 's_hall2', x: 21, y: 12 }, { id: 's_hall3', x: 33, y: 12 },
  { id: 's_bedroom', x: 28, y: 5 }, { id: 's_bathroom', x: 38, y: 5 }, { id: 's_study', x: 17, y: 7 },
  { id: 's_attic', x: 5, y: 5 }, { id: 's_basement', x: 8, y: 28 }, { id: 's_garage', x: 20, y: 29 },
  { id: 's_laundry', x: 37, y: 29 },
];

// 燈泡：第 1～11 級越後面越亮；第 12、13 級是有特殊能力的燈泡
const BULBS = [null,
  { name: '破爛燈泡',     r: 3.0,  color: [255, 150, 70],  desc: '又暗又會閃，晚上隨時可能燒壞。' },
  { name: '省電燈泡',     r: 3.8,  color: [255, 226, 150], desc: '穩定的暖黃光，偶爾會燒壞。' },
  { name: 'LED 燈泡',     r: 4.6,  color: [235, 245, 255], desc: '明亮白光，不會燒壞，能擋住「它」。' },
  { name: '水晶燈泡',     r: 5.4,  color: [190, 240, 255], desc: '晶瑩剔透，掛著水晶墜飾。' },
  { name: '黃金皇家燈泡', r: 6.2,  color: [255, 205, 80],  desc: '金色光芒四射的皇家燈泡。' },
  { name: '藍鑽石燈泡',   r: 7.0,  color: [80, 160, 255],  desc: '藍鑽石切面折射出深海般的光。' },
  { name: '紅鑽石燈泡',   r: 7.8,  color: [255, 70, 100],  desc: '紅鑽石燃燒般的光輝。' },
  { name: '紫鑽石燈泡',   r: 8.6,  color: [190, 90, 255],  desc: '神秘的紫鑽石，光芒極為罕見。' },
  { name: '七彩鑽石燈泡', r: 9.5,  color: 'rainbow',       desc: '不斷變換七種顏色的傳說鑽石。' },
  { name: '火焰燈泡',     r: 10.8, color: [255, 120, 30],  desc: '燈泡裡封印著永不熄滅的火焰。' },
  { name: '星空燈泡',     r: 12,   color: [170, 195, 255], desc: '深藍色的燈泡裡有星星一閃一閃，照得最遠。' },
  { name: '天使燈泡',     r: 3.2,  color: [255, 236, 190], special: 'angel', desc: '燈泡裡住著小天使，晚上會飛出去打怪物（停電也會）；但燈光比較暗。' },
  { name: '粘液燈泡',     r: 0,    color: [120, 230, 90],  special: 'slime', noLight: true, desc: '不會發光，但會流出一灘黏液，走進黏液的怪物都會變得很慢。' },
];
const MAX_TIER = BULBS.length - 1;
const FIRE_TIER = 10, STAR_TIER = 11, ANGEL_TIER = 12, SLIME_TIER = 13;
const NORMAL_MAX = STAR_TIER;                 // 一般燈泡的最高級（合成、升級到這裡為止）
const isSpecialBulb = t => !!(BULBS[t] && BULBS[t].special);
const BULB_PRICE = [0, 1, 2, 3, 4, 6, 8, 10, 13, 16, 20, 26, 22, 18];

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
  noodles:  { name: '泡麵',   kind: 'food', icon: '🍜', hunger: 35, san: 5, desc: '飽食 +35、理智 +5' },
  cocoa:    { name: '熱可可', kind: 'food', icon: '☕', hunger: 10, san: 30, desc: '理智 +30、飽食 +10' },
  bandage:  { name: '繃帶',   kind: 'food', icon: '🩹', hp: 25, desc: '生命 +25' },
  medkit:   { name: '急救箱', kind: 'food', icon: '💊', hp: 60, desc: '生命 +60' },
};
for (let t = 1; t <= MAX_TIER; t++) {
  ITEMS['bulb' + t] = { name: BULBS[t].name, kind: 'bulb', tier: t, desc: (BULBS[t].special ? '特殊燈泡。' : `第 ${t} 級。`) + BULBS[t].desc };
}
ITEMS.key = { name: '鑰匙', kind: 'key', icon: '🗝️', desc: '走到上鎖的寶箱前按 E 就能打開。' };
ITEMS.coin = { name: '硬幣', kind: 'coin', icon: '🪙', desc: '可以跟神秘商人買東西，或投扭蛋機。' };
const ITEM_ORDER = [
  'bulb' + SLIME_TIER, 'bulb' + ANGEL_TIER,
  ...Array.from({ length: NORMAL_MAX }, (_, i) => 'bulb' + (NORMAL_MAX - i)),
  'key', 'lamp_chand', 'lamp_floor', 'lamp_desk', 'battery', 'candle',
  'cocoa', 'canned', 'noodles', 'snack', 'medkit', 'bandage',
];

// 物資表（權重）
const LOOT = {
  general:  { bulb: 4, battery: 2.5, candle: 2, snack: 2, lamp_desk: 1.2, lamp_floor: 0.5, noodles: 1, coin: 3, key: 0.25 },
  food:     { snack: 5, canned: 3, noodles: 3, cocoa: 2, coin: 1 },
  medicine: { bandage: 4, medkit: 1, cocoa: 1.5, battery: 1, coin: 1 },
  tool:     { bulb: 4, battery: 3, lamp_floor: 1.2, candle: 1, lamp_desk: 1, coin: 2, key: 0.35 },
  antique:  { bulb: 5, lamp_chand: 1, lamp_floor: 1.5, candle: 1, medkit: 0.8, coin: 3, key: 0.6 },
  clothes:  { battery: 2, candle: 2, snack: 1, bulb: 2, bandage: 1, cocoa: 0.8, coin: 3 },
};
