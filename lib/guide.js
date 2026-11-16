/**
 * 给 AI 的谱面写作指南（来自源码 + 26 个参考谱面实测）
 * 纯 JS、无外部依赖；文档通过 import.meta.url 相对定位，跨平台可用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TOPICS = ['summary', 'engine', 'platform', 'doc', 'shader', 'glossary', 'reference', 'source', 'playability', 'format', 'schema', 'notes', 'lines', 'judge', 'effects', 'timing', 'pitfalls', 'difficulty', 'patterns', 'workflow'];

const T = {};

T.engine = `# 引擎语义速查（已对 prpr 源码核对）

> 完整版：\`phira/引擎语义速查.md\`（工具内用 topic=doc 直接读）。**先读这里，不要重复 grep Rust 源码。**

## 1. 坐标与时间
- 画布 1350×900，x∈[-675,675]，y∈[-450,450]，原点中心，**+y 向上**。
- 屏幕映射：X%=(x+675)/1350，Y%=(450-y)/900。
- 时间三元组 [a,b,c]=a+b/c 拍，**c 必须 >0**（c=0 → NaN → 引擎 panic）。
- 旋转：RPE 值 R → 引擎 -R；竖直线 = ±90。
- 内部一律用**秒**做时间单位；拍只在写入/阅读时换算一次。

## 2. 事件求值（最容易搞错）
- 每个事件生成两个关键帧：start（用事件缓动）与 end（**tween 0 = 阶跃**）。
- **事件之间的空隙「保持」上一事件的结束值，绝不插值。**
- 多层事件用 chain 后 **逐层相加**（写增量，不是绝对值）。
- **关键帧不排序**：数组顺序即时间顺序，写入必须按 startTime 升序。
- 不要写「撑到 9999999」的兜底事件，它会挡住后面的关键帧（保持语义下也没必要）。
- **空事件数组**（第 2 层起、同键在上层有事件）会让 anim.rs 的 unwrap panic；正确做法是**删键**。
- **零时长事件**（startTime == endTime）多数实现会跳过；拿它做 alpha 闸门会失效。

## 3. 判定线渲染
- Normal 线（Texture=line.png）是细线：厚度 0.01 世界单位（≈屏宽 0.5%），长度 ±lineLength（默认 6）。
- 只有普通线/贴图/文字/粒子四种，**没有三角形图元**；画面里的斜带通常是曲绘、音符身体或特效。
- 文字线：有 textEvents 就不画线只画字；文字取「最后命中的事件」并**保持最后值** → 必须补空串清屏。
- 透明度读 alphaEvents；alphaControl 是另一套（**x 单位是秒**）。
- incline（倾斜）不倾斜线，只按 1 - sin(倾斜)×(base+yOffset)/360 收缩音符横向位置。

## 4. 音符
- 类型 1 Tap / 2 Hold / 3 Flick / 4 Drag；宽度 = 2×0.13175016×675 ≈ 屏宽 13.175%。
- 下落：base=(音符floor-当前floor)×450×speed，沿**判定线局部 y**；线转，音符跟着转。
- 背面 above≠1：整体 y 翻转 + 朝向 -rot。
- 判定后 FADEOUT_TIME=0.16s 线性淡出。
- 流速 SPEED_RATIO=10/45/0.83175≈0.26717；floor 用 speed 事件**积分**得到。
- visibleTime 控制提前量；isFake 不判定、近透明。

## 5. 判定
- 窗口：Perfect 0.08s / Good 0.16s / Bad 0.22s。
- 横向容差 X_DIFF_MAX=0.21/(16/9)×2≈0.23625 世界单位 → ±159.5 RPE 像素。
- 判定是**一维**：只比较判定线局部 x，垂直方向无限；同线同刻两键需拉开 ≥214px。
- 音效在命中时播放：Click/Hold→click.ogg，Flick→flick.ogg，Drag→drag.ogg；可被音符 hitsound 覆盖。

## 6. 资源与打包
- 目录：info.yml + chart.json + 音频 + 曲绘；format 决定格式，缺省按内容嗅探。
- .pez = 标准 zip（根目录直接放文件）。
- info.yml 的 music/illustration/chart 必须真实存在；offset 单位毫秒。
- **extra.json 是独立 schema**：\`bpm\` 只接受裸数字或 \`[{time,bpm}]\`（不是 chart.json 的
  \`startTime\`；写成 RPE 格式 → 整张谱面加载失败 \`Failed to parse extra\`）；
  \`vec4\` 参数必须是 0–255 整数。详见 doc §6.1。

## 7. 校验器会拦什么
- 结构：empty-event-array(error) / zero-duration-event(warn) / unsorted-events(warn) / missing-asset(error)
- 手感：**hold-overlap**（同线两根长条时间重叠）/ **hold-collision**（Tap/Flick 与同线长条同车道且落在身体内）/
  hold-inner-ok（Drag 内嵌，合法）/ **finger-overload**（含"按住中的长条"的并发手指数超上限）/
  **key-clash**（相邻 <140ms 且 |Δx|<170）/ **jack-repeat**（<0.6s 且 |Δx|<70）/ **big-jump**（<0.3s 最近手位移 >400）/
  collision（同线同刻抢判定）/ visual-overlap（跨线视觉重叠）
- strict 模式（strict: true）时，碰撞/长条冲突/多指升级为 **error**；默认是 warn（参考谱面自身也有类似情况）。
- numofnotes(info)：numOfNotes 与真音符数不一致（口径：非 fake，含 Hold）。

## 8. 已踩过的坑
| 现象 | 根因 |
|---|---|
| 时间轴整体错位 | 事件时间存了拍却当秒用 |
| 线一直都在 | 零时长 alpha 事件被跳过 / 兜底事件挡路 |
| 一进游戏闪退 | 事件层里的空数组 |
| 水印常驻且居中 | 没写清屏事件 + 覆盖了 moveY |
| 流速翻倍 | layer1 写了绝对值（跨层相加） |
| 判定线跑出屏幕 | 平移时把增量层也整体平移 |
| 音符方向不对 | 曾误判渲染，实为拍/秒单位错 |

## 9. 快速验证
node test/source_check.mjs / units_check.mjs / run.mjs / smoke.mjs / client_render.mjs

`;

T.summary = `# Phira 谱面速览
- Phira 只吃 RPE / PEC / PBC；**本项目统一输出 RPE JSON**。
- 坐标：RPE 画布 1350×900，x∈[-675,675]，y∈[-450,450]，原点屏幕中心，y 向上为正。
- 时间：\`[a,b,c]\` = a + b/c 拍；**c 必须 > 0**（c=0 → NaN → 引擎 panic 闪退）。
- 音符 4 类：1=Tap(蓝键) 2=Hold(长条) 3=Flick(红键/粉键) 4=Drag(黄键，不需点击)。
- 判定线可移动/旋转/缩放/变色/倾角/隐藏；一条线最多 5 个事件层，同层取第一个命中事件，**跨层数值相加**。
- 判定窗口：Perfect 0.08s / Good 0.16s / Bad 0.22s；横向容差约屏宽 11.8%。
- 音符宽 = 屏宽 13.175%；从屏幕顶下落到判定线约 3.74s / 线流速。

先读 topic=schema 再动手，写完必须跑 phira_validate。`;

T.format = `# 文件与格式
谱面目录：
- info.yml —— 元数据（Phira 以它为准，RPE 的 META 只作参考）
- chart.json —— RPE 谱面本体
- song.mp3 / background.png —— 音乐与曲绘

info.yml 关键字段：
\`\`\`yaml
name: 曲名
difficulty: 13.5      # 定数（浮点）
level: IN Lv.13       # 显示串
charter: 谱师 (AI)
composer: 曲师
illustrator: 画师
chart: chart.json
music: song.mp3
illustration: background.png
offset: 0.0           # 秒
aspectRatio: 1.7777778
lineLength: 6.0
previewStart: 0
tags: [AI生成]
intro: 本谱面由 AI 生成
\`\`\`
生成谱面只需 chart.json；info.yml 由 phira_chart_init 或 phira_chart_set_meta 写入。`;

T.schema = `# RPE JSON 结构（写谱必须遵守）
\`\`\`jsonc
{
  "BPMList": [{ "bpm": 180, "startTime": [0,0,1] }],
  "META": { "RPEVersion": 170, "offset": 0, "name": "...", "charter": "...", "song": "song.mp3", "background": "background.png", "composer": "...", "level": "IN Lv.13", "id": "0" },
  "judgeLineGroup": ["Default"],
  "judgeLineList": [ /* 判定线 */ ]
}
\`\`\`
判定线必填：\`Name\`(string) \`Texture\`(string) \`eventLayers\`(数组) \`isCover\`(0/1)。
判定线可选：\`father\`(-1) \`rotateWithFather\` \`zOrder\` \`attachUI\` \`anchor\` \`bpmfactor\` \`notes\` \`numOfNotes\`
\`posControl/sizeControl/alphaControl/yControl/skewControl\`（样板：各 2 个恒等事件）。
eventLayers 里的事件：\`moveXEvents / moveYEvents / rotateEvents / alphaEvents / speedEvents\`。
extended 里的特殊事件：\`scaleXEvents / scaleYEvents / colorEvents / textEvents / inclineEvents\`（禁止 paint/gif）。

事件字段：\`startTime endTime start end easingType bezier bezierPoints easingLeft easingRight\`。

音符必填：\`type above startTime endTime positionX yOffset alpha size speed isFake visibleTime\`。
可选：\`judgeArea tint [r,g,b] tintHitEffects hitsound\`。`;

