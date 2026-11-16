## v1.1 试玩反馈：黄键要成链、不要全局滤镜

| # | 反馈 | 改动 |
|---|---|---|
| 1 | 黄键太多、散落 → 手感碎 | 黄键不再由"经过音"随机降级产生；改为 `insertDragChains()` 只以**链**出现：同 x 固定 5 个、楼梯 ≥8 个（`tapDragChain` 默认值同步） |
| 2 | 楼梯段里夹按键 | 新增 `drag-stairs-mixed`（info）：≥4 连黄键且 x 单调移动时，段内不要有要按下的键 |
| 3 | 全程滤镜太暗 | 新增 `fx-global-shader`：`global:true` 或任一 shader 覆盖 >50% 曲长 → warn；默认不再建议全程 vignette |
| 4 | 零时长长条 | `fixShortHolds()`：长条 <0.3 拍直接降级成 Tap；`fixHoldTails()` 移动长条时保留原时长（之前会把它压成 0 时长） |
| 5 | 类型配比检查误报 | `type-mix` 只在"几乎没有黄键"（<2%）时才 warn，链式低占比是设计 |

# Phira AI 谱面插件（@local/phira-chart-ai）

给 AI 用的 Phira（RPE 格式）谱面工作台：**指南 / 校验 / 难度分析 / 预览渲染 / 编排 / 风格规划 / 面板**。

## 支持平台

| 平台 | 状态 | 说明 |
|---|---|---|
| Android（Termux / 内置运行环境） | ✅ 已验证 | 当前开发环境 |
| Linux x86_64 / arm64 | ✅ 应可用 | 纯 Node，无原生依赖 |
| macOS（Intel / Apple Silicon） | ✅ 应可用 | 同上 |
| Windows 10/11 | ✅ 应可用 | 已修 Windows `rename` 不能覆盖、路径大小写等差异 |

要求：**Node ≥ 18**（只用到 `node:fs` / `node:path` / `node:os` / `node:zlib`，无编译、无原生模块、无网络依赖）。

## 安装

在 DSH 里用插件管理安装本目录（绝对路径），例如：

```
plugin_manager install_bundle  target = <本目录绝对路径>
```

- 插件通过 `link:` 链接进 profile，改代码后**重启 DSH** 生效；
- 安装后自动获得 15 个工具 + 浏览器右下角的「🎵 Phira 谱面面板」。

## 谱面目录（跨平台关键）

面板与路由**不再硬编码任何设备路径**。允许访问的根目录（只保留真实存在的目录）：

