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

// 門（放在牆上的格子）。DOORS 是現在這個世界用的清單，換世界時由 doorsForWorld 重新填
const DOORS_BASE = [
  { x: 5, y: 10 }, { x: 16, y: 10 }, { x: 27, y: 10 }, { x: 38, y: 10 },
  { x: 5, y: 14 }, { x: 19, y: 14 }, { x: 20, y: 14 }, { x: 35, y: 14 },
  { x: 5, y: 25, station: true }, { x: 22, y: 25, station: true }, { x: 37, y: 25, station: true },
  { x: 0, y: 12, front: true },
];
const DOORS = [...DOORS_BASE];

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

// 燈泡稀有度：1～5 級稀有、沒有技能的 6 級以上史詩、有技能的傳奇（火焰、天使、粘液、回血）
const RARITY = {
  rare:   { name: '稀有', color: '#4da3ff' },
  epic:   { name: '史詩', color: '#c27bff' },
  legend: { name: '傳奇', color: '#ffc23a' },
};
const bulbRarity = t => (BULBS[t].special || t === FIRE_TIER ? 'legend' : t <= 5 ? 'rare' : 'epic');

// 手電筒三個等級
const FLASH_TIERS = [null,
  { name: '破爛手電筒', short: '破爛', dmg: 1, range: 7.5, half: 0.42, color: '#b9b1a8' },
  { name: '稀有手電筒', short: '稀有', dmg: 2, range: 9, half: 0.42, color: '#4da3ff' },
  { name: '巨光手電筒', short: '巨光', dmg: 3, range: 10.5, half: 0.52, color: '#ffc23a' },
];

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
  'pan', 'slingshot', 'watergun', 'firecracker', 'salt', 'marble', 'holywater', 'strongflash', 'megaflash', 'amulet',
  'bulb' + BAYMAX_TIER, 'bulb' + HEAL_TIER, 'bulb' + SLIME_TIER, 'bulb' + ANGEL_TIER,
  ...Array.from({ length: NORMAL_MAX }, (_, i) => 'bulb' + (NORMAL_MAX - i)),
  'key', 'lamp_chand', 'lamp_floor', 'lamp_desk', 'battery', 'candle',
  'charcoal', 'wood', 'cushion', 'newspaper',
  'cocoa', 'chocolate', 'milk', 'canned', 'noodles', 'snack', 'medkit', 'bandage',
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
  cushions: { cushion: 6, newspaper: 5, coin: 1 },
  bar:      { bulb: 3, cocoa: 2, milk: 2, chocolate: 2, coin: 3, candle: 1, key: 0.3, holywater: 1, lamp_desk: 1 },
  luggage:  { bulb: 3, battery: 2, candle: 1.5, bandage: 1, cocoa: 1.5, chocolate: 1.5, coin: 3, marble: 1.5, newspaper: 1, amulet: 0.2, slingshot: 0.4 },
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
const WORLD_NAMES = { 1: '第一世界：家', 2: '第二世界：夢核花園', 3: '第三世界：末班列車' };
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
// 第三世界：上面一排和走道是列車的車廂，最下面一排是車站（白天才能去，晚上列車開走就鎖門）
const ROOMS_W3 = {
  attic:    { name: '機車室',   floor: 'iron',     dayDark: 0.5 },
  study:    { name: '頭等包廂', floor: 'carpet3' },
  bedroom:  { name: '臥鋪車廂', floor: 'carpet3' },
  bathroom: { name: '盥洗室',   floor: 'tile3' },
  hall:     { name: '車廂走道', floor: 'runner' },
  storage:  { name: '行李車',   floor: 'plank3' },
  living:   { name: '交誼車廂', floor: 'carpet3' },
  kitchen:  { name: '餐車',     floor: 'tile3' },
  basement: { name: '月台',     floor: 'platform', dayDark: 0.15 },
  garage:   { name: '候車室',   floor: 'wood3',    dayDark: 0.3 },
  laundry:  { name: '站務室',   floor: 'plank3',   dayDark: 0.3 },
};
for (const r of ROOMS) {
  const w2 = ROOMS_W2[r.id], w3 = ROOMS_W3[r.id];
  r.w1 = { name: r.name, floor: r.floor, dayDark: r.dayDark };
  r.w2 = { name: w2.name, floor: w2.floor, dayDark: w2.dayDark };
  r.w3 = { name: w3.name, floor: w3.floor, dayDark: w3.dayDark };
}
const STATION_ROOMS = ['basement', 'garage', 'laundry'];   // 車站的三間（最下面一排）
const isStationRoom = r => !!r && STATION_ROOMS.includes(r.id);
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
// 家具可以換種類、換位置、增減（remove: true 就拿掉）；pax: true 的座位上坐著蓋白布的乘客
// ====================================================================
const FURN_W3 = {
  // 交誼車廂（客廳）
  rug1: { type: 'rug', color: '#1f3d2e', deco: true },
  tvcab: { type: 'gramocab', name: '留聲機櫃' },
  sofa: { type: 'seat3', name: '絨布沙發', loot: 'cushions', pax: true },
  ctable: { type: 'table3' },
  bookshelf: { type: 'rack', name: '雜誌架' },
  phone: { name: '對講機' },
  plant1: { type: 'passenger', name: '扶手椅' },
  // 餐車（廚房）
  fridge: { type: 'icebox', name: '冰櫃' },
  kdrawer: { type: 'counter', name: '餐車抽屜' },
  kcab: { type: 'cabinet', name: '餐具櫃' },
  dtable: { type: 'dining', name: '餐桌', pax: true },
  // 行李車（儲藏室）
  sshelf: { type: 'rack', name: '行李架', loot: 'luggage' },
  boxA: { type: 'crates3', name: '木箱', loot: 'fuel' },
  boxB: { type: 'trunks', name: '行李箱堆', loot: 'luggage' },
  toolcab: { type: 'cabinet', name: '工具櫃' },
  workbench: { name: '修車工具台' },
  // 車廂走道
  shoecab: { type: 'trunks', name: '行李箱', loot: 'luggage' },
  plant2: { type: 'trunks', name: '行李箱', loot: 'luggage' },
  // 臥鋪車廂（臥室）
  rug2: { type: 'rug', color: '#5a2c2c', deco: true },
  bed: { name: '臥鋪' },
  nightstand: { type: 'cabinet', name: '床頭櫃', loot: 'luggage' },
  dresser: { type: 'rack', name: '行李架', loot: 'luggage' },
  // 盥洗室（浴室）
  bathtub: { type: 'washstand' },
  // 頭等包廂（書房）
  sbook: { type: 'liquor', name: '酒櫃', loot: 'bar' },
  desk: { type: 'seat3', name: '絨布長椅', loot: null, pax: true },
  filecab: { type: 'minibar', name: '小吧台', loot: 'bar' },
  tchest3: { type: 'gramophone', name: '留聲機', w: 1, h: 1 },
  // 機車室（閣樓）：火爐、煤堆、鍋爐管線；電箱從站務室搬到這裡
  chest1: { type: 'coalpile', name: '煤堆', loot: 'coal' },
  chest2: { type: 'pipes' },
  chest3: { type: 'coalpile', name: '煤堆', loot: 'coal' },
  doll: { remove: true },
  tchest1: { remove: true },
  breaker: { name: '發電機', x: 1, y: 9, w: 1, h: 1 },
  // 月台（地下室）
  oldbox1: { type: 'woodpile', name: '木堆', loot: 'fuel' },
  oldbox2: { type: 'bench3', name: '長椅', loot: 'station' },
  boiler: { type: 'cart', name: '行李推車', loot: 'luggage', x: 15, y: 30, w: 2, h: 2 },
  tchest2: { remove: true },
  // 候車室（車庫）
  toolbox: { type: 'bench3', name: '長椅', loot: 'station' },
  gshelf: { type: 'ticket', name: '售票口', loot: 'station' },
  car: { type: 'benches', name: '候車長椅', loot: 'cushions', pax: true, x: 23, y: 28, w: 5, h: 1 },
  gacha: { name: '幸運機' },
  // 站務室（洗衣間）
  washer: { type: 'telegraph', name: '電報機', loot: 'general' },
  basket: { type: 'coalsack', name: '煤袋', loot: 'coal' },
};
const FURN_W3_ADD = [
  { id: 'firebox', type: 'firebox', name: '火爐', x: 8, y: 4, w: 2, h: 2 },
  { id: 'sign', type: 'sign', name: '站牌', x: 6, y: 31, w: 2, h: 1 },
  { id: 'gaslamp1', type: 'gaslamp', x: 2, y: 26, w: 1, h: 1 },
  { id: 'gaslamp2', type: 'gaslamp', x: 14, y: 31, w: 1, h: 1 },
  { id: 'timetable', type: 'timetable', x: 36, y: 26, w: 2, h: 1 },
  { id: 'srack', type: 'rack', name: '行李架', x: 42, y: 27, w: 1, h: 2, loot: 'luggage' },
];
const FURN_W1 = FURN.map(f => ({ ...f }));
function furnForWorld(w) {
  if (w === 3) {
    const list = [];
    for (const f of FURN_W1) {
      const o = FURN_W3[f.id];
      if (o && o.remove) continue;
      list.push({ ...f, ...(o || {}) });
    }
    return [...list, ...FURN_W3_ADD.map(f => ({ ...f }))];
  }
  return FURN_W1.map(f => ({ ...f, ...(w === 2 ? FURN_W2[f.id] || {} : {}) }));
}
// 第三世界多兩扇門（月台↔候車室、候車室↔站務室），車站才像車站
const DOORS_W3 = [{ x: 17, y: 28 }, { x: 31, y: 28 }];
const doorsForWorld = w => [...DOORS_BASE, ...(w === 3 ? DOORS_W3 : [])];

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
const SCENERY_W3 = ['plain', 'plain', 'snow', 'trees', 'bridge', 'trees', 'snow', 'plain', 'tunnel', 'snow', 'city', 'snow'];
const BAYMAX_MAX = 2;   // 整個遊戲最多拿到幾顆大白燈
