# 待辦事項

## 進行中 / 待處理

- [ ] **向中央氣象署申請颱風風雨預測表的書面授權**
  - 對象資料：颱風期間「各地區風力預測」（WindTable.xml，F-C0034-005）、「各地區 24 小時雨量預測」（24hPrecipTable.xml，F-C0034-006）、「各地區總雨量預測」（AllPrecipTable.xml，F-C0034-007）。
  - 原因：檔案內附著作權聲明——未經中央氣象署書面授權，嚴禁複製、改編、分發、發布或向公眾提供。
  - 聯絡方式（檔案內 Remarks 所列）：電郵 webqry@cwa.gov.tw，或傳真 02-23491212（預報中心）。
  - 申請內容建議寫明：非營利登山安全用途、網站網址、顯示方式（表格與縣市分級著色）、標示來源「中央氣象署」、更新頻率（每 20 分鐘讀取一次開放資料）。
  - 取得授權後：在 GitHub → Settings → Secrets and variables → Actions → **Variables** 新增 `TYPHOON_TABLES` = `1`，並保存授權文件。程式不需修改。
  - 未取得授權前：公開網站只顯示颱風路徑、暴風圈、警報全文，並提供氣象署颱風消息頁連結；自己電腦執行時可用 `python -m pipeline.build --typhoon-tables` 開啟（僅限個人使用）。

- [ ] **向魯地圖作者確認可否使用其線上圖磚當底圖**
  - 現況：魯地圖 © Rudy Chung（All rights reserved，允許再散布）；樣式衍生自 OpenAndroMaps Elevate theme（CC BY-NC-SA 3.0）；資料 © OpenStreetMap contributors（ODbL）、等高線為內政部 20m DTM。
  - 作者在 [taiwan-topo issue #68](https://github.com/alpha-rudy/taiwan-topo/issues/68) 對其他 App 的回覆：可以使用，條件是「不透過下載魯地圖來收費」並「標明魯地圖與說明網頁的網址」；協作者另請使用者依 rudymap 開發者頁回報使用量。
  - 官方線上圖磚 `tiles.rudymap.tw`（以 TileJSON 提供、網址每週更換版本）有 Referer 白名單，未列入的網站會被拒絕（403），因此本站目前無法直接使用。
  - 做法：到 https://github.com/alpha-rudy/taiwan-topo/issues 開 issue 詢問，草稿如下；取得同意並加入白名單後，再在底圖選單加入魯地圖（讀取 TileJSON、標示「魯地圖 MOI.OSM（Rudy Chung）｜© OpenStreetMap contributors｜等高線：內政部 20m DTM」並連結 rudymap.tw）。
  - 申請草稿：
    > 標題：請教：非營利登山氣象網站以線上圖磚顯示魯地圖的授權與白名單
    >
    > 您好，我維護一個免費、無廣告的登山氣象整合網站（PWA）：https://htw90u.github.io/tw-hiking-forecast/ ，原始碼：https://github.com/htw90u/tw-hiking-forecast 。網站把中央氣象署的雷達、雨量、降水預報、地震與颱風資訊疊在地形圖上，供登山安全評估使用。
    > 想請教是否可以將魯地圖作為底圖選項之一：
    > 1. 是否可使用 tiles.rudymap.tw 的線上圖磚？若可以，能否將 htw90u.github.io 加入 Referer 白名單？
    > 2. 標示方式預計為「魯地圖 MOI.OSM（Rudy Chung）｜© OpenStreetMap contributors｜等高線：內政部 20m DTM」並連結 https://rudymap.tw/ ；網站不收費、不提供魯地圖下載。
    > 3. 使用者瀏覽過的圖磚會由瀏覽器快取供離線查看（不主動大量下載），這樣是否可以？
    > 4. 若需回報使用量，請告知方式。
    > 感謝您維護魯地圖！

- [x] repository 已公開，GitHub Pages 已啟用（2026-10-24），網址 https://htw90u.github.io/tw-hiking-forecast/
- [x] 已改寫 commit 歷史（2026-10-24），所有版本的 `tests/fixtures/precip24.xml`、`tests/fixtures/wind.xml` 皆替換為虛構測試資料並強制推送。
  - 註：GitHub 伺服器端可能仍暫存舊 commit（以完整 SHA 直接存取時）；若需徹底清除，可在公開前向 GitHub Support 申請清除快取（舊 commit：`9fd403f3e9d62369d2944ba30753a71b25769776` 起）。

## 後續擴充

- [ ] 系集預報（Open-Meteo Ensemble API：ECMWF ENS、GFS ENS）
- [ ] Windy 整合（目前為深連結）
- [ ] 氣象署 WRF 模式（M-A0064，GRIB2）風場圖層
