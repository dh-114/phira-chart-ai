# Phira AI 谱面插件 · 完整功能清单（v1 设计基线）

> 工作区：`phira/Plug-in-code/`　｜　产出格式：**RPE JSON**（唯一）　｜　预览：**本地 Canvas 复刻 prpr**（唯一）
> 难度规则：**只警告、不拦截**　｜　AI 标识：`info.yml` + 谱面内 0–3s 文字水印

---

## 0. 插件形态

| 项 | 设计 |
|---|---|
| 类型 | DSH 插件（Host 侧工具 + Client 侧 Web 面板） |
| 输入 | 谱面目录：`info.yml` + `chart.json` + 音频（可无音频，纯编排） |
| 输出 | 校验报告、难度报告、预览帧/视频帧序列、修改后的谱面 |
| 工作方式 | AI 通过 Host 工具读写；用户通过面板可视化查看/预览 |

**所有功能分成 7 层，共 52 项能力。**

---

## 1. 指南层（Guide）—— 让 AI 会写谱

| # | 功能 | 说明 |
|---|---|---|
| 1.1 | `phira_guide` 工具 | 按主题返回规范：`format` / `schema` / `notes` / `lines` / `effects` / `timing` / `pitfalls` / `difficulty` |
| 1.2 | 技能 `phira-charting` | 载入即获得完整写作规范（本插件内置，含研究结论摘要） |
| 1.3 | 模板库 | 空谱 / 单线标准谱 / 双线交互谱 / **四面判定谱** / **垂直判定谱** / 多指谱 / 观赏特效谱 / 耐力谱 |
| 1.4 | 配方库（可复制代码） | 楼梯、交互、纵连、双押、长条内嵌、**扫线**、**四面判定**、**垂直判定**、雪花装饰、段落过渡 |
| 1.5 | 术语表 | 黄键/蓝键/粉键/长条/判定线/家音符（=用户惯称的装饰音符）等中英对照 |
| 1.6 | 常见错误清单 | 22 条（含 NaN 闪退、father 成环、textEvents 缓动、纹理线误用） |

---

## 2. 生成层（Authoring）—— AI 手动编排

| # | 功能 | 说明 |
|---|---|---|
| 2.1 | `phira_chart_init` | 从模板创建谱面目录（`info.yml` + `chart.json` + 占位音频） |
| 2.2 | `phira_chart_add_notes` | 批量加音符：`time`（拍或秒）、`type`、`x`、`line`、`above`、`fake`、`size`、`speed` |
| 2.3 | `phira_chart_add_line_events` | 批量加判定线事件：`moveX/moveY/rotate/alpha/speed`、`scaleX/scaleY/color/text/incline` |
| 2.4 | `phira_chart_add_line` | 新建判定线（位置/父线/贴图=禁用图片/attachUI/层级） |
| 2.5 | `phira_chart_patch` | 按时间窗/线/音符 ID 局部修改、删除、替换 |
| 2.6 | `phira_chart_apply_pattern` | 应用参数化手法（见 1.4），一次生成一段 |
| 2.7 | **`phira_midi_parse`** | 解析 MIDI（`.mid/.midi`）：轨道/音符/速度 → 时间轴候选（pitch→x 映射可配） |
| 2.8 | **`phira_audio_analyze`** | 分析音频：BPM/节拍网格/onset/能量包络/段落切点（用于对齐与分段） |
| 2.9 | **`phira_chart_auto_draft`** | 基于 MIDI/音频生成**草稿谱面**（节拍对齐 + 基础手法），供 AI 二次编排 |
| 2.10 | `phira_chart_set_meta` | 写 `info.yml`：定数、等级、曲师、谱师（自动加 `(AI)`）、BPM、offset、比例 |
| 2.11 | 时间轴吸附 | 所有写入按 `1/1` `1/2` `1/4` `1/8` `1/12` `1/16` 吸附，防手滑 |

