# phira-chart-ai · Phira 谱面 AI 助手

> 给 AI 代理（以及你）用的 **Phira / RPE 谱面工具链**：写谱、校验、分析、预览、打包。
> 目标不是"帮你打几个键"，而是让 AI **做出能玩、不崩、手感对的谱面**。

- **运行时**：[DeepSeek Harness](https://github.com/deepseek-ai/dsh)（DSH）插件，27 个工具 + 侧栏谱面面板
- **产物**：标准 RPE `chart.json` / `info.yml` / `extra.json`，可直接打成 `.pez` 导入 Phira
- **引擎依据**：所有判定、时间、单位规则均来自 [prpr](https://github.com/TeamFlos/phira) 源码核对（见 `docs/engine.md`）

---

## 它解决什么问题

用 AI 写 Phira 谱面，翻车点几乎都是"引擎语义没对齐"：

| 典型翻车 | 本插件怎么处理 |
|---|---|
| 事件时间单位写错（拍 vs 秒） | 统一拍→秒换算，`phira_validate` 直接报 |
| 空事件数组让游戏 panic | 生成时就避免 + 校验报 `empty-event-array` |
| 事件不按时间排序（引擎不排序） | 写入自动排序 + 校验 `unsorted-events` |
| 判定线 alpha 首帧不从 0s 开始 → 整首不透明 | 校验 `line-alpha-head`（源码 `line.rs:237`） |
| 全程后处理滤镜 → 整屏发暗 | 校验 `fx-global-shader`（覆盖 >50% 或 `global:true`） |
| 长条尾后 100ms 接按键（按不出来） | 校验 `hold-tail-press` |
| 音符挤在 ±200 内 / 满屏贴边 | 按 24 张参考谱面的横向分位生成 |
| 类型配比失衡（全是 Tap） | 校验 `type-mix`，对齐 Tap 57 / Hold 13 / Flick 5 / Drag 25 |
| 难度"感觉"和标数不符 | 先测后标：`info.yml` 写实测预测值 |

## 工具一览（27 个）

**生成**
`phira_chart_generate`（MIDI / 规划两条路径，一键出整谱）
`phira_chart_plan`（段落规划）+ `phira_chart_build_from_plan`
`phira_midi_parse`（MIDI → 音符候选）

**编辑**
`phira_chart_init` `phira_chart_add_notes` `phira_chart_add_line` `phira_chart_add_events`
`phira_chart_apply_pattern`（19 种手法）`phira_chart_add_effect` `phira_chart_add_shader`
`phira_chart_set_meta` `phira_chart_patch` `phira_chart_edit`（任意字段）`phira_chart_batch`

**检查**
`phira_validate`（**60+ 条检查**）`phira_doctor`（一次体检：解析/资源/难度）`phira_analyze`（密度/手部/难度归因）

**看效果**
`phira_preview_frame` `phira_preview_strip` `phira_panel_open` `phira_panel_status`（侧栏可视化）

**知识**
`phira_guide`（20 个主题：引擎语义 / 格式 / 判定 / 特效 / 手法 / 踩坑 / 可玩性…）

## 安装（DSH）

```bash
# 在你的 DSH 工作区里
git clone https://github.com/dh-114/phira-chart-ai.git phira/Plug-in-code
```

然后在 DSH 里安装（二选一）：

```bash
# A. 从 GitHub 直接装（推荐）
dsh plugin install github:dh-114/phira-chart-ai
# B. 本地开发：克隆后按包名 link，注意 profile 里的依赖名必须和 package.json 的 name 一致
#    "dsh-phira-chart-ai": "link:/storage/emulated/0/dsh/phira/Plug-in-code"
```

装完重启 DSH。**注意**：`cordis.patch.yml` 里的 `name` 必须等于 `package.json` 的 `name`，
否则 DSH 会去解析一个不存在的别名，报 `entry did not activate … failed to import`。
同理 **`client.js` 里 `window.__ModuleLoader__.load({ id })` 的 `id` 也必须等于包名**，
写别名会让页面侧找不到组件，启动时直接 `client-plugin-tree-failed`。

面板：侧栏「Phira」标签自动出现，可直接载入谱面目录看时间轴与判定线。

## 快速上手

对 AI 说：

```
用 phira_chart_generate 把 这首歌.mid 做成一张 IN 13 的谱面，输出到 ./out
再用 phira_validate 和 phira_doctor 检查，有 error 就修到 0，最后打包成 .pez
```

或者从零手写：

```
phira_chart_init → phira_chart_apply_pattern（铺楼梯/双押）→ phira_chart_add_effect（换色）
→ phira_validate → phira_preview_strip 看效果
```

## 项目结构

```
index.js            # 宿主工具注册（27 个工具）
client.js           # 侧栏面板（Web）
lib/
  rpe.js            # RPE 读写 / 归一化 / 拍秒换算
  validate.js       # 60+ 条校验（含源码核对项）
  analyze.js        # 统计 / 难度归因 / 连击里程碑
  plan.js           # 段落规划器（19 种手法调度）
  generator.js      # MIDI / 规划 → 整谱
  author.js         # 手法库 / 事件写入 / 自动收口
  effects.js        # extra.json 解析与着色器预览
  distribution.js   # 24 张参考谱面的分位与配比（已排除耐力谱）
  render.js routes.js midi.js guide.js …
docs/
  engine.md         # 引擎语义（权威速查，按 prpr 源码核对）
  FEATURES.md       # 功能清单
  WORKFLOW.md       # 制谱流程
  CHANGELOG.md      # 变更记录（含每条 bug 的成因与修法）
  difficulty-calibration.md # 难度模型 vs 25 张参考谱面的比对
  ref-src/          # prpr 关键源码摘录（GPLv3，见 NOTICE）
test/               # 12 套测试，260+ 断言
```

## 测试

```bash
node test/source_check.mjs   # 常量/语义 vs prpr 源码（19 项）
node test/run.mjs            # 25 张参考谱面回归
node test/schema_check.mjs   # 结构校验（24 项）
node test/effects_check.mjs  # extra.json / 着色器（24 项）
node test/quality.mjs        # 手感硬指标（100+ 项）
node test/smoke.mjs          # 工具冒烟（38 项）
```

`test/quality.mjs` 里的 MIDI 用例需要 `PHIRA_TEST_MIDI=/path/to.mid`，或把样例放进 `test/fixtures/*.mid`。

## AI 开发声明

本项目**绝大部分代码、文档、测试与规则来自 AI 生成**，人类只负责需求、试玩反馈与最终取舍：

- 代码/文档/校验规则：由 **DeepSeek Harness 上的 AI 代理**（模型 `deepseek-v4-flash`）编写与迭代
- 引擎语义：由 AI 阅读 prpr 源码后提炼，逐条标注文件行号（`docs/engine.md`）
- 参考谱面统计：24 张 RPE 谱面的自动统计（排除耐力谱）
- **人类角色**：提需求、试玩、指出"这句提示是错的"、决定发布
- 结论：**不要把它当作官方工具**；校验规则来自实测与源码推演，可能有误；谱面手感最终以人耳人眼为准

如果你发现某条规则与真实引擎行为不符，欢迎提 Issue/PR——请附"复现谱面 + 引擎版本 + 具体现象"。

## 许可证

- 代码与文档：**GPL-3.0-or-later**（见 `LICENSE`）
- `docs/ref-src/` 下的 prpr 源码摘录：GPLv3，归属 TeamFlos（见 `NOTICE.md`）
- 使用本工具生成的谱面：**归你所有**，不受 GPL 约束（谱面是数据产物）

## 相关

- Phira / prpr：https://github.com/TeamFlos/phira
- RPE 格式：https://github.com/Catrong/phi-plugin-nya/tree/main/RPE
- DSH：https://github.com/deepseek-ai/dsh
