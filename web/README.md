# 网页版源码

《更迭》以实体桌游为核心。本目录中的网页版用于试玩和数值测试，包含界面、规则引擎、本地联机服务与云端 Worker。实体卡牌的印刷原图位于仓库根目录的 `卡牌/`；网页使用优化后的 WebP 图片，位于 `assets/`。网页版的实现或实验参数与实体规则不一致时，应先核对并记录差异。

## 目录

| 路径 | 用途 |
| --- | --- |
| `src/` | 当前桌面界面、卡面清单及来源记录 |
| `game/` | 游戏规则、卡牌数据及本地联机服务 |
| `cloud/` | 云端 API、构建脚本、数据库适配与测试 |
| `assets/` | 网页使用的卡牌和背景图片 |
| `scripts/` | 生成独立页面的脚本 |
| `tests/` | 本地规则与联机测试 |
| `db/`、`drizzle/` | 数据库结构与迁移文件 |
| `deploy/` | 独立服务器部署示例 |

`cloud/vendor/game_data.json` 是云端使用的精简数据；`game/game_data.json` 包含完整游戏数据与说明书，二者用途不同。

## 本地构建与测试

需要 Node.js 22 或更新版本、Python 3。以下命令均在 `web/` 目录运行：

```sh
npm run build
npm test
npm start
```

`npm run build` 会生成 `standalone.html` 和 `dist/`；这两项是构建产物，已排除在 Git 提交之外。`npm start` 启动本地服务，默认地址为 `http://127.0.0.1:8788/`。先构建再启动，才能看到当前界面。服务运行期间产生的房间存档写入 `game/rooms/`，也不会提交到仓库。

可用 `PYTHON=/path/to/python3 npm run build` 指定 Python 路径。修改印刷卡面后，需要同步更新网页图片和 `src/card-assets.metadata.json` 中的来源摘要，否则构建会提示图片来源不一致。

目前 `T2-06` 缺少完整科技卡面，网页版使用插画替代；其他卡面与来源见 [`src/card-assets-notes.md`](src/card-assets-notes.md)。

## 发布到 GitHub Pages 实现多人联机

网页版内置了 **P2P 联机模式**：房主浏览器作为权威主机，访客通过 WebRTC 直连（Trystero/webConnect 公共信令），不需要任何后端服务器，因此可以整个发布到 GitHub Pages 等静态托管。规则引擎与服务器版完全相同，私有手牌按座位分别下发。

```sh
npm run build:pages
```

该命令生成完全自包含的 `dist-pages/`（`index.html` + `assets/`，CSS/JS/规则引擎全部内联、资源路径改为相对路径），并开启 `window.ITERATION_P2P_ONLY`，首页联机区自动切换为 P2P 入口。

仓库根目录已提供 GitHub Actions 工作流 `.github/workflows/pages.yml`：推送到 `main` 分支后自动构建 `web/dist-pages/` 并发布到 GitHub Pages。启用方式：

1. 将本仓库推送到 GitHub（`git remote add origin git@github.com:<用户名>/<仓库>.git && git push -u origin main`）。
2. 在 GitHub 仓库页面 **Settings → Pages** 中，将 **Source** 设置为 **GitHub Actions**（无需手动上传文件）。
3. 等待工作流运行完成，访问 `https://<用户名>.github.io/<仓库>/` 即可游玩；把页面地址（`?room=房间码` 邀请链接）发给朋友即可联机。

注意事项：

- P2P 模式依赖浏览器 WebRTC 与公共信令服务器，适合熟人联机；房主掉线则对局暂停，房主刷新后可通过“续接联机身份”恢复。
- 服务器版（`npm start`）不受影响，仍提供 HTTP 房间、观战与云端 D1 方案。
- Windows 中文系统下，构建脚本已显式按 UTF-8 读写文件；`build-site.mjs` 与 `build-pages.mjs` 会自动在 Windows 上使用 `python`（可用 `PYTHON=/path/to/python npm run build` 覆盖）。
