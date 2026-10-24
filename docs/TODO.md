# 待辦事項

## 進行中 / 待處理

- [ ] **向中央氣象署申請颱風風雨預測表的書面授權**
  - 對象資料：颱風期間「各地區風力預測」（WindTable.xml，F-C0034-005）、「各地區 24 小時雨量預測」（24hPrecipTable.xml，F-C0034-006）、「各地區總雨量預測」（AllPrecipTable.xml，F-C0034-007）。
  - 原因：檔案內附著作權聲明——未經中央氣象署書面授權，嚴禁複製、改編、分發、發布或向公眾提供。
  - 聯絡方式（檔案內 Remarks 所列）：電郵 webqry@cwa.gov.tw，或傳真 02-23491212（預報中心）。
  - 申請內容建議寫明：非營利登山安全用途、網站網址、顯示方式（表格與縣市分級著色）、標示來源「中央氣象署」、更新頻率（每 20 分鐘讀取一次開放資料）。
  - 取得授權後：在 GitHub → Settings → Secrets and variables → Actions → **Variables** 新增 `TYPHOON_TABLES` = `1`，並保存授權文件。程式不需修改。
  - 未取得授權前：公開網站只顯示颱風路徑、暴風圈、警報全文，並提供氣象署颱風消息頁連結；自己電腦執行時可用 `python -m pipeline.build --typhoon-tables` 開啟（僅限個人使用）。

- [ ] 決定 repository 公開或升級 GitHub Pro，並在 Settings → Pages → Source 選「GitHub Actions」。
- [ ] repository 若要公開：舊的 commit 歷史中仍有兩個颱風表原始檔（`tests/fixtures/precip24.xml`、`tests/fixtures/wind.xml` 在 2026-10-23 的版本），公開前需改寫歷史移除。

## 後續擴充

- [ ] 系集預報（Open-Meteo Ensemble API：ECMWF ENS、GFS ENS）
- [ ] Windy 整合（目前為深連結）
- [ ] 氣象署 WRF 模式（M-A0064，GRIB2）風場圖層