1. 环境变量 `PHIRA_ROOTS`（多个用系统路径分隔符：Linux/macOS 为 `:`，Windows 为 `;`）
2. 宿主工作目录及其上两级
3. `~`、`~/dsh`、`~/phira`、`~/charts`
4. 平台常见挂载点：
   - Android：`/storage/emulated/0`、`/sdcard`
   - Linux/macOS：`/mnt`、`/media`、`/run/media`
   - Windows：当前盘符根（如 `C:\`）

默认目录依次探测 `<root>/phira`、`<root>/dsh/phira`、`<root>/.dsh/phira`，找到即用。

示例：

```bash
# Linux / macOS
export PHIRA_ROOTS="$HOME/charts:/mnt/data/phira"
# Windows (PowerShell)
$env:PHIRA_ROOTS = "D:\charts;C:\phira"
```

## 工具（Host，15 个）

| 工具 | 作用 |
|---|---|
| `phira_guide` | 写作指南（summary/format/schema/notes/lines/judge/effects/timing/pitfalls/difficulty/patterns/workflow） |
| `phira_validate` | 崩溃/结构/语义/可玩性校验（致命·警告·建议，带时间戳） |
| `phira_analyze` | 难度预测（标定口径：剔除耐力谱 23375 + 3 个作者自填异常后 21 张，MAE≈0.31）+ 12 项可玩性 |
| `phira_chart_init` | 创建 RPE 骨架（chart.json + info.yml） |
| `phira_chart_add_notes` | 批量加音符（beat/sec、Hold、fake、size、speed） |
| `phira_chart_add_events` | 加判定线事件（move/rotate/alpha/speed/scale/color/text/incline） |
| `phira_chart_add_line` | 新增判定线 |
| `phira_chart_apply_pattern` | 10 种手法：stairs/trill/jack/chord/hold/holdInner/sweep/vertical/fourSide/freeze |
| `phira_chart_ai_mark` | AI 水印线 + info.yml 标识 |
| `phira_chart_set_meta` | 曲名/定数/等级/谱师/BPM/offset |
| `phira_midi_parse` | 解析 MIDI → tempo/轨道/音符候选（pitch→x） |
| `phira_chart_plan` | 生成 8 段段落规划（5 种风格档案） |
| `phira_chart_build_from_plan` | 按规划生成 + **自动定数校准**（最多 4 轮） |
| `phira_preview_frame` | 指定时间点渲染 PNG |
| `phira_preview_strip` | 多帧胶片 PNG |

## 面板（Client）

右下角浮动面板，包含：
- 帧序列播放（4 秒窗口 / 48 帧，自动预取下一窗口）
- 时间轴拖拽、播放/暂停
- 校验报告（带时间的条目点击**跳帧**）
- 难度曲线（每秒物量 + 同刻数 + 当前时间线）
- 开关：假音符、调试信息

## HTTP 路由（只读，供面板使用）

| 路由 | 说明 |
|---|---|
| `GET /phira/info` | 平台信息、允许根目录、默认目录 |
| `GET /phira/list?dir=` | 目录浏览（仅目录，最多 300 条） |
| `GET /phira/chart?path=` | 谱面数据 + 校验 + 难度 + 曲线 + plan.json |
| `GET /phira/sheet?path=&t0=&t1=&n=&w=` | 帧序列雪碧图（响应头带 x-frames/x-cols/x-frame-w…） |
| `GET /phira/frame?path=&t=&w=` | 单帧 PNG |

所有路径都经过根目录白名单校验，越界请求返回 400。

## 测试

```bash
node test/platform_check.mjs   # 跨平台自检（路径/根目录/中文路径/无硬编码）
node test/schema_check.mjs     # 15 个工具 schema 合法性
node test/smoke.mjs            # 真实执行 6 个工具
node test/routes_check.mjs     # 路由（list/chart/sheet/frame/越界拦截）
node test/run.mjs [参考铺面目录] # 25 个参考谱面回归（0 error 基线）
```

参考铺面目录默认取 `<插件目录>/../../参考铺面`，也可用 `PHIRA_CHARTS` 指定。

## 已知限制

- 面板只做**视觉渲染**，不模拟判定、不打分、不评估手感；
- 预览按谱面 `aspectRatio` 渲染；`forceAspectRatio` 的黑边在面板中暂未模拟；
- 大谱面（>2 万音符）抽帧会明显变慢，面板窗口内帧数可下调。

## 面板形态（v0.2）

- **挂载在会话作用域**（`conversation.input.dock`）：只在对话页出现，首页/设置页不出现；
- **默认折叠**为右下角小药丸「🎵 Phira 面板」，不遮挡内容；
- **响应式**：宽屏为右侧卡片（≤600px），窄屏（≤640px）自动变成底部全宽抽屉，按钮高度 ≥42px，兼容安全区（`env(safe-area-inset-bottom)`）。

## 跨平台验证记录

| 环境 | 结果 |
|---|---|
| Android arm64 / Node 24 | platform / schema / smoke / routes / 25 谱面回归 全部通过 |
| Ubuntu 22.04 x86_64 / Node 20 | platform / schema / smoke / routes 全部通过；渲染几何统计与 Android 完全一致 |

同一帧（t=30s, 640px）两平台渲染统计：`notes 830 / lines 26 / drawn 6 / vis 17 / chord 2 / 640×360 / bpm 136` —— **完全一致**。
PNG 字节哈希略有差异（ARM 与 x86 的浮点舍入 + zlib 版本不同），属正常现象，视觉上无差别。

> 桌面端首次运行建议先跑：`node test/platform_check.mjs`。

## 面板 v0.3（本地渲染 + AI 联动）

- **播放**：改为浏览器内 `requestAnimationFrame` 渲染（不再请求帧序列），60fps 连续播放；
- **AI 指定谱面**：工具 `phira_panel_open(path)` → 面板 1–2 秒内自动切换；
- **自动刷新**：面板每 1.5s 轮询 `/phira/state`，谱面文件 mtime/size 变化时自动重新加载（AI 改谱后面板即时更新）；
- **新增路由**：`GET /phira/data`（紧凑渲染数据）、`GET /phira/state`（面板状态）。

## 音频（v0.4）

- **背景音乐**：`GET /phira/music?path=` 流式输出谱面 `info.yml` 的 `music` 文件，支持 HTTP Range（可拖动）；
- **按键打击音效**：`click.ogg / drag.ogg / flick.ogg` 随插件分发在 `assets/sfx/`（来自 Phira `assets/`，跨平台自包含），通过 `GET /phira/sfx?name=` 提供；
- 触发规则与 prpr `judge.rs` 一致：**判定命中时**播放，`Click/Hold → click`、`Flick → flick`、`Drag → drag`，并支持音符自带 `hitsound`（未知文件回落到默认）；
- 面板提供「音乐 / 音效」两个开关；播放器暂停时音频同步暂停，拖动时间轴会 seek 音频。

## 源码一致性校验

`node test/source_check.mjs`（需要同目录有 `../source code/prpr/src`，否则自动跳过）逐项比对：

| 项 | 来源 |
|---|---|
| RPE 画布 1350×900 | `parse/rpe.rs` |
| NOTE_WIDTH_RATIO_BASE 0.13175016 | `core.rs` |
| HEIGHT_RATIO 0.83175 → SPEED_RATIO | `core.rs` / `parse/rpe.rs` |
| FADEOUT_TIME 0.16 | `core/note.rs` |
| 判定窗口 0.08 / 0.16 / 0.22 | `judge.rs` |
| X_DIFF_MAX = 0.21/(16/9)*2 | `judge.rs` |
| 关键帧 tween 0 = 阶跃、事件空隙保持 | `core/tween.rs` / `parse/rpe.rs` |

## v0.5 修复（来自 MIDI 实战测试）

| 问题 | 修复 |
|---|---|
| `sec` 参数被当拍 | `beatOf` 改 `/[a-z]?sec$/i`，`sec`/`startSec`/`endSec` 都按秒 |
| MIDI/规划只按单一 BPM | `midiToChartNotes` / `planChart` 支持 `bpmList`（RPE 格式），多 BPM 用 `bpm.beatAt()` |
| `ai_mark` 重复追加 intro | 幂等：已含标识不再拼接；tags 去重 |
| 校验器不查资源文件 | `phira_validate` 检查 `info.yml` 的 music/illustration/chart 是否存在（缺失 → error） |
| 校验器拦不住闪退写法 | 新增 `empty-event-array`(error，查**原始 JSON**)、`zero-duration-event`(warn)、`unsorted-events`(warn)、`num-notes-mismatch`(info) |
| 文字不渲染 | 宿主渲染器画 ASCII 点阵；面板用 canvas `fillText`（支持中文） |
| `makeLine` 兜底事件挡后续事件 | 基线事件只覆盖 1 拍（之后按「保持」语义），不再写空数组键 |
| `applyAIMark` 丢 moveY / 无清屏 | 保留图层；`endBeat+1` 写空串清屏；到点 alpha 淡出 |
| `fourSide` 上下颠倒/贴边 | Top `y=+450`、Bottom `y=-450`、左右 `±620` |
| `vertical` 音符同一 x | 沿线按 `span` 均匀分布 |
| `numOfNotes` 漏算 Hold | 统计所有非 fake 音符 |
| 校准 4 轮仍差 0.8 | 8 轮、步长 1.22/1.09、容差 0.25 |
| `midi_parse` 把 16 分音符标成 Hold | 阈值可配 `holdThresholdSec`（默认 0.25s），并返回 `truncated` |
| 没有 patch 工具 | 新增 `phira_chart_patch`：`prune-empty` / `sort-events` / `delete-notes` |

## 工作流优化

- `phira/引擎语义速查.md`：所有已核实的引擎语义集中在此，**不再重复 grep Rust 源码**；
- 根目录 `AGENTS.md`：约定先读速查表、改完必跑 6 个测试；
- `phira_guide` 新增 `engine` 主题，工具内即可查核心 8 条。

## 给 AI 的指南（v0.6）

`phira_guide` 现在有 15 个主题，重点：

| topic | 内容 |
|---|---|
| `engine` | 引擎语义速查：坐标/时间、事件求值（tween 0、保持、跨层相加、关键帧不排序、空数组 panic）、渲染、音符、判定、资源、坑、验证命令 |
| `platform` | 跨平台兼容：路径（禁止硬编码、`PHIRA_ROOTS`、`import.meta.url`）、文件（UTF-8 无 BOM、Windows rename、大小写）、音频（Range、WebAudio）、渲染（纯 JS 光栅器 / Canvas） |
| `doc` | 完整文档 `docs/engine.md`（随插件分发，任意设备可读；找不到时回退内置摘要） |

`docs/engine.md` 与 `phira/引擎语义速查.md` 内容一致，插件内那份是权威版（`guide('doc')` 优先读它）。

自检：`node test/guide_check.mjs`。

## v0.7 着色器支持

Phira 的后处理在 `extra.json`（不在 chart.json 里）：

```json
{ "bpm": 136,
  "effects": [{ "shader": "grayscale", "start": [0,0,1], "end": [8,0,1],
                "global": false, "vars": { "factor": 1 } }] }