T.notes = `# 音符
| type | 名称 | 判定 |
|---|---|---|
| 1 | Tap（蓝键） | 按下，沿线方向容差内 |
| 2 | Hold（长条） | 按住，中途松手有 0.05s 宽限 |
| 3 | Flick（红键/粉键） | 突然快速滑动（速度阈值 ≈0.57），方向不限 |
| 4 | Drag（黄键） | **不用点**：手指在容差内或按住即自动判定 |

- \`positionX\`：相对判定线中心的 RPE 像素，±675 为屏幕边界。
- \`size\`：只改**视觉**宽度，不改判定宽度；\`judgeArea\` 只改**判定**宽度。
- \`above\`：1 = 正面下落；0 = 从背面（配合 180° 旋转的线）。
- \`isFake\`：1 = 假音符（不判定、不计分、无特效）——装饰必须用它。
- \`speed\`：音符自身流速倍率（0 = 静止，负 = 上飞）。建议 0.8–2.0。
- \`yOffset\`：正数向上偏移（偏移量 × speed）。
- \`visibleTime\`：提前多少秒开始显示；< 0.5s 会"突然出现"。

物量参考：普通谱 2–9 音符/s，峰值 ≤ 30；Tap 50–75%、Drag 10–30%、Hold 5–25%、Flick 2–10%。`;

T.lines = `# 判定线

## 高度（最容易踩的默认值坑）
- **承载音符的主判定线放在屏幕偏下**：参考 25 份谱面在 t=30s 的主线 y **中位数 ≈ -270**（多数 -250 ~ -310，约屏幕 60–65% 处）。
- 新建谱面 phira_chart_init 默认就是 lineY = -270；y=0 是屏幕正中，下落距离过短、贴脸，不要用。
- 纯演出线（FX/扫线）可以放 y=0 甚至出屏，它们不承载判定。
- 校验规则 line-height 会在主线接近正中（|y| < 120）时 warn。

事件值域：moveX ±675、moveY ±450、rotate 度（引擎取负）、alpha 0–255（**负数会隐藏线和线上音符**）、speed 流速（实测 -1000 ~ 10000）。

| 手法 | 做法 |
|---|---|
| 平移 | moveX/moveY 事件 |
| 扫线 | 一次事件从 -675 扫到 675，时长 0.5–3s（实例：11832 675→-550/2.7s） |
| 往复扫 | 0.67s 内 ±650→∓270，反复出现（实例：37207） |
| 旋转 | rotate 0→90/-90/180；90° = 垂直判定 |
| 背面 | rotate 180 或 note.above=0 |
| 缩放 | extended.scaleX/Y（普通线是倍数；纹理线按像素，默认 2/1350） |
| 倾角 | extended.inclineEvents（**参考 25 谱的 1089 个事件值全为 0**：形式上存在、实际从不使用；生成器默认禁止） |
| 位移 + 透明 | alpha 事件（0 隐藏线，连音符一起隐藏仅当 alpha<0） |

**布局**：可以把判定线放到屏幕外（x=±620、y=±600~1000）做"围屏"效果；示例 14940 用 y=600 的透明线让长条从屏幕外扫入。
**四面判定**：示例 54712 在 (±620, ±300) 四角布线；38897 用扇形（x=-600/-400/+600 配 -60/-70/+60 度）。
**垂直判定**：示例 37207 左侧线 x=-650 rot=90、右侧 x=+650 rot=-90，音符 x=0 时从侧向落入。
**父子线**：father 指向另一条线，子线继承位移（rotateWithFather 决定是否继承旋转）；**禁止成环**。
**attachUI**：pause/combonumber/combo/score/bar/name/level，一条线只能绑一个；绑定后该线自动隐藏。
**文字线**：textEvents 所在线永远隐藏、不绘制线上音符（但音符仍参与判定）；**textEvents 禁止用非 1 缓动（会崩）**。`;

