# 山岳氣象地圖 tw-hiking-forecast

把中央氣象署（CWA）的雷達回波、雨量、定量降水預報（QPF）、測站觀測、登山/育樂景點預報、鄉鎮預報、地震報告、颱風警報與風雨預測整合在一張地形圖上，供登山安全評估使用。網頁本身就是 PWA，可「加到主畫面」當 App 使用，最近查詢的資料可離線瀏覽。

設計與資料來源規劃見 [docs/PLAN.md](docs/PLAN.md)。

## 功能

| 類別 | 內容 |
|---|---|
| 疊圖（可調透明度/濃淡） | 雷達回波（近 1 小時 10 分鐘動畫）、過去 1 小時雨量、今日累積雨量、未來 1 小時雨量、定量降水預報（4 個 12 小時時段）、溫度分析、衛星雲圖（紅外/可見光/色調強化）、颱風 24 小時與總雨量預測（警報期間） |
| 點擊地圖任一處 | 所在鄉鎮、登山安全評估燈號（列出觸發原因）、該點格點值、QPF 四時段、登山/景點預報（3 天逐 3 小時、一週逐 12 小時）或鄉鎮預報、鄰近測站即時值、測站歷史圖表（24 小時 / 3 天 / 7 天 / 31 天 / 自訂區間）、近期地震、警特報 |
| 反向查詢 | 「列出受影響山區」：目前圖層超過門檻的山或景點清單（依強度排序） |
| 地震 | 震央、10/30/50 km 範圍圈、範圍內的山與景點、各地震度 |
| 颱風 | 路徑（實際/預測）、7 級與 10 級風暴風圈、70% 機率半徑、警報全文；各地區風力、24 小時與總雨量預測（平地/山區）需開啟 `TYPHOON_TABLES`，見下方授權說明 |
| 地點預報 | 氣象署 14 類育樂景點預報（登山 151 處、國家公園、森林遊樂區、農場、水庫、海水浴場…）＋全台 368 鄉鎮 |
| 無障礙 | 字體 90–200%、淺色/深色/高對比主題、色盤（氣象署原色/色弱友善/高對比）、粗體、減少動畫、鍵盤操作、螢幕報讀（圖表附摘要與數據表、燈號不只靠顏色） |
| 離線 | App 外殼、最後一次資料、瀏覽過的底圖圖磚自動快取；最近 40 筆查詢可離線開啟；可預先下載目前範圍底圖 |

## 架構

```
CWA 開放資料 S3 (cwaopendata, 免金鑰)
   │  GitHub Actions 每 20 分鐘
   ▼
pipeline/ (Python)  ── 轉成精簡格式 ──►  site/data/  ──►  GitHub Pages (PWA)
   ├ grids.py    格點 → 16-bit PNG（TWD67→WGS84 校正）
   ├ qpf.py      QPF 圖片 → 自動地理對位 + 由圖例色彩反推雨量級距
   ├ stations.py 測站即時值 + 逐時歷史封存（月檔 CSV.gz）
   ├ forecast.py 景點/鄉鎮預報
   └ hazards.py  地震、颱風、警特報
```

* 定量降水預報只提供圖片、沒有座標：以縣市界線（taiwan-atlas，內政部資料）對圖上的黑色界線做 chamfer matching 求出像素↔經緯度轉換，每次執行都會驗證，版面改變時自動重新擬合；再把圖例的 17 種顏色反推回雨量級距，前端即可用任何色盤重繪並點擊查值。
* 測站歷史：S3 `history/` 保留約 15 天逐時資料，pipeline 首次執行時回補，之後每次累積到 `archive/YYYY-MM.csv.gz`，網站提供近 31 天逐站檔，更早的區間由瀏覽器下載月檔解壓查詢。

## 本機執行

```bash
python3 -m pipeline.build            # 自動建立 .venv 並安裝 requirements.txt，輸出到 site/data/
python3 -m http.server -d site 8000  # 開啟 http://localhost:8000
```

常用參數：`--only stations,grids,qpf`（只跑部分任務）、`--history-days 15`（回補天數）。
每次執行都會在 `logs/` 產生紀錄檔，第一行為重現指令。

## 測試

```bash
.venv/bin/python -m pytest -q tests          # pipeline 單元測試（真實 CWA 資料裁切成的 fixtures）
node tests/e2e/run_e2e.cjs                   # 前端端對端測試（Playwright/Chromium，需先 build）
eslint site/js site/sw.js tests/e2e          # 前端 lint
```

## 部署（GitHub Pages）

1. Repository → Settings → Pages → Source 選 **GitHub Actions**。
   （私人 repository 需 GitHub Pro 以上才能使用 Pages；公開 repository 免費且 Actions 分鐘數不限。）
2. `.github/workflows/build-deploy.yml` 會每 20 分鐘抓資料並部署，也可在 Actions 頁面手動執行。
3. 目前所有資料皆取自氣象署公開 S3，不需要 API 授權碼。若之後加入僅 REST API 提供的資料，請把授權碼放在 Settings → Secrets → Actions 的 `CWA_API_KEY`，**不要寫進程式碼或 commit**。

## 資料來源與授權

* 中央氣象署開放資料（政府資料開放授權條款）。
* 颱風各地區風力／24 小時雨量／總雨量預測表附有氣象署著作權聲明（未經書面授權不得向公眾提供），因此**預設不輸出**，網站改提供[氣象署颱風消息](https://www.cwa.gov.tw/V8/C/P/Typhoon/TY_NEWS.html)連結。個人使用可執行 `python -m pipeline.build --typhoon-tables`；取得授權後在 GitHub Actions Variables 設定 `TYPHOON_TABLES=1` 即可在網站顯示。申請進度見 [docs/TODO.md](docs/TODO.md)。
* 行政區界：[taiwan-atlas](https://github.com/dkaoster/taiwan-atlas)（MIT，資料來源內政部）。
* 地圖：Leaflet（BSD-2）、OpenTopoMap（CC-BY-SA）、OpenStreetMap、內政部國土測繪中心。
* 本工具的安全評估為自動規則判斷，僅供參考，請以現場狀況與官方資訊為準。