```

| 能力 | 实现 |
|---|---|
| 10 个内置着色器 | `lib/effects.js` 用 JS 逐像素近似实现，`phira_preview_frame/strip` 会真正应用 |
| 自定义着色器 | `shader: "/xxx.glsl"` + `phira_chart_add_shader` 写文件并解析 `uniform ...; // %默认%` 参数 |
| 参数 | 支持固定值 / 颜色 / 关键帧数组（RPE 保持+插值语义） |
| 写入 | `phira_chart_add_effect`（自动沿用谱面 BPMList，可 append/replace） |
| 校验 | 未知 shader、自定义文件缺失、时间范围非法 → error；vars 类型异常 → warn |
| 指南 | `phira_guide(topic="shader")` |

测试：`node test/effects_check.mjs`（20 项）。

## v0.8 修改能力与自动风格

### 改谱：`phira_chart_patch`
| op | 作用 |
|---|---|
| `update-notes` | 按 `line/fromBeat/toBeat/types/minX/maxX` 筛选，改 `x/xShift/type/alpha/size/speed/fake/beat/beatShift/endBeat` |
| `delete-notes` | 同套筛选条件删除 |
| `clamp-x` | 越界音符拉回 ±limit |
| `set-line` | 判定线基线 `x/y/rot/alpha/speed` |
| `delete-line` | 删整条线并修正 `father` |
| `prune-empty` / `sort-events` / `dedupe-events` | 清理空数组、排序、去重 |