T.judge = `# 判定模型：垂直通道 + 时间窗（写谱必读）

Phira 的判定是**一维**的：只算「沿判定线方向」的距离，垂直于线的方向**完全自由**。

- 水平判定线 → 判定通道是**竖直**的，贯穿整屏（上下点哪都行，只需横向对）；
- 判定线旋转 90° → 通道变**水平**，此时只需纵向对（这就是"垂直判定线"）。

**宽度**：容差 = \`X_DIFF_MAX（0.236 世界单位）≈ ±159.5 RPE 像素\`，而音符宽 177.9px
→ 命中窗口总宽 ≈ **1.8 个音符宽**；\`judgeArea\` 可按音符放大这个宽度（\`size\` 只改视觉，不改判定）。

**时间窗**（固定）：Perfect ≤0.08s / Good ≤0.16s / Bad ≤0.22s。
但**偏移越大时间窗越窄**：Click 允许 dt = LIMIT_BAD − LIMIT_PERFECT×max(0, dist/0.9 − 1)；
多音符择优时 key = dt + max(0, dist/音符宽 − 1)×0.2。→ 打正中间最宽松。

**各音符差异**
| 音符 | 触发条件 | 额外宽松 |
|---|---|---|
| Tap 蓝键 | 通道内按下 | 上下自由 |
| Hold 长条 | 通道内按住并保持 | 松手 0.05s 宽限 |
| Drag 黄键 | **不用按**：手指在通道内或按键按住即预判 | 到点自动判定，+ Good 容差 |
| Flick 红键 | 从静止**突然快速滑动**（阈值≈0.57，方向不限） | + Good 容差 |

**两条写谱推论（很重要）**
1. 多线同刻几乎"免费"：一次点击可同时满足多条线 → 跨线双押成本低，只影响可读性；
2. 真正的"抢判定"只发生在**同一条线**上：同刻音符沿线距离必须拉开（建议 ≥ 音符宽 ×1.2 ≈ 214px）。
   校验器按这个口径判定（\`collision\` = 同线抢判定，\`visual-overlap\` = 跨线视觉重叠）。`;

T.effects = `# 缓动与动效
官方 easingType（1–29）：
1 Linear / 2 Out Sine / 3 In Sine / 4 Out Quad / 5 In Quad / 6 IO Sine / 7 IO Quad /
8 Out Cubic / 9 In Cubic / 10 Out Quart / 11 In Quart / 12 IO Cubic / 13 IO Quart /
14 Out Quint / 15 In Quint / 16 Out Expo / 17 In Expo / 18 Out Circ / 19 In Circ /
20 Out Back / 21 In Back / 22 IO Circ / 23 IO Back / 24 Out Elastic / 25 In Elastic /
26 Out Bounce / 27 In Bounce / 28 IO Bounce / 29 IO Elastic

参考谱面实际偏好：**线性(1) 占 56%**，其余以 **Out 系**为主（4 Out Quad、8 Out Cubic、2 Out Sine、18 Out Circ）。9 成谱面不用贝塞尔（全数据集仅 12 次）。

建议：
- 位移/旋转默认 1 或 4/8（顺滑）
- 需要"爆发"用 16/17（Expo）、"回弹"用 20（Out Back）
- 每段只给 1–2 条线做动效，宁少勿乱
- 判定线瞬移（同刻突变）会让玩家读不出音符位置，慎用

## 新速度缓动（RPE 1.70 speed easing）
- 只有 speedEvents 的 easingType 大于 1 时才会涉及；缓动为 1（线性）的谱面不受影响。
- 引擎有两种解释：Legacy（旧）与 Modern（RPE 1.70 的积分方式），数值曲线不同。
- Phira 默认用 Legacy；导入时若检测到非 1 缓动的 speed 事件，会提示
  「该谱面使用了 RPE 1.7.0 引入的速度事件缓动，默认不启用」。
- 开启方式：谱面信息页的「新速度缓动」三态勾选（空/✓/x）；
  或直接写 info.yml：useRpe170Speed: true（启用）/ false（强制旧行为）。
- 插件里：phira_chart_set_meta 支持 useRpe170Speed；校验会对非 1 缓动的 speed 事件发 warn。`;

T.timing = `# 时机与结构
通用骨架：
\`\`\`
前奏留白 → 导入段 → 主歌(Tap+Drag) → 判定线强化 → 休息(可选) → 高潮(双押/长条) → 收尾
\`\`\`
- 前奏：0.4–30s 都可能；前奏期间只用判定线演出，**不要放需要打的音符**。
- 导入段：单线、低速、Tap 为主，建立视觉语言。
- 主歌：密度抬升，出现双押/楼梯/交互。
- 强化段：判定线事件密度上升（倾角/缩放/染色）。
- 休息：0.5–3s 明显留白。
- 高潮：多指、长条内嵌、瞬时变色。
- 收尾：判定线淡出 + 最后一个长条/单点。

时值：@180bpm 1/4 拍=0.083s、1/8=0.167s、1/2 拍=0.167s、1 拍=0.333s。
参考谱面相邻音符间隔中位数 0.06–0.27s。`;

T.pitfalls = `# 会导致崩溃/打不开的错误（必须避免）
1. 时间三元组 c=0 → NaN → 引擎 \`not_nan().unwrap()\` panic（**闪退**）
2. father 成环或越界 → 加载报错/栈溢出
3. 缺必填字段（判定线 Name/Texture/eventLayers/isCover；音符 11 个必填字段）→ 加载失败
4. \`alpha\` 为负数 → serde 解析失败（u16）
5. \`isFake/isCover/above\` 类型错（必须是数字）
6. textEvents 用非 1 缓动 → 播放器崩溃（官方 issue #252）
7. 纹理/音频/GIF 文件缺失 → 错误页
8. 多张线绑同一个 attachUI → UI 错乱
9. 真音符 |x| > 675 → 出界
10. 同刻点击类音符横向重叠（< 179px×1.2）→ 抢判定
11. 长条 endTime < startTime
12. **不要用图片纹理 / GIF / paint 事件**（本项目禁用）`;

