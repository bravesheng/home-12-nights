# 在家生存 12 夜

3D 第一人稱恐怖生存網頁遊戲，主要在 Android 平板上用 Chrome 玩（加到主畫面，可以離線）。純靜態網頁，沒有建置步驟，也沒有 npm 套件。

## 規則

- 遊戲文字、程式註解、commit 訊息和文件都用台灣繁體中文。
- 平板觸控是主要玩法，也要支援電腦鍵盤滑鼠；改操作或介面時兩邊都要顧到。
- 不要改 `lib/`（Three.js 原始檔）。
- 新增遊戲要載入的檔案時，要加進 `sw.js` 的 `ASSETS`（離線快取清單），不然離線會壞掉；script 和 css 還要加進 `index.html`，網址帶 `?v=` 版本號。
- 存檔在 localStorage（`home99_save_v1`、`home99_progress_v1`）。改存檔內容時要能讀舊存檔，不能讓平板上的進度不見。`home99_progress_v1` 放解鎖的世界（`w2`、`w3`、`w4`）、圖鑑見過的怪物（`seen`，`seenInit` 表示舊玩家已經照存檔進度補過）和燈泡圖鑑拿過的東西（`bulbs`、`flash`、`planks`，`gotInit` 表示已經照存檔補過）。第四世界的存檔多一個 `w4`（自己蓋的牆、屋頂、搬過的家具、家、天氣、神秘店員的位置）。
- 角色一律寫實風、不要可愛風（設計師的要求），新怪物照 `docs/world3-plan.md`、`docs/world4-plan.md` 和紙本設計圖做（設計師的手稿照片放在 `docs/sketches/`，第四世界的怪物照 `IMG_7429.jpeg` 和 `1792913783585_1.jpg`，設計師說「要跟我畫的一樣，不要亂改」）。第三世界的場景參考《鬼滅之刃劇場版：無限列車篇》那種復古蒸汽列車：每節車廂功能不同、可以爬上車頂。
- 改了玩法、操作或測試用網址參數，要一起更新 `README.md`。
- `test.html` 是測試版（不同網址、可以另外加到主畫面）：由 `tools/make-test.mjs` 從 `index.html` 產生，不要手改；改了 `index.html` 要跑 `node tools/make-test.mjs`（`stamp.sh` 會自動跑，試玩測試也會檢查有沒有同步）。測試版只多了 `window.TEST_MODE = true`：`js/game.js` 的 `TEST_MODE` 讓所有世界、圖鑑怪物和燈泡圖鑑都開著、選難度時可以選從第幾夜開始，而且不讀不寫 localStorage 的存檔和進度。

## 改完遊戲要跑自動試玩測試

```
node tools/playtest.mjs
```

改到遊戲檔案（`index.html`、`style.css`、`js/`、`sw.js`）就要跑，全部通過（結束代碼 0）才算完成。截圖在 `playtest-out/`，可以打開來確認畫面。

- 無頭瀏覽器沒有 GPU，FPS 只有個位數，遊戲時間也走得很慢（每幀最多算 0.05 秒），看不出平板上順不順。
- 新功能如果能自動檢查，就順便在 `tools/playtest.mjs` 補一個情境或檢查。
- 測試用網址參數（要有 `world` 或 `cut` 才會生效）：
  - `?world=2&night=6`：直接開某個世界的某一夜（第 2 夜以後從天黑前 3 秒開始）；`?world=3` 是第三世界（第 2 夜以後火爐先放好 3 塊木炭）
  - `&kit=1`：帶齊武器和燈泡（第三世界另外帶 6 塊木炭、4 根木柴、3 把鑰匙）
  - `&diff=easy`／`normal`／`hard`：難度（預設 normal）
  - `&dusk`：第 1 夜也從天黑前 3 秒開始
  - `&cold`：第三世界這一天強制是寒寂之境；`&fire=0`：火爐一開始是空的（測列車停下來）
  - `?world=4`：第四世界（賣場）。`&kit=1` 只帶 16 格以內的東西（背包只有 16 格），另外在旁邊的地上放各級板子各 2 片、一扇木門，背包裡有木柴和煤炭；`&cold` 寒寂之境、`&acid` 馬上下酸雨、`&red` 今晚紅月
  - `?cut=1`：直接播第一世界破關的開門動畫；`?cut=2`：第二到第三世界的過場動畫；`?cut=3`：第三世界的結局（按「走進賣場」播第三到第四世界的過場動畫）