### 风格不再由 AI 手选
`phira_chart_plan` 的 `style` 默认 `auto`，传 `midiPath` 会解析 MIDI 得到
平均密度/峰值/复音/长音占比，自动选 `multiFinger`/`endurance`/`lineShow`/`visual`/`balanced`，
并输出**选择理由**。

### 校验补强（原来漏报的原因）
- `hold-overlap`：同线两根长条时间重叠（原来没有这条规则）
- `hold-inner`：音符落在同线长条身体内且横向重叠（`holdInnerTypes` 之前声明了但没实现）
- `fingers`：按定数自动封顶（<15→2、<17→3、<18→5），不再依赖手动传 `maxFingers`
- `maxChord` 只统计真音符（假音符不算手指）
- `strict: true` 时以上升级为 error

## v0.9 给 AI 更大自主权

| 能力 | 说明 |
|---|---|
| `phira_chart_edit` | 通用 JSON 编辑：按点号路径 `set / delete / append` 任意字段（含工具未封装的 paintEvents/gifEvents/posControl） |
| `phira_chart_plan` `style:"custom"` | 自定义段落（name/frac/density/chord/tech/fx），不必受 5 种固定风格限制 |
| 音符扩展字段 | `add_notes` 透传 `tint` / `hitsound` / `extra`（任意 RPE 合法字段） |
| 校验分级 | error 必须为 0；warn/info 作为建议，AI 可权衡保留并在交付说明里写清 |
| 指南 | `workflow` 主题新增「AI 的自主权」：工具是助手不是枷锁、可以不用 plan 自己生成、能判断的不问用户 |

冒烟测试覆盖：通用编辑（改 META/音符 x/追加 extended 事件）+ custom 规划。

## v0.10 新手法：holdMelody（长条内嵌旋律）

```js
phira_chart_apply_pattern({ path, pattern: 'holdMelody', params: {
  line: 0, startBeat: 8, beats: 4, x: 0,
  melody: [-300, -150, 0, 150, 300],   // 可选：一般来自 MIDI 旋律 pitch→x
  types: [4, 3],                        // 黄键 Drag / 红键 Flick 交替
  count: 4, spread: 120, offsetBeat: 0.5, tailBeat: 0.5,
}})
```

- 先放一根长条，再在长条身体内按 melody（或均匀分布）放 Drag/Flick；
- 校验口径调整：**Tap / Flick / Drag 内嵌长条属于正常写法**（info 级 `hold-inner-ok`），
  只有不被允许的类型（如 Hold 内嵌、或显式配置外的）才 warn，`strict` 下升级 error；
- `holdInnerTypes` 默认改为 `[1,3,4]`。

## v0.11 新手法（对应上下双线/反向下落/长条+红键/假线压音）

| 手法 | 作用 |
|---|---|
| `mirrorLines` | 上下两条互为主判定线，第二条 rot=180（x/y 双翻转），音符反向落下 |
| `belowDrag` | 黄键从屏幕下方升到主判定线（`above=0`），坐标按 melody/pitches |
| `crossLines` | 上下双线：下方音符打上线、上方音符打下线；给 beats 生成一对长条 |
| `holdFlick` | 长条起点同时出现红键（可 `flickDx` 微移） |
| `fakePulse` | 假判定线随旋律压音：scaleY 脉冲 + moveY 浮动，可复用开局/休息段 |
| `holdFlickMelody` | 一只手按长条、另一只手按旋律打红键（自动避开长条车道，`minGap`） |

旋律参数统一支持：`melody: [x...]` 或 `pitches: [midi...] + span`（自动映射到 ±span）。

## v0.12 指南扩展

`phira_guide` 新增/重写四个主题：

| topic | 内容 |
|---|---|
| `glossary` | 专有名词：RPE/PE/`.pez`/判定线/事件层/时间三元组/offset/Tap/Hold/Flick/Drag/假音符/双押/楼梯/交互/纵连/流速/缓动/压音/倾角/attachUI… |
| `reference` | 参考谱面统计：音符构成、事件分布、手法计数、缓动偏好、间隔中位、主线高度、休息段 |
| `patterns` | 全部 17 种手法：参数 + 什么时候用 + 参考计数 + 按难度/段落的选型 |
| `shader` | 10 个内置着色器的参数与使用场景、编排建议、自定义 GLSL 模板 |

测试 `test/guide_check.mjs` 会校验这些主题的关键内容是否齐全。

## v0.13 指南内置参考源码

- `docs/ref-src/`：9 个 prpr 源码文件（core/note/line/anim/tween/effect、parse/rpe、parse/extra、judge），共 4225 行，**只读参考**，附 `NOTICE.md`（GPLv3、上游路径、不被插件引用）。
- `phira_guide(topic="source")`：精选 7 段源码摘录 + 解读（事件关键帧、音符变换、线渲染、速度积分、判定窗口、extra.json、常量表），并给"何时该去翻完整文件"的建议。
- 测试：`test/guide_check.mjs` 校验 9 个文件存在 + NOTICE + source 主题关键词。

## v0.14 按参考分布生成音符

