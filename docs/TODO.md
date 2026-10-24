# 待辦事項

## 進行中 / 待處理

- [ ] **向中央氣象署詢問／申請（一封信涵蓋三件事）**
  - 聯絡方式：電郵 webqry@cwa.gov.tw，或傳真 02-23491212（預報中心）。
  - ① 颱風「各地區風力預測」「各地區24小時雨量預測」「各地區總雨量預測」（WindTable.xml／24hPrecipTable.xml／AllPrecipTable.xml，F-C0034-005/006/007）：檔案內附著作權聲明（未經書面授權不得向公眾提供），申請書面授權。
  - ② 本網站將定量降水預報 I～IV 加總為「未來24／48小時累積降水」並標示為衍生資料（非氣象署發布之預報），詢問是否符合開放資料使用規範與《氣象法》第17、18條。
  - ③ 氣象署網站每日發布之「6小時定量降水預報圖」不在開放資料平台中，詢問可否依網站資訊使用聲明擷取並疊圖顯示，或是否有開放資料版本。
  - 取得同意後：① 在 GitHub → Settings → Secrets and variables → Actions → **Variables** 新增 `TYPHOON_TABLES` = `1`；② 保留現行做法並記錄回覆；③ 加入網站6小時版本（需先開放此開發環境連線 www.cwa.gov.tw 以撰寫與測試程式）。
  - 申請信草稿：
    > 主旨：非營利登山氣象網站使用氣象資料之授權與諮詢
    >
    > 您好，我維護一個免費、無廣告的登山氣象整合網站（PWA）：https://htw90u.github.io/tw-hiking-forecast/ ，原始碼公開於 https://github.com/htw90u/tw-hiking-forecast 。網站使用貴署開放資料（雷達、雨量、定量降水預報、測站、育樂景點與鄉鎮預報、地震與颱風資訊），依政府資料開放授權條款於網站標示顯名聲明，提供登山者安全評估參考。想請教以下三件事：
    > 1. 颱風期間「各地區風力預測」「各地區24小時雨量預測」「各地區總雨量預測」XML 檔附有著作權聲明，敬請同意本網站以表格及縣市分級著色方式顯示，並標示「資料來源：中央氣象署」。
    > 2. 本網站將定量降水預報（I～IV）各時段加總，顯示「未來24／48小時累積降水」，並清楚標示「本圖為本網站將上述各時段預報加總計算之衍生資料，非中央氣象署發布之預報」。請問此做法是否符合開放資料使用規範及《氣象法》相關規定？如需調整，敬請指導。
    > 3. 貴署網站每日發布的6小時定量降水預報圖，目前未見於開放資料平台（平台之 F-C0041 僅於陸上颱風警報期間提供）。請問是否可依網站資訊使用聲明擷取使用，或未來是否有開放資料版本？
    > 網站不收費、不刊登廣告，並保留原始發布時間與來源標示。感謝撥冗回覆。

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