---

## 3. 校验层（Validate）—— 保证不崩、不闪退

| # | 功能 | 检查内容 |
|---|---|---|
| 3.1 | `phira_chart_validate` | 一键全量校验，输出 **错误 / 警告 / 建议** 三级 + JSON 路径 + 修复建议 |
| 3.2 | Schema 校验 | 必填字段、类型、枚举、默认值（严格对齐 `rpe.rs` 的 serde 定义） |
| 3.3 | 崩溃校验（致命） | `beat` 分母为 0/NaN；**三元组 `b<0`（prpr 是 `Triple(i32,u32,u32)`，整谱加载失败）**；`father` 成环；事件 `endTime<startTime`；`easingType` 越界；`alpha` 越界；`isFake/isCover/above` 类型错；`textEvents` 带缓动（官方 issue #252）；音符 `endTime<startTime` |
| 3.4 | 语义校验 | 音符落在判定线时间范围外；事件层内重叠/乱序（乱序查**原始 JSON**，且 speedEvents 例外——引擎会自己排序）；空事件数组分「闪退（前层有关键帧）」与「静默丢值（链首）」两种；`attachUI` 冲突/非法；`visibleTime` 过小；`speed` 为 0/负；Hold 过短；`numOfNotes` 与实际不符；`judgeArea`/`size` 越界 |
| 3.5 | 资源校验 | `info.yml` 引用的 `chart/music/illustration` 是否存在；**禁止引用图片纹理**（`Texture != "line.png"` 报警告）；禁 `isGif`、`paintEvents`、`gifEvents` |
| 3.6 | 规模校验 | 线数/音符数/事件数/文件大小阈值（防卡顿） |
| 3.7 | 官方 lint 对照 | 复刻 `prpr::parse::lint` 的两项警告（新式流速事件、`attachUI`） |
| 3.8 | 自动修复 | `--fix` 模式：补默认字段、裁剪越界值、拆环、清空非法事件 |

---

## 4. 分析层（Analyze）—— 难度与可玩性

| # | 功能 | 说明 |
|---|---|---|
| 4.1 | `phira_chart_analyze` | 物量/密度/峰值/时长/音符类型/线数/事件数/假音符统计 |
| 4.2 | `phira_chart_difficulty` | 定数预测（特征加权 + 26 个参考谱面标定），输出定数、置信区间、贡献因子 |
| 4.3 | `phira_chart_playability` | 12 项可玩性检查（见下表；`collision` 曾只进 stats 不产 issue，v0.17 修） |
| 4.4 | 分段难度曲线 | 按 4–8 秒窗口输出难度热力数据（给面板画曲线） |
| 4.5 | 手指数分析 | 同刻最大手指数、各段峰值、持续时长、**四面/垂直音符占比** |
| 4.6 | 报告导出 | `report.md` / `report.json` |

**4.3 的 12 项检查**

| # | 检查 | 判定 | 级别 |
|---|---|---|---|
| 1 | 音符出界 | **屏幕位置** `\|ex\|>675`（ex = 线位移 + x·cos 旋转），非 fake | 错误 |
| 2 | 贴边 | 屏幕位置 `\|ex\|>600` 且非垂直判定线 | 警告 |
| 3 | 按键碰撞 | 同刻（±1ms）点击类（1/2/3，**Drag 不算**)横向间距：< 音符宽×0.8 → 警告；< ×1.2 → 建议 | 警告/建议 |
| 4 | 开局无准备 | 首音符 < 2s 且音频前奏不足 | 警告 |
| 5 | 多指超规格 | 同刻**需要按下**的音符数（Drag 不计）> 难度档上限 | 警告 |
| 6 | 判定线瞬移 | 单事件位移 > 675 且 < 0.1s；或速度 > 3000px/s 且音符密集 | 警告 |
| 7 | 可读性 | 音符可见时间 < 下落时间×0.5；`alpha<0` 隐藏段内有音符 | 警告 |
| 8 | 长条异常 | 时长 < 0.1s 或 > 4s（非观赏谱） | 建议 |
| 9 | 双押间距 | 双押横向间距 > 900px（单手不可及） | 建议 |
| 10 | **长条内嵌类型** | 同线长条区间内、同轨（\|Δx\|<音符宽×1.2）出现 Tap/Flick → 警告；Drag → 建议；Drag 错开车道 → 单独提示 | 警告（可关） |
| 11 | 手指数（跨音符） | 长条按住期间 + 同刻按下 > 上限 | 警告 |
| 12 | 撞键/连打/大跳 | 同线相邻（**用屏幕有效坐标**）：<140ms 且 <170px 撞键；<0.6s 且 <70px 连打；<0.3s 且 >400px 大跳 | 警告 |

