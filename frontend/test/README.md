# 调试图（不是产品入口）

产品页是 `../index.html`（`frontend/index.html`），跟弹判定那条链路在
`../js/follow-score.js` + `../js/engine/` + `../js/app/`。

这里的两个页面是**开发/排查用**的，直接从浏览器打开：

| 页面 | 地址 | 干什么的 |
|---|---|---|
| 练习台 | `/test/practice.html` | 老页面：五个模式（单音/技巧/和弦/扫弦/转换）+ 全部阈值滑块 + 麦克风诊断 |
| 格子版跟弹 | `/test/follow-chips.html` | 老页面：音符格子 + 跟弹判定（错了不停），用同一份时间轴 JSON |

它们引用的是 `../js/*`（main.js / judge.js / ui.js / state.js / exercises.js / follow.js /
metronome.js），也就是**老的那套调试图链路**；产品页那条链路（follow-score.js）跟它们不共用。

离线脚本（回归、探针）在仓库根的 `test/` 目录里（`node test/*.mjs`），跟这里的页面不是一回事。