新增 `lib/distribution.js`。**统计口径已剔除耐力谱 23375**（693s / 13,868 音符 / 黄键 61%，
单张就占全库 38%，之前「中线 25.8%」「同刻 p50 260」其实都是那一张谱的形状）：

| 分布 | 实测（24 谱 / 22,752 真音符） |
|---|---|
| x 分位 | p10 −390 / p25 −241 / p50 0 / p75 253 / p90 390 |
| \|x\| 分位 | p25 130 / p50 **248** / p75 375 / p90 405；>400 占 **17.9%**，>500 仅 0.3% |
| \|x\| 分桶 | 0–50 **14.6%**、100–150 14.7%、400–450 **13.4%**，其余 4–11% |
| 同刻同线间距 | p25 300 / p50 506 / p75 675（写谱用 300/500 两档，必须 ≥213.5） |
| 相邻横跳（<0.6s） | p50 270 / p75 506 / p90 675 |
| 类型占比 | Tap 56.9% / Drag 24.9% / Hold 13.0% / Flick 5.3% |

`materializePlan` 改为按分布摆放：`stairsRange` 定范围、`chordXs` 定同刻间距（**先压缩间距再排布**，
保证 ≥213.5px，不再逐点 clamp 把 5 指和弦挤成 40px）、trill 摆幅与 stairs 外侧用 `sampleX` 采样、
收尾**纯平移**把中位拉回 0（p50=0，不再整体缩放——缩放会把同刻间距一起压扁）、13 级不加倾角。

测试 `test/distribution_check.mjs`（22 项）：采样分布、同刻间距、3 个随机种子的生成结果都要落在参考区间。

## v0.15 千本樱实战 bug 修复

| # | 问题 | 修复 |
|---|---|---|
| 1 | `add_effect` 写 RPE 的 `bpm:[{bpm,startTime}]`，prpr 的 `BpmForm` 只认 `数字` 或 `[{time,bpm}]` → 整个 extra.json 解析失败 | 新增 `bpmFormOf/normalizeBpmForm`，写入合法 BpmForm 且能自动修旧文件；校验加 `extra-bpm-form` error |
| 2 | `vec4` 参数写成浮点，prpr 要求 `[u8;4]`（0–255 整数） | 校验加 `effect-var-type` error |
| 3 | `raster.line()` 在 width=1 时**整条画不出来**（1920 宽下采样不到像素中心） | 最小半径 0.71 + 步进 ≤0.35px；回归测试覆盖 |
| 4 | `build_from_plan` 均匀步长 + 随机 x → 662 key-clash / 727 jack | 生成器加最小步长(≥140ms)、jack 改 90px 交替、hold 间隔≥1.25 拍、stairs 按数量限幅；新增 **生成后松弛**（撞键/同点/大跳/长条重叠收敛到 0） |
| 5 | `update-notes` 的修改项必须写 `op.set`，写在顶层会"匹配但不改" | 兼容顶层字段（保留 `op.set`） |
| 6 | `fakePulse` 只有 scaleY、alpha 默认 255 → 假线整曲挂着 | 自动补淡入/淡出 alpha 事件 |
| 7 | `parseMidi` 只吃 Buffer，脚本直用报"缺少 MThd" | 支持直接传文件路径 |
| 8 | 自定义着色器 `smoothstep(1.05, 0.12, …)` 边界反序 | `add_shader` 写入前拦截；编译失败会导致整个谱面加载失败 |
| 9 | `vars` 裸数字被插件忽略（prpr 的 `ExtAnim::Fixed` 是合法的） | 解析器接受数字/固定数组 |
| 10 | 校验器把**长条头重复计数**（按住中 + 新按下），误报 finger-overload | 只统计 t 之前开始的长条 |

回归测试新增：1px 线可见、生成器 0 warning、patch 顶层兼容、smoothstep 拦截、extra bpm/var 校验。

### 追加修复（v0.15）
- **校验器读取 `info.yml` 的 `useRpe170Speed`**：已开启时，非 1 缓动的 speed 事件从 warn 降为 info（`new-speed-easing-enabled`）；工具与面板两条路都生效。
- 千本樱谱面复检：**0 error / 0 warning / 3 info**（10 个特效解析正常，含自定义 `petalglow.glsl`）。

## v0.16 判定线降级 + 一键工具

**判定线不再是风格轴**：删除 `lineShow` 风格；主线默认静止（只保留段落变色）；倾角默认禁用（参考 25 谱 1089 个 incline 事件值全为 0）；开场/休息自动压音线（最多 2 条）。

**左右手分侧**：乐句按半屏分配（一手一半），同刻和弦对称居中；校验新增 `hand-balance`（一侧 <25% 报 warn）。

**双判定线 `dualLines`**：上下各一条都带音符，y ±300（可配）、x 镜像、底部旋转 180°、单段 ≤32 拍、BPM ≥160 直接拒绝。

**密度相关手感校验**（默认 warn）：`drag-crowd`（双押 0.12s 内的黄键）、`hand-load`（0.15s 窗口内手指数超上限）、`key-clash`/`jack-repeat`/`big-jump`/`finger-overload`/`hold-collision`。

