# 在家生存 12 夜

3D 第一人稱恐怖生存網頁遊戲，主要在 Android 平板上用 Chrome 玩（加到主畫面，可以離線）。純靜態網頁，沒有建置步驟，也沒有 npm 套件。

## 規則

- 遊戲文字、程式註解、commit 訊息和文件都用台灣繁體中文。
- 平板觸控是主要玩法，也要支援電腦鍵盤滑鼠；改操作或介面時兩邊都要顧到。
- 不要改 `lib/`（Three.js 原始檔）。
- 新增遊戲要載入的檔案時，要加進 `sw.js` 的 `ASSETS`（離線快取清單），不然離線會壞掉；script 和 css 還要加進 `index.html`，網址帶 `?v=` 版本號。
- 存檔在 localStorage（`home99_save_v1`、`home99_progress_v1`）。改存檔內容時要能讀舊存檔，不能讓平板上的進度不見。`home99_progress_v1` 放解鎖的世界（`w2`、`w3`）和圖鑑見過的怪物（`seen`，`seenInit` 表示舊玩家已經照存檔進度補過）。
- 角色一律寫實風、不要可愛風（設計師的要求），新怪物照 `docs/world3-plan.md` 和紙本設計圖做。
- 改了玩法、操作或測試用網址參數，要一起更新 `README.md`。

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
  - `?cut=1`：直接播第一世界破關的開門動畫；`?cut=2`：第二到第三世界的過場動畫
- 只跑某幾個情境：`PT_ONLY=w3,w3cold node tools/playtest.mjs`（名稱是 `scenario()` 的第一個參數）。現在共 15 個情境。
- 這台 Mac 沒有全域的 Node 版 Playwright（`/opt/homebrew/bin/playwright` 是 Python 版），Node 版裝在上一層目錄 `~/codebase/node_modules`，`import('playwright')` 往上找得到。
- 自己開來看：`python3 -m http.server 8765`，打開 http://localhost:8765/（跟 `.claude/launch.json` 的設定一樣）。

## 發布

```
./stamp.sh
```

要讓平板下載新版時才跑。它會寫入發布時間（台灣時間，主選單會顯示），並把 `sw.js` 的快取版本號和 `index.html` 的 `?v=` 加 1。跑完另外 commit，訊息用「發布 <stamp.sh 印出的時間>」，例如「發布 2026/10/04 11:04」。只改文件或 `tools/` 的話不用發布。

## 檔案

- `index.html`：畫面元素和各個選單。script 依序載入 `version.js` → `data.js` → `audio.js` → `world2.js` → `world3.js` → `game.js`，都是一般 script，頂層的變數和函式（例如遊戲狀態 `G`、`mode`）彼此共用；最後的 `render3d.js` 是 module。
- `js/data.js`：地圖、家具、物品、燈泡的資料；每個世界的房間名字、地板、門和家具（第三世界可以換位置、增減）、寶箱四級、站名和窗外風景。
- `js/game.js`：遊戲邏輯和介面：世界、存檔、燈光、怪物、武器、商人和扭蛋、日夜事件、輸入、主迴圈。`isW3()` 的分支會呼叫 `world3.js` 的函式。
- `js/world2.js`：第二世界的 5 隻怪物。
- `js/world3.js`：第三世界：車站門的鎖、火爐和燃料、列車停下來、寶箱、體溫和寒寂之境、大白燈的擁抱、4 隻新怪物、過場動畫和結局、圖鑑的「見過」紀錄。
- `js/render3d.js`：Three.js 3D 畫面，貼圖和模型都是程式產生的。第三世界的場景（車廂、車站、真的窗戶和會捲動的車外風景、滑門、家具、寶箱、大白、新怪物）在「第三世界」那幾段。
- `js/audio.js`：音效和音樂都用 WebAudio 即時合成，沒有音檔。
- `js/version.js`：發布時間，由 `stamp.sh` 寫入，不要手改。
- `sw.js`：離線快取，只在 https 啟用，本機開發時不會快取。
- `docs/world2-plan.md`：第二世界的設計計劃書。
- `docs/world3-plan.md`：第三世界（末班列車）的設計計劃書（已經做完）。
- `tools/playtest.mjs`：自動試玩測試。