T.difficulty = `# 难度
- 定数 \`difficulty\` 是浮点（参考 10.0–17.0），\`level\` 只是显示串。
- 难度 ≈ 峰值手速 × 手指数 × 判定线干扰 × 时长；Drag 多会**稀释**难度。
- 社区惯例：IN 15 以下尽量不超过 2 指；15–16 可 3 指；AT/16+ 放开（本插件按配置只做警告）。

分档参考：
- 10–13：2.5–5 音符/s，最大同刻 ≤4
- 14–15：5–8 音符/s，出现三押/长条内嵌/密集判定线
- 16–17：多指（同刻 14–25）或极高密度（8.5–12.9/s）或超长耐力`;

T.patterns = `# 手法库：怎么用、什么时候用（依据 26 个参考谱面）

## 一、基础形态
- 单点流 stairs {startBeat,count,stepBeat,x0,x1}：全谱骨架；旋律级进时 x 单调走。参考谱楼梯 5,012 次。
- 交互 trill {x1,x2,stepBeat,count}：左右手交替，1/8 或 1/4 拍；参考 1,402 次，常配对称移线。
- 纵连 jack {x,stepBeat,count}：同音重复/鼓点，高难特征；3,167 次，23375 最多（2,491）。
- 双押 chord（chord:2, xs 默认 ±260）：最常用强化；5,918 次，间距中位 375–580px。
- 三押 chord:3（xs 默认 -350/0/350）：只在 14+ 用；746 次。
- 四押+ add_notes 手写 xs：多指谱专属（15+）；1,540 次（47280/23375/54712/48789）。
- 长条 hold {beats,x,stepBeat,count}：低音延音、尾奏、观赏段；3,329 次，均值 0.2–1.8s。
- 长条内嵌 holdInner {beats,innerCount,innerType}：一手指按住、另手点内嵌；1,559 个（13496 专项）。

## 二、进阶形态
- holdMelody {beats,x,melody/pitches,types=[4,3]}：长条里跟旋律跳黄/红键；内嵌黄键不算违规。
- holdFlick {beats,x,flickDx}：长条起点红键强调；同位置会有 collision warn（预期）。
- holdFlickMelody {beats,x,melody/pitches,minGap}：一手长按、一手按旋律打红键；自动避开长条车道。
- 黄键链的手感规则（试玩反馈）：**同 x 的链固定 5 个**（手指按住原地不动，5 下刚好）；**楼梯状至少 8 个**（走位才成立），且楼梯段里**不要夹其他按键**（校验：drag-stairs-mixed）。整体黄键占比别超过 ~25%。
- tapDragChain {type, x, count, stepBeat, shape, x2}：**按键起头 + 一串黄键收尾**。type 取 1 蓝键 / 3 红键；
  shape='same' 黄键贴着原键的 x（手指原地不动就自动判定，最省力，适合重音后的"甩尾"），
  shape='stairs' 黄键从 x 走到 x2（做成楼梯状的滑行）。黄键不需要按下，但需要手指经过它的 x，
  所以同 x 版本要贴住原键、楼梯版本相邻黄键间距建议 ≤300px。

## 三、多判定线与特殊线（手法之外，但决定读谱）
- mirrorLines {y, rotB}：上下两条互为主线的镜像布局，第二条整体转 180°，音符从相反方向落下。
- dualLines {startBeat, count, y, maxBpm}：上下两条都承载音符；BPM ≥160 会被拒绝（读谱困难）。
- crossLines {beats, ...}：两条线交叉布置，音符在交叉点附近换手；两段之间要有空拍缓冲。
- belowDrag：屏幕下方升上来的黄键，落点对齐主线上已有的按键（点键的瞬间刚好掠过黄键）。
- vertical {x, rot, span}：竖直判定线（rot 90°），音符沿线的纵向排开；建议贴边、单段 ≤8–12s。
- fakePulse {startBeat, beats, period, depth, melody}：假判定线随旋律压音，纯视觉（开局/休息/局内都能用）。

## 什么时候用哪种（按段位与难度）
- 12–14：楼梯 + 双押为主，纵连点到为止；这一段的核心是"节奏干净"，不要为凑难度硬塞音符。
- 13–14 的抒情段：用 holdMelody / tapDragChain 做装饰，让手有事做但不抢判定。
- 15–16：交互 trill + 三押 + 长条内嵌开始上量；竖直判定和交叉双线每首最多各一段。
- 17+：多指 chord(4+)、跨线同刻、连续纵连；普通段位不要碰。

## 压音线（假判定线）的正确做法（试玩反馈）

- 只在该段**没有音符**时出现：出现 → 压几拍 → 消失，音符一开始就必须收掉（校验器：fx-line-over-notes）。
- 同时**最多 2 条**，不要一次铺很多：fakePulse({lines: 1|2, style})。
- 倾斜是**可选**的：style 'tilt'（一条带 10° 倾斜）/ 'verticalPair'（两条竖直平行，x ±300）/ 'single'（一条平线）；按段落轮换样式。
- 每段都要有 alpha 闸门（淡入/淡出），scaleY 按拍压缩 1→0.65→1；**不要给压音线加旋转动画**（rotDepth 默认 0）。
- 参考谱面无音符装饰线常见 3–30 条，但是**分段**出现，不是同时全亮。

## 试玩反馈沉淀（这些都是被打回过的，别再犯）

- **长条结束后的 100ms 内不要接按键**（尤其蓝键和另一根长条）：按住的手指要先松开才能再点/再按，同一个点上做不到 → hold-tail-press。长条尾后至少留 0.5 拍，或把下一个音换到别的车道。
- **强扭曲特效不要盖判定线**：fisheye / glitch / radialBlur / circleBlur 压在竖直或贴边的判定线上时，线会被揉到看不见（实测玩家以为"判定线没了"）→ fx-distort-line。这类段落用换色/暗角。
- **类型配比要对齐参考**（Tap 57% / Hold 13% / Flick 5% / Drag 25%）：全是 Tap 的谱"只有点、没有划和按"→ type-mix。慢歌黄键少是正常的，密集长谱才会被判为问题。
- **同侧窄跨度连打别超过 9 个**（1 秒内同侧、横向跨度 <120px）：另一只手完全帮不上 → same-side-stream。
- **竖直判定线贴边**（|x| ≥ 400）、**单段 ≤12s**：竖打本来就吃横向体力，放中间会和主线挤 → vertical-line-center / vertical-line-long。
- **上下双线音符要向外分开**：上方线 above=0、下方线 above=1，否则两股音符在中线糊成一片 → cross-line-direction。
- **每 30 秒窗口单侧 ≤62–70%**：全曲 56% 右不代表不累，某段 78% 那只手会先酸 → hand-balance-window。
- **长条内嵌用同车道**（Δx=0）：按住长条的那根手指顺手就判到；偏移 240–260px 会被玩家看成"长条旁边另有音符"。
- **alpha 动画的首个关键帧必须在 0s**：引擎 line.rs:237 是 alpha.now_opt().unwrap_or(1.0)，首个关键帧之前回落到 1.0 → 线从 0s 起整段不透明（压音线"一直有"的真正原因）。做法：在 0s 写一条 alpha=0 的保持段，再开始淡入。
- 线**不要写 alphaControl**：它恒为 1 时同样让线整首不透明，会把 alphaEvents 压掉（校验：line-alpha-control）。
- **不要用任何全局/全程后处理**：global:true 或某个 shader 覆盖超过半首歌，等于"整首戴滤镜"，实测被反馈"太暗"（校验：fx-global-shader）。只在高潮等小段点缀（≤15%）。
- 压音线**不要写每拍的 scaleY 压缩**：实机整屏闪烁（玩家反馈"整个屏幕都在闪"，去掉压缩立刻正常）。只用 alpha 出现→消失；真要压缩必须显式 pulse:true 并实机确认。
- 压音线**只在该段没有音符时出现**，同时最多 2 条，样式可按段落轮换（tilt / verticalPair / single），不要加旋转动画。
- 压音线**不是一直有**，而且**每次出现的位置和倾斜都要不一样**：fakePulse 传 varyY / varyTilt / varyX（确定性派生，同一 startBeat 结果稳定），别每段都在同一高度、同一角度。
- vignette 的 radius 不要超过 16：引擎公式 vig=(u(1-u)v(1-v)*radius)^extend，u(1-u)v(1-v) 最大 1/16，radius>16 时中心 vig>1，mix() 会把画面提亮（过曝/闪烁）。默认 15。
- 排查「整屏闪」按层二分：① 去曲绘背景 ② 去压音假线 ③ 去 extra.json 全部特效 ④ 去 alpha 事件——一次一个变体包，试到"不闪"就定位。
- Phira 设置里的「着色器」开关只关自定义 glsl，内置 vignette/chromatic/glitch 仍生效；"关了着色器还闪"不代表特效无关。
- **音符跟主旋律，不要跟 MIDI 全音符**：16 分装饰音全删、整拍骨干保留，音符数会从 1500+ 降到 1100 左右，可玩性反而更好。

## 判定线布局的硬规则（来自实际试玩反馈）

- **主判定线不要长时间旋转**：rotate 会让音符的落点方向/横向压缩一起变，长段倾斜打起来"发飘"。
  承载音符的线倾斜 ≥3° 且持续 ≥4s → 校验器报 line-rotate-tilt；要倾斜就 1–2 秒内转过去再转回来。
  （参考谱面里 45–60° 的大倾斜都发生在只挂少量音符的观赏线上。）
- **竖直判定线要贴边、要短**：竖着打本来就吃横向体力，放在屏幕中间会和主线挤在一起。
  |moveX| < 380 → vertical-line-center；承载音符超过 12s → vertical-line-long（建议 ≤8–12s 或拆段）。
- **上下双线的音符要向外分开**：上方线音符 above=0（从下往上）、下方线 above=1（从上往下）；
  两条线的音符朝彼此运动时校验器报 cross-line-direction（会在中线糊成一片）。
- **左右手要分窗均衡**：全曲 56% 右不代表不累，某 30s 段单侧到 70% 就会先酸 → hand-balance-window。
  写谱时按段左右镜像，而不是只在全曲层面凑平均。
`;
T.platform = `# 跨平台兼容（Windows / Linux / macOS / Android）

## 路径
- 一律用 \`path.join\` / \`path.resolve\`；**禁止硬编码** \`/storage/emulated/0\`、\`C:\\\` 等绝对路径。
- 根目录来源优先级：环境变量 \`PHIRA_ROOTS\`（多个用系统分隔符 : 或 ;）→ 宿主 cwd 及上两级 → 家目录 → 平台挂载点。
- 插件资源用 \`import.meta.url\` 定位（音效在 \`assets/sfx/\`、文档在 \`docs/\`），不依赖安装位置。
- 自检：\`node test/platform_check.mjs\`（会检查越界拒绝、中文/空格路径、硬编码路径）。

## 文件
- 编码 UTF-8 **无 BOM**（BOM 会让 JSON.parse 失败）；读文件时兼容 \`\\r\\n\`。
- 写文件先写 \`*.tmp-<pid>-<ts>\` 再 rename；**Windows 不能 rename 覆盖已存在文件**，需先 unlink。
- Windows 路径大小写不敏感：不要创建仅大小写不同的同名文件。
- 文件名可含中文/空格/括号——Phira 谱面常见，别做 ASCII 化。

## 音频与资源
- 支持 mp3 / ogg / wav，按扩展名给 Content-Type；BGM 路由支持 Range（可拖动）。
- 音效随插件分发（\`assets/sfx/*.ogg\`），通过 \`/phira/sfx\` 提供，不依赖系统音效库。
- 浏览器端用 WebAudio 解码缓冲，避免 \`<audio>\` 克隆的并发上限。

## 渲染
- 宿主预览是**纯 JS 光栅器**（自带 PNG 编码 + 点阵字体），不依赖 canvas/native，全平台一致。
- 面板用浏览器 Canvas，中文用系统字体（\`fillText\`）；宿主预览只支持 ASCII 文字。
- 跨平台形态检查：\`node test/client_render.mjs\`。

## 时间与数值
- 内部统一用秒（浮点），避免变 BPM 下整数拍漂移；BPM 换算只做一次。
- 浮点比较用容差（1e-6），不要直接 ===。
`;

