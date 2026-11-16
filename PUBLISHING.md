# 发布清单（维护者用）

这份文件不随 tarball 发布，只用于把仓库整理成可公开的状态。

## 1. 发布前检查

```sh
npm install
npm test          # 72 条断言：store / threads / service / schedule / plugin
for f in *.js; do node --check "$f"; done
```

- [ ] 版本号与 `CHANGELOG.md` 一致（当前 `0.4.2`）
- [ ] `README.md` 与当前界面一致（页签、按钮名、报告结构）
- [ ] `package.json` 的 `repository` / `homepage` / `bugs` 指向 `skyrocks/dsh-mail-digest`
- [ ] `engines.dsh` 与目标 DSH 版本匹配（`>=0.2.2-rc.2 <0.3.0`）
- [ ] `peerDependencies` 只有真正 import 的包（`react` / `cordis` / `typert-protocol`）
- [ ] `locale/*.json`、`docs/DETAIL.md`、`icon.svg` 都在 `files` 里

## 2. 本地安装自测

```sh
cd ~/PrivateCode/dsh/dsh-mail-digest && npm install
dsh plugin --profile desktop add "link:$PWD"
```

装完在「设置 → 邮件整理 → 配置」填一个真实邮箱，点「测试连接」；再点报告页的「立即整理」，
等通知出现，点开确认侧边栏面板与「在浏览器打开」都正常。

> 改动 Host 侧（`index.js` / `service.js` / `tools.js` / `typert.host.js` / `store.js` / `schedule.js`）
> 之后必须**完全退出 DSH 再打开**才生效——typert 接口清单只在进程启动时注册一次。
> 只改 `client.js` 时刷新页面即可。

## 3. 打包

```sh
npm pack
# 产物：skyrocks-dsh-mail-digest-0.4.2.tgz
```

## 4. 发布

```sh
git add -A && git commit -m "release: 0.4.2"
git push origin main
git tag -a v0.4.2 -m "v0.4.2"
git push origin v0.4.2
gh release create v0.4.2 skyrocks-dsh-mail-digest-0.4.2.tgz --title v0.4.2 --notes-file CHANGELOG.md
```

顺序要求：**先提交（含 CI）再打 tag**，否则 `main` 会比 tag 多一个 commit。

## 5. 曝光（发布才算完成）

```sh
gh repo edit skyrocks/dsh-mail-digest \
  --add-topic dsh-plugin --add-topic deepseek-harness \
  --add-topic dsh --add-topic client-plugin \
  --add-topic email --add-topic imap
```

- topic 是生态雷达站全量扫描的唯一入口，漏打等于不可见。
- 自有索引 `skyrocks/dsh-plugins` 的 `index.json` 需要同步加条目，并把 `commit` pin 到本次 tag 的 commit。
- 推完索引后记得刷 jsDelivr：`https://purge.jsdelivr.net/gh/skyrocks/dsh-plugins@main/index.json`。

## 6. 已知边界

- 本机 `github.com:443` 不稳定时，`git push` 改走 SSH（`ssh -T git@github.com` 可用）；
  两条通道都不通时用 API 镜像工具 `.tools/gh-push.mjs`。
- 新增 `.github/workflows/*` 需要 token 带 `workflow` scope，否则服务端拒绝。
