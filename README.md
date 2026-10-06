# claude-mods

[Claude Code](https://claude.com/claude-code) mods by Dustin Yuchen Teng. Each folder is one self-contained mod with its own README, screenshots and tests; this repository is also a plugin marketplace, so you add it once and install the mods you want.

Dustin 寫的 Claude Code mods 合集。每個資料夾是一支獨立的 mod，各有自己的說明、截圖和測試；整個 repo 同時是一個 plugin 市集，加一次就能挑著裝。

| Mod | What it does | 說明 |
| --- | --- | --- |
| [screen-guard](screen-guard/) | Masks names, organisations, secrets and contact details in the transcript while you screen-share; click a bar to reveal it. | 分享螢幕時把人名、公司、金鑰、聯絡方式畫成黑條，點一下解開。 |
| [cache-panel](cache-panel/) | A quiet reminder before your prompt cache goes cold, with keep-warm, ping and compact options and live cost estimates. | 快取快過期前提醒，一鍵選保溫、單次喚醒或壓縮，附即時成本估算。 |

## Install

Requires Claude Code 2.1.287 or newer.

```bash
claude plugin marketplace add danyuchn/claude-mods
claude plugin install screen-guard@dustin-mods
claude plugin install cache-panel@dustin-mods
```

Open sessions pick new mods up after `/reload-plugins`. Before installing, `claude plugin validate <mod folder>` lists every event a mod hooks and every call it makes.

## Layout

```
.claude-plugin/marketplace.json   lists every mod in this repo
<mod>/
  .claude-plugin/plugin.json      the mod's manifest and version
  hooks/                          hooks.json + the hooks module
  types/                          shape of the mod's $.state values
  README.md                       what it does, setup, limits, roadmap
  docs/                           screenshots
```

Each mod is versioned on its own in its `plugin.json`. To add a mod: create its folder in the layout above, add an entry to `.claude-plugin/marketplace.json`, and add a row to the table here.

## License

MIT
