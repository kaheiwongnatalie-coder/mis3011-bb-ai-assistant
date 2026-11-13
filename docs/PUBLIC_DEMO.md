# 公开展示页与本机后台

已发布：[https://rlqxsys.github.io/mis3011-bb-ai-assistant/](https://rlqxsys.github.io/mis3011-bb-ai-assistant/)。

完整交接文档位于项目根目录：[交接文档_时间规划与动态提醒.md](../交接文档_时间规划与动态提醒.md)。

## 组员直接看什么

公开页保留任务、计划、提醒三页，初始载入五次真实 DeepSeek 公告处理形成的三项任务。

1. 点击任务，查看课程要求、正式时间与原文。
2. 打开计划，修改空闲时间、每日容量或添加已有安排，查看准备块变化。
3. 确认一项任务完成，查看对应准备块释放及待发提醒更新。
4. 在历史时间控制中前进，查看提醒到达。
5. 使用“体验演示”检查作业流程、考试改期、时间不足与分班条件四类原文场景。
6. 设置中可以查看真实 AI 运行记录、恢复初始任务或导出当前状态。

每位组员的操作保存在自己的浏览器，不互相覆盖。经典演示使用原包课程及明确的操作事件；设置中的真实 AI 记录保留了输入原文和模型返回。

## 哪些运行在公开页 哪些需要 Node 服务

| 功能 | 公开页 | 本机 Node 服务 |
| --- | --- | --- |
| 查看原文、任务、计划和提醒 | 支持 | 支持 |
| 调整空闲、忙碌、完成与提醒偏好 | 支持，浏览器实时计算 | 支持，后端保存 |
| 四类经典演示 | 支持 | 支持 |
| 查看既有真实 AI 调用 | 支持 | 使用对应验收工作区时支持 |
| 新资料触发模型处理、自然语言安排调整 | 按文档启动后台复测 | 支持，需配置模型连接 |
| 浏览器关闭后继续扫描资料 | 随浏览器暂停 | Node 服务运行期间支持 |

## 开发者：运行完整 AI 流程

以下步骤用于开发、接入与真实模型复测。组员查看展示时，直接使用文档顶部的公开地址。

在克隆的项目目录中运行，要求 Node.js 22+：

```bash
BB_ASSISTANT_MODE=review BB_ASSISTANT_STATE_FILE=.local/ai-review.json PORT=4176 npm start
```

在 Windows PowerShell 中用 `$env:BB_ASSISTANT_MODE='review'; $env:BB_ASSISTANT_STATE_FILE='.local/ai-review.json'; $env:PORT='4176'; npm start` 启动。此验收服务监听 `http://127.0.0.1:4176/`，使用独立状态文件。右上角设置中配置模型后，可自动处理本地课程包和增量资料。Node 服务运行期间，关闭浏览器仍会继续处理；服务重启后重新填写模型 key。

按原始发布时间回放公告：

```bash
export BB_AI_REVIEW_URL=http://127.0.0.1:4176
node scripts/automation-demo.mjs new
node scripts/automation-demo.mjs update
node scripts/automation-demo.mjs eco
```

`new` 备份并切换验收工作区，后续命令推进到真实公告的发布时间，由后台自动识别更新。完整带断言的复测使用 `node scripts/live-automation-eval.mjs`；当前工作区保留验收结果时，可使用 `node scripts/export-ai-example.mjs` 导出样例。

## 模拟 Blackboard 接入（离线）

在项目根目录运行 `node scripts/mock-bb-demo.mjs --serve`，然后打开 `http://127.0.0.1:4175/#tasks`。只想在终端验收时，运行 `node scripts/mock-bb-demo.mjs`，检查通过后会自动退出。

后台按历史发布时间读取 `BB_Source_Feed/courses/` 中的原始公告，使用仓库中保存的模型响应重新生成任务、排程和提醒。本次运行不连接 Blackboard 或模型服务。演示验证 CSC1001 考试改期、旧提醒撤销、ECO3121 作业进入计划，以及相同公告去重。点开任务的「来源」可以查看公告片段和原文件。

## 本地构建与更新

Node.js 22+，在项目目录执行：

```bash
npm test
npm run build:public
```

输出为 `dist/`。构建复用 `web/` 三页界面、`core/` 排程引擎及 `demo/` 原文场景；`public/` 提供浏览器状态适配和精简设置面板。

`.github/workflows/pages.yml` 在 main 更新后测试、构建并发布 GitHub Pages。部署地址由仓库的 Pages 设置与 Actions 结果确认。

展示的 AI 记录来自 `examples/automation-live-output.json`；更新这份记录需要先按交接文档完成真实后台验收，再导出样例。仅打开公开页不会调用模型。
