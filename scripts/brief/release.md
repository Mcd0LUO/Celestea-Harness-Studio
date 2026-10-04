## 常规条款 · 发布阶段

顺序与理由见 `docs/AGENT.md` §4（**不在这里复述** —— 一个事实一个家）。
只强调三条最容易错的：
- **先 tag 再 build**（版本号由 `git describe --tags` 派生，反过来会让包自称旧版本）；
- **等这个 tag 上的 CI 绿了再 publish**（tag 红了而 `webdist/build-meta.json` 记着那个 sha，用户可见）；
- **publish 必须有人类显式授权**（`CELESTEA_PUBLISH_AUTHORIZED=1`），发完从**真实 registry** 装一遍验证。