#!/bin/bash
# 發布前執行：寫入發布時間、更新快取版本號（平板才會下載新版）
set -e
cd "$(dirname "$0")"
STAMP=$(date '+%Y/%m/%d %H:%M')
N=$(( $(grep -o "home12-v[0-9]*" sw.js | grep -o "[0-9]*$") + 1 ))
sed -i '' "s/home12-v[0-9]*/home12-v$N/" sw.js
sed -i '' "s/?v=[0-9]*/?v=$N/g" index.html
cat > js/version.js <<JS
// 發布時間：發布時由 stamp.sh 自動寫入，主選單會顯示，用來確認平板上跑的是哪一版
const BUILD_TIME = '$STAMP';
JS
echo "版本 $STAMP（快取 home12-v$N）"