**一键工具（省 token）**：
- `phira_chart_generate` —— MIDI 一次生成整谱（不再让 AI 重写生成器脚本）
- `phira_doctor` —— 一次体检：解析/资源/校验/难度模型各项贡献（不再让 AI 读源码）
- `phira_chart_batch` —— 一次调用顺序执行多条谱面操作

`phira_analyze` 现在输出难度公式每一项的贡献，AI 不需要读 `analyze.js` 源码。

## v0.17 手感/质量重做（源码级回归）

这一轮不是加功能，而是把「生成出来的谱面能玩」和「校验器说真话」这两件事做扎实。
每一条都回到 prpr 源码确认过依据（`test/source_check.mjs` 已扩到 **18 项**自动比对）。

### 一、一键生成（source=midi，默认）重写：构造即合规

旧实现把 MIDI 起音直接映射成音符，**自带 153 处长条重叠、168 处长条内嵌撞车、218 处手指数超限**
（自己的 `phira_validate` 就会报）。现在按手感硬指标重新合成：

| 规则 | 依据 |
|---|---|
| 长条时长自动收在下一个音符之前，同刻只有一根长条 | 长条按住期间第二条要第二根手指 |
| 长条按住期间只放 Drag（自动判定、不占手指），绝不放 Tap/Flick | `judge.rs`：Drag 只要触点在 `X_DIFF_MAX` 内经过就 `PreJudge` |
| 双押只在整拍、无长条激活、间隔 ≥0.45s，且两键间距 ≥213.5px | 一个触点只判**最近的那个**音符（`judge.rs` 的 `closest`） |
| 相邻横移按间隔分级限速（<0.3s 限 320 / <0.5s 限 300） | 手速上限 |
| 间隔 <150ms 的经过音一律转 Drag 并贴住上一个音符的 x | 16 分经过音当 Tap 会 62ms 撞键 |
| 前奏留白默认 2s | 首音符贴脸 |
| 定数默认按**实测值**写 info.yml（`lockDifficulty=true` 可锁目标） | 先测后标，避免"为凑定数硬塞音符" |

实测（`[Air]鸟之诗.mid`，3 分钟）：旧版 824 音符 / 4 warn；新版 622 音符 / **0 error 0 warn**，
首音符 2.0s，预测 10.79 → info.yml 写 10.8。

### 二、特效减负：`effects` 档位

| 档位 | 内容 | 3 分钟谱事件数 |
|---|---|---|
| `off` | 只有判定线 + AI 水印 | 9 |
| `light`（默认） | + 1 段假线压音；plan 模式再加判定线换色 | 30（plan）/ 9（midi） |
| `normal` | + 演出线、扫线、淡入（旧行为） | 87 |

### 三、校验器修掉的坑（每条都有源码依据 + 回归用例）

| # | 问题 | 依据 |
|---|---|---|
| 1 | `unsorted-events` 是死项（读的是 normalize 后已排序的数组，永不触发） | 只有 `parse_speed_events` 会 `sort_by_key`，通用 `parse_events` 不排序 |
| 2 | 空事件数组只认「闪退」，漏了「静默丢值」：链首空数组会让 `now_opt()` 返回 `None`，后面各层事件全丢 | `anim.rs` `now_opt()` + 调用方 `unwrap_or(默认值)` |
| 3 | `finger-overload` 漏算长条头（毫秒取整后 `|sec-t|<1e-6` 不成立） | — |
| 4 | `maxChord`/`fingers` 把 Drag 当手指（1 Tap + 2 Drag 报"需要 3 根手指"） | Drag 不占手指 |
| 5 | `note-oob` 分级错：加一条 0→10 的 moveX 呼吸就能把真出界 error 洗成 info；局部 700 + 整线 -100（屏幕内）反而报 error | 引擎音符坐标 = `position_x/675`，看屏幕位置 |
| 6 | 同线同刻 `collision` **只进 stats 从不产出 issue**（engine.md §7 第 9 条实际失效），现在分两级：<音符宽 0.8 告警、<1.2 提示 | 参考谱面实测 p5≈203px，213px 一刀切会让 15/25 张正经谱面都报警 |
| 7 | 长条内嵌 Drag 不看横向距离（对面 1200px 也算"同车道标准写法"） | — |
| 8 | `hand-load` 重叠窗口重复计数 + 文案「需 3 指」（其实是先后按） | — |
| 9 | `dragRatio`/`byType` 把假音符算进难度（500 个假 Drag 让定数掉 1.25） | 假音符不判定 |
| 10 | `densityPeak` 用 `floor(sec)` 绝对秒桶，同一段爆发平移 0.5s 峰值减半 | — |
| 11 | `jack`/`key-clash`/`big-jump` 用逻辑 x，扫线时该报大跳不报、误报同位置连击 | 玩家按屏幕位置出手 |
| 12 | `numOfNotes=0` 漏报（`declared > 0` 把 0 当"没写"） | — |
| 13 | playability 的「碰撞」「开局」两项是死代码（`stats()` 不返回 `firstSec`/`collisions`） | — |
| 14 | `predictDifficulty` 不返回 `terms`，`phira_doctor` 的公式明细永远不打印 | — |
| 15 | 负拍写出 `b<0` 的三元组（prpr 是 `Triple(i32,u32,u32)`），整张谱直接打不开，而校验报 0 error | `parse/rpe.rs` 的 serde 定义 |
| 16 | `extra.json` 的时间用 chart 的 BPMList 换算（应该用它自己的 `bpm` 字段） | `parse/extra.rs`：`let mut r: BpmList = ext.bpm.into();` |
| 17 | `relaxGenerated` 把"跨侧换手"当 jack 连打 → 每张规划谱 6–11% 音符被推到 ±560 墙边 | — |
| 18 | 收尾长条与末段内容对账缺失 → 同刻双长条 / 26ms 长条；864 组参数里 100 组 hold-overlap、270 组 hold-short | — |
| 19 | 秒级阈值用 `plan.meta.bpm` 而非谱面 BPMList，多 BPM 下 140ms 最小间隔失效（实测 83ms） | — |
| 20 | `apply_pattern` 不夹 x → x=900 直接写出 `note-oob` error；`hold`/`holdFlick`/`holdMelody` 默认参数自己违规 | — |
| 21 | `chordXs` 逐点 clamp → `chordXs(5,gap520)=[-560,-520,0,520,560]`（相邻 40px） | — |
| 22 | MIDI 第一个 tempo 不在 tick 0 时整曲时间被拉伸（SMF 规定此前按 120BPM） | SMF 规范 |
| 23 | 面板白屏：`density[floor(sec)]++` 让 33 万长数组进客户端 `Math.max(...dens)` 栈溢出 | — |
| 24 | 工具层绕过根目录白名单（`resolvePath` 是裸 `path.resolve`）；渲染尺寸无上限（width=200000 → 83GB） | — |
| 25 | `null` 元素 / 字符串 `eventLayers` 让 normalize 与 validate 抛 TypeError | — |

