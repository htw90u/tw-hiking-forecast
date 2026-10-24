# Peak lists (tags)

Each `*.json` file here tags OSM peaks with a list name, shown in the app (e.g. 百岳, 小百岳, 三角點).
Files are read by `pipeline/peaks.py` on every build; changing them re-tags `site/data/peaks.json`
without downloading OSM again.

```json
{
  "id": "baiyue",
  "label": "百岳",
  "source": "where the list comes from",
  "match_km": 1.5,
  "peaks": [
    {"n": "玉山北峰", "lat": 23.4875, "lon": 120.9597},
    {"n": "雪山", "min_ele": 3000}
  ]
}
```

* `n` must equal the OSM name (`name:zh-Hant`, `name:zh`, then `name`).
* With `lat`/`lon`, a peak matches when it is within `match_km` (default 1.5 km); this is the
  reliable way because many peaks share a name.
* Without coordinates, `min_ele` (metres) is used to tell same-name peaks apart.
* `id` is the stable key stored in peaks.json; `label` is what the app shows.