---

## 5. 预览层（Preview）—— 按源码复刻

| # | 功能 | 说明 |
|---|---|---|
| 5.1 | Canvas 渲染器 | 完整复刻：BPM→秒、事件求值（5 层+extended）、floor position 积分、父子线变换、旋转缩放、4 类音符（含 Hold 头身尾）、判定区、above 翻转、lineLength、纵横比拉伸 |
| 5.2 | 指定帧渲染 | `phira_preview_frame(t)` → 单帧图（DataURL/PNG） |
| 5.3 | 多帧胶片 | `phira_preview_strip(t0, t1, n)` → N 帧网格图 |
| 5.4 | 连续播放 | 面板内播放（播放/暂停/倍速/拖动/跳转），音频同步 |
| 5.5 | 比例模拟 | 16:9 / 19.5:9 / 20:9 / 4:3 / 自定义 / `forceAspectRatio` 黑边 |
| 5.6 | 调试叠加 | 判定线 ID、判定区宽度、音符轨迹、手指数、密度条 |
| 5.7 | 报告联动 | 点击校验项/难度峰值 → 跳到对应帧 |
| 5.8 | 导出 | 帧序列（PNG 打包）；GIF/MP4 为二期 |

---

## 6. AI 标识层

| # | 功能 | 说明 |
|---|---|---|
| 6.1 | `info.yml` 写入 | `charter: "原名 (AI)"`、`tags: ["AI生成"]`、`intro` 追加声明 |
| 6.2 | 谱面内水印 | 0–3s，y≈−420，`textEvents` 线显示「本谱面由 AI 生成」，**该线不放音符** |
| 6.3 | 可配置 | 文案、位置、时长、是否启用 |

---

## 7. 面板 UI

| # | 区域 | 功能 |
|---|---|---|
| 7.1 | 文件树 | 选择谱面目录、读取 `info.yml` 摘要 |
| 7.2 | 预览画布 | 播放器 + 时间轴 + 帧步进 |
| 7.3 | 校验报告 | 三级列表、跳帧、一键修复 |
| 7.4 | 难度报告 | 定数、曲线、手指数、10 项检查 |
| 7.5 | 事件时间轴 | 判定线事件条（可筛选线/类型） |
| 7.6 | 导入 | MIDI / 音频 / 既有谱面 |

---

## 8. 工程与安全

| # | 功能 |
|---|---|
| 8.1 | 原子写入 + 每次修改自动备份（与 DSH undo 快照联动） |
| 8.2 | 只读校验模式（不落盘） |
| 8.3 | 大文件保护（>20MB 提示、分片解析） |
| 8.4 | 26 个参考谱面回归测试（解析/求值/校验零误报基线） |
| 8.5 | 生成谱面自动禁止：图片纹理、GIF、paint 事件 |

---

## 9. 配置项（默认值）