T.shader = `# 后处理着色器（extra.json）：怎么用、什么时候用

## 数据位置
extra.json 与 chart.json 同目录：{ "bpm": 136, "effects": [ { "shader": "grayscale", "start": [0,0,1], "end": [8,0,1], "global": false, "vars": { "factor": 1.0 } } ], "videos": [] }
- start/end 是拍三元组；global:true 作用整屏（更耗性能，慎用）。
- vars 支持数字、颜色 [r,g,b,a]、关键帧数组 [{startTime,endTime,start,end,easingType}]。

## 10 个内置：参数与场景
- grayscale（factor 1.0）：回忆/休息段，配慢速长条。
- vignette（color, extend .25, radius 15）：压暗聚焦；开局渐入、单线特写。
- pixel（size 10）：复古/8bit，短时用。
- chromatic（sampleCount 3, power .01）：副歌高潮、判定线抖动。
- noise（seed 81, power .03）：颗粒/胶片感，长时间低强度。
- glitch（power .03, rate .6, speed 5, blockCount 30.5）：电子/故障，配拍点脉冲。
- fisheye（power -.1）：转场、镜头挤压。
- circleBlur（size 10）：柔焦、梦感、休息段。
- radialBlur（centerX/Y .5, power .01, sampleCount 6）：冲刺/推镜，副歌进点前 1–2 拍。
- shockwave（progress .2, centerX/Y .5, width .1, distortion .8, expand 10）：爆点一击，落在重拍。

## 编排建议
- 参考谱面 25 份没有用 extra.json（它是 Phira 扩展），所以特效是加分项不是必需。
- 一段最多叠 2–3 个；同屏叠加越多越糊。
- 用关键帧做脉冲：shockwave progress 0→1 用 0.5 拍落在重拍。
- 转场用 fisheye/glitch 0.5–1 拍；情绪段 grayscale/vignette 持续 8–16 拍。
- global:true 只在整曲级转场用，时间要短。

## 自定义着色器
- 文件放谱面目录，shader 写 "/文件名.glsl"（以 / 开头按文件加载）。
- 参数声明：uniform float power; // %0.01% / uniform vec2 center; // %0.5,0.5% / uniform vec4 color; // %0,0,0,1%
- 内置 uniform：time(float)、screenSize(vec2)、UVScale(vec2)、screenTexture(sampler2D)。
- 最小模板（#version 100）：varying vec2 uv; uniform sampler2D screenTexture; uniform float power; // %0.01%
  void main() { vec2 d = uv - vec2(0.5); gl_FragColor = texture2D(screenTexture, uv + d * power); }
- 工具：phira_chart_add_shader 写文件并解析参数 → phira_chart_add_effect 引用。
- 预览：10 个内置有 JS 近似；自定义 GLSL 预览无法执行，只能真机验证。

`;