### 四、回归

```bash
node test/quality.mjs      # 50 项：上面每一条的断言（新增）
node test/source_check.mjs # 18 项源码一致性（扩充）
```

864 组规划参数扫描（风格 × 难度 × seed × 时长）：**0 error 0 warning**。

## v0.18 盲测反馈（第三方只用工具、无任何提示）

给一个"什么都不知道"的智能体只喂 MIDI+音频，让它自己做谱 + 自己测插件。结果：

- 成品：622 音符 / 3 线 / 16 事件 / 首音符 2.00s / **0 error 0 warn 0 info**，自标 10.8（没硬凑 13），打包 `.pez` 可导入；
- 插件测试：26 个脚本 217 条断言全过、25 张参考谱回归 0 error；
- 它**自己发现了 1 个我漏掉的真 bug**，以及 3 类小问题。

### 已修（来自这次盲测）

| # | 问题 | 修复 |
|---|---|---|
| 1 | **同键事件区间重叠**既不被校验、也不被预览复刻：演出线 alpha 同时有 `0→1拍 255` 与 `0→2拍 0→110`，`parse_events` 按数组顺序压关键帧 → 实机前 0.5s 满亮再突降，预览却是平滑淡入 | 新增 `fixEventOverlaps()`（同键按开始排序、前一个提前收口、丢零时长），生成两条路径出口都调用；校验新增 `event-overlap` warn（参考谱 24/25 张为 0，唯一有的是已排除的耐力谱） |
| 2 | `phira_midi_parse` 默认 BPM 写死 180，与输出里自报的 Tempo 120 矛盾 → 按它换算整谱错位 | 默认取 MIDI 首个 tempo，并在输出里标注「换算用 BPM」 |
| 3 | `phira_chart_generate` 不收 `charter/composer/illustrator`，传了被静默忽略 | 补进 schema 并透传 |
| 4 | 生成时 `META.name/charter/level/song` 是占位值（IN Lv.1 / song.mp3），与 info.yml 对不上且没人查 | 生成后 `syncMeta()` 与 info.yml 同步；没有对应资源时删掉占位键；`phira_validate` 新增 `meta-info-mismatch`（info） |
| 5 | 新建 info.yml 有首行空行 | `writeInfo` 跳过空首行 |

### 已确认不是 bug（不改）

- **966 个 MIDI 音符 → 622 个谱面音符**：同一 1/16 格的和弦音会被合并/按风格取舍（双押只在整拍），是设计；不是"丢音"。
- **`analyze` 不报"跨手大跳"**：`big-jump` 只看"同一只手"，左右手交替不算单手横移，这是刻意口径。
- **预览渲染不了中文**：字体只有点阵 ASCII，属已知限制（文档已写）。
- **MIDI 轨道名乱码**：多数 MIDI 用 GBK 存轨道名，Node 无内置解码；不影响谱面数据。

## v0.19 导入报错修复（extra.json 的 Variable 形状）

**现象**：谱面导入 Phira 直接失败 ——
`Failed to parse extra / data did not match any variant of untagged enum Variable at line 23 column 9`。