```yaml
format: rpe                 # 固定
aspect: 16/9                # 预览比例
allowImages: false          # 禁用图片/纹理线
maxFingersByDifficulty:
  "<15": 2
  "15-16": 3
  "17+": 8                  # 仅警告
holdInnerTypes: [1, 3]      # 长条内只允许黄键/粉键（可关）
aiMark:
  charterSuffix: " (AI)"
  tags: ["AI生成"]
  watermark: { start: 0, end: 3, y: -420, text: "本谱面由 AI 生成" }
launchGapSec: 2             # 开局留白阈值
collisionRatio: 1.2         # 碰撞阈值 = 音符宽 × 1.2
```

---

## 10. 每条规则的知识出处（可追溯）

| 规则 | 出处 |
|---|---|
| `beat` 分母不能为 0 | `Triple::beats` 除零 → `not_nan().unwrap()` panic |
| `father` 不能成环 | `has_cycle` 报 "infinite recursive parent relations" |
| `textEvents` 缓动崩溃 | 官方文档 issue #252 |
| 文字线永远隐藏 | 官方 RPE 文档 `extendEvent.html` |
| 纹理线缩放单位不同 | `rpe.rs` `scale: factor = texture=="line.png" ? 1 : 2/1350` |
| 世界坐标 ±1 / y±1/a | `resource.rs` camera zoom `(1, -aspect)` |
| 音符宽 13.175% | `NOTE_WIDTH_RATIO_BASE` |
| 判定半宽 11.8% | `X_DIFF_MAX = 0.21/(16/9)*2` |
| 顶到线 3.74s | `SPEED_RATIO = 10/45/HEIGHT_RATIO` |
| 扫描线实例 | `11832` 675→−550/2.7s；`37207` ±650/0.67s 往复 |
| 四面判定实例 | `54712` t=31s 四角 (±620, ±300)；`38897` t=63s 扇形 |
| 垂直判定实例 | `37207` L05 x=−650 rot=90；`54712` L33 rot=90 |
| 顶部判定线实例 | `14940` y=600；`54712` y=1000；`53602` y=620 |
| 开局围屏长条 | `14940` L06–L09 起点 y=600、alpha=0，t≈9s 扫入 |
| 长条内嵌类型 | 实测 Click > Drag > Flick（故本项为警告而非错误） |

---

## 里程碑

1. **M1 核心库**：类型/时间/缓动/求值 + 26 参考谱面回归对齐
2. **M2 校验器**：schema + 崩溃 + 语义 + 资源
3. **M3 分析器**：难度预测 + 10 项可玩性
4. **M4 预览器**：Canvas 单帧 → 多帧 → 播放
5. **M5 生成器**：模板/配方/MIDI/音频
6. **M6 面板与集成**：工具注册、UI、AI 标识、打包

---

## 实现状态（更新）

| 模块 | 状态 |
|---|---|
| lib/rpe.js（时间/BPM/29 缓动/事件求值/归一化） | ✅ |
| lib/validate.js（结构/崩溃/语义/可玩性） | ✅ 25 个参考谱面 0 error |
| lib/analyze.js（难度标定 R²≈0.93 + 10 项可玩性） | ✅ |
| lib/guide.js（11 个主题） | ✅ |
| index.js（guide/validate/analyze/chart_init） | ✅ 已安装可用 |
| lib/raster.js（光栅器 + PNG 编码） | ✅ |
| lib/font.js（5×7 点阵字体） | ✅ |
| lib/render.js（几何渲染 + 调试信息叠加） | ✅ |
| phira_preview_frame / phira_preview_strip | ✅ 代码就绪（需重载插件后出现在工具列表） |

**渲染规则（已实现）**
- 只画当前应显示的判定线：`alpha>0`、非文字线、非 attachUI 线、屏幕内；
- 假音符：默认 13% 透明度（`showFake:false` 可完全隐藏）；
- 四类音符分色：Tap 青蓝 / Hold 绿 / Flick 粉 / Drag 琥珀；
- 长条：显示区域（填充 30% + 描边）+ 胶囊头 + 尾标记；
- 调试信息：时间/总时长、BPM、物量、判定线数与可见数、上屏音符数、当前同刻数、纵横比、类型图例、底部密度总览时间轴 + 当前时间游标。