T.glossary = `# 专有名词（AI 与用户沟通时先对齐）

## 格式与文件
- RPE：Re:PhiEdit 的谱面 JSON 格式，Phira 支持；本插件只产出 RPE。
- PE / PEC / PBC：其他谱面格式，Phira 也能读，但本插件不生成。
- info.yml：谱面元数据（曲名/定数/曲师/谱师/音频/曲绘/offset）。
- chart.json：谱面本体（BPMList + judgeLineList + notes）。
- extra.json：Phira 扩展（后处理特效/视频/着色器），可选。
- .pez：可直接导入 Phira 的打包格式（本质是 zip）。
- 曲绘：封面图，info.yml 的 illustration。

## 谱面结构
- 判定线（judge line）：音符的归属与判定基准；有位置/旋转/透明度/流速/倾角等。
- 主判定线：承载主要音符、玩家最常看的线；参考谱面常放 y≈-270（屏幕偏下）。
- 假判定线：只做视觉演出、不承载音符的线（fakePulse 生成）。
- 事件层（eventLayers）：同一条线最多 5 层，同名事件跨层相加（不是覆盖）。
- 父子线（father）：子线继承父线位移，用于整体运动。
- 时间三元组 [a,b,c]：a + b/c 拍；c 必须大于 0，否则 NaN 崩溃。
- offset：谱面相对音频的偏移（毫秒）。

## 音符
- Tap 蓝键：点一下。
- Hold 长条：按住到头。
- Flick 红键/粉键/划键：向上划。
- Drag 黄键：手指在横向范围内即可，不需要点击。
- 假音符（isFake）：不判定、不计分，装饰用。
- 长条内嵌：长条时段内还有别的音符。同车道（横向重叠）时**只有 Drag 安全**（自动判定、不占手指）；
  Tap/Flick 放同车道需要另一只手在同一点击/划，实际会撞车（参考谱几乎不这么写）。
- 双押/三押/四押：同刻 2/3/4 个音符；手指数以真音符为准。
- 跨线同刻：同一时刻不同判定线都有音符，需要双手分工。

## 手感与难度
- 物量：音符总数。
- 定数（difficulty）：难度数值，Phira 中 IN 难度显示为 Lv.n。
- 判定窗口：Perfect 0.08s / Good 0.16s / Bad 0.22s。
- 横向容差：约 ±159.5 RPE 像素（一维判定）。
- 流速（speed）：音符下落速度，10 为参考中位；8 更慢更好读。
- 缓动（easing）：事件数值的变化曲线，1=线性，2=Out Sine，8=Out Cubic 等；参考谱 56% 是线性。
- 新速度缓动（RPE 1.70 speed easing）：speedEvents 用非 1 缓动时的新旧解释差异；Phira 默认关闭，需在谱面信息勾选或 info.yml 写 useRpe170Speed: true。
- 楼梯/交互/纵连：单向走位 / 左右交替 / 同点连击。
- 耐力谱：超长、低强度、大量 Drag 的谱面。
- 压音：判定线随节拍压缩/浮动，制造"踩点"感（fakePulse）。
- 倾角（incline）：让音符横向透视收缩、判定不变，视觉与判定位置不一致；参考谱面从未真正使用（值全 0），生成器默认禁用。
- attachUI：把判定线绑到游戏 UI 槽位（combo/score 等），做主题皮肤。
- strict 校验：把碰撞/长条冲突/多指从 warn 升级为 error。

`;
T.reference = `# 参考谱面统计（写谱前看一眼，别凭感觉）

- 数据集：**24 个 RPE 谱面 / 22,752 真音符**（统计口径剔除耐力谱 23375：它单张 13,868 音符 / 黄键 61%，
  占全库 38%，会把所有分位和分桶拽偏）。
- 类型占比：Tap **56.9%** / Drag **24.9%** / Hold **13.0%** / Flick **5.3%**；
  单曲普遍 Tap 50–75%、Drag 10–30%、Hold 5–25%、Flick 2–10%。
- 判定线事件 169,561 个：moveX 55,666 / moveY 45,305 / alpha 35,770 / rotate 25,588 / speed 7,232。
- 倾角 incline 1,089 条线；color 260；scaleX/Y 312/306；text 仅 14 条线（4 谱面）。
- 缓动：线性 56.3%；常用 Out Cubic(8) / Out Quad(4) / In Quad(5) / Out Circ(18) / Out Sine(2)；
  贝塞尔全库仅 12 次、裁剪缓动 75 次——不要滥用。
- 手法计数：双押 5,918（最常用）、楼梯 5,012、纵连 3,167、长条 3,329、交互 1,402、
  长条内嵌 1,559、三押 746、四押+ 1,540、跨线同刻 2,822、Flick 1,665、假音符 759。
- 长条内嵌类型（实测 1,961 个）：Drag 1,258 / Tap 684 / Flick 19；
  其中与长条**同车道**（|Δx|<音符宽）的只有 726 个，且 **715 个是 Drag**，同车道 Tap/Flick 全库只有 11 个
  → 结论：同车道内嵌 Drag 最省手（不用按下）；同车道放 Tap/Flick 要另一只手在同一位置点/划（参考 25 谱里 725 例 Drag vs 各 6 例 Tap/Flick）——是提醒，不是禁止。
- 相邻音符间隔中位 0.059–0.273s；开局首音符 0.39s–30.46s（取决于前奏，别一刀切）。
- 休息段通常 0.5–3s 留白（14940 有 4 段共 9.7s），但用 alpha/缩放做过渡，不是纯黑。
- 主判定线高度：25 份谱面 t=30s 中位数约 -270（多数 -250 ~ -310，屏幕 60–65%）。

## 横向分布（生成器按这个来摆音符）
- x 分位：p10 -390 / p25 -241 / p50 **0** / p75 253 / p90 390。
- |x|：p25 130 / p50 **248** / p75 375 / p90 405；**>400 占 17.9%**，>500 仅 0.3%。
- |x| 每 50px 占比：0-50 **14.6%**、50-100 5.8%、100-150 14.7%、150-200 6.9%、200-250 8.0%、
  250-300 10.7%、300-350 11.4%、350-400 10.0%、**400-450 13.4%**、450-500 4.2%、>500 0.3%。
- 结论：**中线不特别密集（约 15%）+ 100-150 与 400-450 各有一个高点 + 500 以外几乎没有**；只挤在 ±200 内、或满屏贴边，都不像参考谱。
- 左右手：长期保持"一手负责一半屏幕"（左侧音符归左手、右侧归右手），不要连续把音符堆在同一侧。
- 密度按定数：Lv13 参考约 3.1–5.3 音符/s；超过上限会让谱面变成"堆音符"，手感下降。
- 同刻同线间距：p25 300 / p50 **506** / p75 675（写谱用 300/500 两档更好读，且必须 ≥213.5 防抢判定）。
- 相邻横跳（间隔 <0.6s）：p50 270 / p75 506 / p90 675（快速大跳不要超过 ~600px）。
- 工具：lib/distribution.js 提供 sampleX / chordXs / stairsRange / maxJump / densityHint；
  build_from_plan 已用它们生成，种子可用 opt.seed 复现。
- 速度：中位 speed=10；慢板曲可降到 8 给读谱时间。
- 图鉴：13496 长条内嵌专项 / 23375 耐力（693s、9,369 Drag）/ 53602 垂直判定与自定义 UI /
  11404 双押与判定线手法 / 23897 极限特效 / 75892 文字与负 alpha / 47280 多指。

`;
T.source = `# 参考源码（随插件分发，只读）

位置：docs/ref-src/（9 个文件，4225 行，GPLv3，见 NOTICE.md）。
**先看下面的摘录；需要细节再打开对应文件，不要修改它们，也不要把它们复制进插件逻辑。**

## 1. 事件求值：为什么是「保持」而不是插值
parse/rpe.rs（parse_events）：
  kfs.push(Keyframe { time: r.time(&e.start_time), value: e.start.clone().into(), tween: e.tween(bezier_map) });
  kfs.push(Keyframe::new(r.time(&e.end_time), e.end.clone().into(), 0));
core/tween.rs：TWEEN_FUNCTIONS[0] = |_| 0.  → 索引 0 是阶跃（常量 0）
core/anim.rs（now_opt）：
  if let Some(next) = &self.next { T::add(&now, &next.now_opt().unwrap()) }
解读：每个事件产生 start（用事件缓动）与 end（tween 0 = 保持）两个关键帧；
两层事件用 next 链相加；若某层该键是空数组，next.now_opt() 返回 None → unwrap 崩溃。

## 2. 音符变换：base / incline / above / 淡出
core/note.rs：
  let base = height - line_height;                                  // 未来音符 base > 0
  let incline_val = 1. - incline_sin * (base * aspect + yOffset) * RPE_HEIGHT / 2. / 360.;
  tr.x *= incline_val; tr.y += base;                                // 沿判定线局部 y 下落
  const FADEOUT_TIME: f64 = 0.16;                                   // 判定后 0.16s 淡出
core/line.rs：背面音符（above != 1）在 scaling(1,-1) 模型下绘制 → 位置 y 翻转、朝向取反。
解读：音符是判定线的子节点，线转音符跟着转；incline 只收缩横向位置，不倾斜线。

## 3. 判定线渲染：只有细线
core/line.rs（Normal 线）：
  draw_line(-len, 0., len, 0., 0.01, color);   // len = lineLength，厚度 0.01 世界单位
  let alpha = self.object.alpha.now_opt().unwrap_or(1.0) * res.alpha;
解读：普通线永远是细线；有 textEvents 时不画线只画字；线的透明度来自 alphaEvents。

## 4. 速度与 floor（音符下落位置）
parse/rpe.rs（parse_speed_events）：
  对 speed 事件按时间积分得到 height，再乘 SPEED_RATIO = 10/45/0.83175。
解读：音符 base = (音符 floor - 当前 floor) × 450 × speed；改 speed 事件等于改下落速度。

## 5. 判定：窗口 + 一维横向
judge.rs：
  pub const LIMIT_PERFECT: f64 = 0.08;
  pub const LIMIT_GOOD: f64 = 0.16;
  pub const LIMIT_BAD: f64 = 0.22;
  const X_DIFF_MAX: f64 = 0.21 / (16. / 9.) * 2.;   // ≈ 0.23625 世界单位
解读：只比较判定线局部 x（一维），垂直方向无限；所以同线同刻两键必须拉开。

## 6. extra.json 与着色器
parse/extra.rs：
  enum BpmForm { Single(f64), List(Vec<ExtBpmItem>) }
  struct ExtEffect { start: Triple, end: Triple, shader: String, vars: HashMap<String, Variable>, global: bool }
  enum Variable { Float(..), Vec2(..), Color(..) }
  if let Some(path) = rpe.shader.strip_prefix('/') { 加载文件 } else { Effect::get_preset(&rpe.shader) }
core/effect.rs：10 个内置着色器；uniform 用 GLSL 注释声明默认值 uniform float x; // %0.01%

## 7. 常量表
core.rs：NOTE_WIDTH_RATIO_BASE = 0.13175016、HEIGHT_RATIO = 0.83175
parse/rpe.rs：RPE_WIDTH = 1350、RPE_HEIGHT = 900、SPEED_RATIO = 10/45/HEIGHT_RATIO

## 使用建议
- 先读「引擎语义速查」和本主题；仍不清楚再打开 docs/ref-src/ 对应文件（文件头有上游路径注释）。
- 想验证结论：用工具跑最小实验（phira_chart_init + add_notes + validate），比读完整源码快。
- 发现新语义时，补回 docs/engine.md，而不是只留在对话里。

`;
T.playability = `# 可玩性 / 手感审计（校验通过 ≠ 能玩）

## 为什么单看 validate 会漏
引擎判定是「按最近音符选一个」：长条被按下后状态是 JudgeStatus::Hold，**不再参与新触碰的候选**，
所以同车道再放一个 Tap，引擎层仍能判到那个 Tap —— 校验看起来没问题。
但物理上一根手指正按在长条上，另一根手指要去同一个位置点击/划，必然撞车。
参考谱面的数据也印证：同车道内嵌 726 个里 715 个是 Drag，Tap/Flick 全库只有 11 个。

## 硬指标（目标全为 0）
| 指标 | 阈值 | 说明 |
|---|---|---|
| hold-collision | Tap/Flick 与同线长条同车道且落在身体内 | 手指撞车；Drag 不受限 |
| finger-overload | 含"按住中的长条"的并发手指数 > 难度上限 | 定数 <15→2，<17→3，<18→5 |
| key-clash | 相邻 <140ms 且 |Δx| <170 | 手指来不及分开 |
| jack-repeat | 相邻 <0.6s 且 |Δx| <70 | 读谱像一次，容易漏 |
| big-jump | 相邻 <0.3s 且最近手位移 >400 | 半屏位移，手感断崖 |
| hold-overlap | 同线两根长条时间重叠且横向重叠 | 需要两指按同一条线 |

## 流程
MIDI 解析 → 量化 → 分段 → 生成音符 → **手感审计** → phira_validate → phira_analyze → 按 predicted 标定数 → 抽帧 1–2 次 → 打包。

审计口径注意：大跳要按「最近手配对」（双押时两只手各走各的），不能按连续音符算，
否则同一份谱会得到 0 与 42 两种结果（同一份谱两种口径，我们踩过）。

## 演出上的相关坑
- incline（倾角）让音符视觉 x 收缩（10° 时离线越远收缩越大：base=300 约 14.5%、base=450 约 21.7%），
  但判定仍按逻辑 x → 看到的位置和打的位置不一致，手感发飘；不是每张谱都需要倾斜。
- 满宽判定线做 moveX 平移几乎看不出效果，却会把有效坐标推向边缘（note-near-edge 用的是 ex 而不是 x）。

`;
T.workflow = `# 推荐工作流

## 风格：AI 自己定
- phira_chart_plan 的 style 默认 auto：传 midiPath 时解析 MIDI 得到
  平均密度 / 峰值密度 / 复音 / 长音占比，自动选 multiFinger / endurance / lineShow / visual / balanced 并给出理由。
- 也可以 style: "custom" + custom.sections 自定义段落（名字/占比/密度/同刻/手法/演出），
  或显式指定五种档案。**由 AI 按音乐判断，不需要问用户。**

## AI 的自主权（重要）
- **工具是助手，不是枷锁**：需要工具没封装的字段时，用 phira_chart_edit 直接按路径改/删/加任意 JSON
  （例：judgeLineList.0.notes.3.positionX、META.name、extended.paintEvents）。
- **可以完全不用 plan**：自己写脚本生成 chart.json（edit/write 工具）也是合法路径，工具只负责校验与预览。
- **创作不限**：判定线数量、演出、结构、手法组合、长音密度，都由 AI 根据音乐决定。
- **校验分级**：error 必须清零（会崩/非法）；warn/info 是建议，可以权衡后保留，但要在交付说明里写清原因。
- **先斩后奏**：能自己判断的不要问用户；只有"用户偏好"（难度、是否剪辑）才需要确认。

## 改谱用 phira_chart_patch（不要重建整谱）
ops 一览：
- update-notes：按 line / fromBeat / toBeat / types / minX / maxX 选中音符，改 x / xShift / type / alpha / size / speed / fake / beat / beatShift / endBeat
- delete-notes：同一套筛选条件，删除
- clamp-x：把 |x| > limit 的音符拉回边界（修贴边/出界）
- set-line：改判定线基线 x / y / rot / alpha / speed
- delete-line：删整条线（自动修正 father 索引）
- prune-empty / sort-events / dedupe-events：清理空数组、排序、去重

改完会自动重新校验，返回 error/warn 计数。

1. \`phira_chart_init\` 建骨架（或 phira_audio_analyze 得到 BPM 后建）。
2. 用 \`phira_midi_parse\` / 音频节拍网格拿时间轴。
3. 先用 \`phira_chart_add_notes\` 铺主歌骨架（Tap 流）。
4. \`phira_chart_apply_pattern\` 加双押/楼梯/交互/长条。
5. \`phira_chart_add_line_events\` 加判定线动效（每段 1–2 条线）。
6. \`phira_validate\` 直到 0 error；\`phira_analyze\` 看难度与可玩性。
7. \`phira_preview_frame/strip\` 抽帧自检（音符出界、重叠、动效遮挡）。
8. 确认 info.yml 的 charter 带 \`(AI)\`、tags 含 \`AI生成\`、0–3s 水印存在。`;

function readDoc() {
  const cands = [
    path.join(HERE, '..', 'docs', 'engine.md'),
    path.join(HERE, '..', '..', '引擎语义速查.md'),
  ];
  for (const p of cands) {
    try {
      const text = fs.readFileSync(p, 'utf8');
      if (text.length > 400) return { path: p, text };
    } catch { /* 试下一个 */ }
  }
  return null;
}

export function guide(topic) {
  if (topic === 'doc') {
    const d = readDoc();
    return '（Phira 引擎语义完整文档）\n\n' + (d ? d.text : T.engine + '\n\n（未找到 docs/engine.md，返回内置摘要）');
  }
  const key = topic && T[topic] ? topic : 'summary';
  const head = `（Phira 谱面指南 · topic=${key}）\n\n`;
  const index = Object.keys(T).join(' / ');
  return head + T[key] + (key === 'summary' ? `\n\n可用 topic：${index}` : '');
}