**根因**：`extra.json` 里 `vars.color` 写成了 0~1 浮点（`[0.02, 0, 0.1, 1]`）。
prpr 的定义是 `Variable = Float | Vec2 | Color([u8;4])`（serde untagged），
Color 的 4 个分量是 **u8**；0~1 浮点让三个变体全不匹配 → **整个 extra.json 解析失败 → 整张谱打不开**。
插件的校验器当时只检查「关键帧里的颜色」，**裸值完全没查**，所以 0 error 放行了。

### 修了什么

| # | 位置 | 修复 |
|---|---|---|
| 1 | `lib/effects.js` 校验器 | 按 prpr 形状严格校验**裸值**：`null`=Default、数字=Float、`[数,数]`=Vec2、`[0–255 整数×4]`=Color；其余直接 `effect-var-type` error。关键帧额外要求：必有整数 `easingType`、整组同一类型（untagged 只挑一个 V） |
| 2 | `lib/editor-tools.js` 写入器 | `add_effect` 写盘前规范化 vars：4 元素若统一为 0~1 → **自动 ×255**；长度/范围非法直接抛错（不再把打不开的文件写出去） |
| 3 | `lib/author.js` | 音符 `tint` 与 `color` 事件同样是 `RGBColor = [u8;3]`，写入时统一走 `normRGB()`（0~1 自动换算，长度不对抛错） |
| 4 | `lib/render.js` | `renderFrame(chart, info, t)` 的 `t` 非数字时给明确错误，而不是在叠字里抛 `toFixed of undefined` |

### 回归

- `test/quality.mjs`：+10 项（裸值 Float/Vec2/Color/Default/3 元素、`normRGB` 三条、tint/color 事件写入换算）
- `test/smoke.mjs`：+2 项（工具层写入时 0~1 → 0–255 换算、写出的 extra.json 解析 0 error）

## v0.20 试玩反馈（第二轮）

| # | 反馈 | 插件侧改动 |
|---|---|---|
| 1 | 长条结束后**立马**跟按键（尤其蓝键和长条）做不到 | 新增 `hold-tail-press`：长条结束后 100ms 内、同车道接要按下的音符 → warn。生成器长条尾后统一留 0.5 拍（MIDI 与 plan 两条路径） |
| 2 | 开局/休息段要假判定线压音（出现—移动—旋转—消失卡点） | `fakePulse` 增强：默认加每拍上下浮动 + `rotDepth` 卡点旋转 + alpha 闸门（淡入/淡出），并自动收口事件重叠；生成器开场/休息默认开 |
| 3 | 生成器写的数据类型要和源码对齐，浮点写进整数字段要报错 | `validate` 的整数字段扫描补齐（控制事件 `easing`、`tintHitEffects` 等），导出 `INTEGER_FIELDS`；`test/source_check.mjs` 新增一项：把这份清单和 `parse/rpe.rs`（+ `core.rs` 的 Triple）逐字段比对，源码加了整数字段而清单没跟上就会失败 |
| 4 | 踩过的坑写进指南 | `phira_guide(topic="playability"/"patterns")` 新增「试玩反馈沉淀」九条：长条尾接键、特效别盖判定线、类型配比、同侧窄跨度连打、竖线贴边且短、双线上线 above=0/下线 1、每 30s 单侧 ≤62–70%、长条内嵌用同车道、跟主旋律不追全音符 |

另外这轮还加了：`type-mix`（类型配比偏离参考）、`same-side-stream`（同侧窄跨度连打）、`fx-distort-line`（强扭曲盖判定线）、`hold-inner-none`（全谱无长条内嵌提示）、`melodyOnly` 生成选项。

## v0.21 终检（全量审计后修的 4 个 bug）

| # | 问题 | 修复 |
|---|---|---|
| 1 | `generateChart({source:'plan'})` 不给 MIDI 直接抛 `MIDI 不存在: undefined`（plan 模式根本不用 MIDI） | 只在 `source==='midi'` 时校验 MIDI；plan 分支的 `mid` 允许为 null |
| 2 | plan 模式长条尾后紧跟按键（`hold-tail-press`） | 新增 `fixHoldTails()`：尾后 0.5 拍内的同车道按键 → 后移 → 换车道 → 降级黄键（用真实三元组分母算拍，之前写死 192 会错） |
| 3 | `styles.js` 里写了 `params.drag`（0.15–0.47）但**从来没用过** → 所有风格都 97–98% Tap，`type-mix` 报警 | 新增 `applyStyleDensity()`：按风格 drag 比例把 Tap 降级成黄键；只降级同刻最外侧的音、且黄键间隔 ≥0.35 拍（否则 `drag-crowd`） |
| 4 | `materializePlan` 里拿不到 `style`（风格在 `plan.meta.style`） | 从 `plan.meta.style` 取；顺带修掉了误插在演出线函数里的调用 |

终检脚本 `.tmp/final-audit.mjs` 覆盖：参考谱面回归（25 张 0E）、生成器 sweep（18 次生成 0E/0W）、10 种内置着色器写入回读、压音线模板（alpha 首帧 0s / 无 alphaControl / 默认无 scaleY）、文档镜像与 20 个指南主题、成品（0E/0W、压音可见 2.4%）。