## M5 已实现（编排层）

| 工具 | 作用 |
|---|---|
| `phira_chart_add_notes` | 批量加音符（beat/sec，Hold 带 endBeat，支持 fake/size/speed） |
| `phira_chart_add_events` | 加 moveX/moveY/rotate/alpha/speed + scaleX/scaleY/color/text/incline |
| `phira_chart_add_line` | 新增判定线（位置/旋转/zOrder/attachUI） |
| `phira_chart_apply_pattern` | 10 种参数化手法：stairs/trill/jack/chord/hold/holdInner/sweep/vertical/fourSide/freeze |
| `phira_chart_ai_mark` | 写 AI 水印线 + info.yml 标识 |
| `phira_chart_set_meta` | 曲名/定数/等级/谱师/BPM/offset |
| `phira_midi_parse` | 解析 MIDI → tempo/轨道/音符候选（pitch→x） |

**同时修的两个引擎级正确性问题**
- 生成的判定线必须带 baseline `speedEvents`（否则引擎流速为 0，音符不动）；
- 出界校验要考虑判定线旋转（垂直线上 `note.x` 作用于屏幕 Y），且"恒定位移"不算"会移动"。

## 判定模型（已落地到校验与指南）

判定是**一维**的：只算沿判定线方向的距离，垂直方向完全自由（贴合 prpr `judge.rs` 的逆变换 + 局部 x 比较）。

- 容差 ≈ ±159.5 RPE 像素（≈1.8 个音符宽）；`judgeArea` 可放大，`size` 只改视觉；
- 时间窗 0.08/0.16/0.22s，且**偏移越大时间窗越窄**；
- Tap 需按下 / Hold 需按住（0.05s 宽限）/ Drag 不用按 / Flick 需突然快速滑动（方向不限）。

**校验口径（本轮修正）**
- `collision`：**同一条线**、同刻、局部 x 间距 < 音符宽×1.2 → 警告（会抢判定）；
- `visual-overlap`：跨线同刻、屏幕位置重叠 → 仅建议（多线同刻成本低）。
- 参考谱面实测：同线碰撞 **208 对/15 谱面**，跨线视觉重叠 1132 对（旧口径把跨线也算碰撞，多算约 185 对）。

**指南新增 topic**：`judge`（垂直通道判定模型），工具枚举已同步。

## M5+ 风格档案与段落规划器（AI 主导整谱结构）

**5 个风格档案**（参数取自 26 个参考谱面的中位数）

| 档案 | 参考谱面 | 密度 | 同刻 | Drag | 事件率 |
|---|---|---|---|---|---|
| lineShow 判定线主导 | 11404/11832/13474/14940/2165/24101/37207/8706 | 5.0/s | 3 | 12% | 31/s |
| multiFinger 多指 | 23375/41292/46213/54712 | 12.5/s | 14 | 23% | 12/s |
| visual 观赏 | 28063/48789/47280/38897 | 6.6/s | 12 | 42% | 63/s |
| endurance 耐力 | 23375/46213/54712 | 12.7/s | 24 | 47% | 23/s |
| balanced 均衡 | 30818/30907/53602/46779/67921/75892 | 5.7/s | 4 | 15% | 36/s |

**规划器**
- `phira_chart_plan`：按风格+时长+定数产出 8 段结构表（intro/verse/build/chorus/rest/verse2/chorus2/outro），每段含密度、步长、同刻数、手法、演出；
- `phira_chart_build_from_plan`：按表生成音符 + 判定线演出（染色/倾角/扫线/淡入）+ AI 水印，并**自动定数校准**（生成→预测→调密度→重生成，最多 4 轮）。

**实测**：目标定数 13 → 校准轨迹 11.89 → 12.27 → **12.70**，0 error / 0 warning。