- 只跑某幾個情境：`PT_ONLY=w3,w3cold node tools/playtest.mjs`（名稱是 `scenario()` 的第一個參數）。現在共 21 個情境。
- 內建瀏覽器的面板沒顯示在前面時，Chrome 會把遊戲迴圈降到每秒 1 幀，截圖也會慢一拍：要測時間相關的東西就直接呼叫更新函式（例如 `updateWarlord(e, 0.1)`），截圖前多等一下或連拍兩張。
- 這台 Mac 沒有全域的 Node 版 Playwright（`/opt/homebrew/bin/playwright` 是 Python 版），Node 版裝在上一層目錄 `~/codebase/node_modules`，`import('playwright')` 往上找得到。
- 自己開來看：`python3 -m http.server 8765`，打開 http://localhost:8765/（跟 `.claude/launch.json` 的設定一樣）。

## 發布

```
./stamp.sh
```

要讓平板下載新版時才跑。它會寫入發布時間（台灣時間，主選單會顯示），並把 `sw.js` 的快取版本號和 `index.html` 的 `?v=` 加 1。跑完另外 commit，訊息用「發布 <stamp.sh 印出的時間>」，例如「發布 2026/10/04 11:04」。只改文件或 `tools/` 的話不用發布。

## 檔案

- `index.html`：畫面元素和各個選單（`test.html` 是它的測試版，產生出來的）。script 依序載入 `version.js` → `data.js` → `audio.js` → `world2.js` → `world3.js` → `world4.js` → `game.js`，都是一般 script，頂層的變數和函式（例如遊戲狀態 `G`、`mode`）彼此共用；最後的 `render3d.js` 是 module。
- `js/data.js`：地圖、家具、物品、燈泡的資料。第一、二世界共用 44×33 的房子（`ROOMS_HOUSE`、`DOORS_HOUSE`、`SOCKETS_HOUSE`、`FURN`）；第三世界是 59×25 的列車地圖（4 節車廂，2026/10/31 拿掉臥鋪、加寬成 7 排、天花板 3.3 公尺），自己一套 `ROOMS_W3`（房間有 `aisle`／`comp`／`roof`／`station` 旗標）、`DOORS_W3`（`vest` 連結處、`comp` 包廂、`station` 車站）、`SOCKETS_W3`、`FURN_W3`、`W3_CARS`（每節車廂的 x 範圍）、`W3_WINDOWS`、`W3`（起點、商人、禮物、過場路線、巡邏點、煙囪）。`MAP_W`／`MAP_H`、`ROOMS`、`DOORS`、`SOCKETS`、`FURN` 是「現在這個世界」的，換世界時由 `applyWorld` 重新填。另外有寶箱四級、站名和窗外風景。第四世界是 100×76 的賣場（`W4W`、`W4H`，十字主走道在 `W4AX`、`W4AY`；`W4MAP` 在載入時用程式排出樣品間 `W4_ROOMS_TMPL`、貨架、柱子；格局改版要把 `W4_MAP_VER` 加 1，舊存檔會由 `migrate4` 把蓋的板子退回來），`FURN4` 是家具能不能搬（`move`）、收納（`store`）、踩過去（`solid: false`）和功能（`fn`）；`PLANKS` 是五級板子；`wallsForWorld` 是額外的牆格子。日夜長度看 `DAY_SECS`／`NIGHT_SECS`（第四世界白天 300 秒、晚上 360 秒）。 站上、坐下、躺下家具是通用的：`FURN_TOP_H`（頂面高度，可以是函式）、`FURN_SIT`、`FURN_LIE`，加一行 type 就能用（判斷在 game.js 的 `tileTopH`、`groundUnder`、`sitDown`、`lieDown`）。
- `js/game.js`：遊戲邏輯和介面：世界、存檔、燈光、怪物、武器、商人和扭蛋、日夜事件、輸入、主迴圈。`isW3()` 的分支會呼叫 `world3.js` 的函式。
- `js/world2.js`：第二世界的 5 隻怪物。
- `js/world4.js`：第四世界（3008 無盡賣場）：自己蓋的牆放在格子的「邊」上（`G.b4`：`h`／`v` 兩個陣列、`roofs`）；轉 15°、45° 的斜牆是 `free: true`（`cx`、`cy`、`ang`），碰撞照線段算，尋路、視線、光、在家裡把它穿過的格子當成有牆（`G.b4.cells`、`freeIn`），碰撞（`hitsWall4`）、視線（`sightBlocked4`）、尋路（`computeFlow4`：打得破的牆很貴、玻璃過不去，怪物路上有牆就記在 `e.wallAhead` 去打）、光（`lightMask4`：被不透明的牆擋住）、「在家裡」（`enclosure4`）都要算上它；拿在手上的東西是 `G.hand`（板子、家具，或背包滿了多拿的第 17 個）、預覽 `ghost4()`、放下 `place4()`；架上擺的真的東西（`DISPLAY4` 的架子，`shelfSlots4` 排位置、`stockShelves4` 每天補貨，是 `G.pickups` 裡有 `s`、`si`、`z` 的那些，看著按 E 拿：`lookedPickup4`；3D 模型在 render3d.js 的 `item3D`）、口哨的紅點藍點（`whistle4`）、背包 16 格、櫃子收納、火爐、天氣（紅月、寒寂之境、酸雨）、神秘店員、5 隻新怪物、燈泡圖鑑、過場和結局。牆、門、家具改變了要呼叫 `b4Changed()`（路線、光、在家裡都會重算）。
- `js/world3.js`：第三世界：車站門的鎖、火爐和燃料、列車停下來、寶箱、車頂（爬梯和艙口用換位置的方式上下，車頂的風）、體溫和寒寂之境、大白燈的擁抱、4 隻新怪物（墮落戰神只在 `aisle` 房間裡走、檮杌會跟著上車頂）、過場動畫和結局、圖鑑的「見過」紀錄。
- `js/render3d.js`：Three.js 3D 畫面，模型都是程式產生的；貼圖大部分是程式畫的，第三世界的牆壁、地板、天花板、車身、車門、車頂、地毯、家具的材質（胡桃木、絨布、皮箱、黃銅、桌布）、車窗外的風景（遠景、五種中景、白天的站場；中景和站場是 Gemini 畫在洋紅色背景上再去背）、牆上的海報（`W3.posters`）和時刻表是照片貼圖（`PHOTO_TEX`，載入好才開始畫，載不到就用程式畫的；家具用 `photoMat(照片, 顏色)`，照片乘上顏色，深淺跟原本的純色一樣）。怪物也用照片材質，形狀、顏色、臉和花紋不變：`withDetail(材質, 名字, 一公尺幾張, 強度)` 把 `d-*` 細節紋路（照片除以模糊過的自己，平均是灰色）用模型座標的三向投影乘在原本的顏色上（不靠 UV，細長的手腳不會拉長）；菇傘、菌褶、菇柄、葵花籽、花瓣、熔岩直接用 `m-*` 照片（`photoInto` 畫進原本的畫布再拉回原本的平均色）；眼球的貼圖用 `overlayDetail` 疊眼白的照片。光照貼圖的大小跟著地圖走（`allocLM`）。第三世界的場景（車廂、車站、真的窗戶和會捲動的車外風景、滑門、家具、寶箱、大白、新怪物、車頂和車頭的鍋爐煙囪）在「第三世界」那幾段；座位上寫實、形形色色的乘客在「第三世界的乘客」那一段（臉和衣服用畫布畫，零件合併成幾個網格）；車頂比車廂地板高 `ROOF_H`，放東西和擺鏡頭都要加 `floorH(x, y)`。第四世界在「第四世界」那幾段：`buildStore4`（地板、天花板的日光燈板、牆、柱子、招牌）、`store4Furniture`（家具全部程式產生，每件照材質合成幾個網格 `mergeByMat`；搬動時 `Renderer.furn4` 拆掉重建）、`syncBuild4`（自己蓋的牆、屋頂、地上的板子）、5 隻新怪物和神秘店員（`syncMonster4`、`buildClerk4`）、雪和酸雨（`syncWeather4`），光照貼圖用 `addLight4`。
- `js/audio.js`：音效和音樂都用 WebAudio 即時合成，沒有音檔。
- `js/version.js`：發布時間，由 `stamp.sh` 寫入，不要手改。
- `sw.js`：離線快取，只在 https 啟用，本機開發時不會快取。
- `manifest.webmanifest`／`manifest-test.webmanifest`：正式版和測試版的 PWA 設定（名字、開始網址不同，所以可以各自加到主畫面）。
- `tools/make-test.mjs`：從 `index.html` 產生 `test.html`。
- `docs/world2-plan.md`：第二世界的設計計劃書。
- `docs/world3-plan.md`：第三世界（末班列車）的設計計劃書（已經做完）。
- `docs/world4-plan.md`：第四世界（3008 無盡賣場）的設計計劃書（設計圖上的連 WiFi 多人連線還沒做，要另外架伺服器）。
- `tools/playtest.mjs`：自動試玩測試。
- `tex/*.webp`：照片貼圖（都在 `sw.js` 的 `ASSETS` 裡）。原圖是用 Chrome 在 Gemini 網頁生成的 2048×2048 JPEG，下載在 `generated-images/`（很大，不放進 git）；`python3 tools/make-photo-tex.py` 把原圖修成可以無縫重複的貼圖、壓成 WebP（`--preview` 會在 `playtest-out/` 拼一張重複排的預覽，`--monsters` 只做怪物的）。要加新的照片貼圖：在 Gemini 生成、下載，把檔名加進 `make-photo-tex.py` 的 `SOURCES` 和輸出，再加進 `render3d.js` 的 `PHOTO_TEX` 和 `sw.js` 的 `ASSETS`。不要用 Gemini 的 MCP（要另外付費），用 Chrome 操作網頁生成；一定要用「下載原尺寸」，下載不了就告訴使用者，不要改用網頁上的預覽圖。
