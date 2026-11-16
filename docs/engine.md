# Phira / prpr 引擎语义速查（已对源码核对）

> **给 AI 的约定：先读这份文件，不要再去 grep `source code/prpr/src`。**
> 只有在本文没有覆盖、或需要用新事实反驳本文时，才去读源码，并把结论补回这里。
>
> 每条都标注了源码位置；但**不要再打开源码核对**——`node test/source_check.mjs` 会自动比对常量与关键语义。

## 1. 坐标与时间

| 项 | 值 | 源码 |
|---|---|---|
| 画布 | 1350 × 900，x∈[-675,675]，y∈[-450,450]，原点中心，**+y 向上** | `parse/rpe.rs` RPE_WIDTH/HEIGHT |
| 时间 | `[a,b,c]` = a + b/c 拍；**c=0 → NaN → panic** | `parse/rpe.rs` `Triple::beats().not_nan().unwrap()` |
| 屏幕映射 | `X = (x+675)/1350*W`，`Y = (450-y)/900*H` | 相机 `zoom=(1,-aspect)` + 谱面模型 `scaling(flip_x,-1)` |
| 旋转 | RPE 旋转值 `R` → 引擎 `-R`；竖直线 = `±90` | `parse/rpe.rs` `events_with_factor(..., -1., "rotate")` |

## 2. 事件求值（**最容易搞错的一条**）

- 每个事件生成 **两个关键帧**：`(startTime, start, 事件缓动)` 与 `(endTime, end, tween 0)`；
  `tween 0 = |_| 0.` 是**阶跃**。
- **事件之间的空隙「保持」上一事件的结束值，绝不插值。**
- 多层事件：`chain` 后用 `T::add` **逐层相加**（不是覆盖）。
- **关键帧不排序**：数组顺序 = 时间顺序。所以**写入时必须按 startTime 升序**，且不要写「撑到 9999999」的兜底事件挡在中间。
  - 唯一例外：**`speedEvents` 会被引擎排序**（`parse/rpe.rs` `parse_speed_events` 里 `events.sort_by_key(...)`），
    乱序不致命；`alpha/moveX/moveY/rotate/color/incline/text` 走通用 `parse_events`，**没有排序**
    （且它用 `rpe[0]` 判断要不要补 time=0 的默认帧）→ 乱序 = 关键帧错位、值算错，**不会崩**。
  - 校验器已据此区分：`unsorted-events` 只对非 speedEvents 报（看**原始 JSON**，`normalizeChart` 会排序所以不能事后判断）。
- 空数组 `"xxxEvents": []`：`events_with_factor` 用 `filter_map` 只丢**键不存在**的层，显式空数组仍会进 `AnimFloat::chain`。
  两种后果，**都只能靠删键解决**：
  1. 空数组前面有层带事件 → `core/anim.rs` `now_opt()` 对无关键帧的 `next` 直接 `.unwrap()` → **闪退**（`empty-event-array`，error）；
  2. 空数组排在链首 → `now_opt()` 因首层无关键帧返回 `None`，调用方 `unwrap_or(默认值)` →
     **后面各层事件全部被静默丢弃**（线 alpha 停在 1、位移停在 0），不崩但画面完全不对（`empty-event-array-head`，warn）。
- 零时长事件（startTime == endTime）许多实现会跳过 → 用它做「alpha 闸门」会失效。

## 3. 判定线渲染

- `Normal` 线（`Texture: "line.png"`）= 一条**细线**，厚度 `0.01` 世界单位（≈屏宽 0.5%），长度 `±lineLength`（默认 6 → 远超屏幕）。
- 线型只有：普通线 / 贴图 / 文字 / 粒子；**没有三角形图元**——画面上看到的"三角形/斜带"要么是曲绘、要么是音符或特效。
- 文字线：`textEvents` 存在时该线**不画线**，只画文字；文字取「最后命中的事件」，之后**保持最后值**（所以要写空串清屏）。
- 线透明度读事件层 `alphaEvents`；`alphaControl` 是另一套（**x 单位是秒**，不做拍→秒换算）。
- `incline`（倾斜）**不倾斜线**，只把音符横向位置按 `1 - sin(倾斜)×(base+yOffset)/360` 收缩。

## 4. 音符

| 项 | 值/规则 | 源码 |
|---|---|---|
| 类型 | 1 Tap / 2 Hold / 3 Flick / 4 Drag | — |
| 宽度 | `2 × 0.13175016 × 675` RPE 像素（屏宽 13.175%） | `core.rs` NOTE_WIDTH_RATIO_BASE |
| 下落 | `base = (音符floor - 当前floor) × 450 × speed`，沿**判定线局部 y** 下落；线转，音符跟着转 | `core/note.rs` |
| 背面 | `above≠1` 用 `scaling(1,-1)` 包裹 → 位置 y 翻转、朝向 `-rot` | `core/line.rs` |
| 淡出 | 判定后 `FADEOUT_TIME = 0.16s` 线性淡出 | `core/note.rs` |
| 流速 | `SPEED_RATIO = 10/45/0.83175 ≈ 0.26717`（世界单位/秒，每 RPE speed） | `parse/rpe.rs` |
| 遮挡 | `visibleTime` 控制提前量；`isFake` 不判定、近透明 | — |

## 5. 判定

| 项 | 值 |
|---|---|
| 窗口 | Perfect 0.08s / Good 0.16s / Bad 0.22s |
| 横向容差 | `X_DIFF_MAX = 0.21/(16/9)×2 ≈ 0.23625` 世界单位 → ±159.5 RPE 像素 |
| 判定维度 | **一维**：触点在判定线局部坐标下只比较 x；垂直方向无限 |
| 判定半径 | `dist = \|note.x − touch.x\| / note.judge_area ≤ X_DIFF_MAX(=0.23625 world ≈ ±159.5px)` → `judge_area` 是**容差倍数**（2 = 判定范围翻倍），不是几何尺寸 |
| 每触点只判一个 | 遍历时维护 `closest`，`if dt >= closest.3 { break; }` → **一次点击最多判给一个音符**。所以"两个音符挨得近"的后果是**判给错的音符**（该中的没中），不是双判 |
| Drag 不占手指 | 无按键按下时只有 `Drag` 会继续走 `PreJudge`；点击事件也不会判给 Drag（`debug!("reject by drag")`）→ **Drag 只要触点经过就自动判定**，`同刻手指数`/`撞键`统计必须排除它 |
| 坐标 | 音符局部坐标 = `position_x / (RPE_WIDTH/2)` = `position_x / 675`（世界单位），屏幕可见范围 ±1 → **`\|positionX\| > 675` 即出界**（与判定线位移无关） |
| 音效 | 命中时播放；`Click/Hold→click.ogg`、`Flick→flick.ogg`、`Drag→drag.ogg`；音符可带自定义 `hitsound` |

## 6. 资源与打包

- 谱面目录：`info.yml` + `chart.json` + 音频 + 曲绘；`info.yml.format` 决定格式，缺省按内容嗅探。
- `.pez` = 标准 zip（根目录直接放上述文件）。
- `info.yml` 的 `music`/`illustration`/`chart` 文件名要真实存在；`offset` 单位毫秒。
- 音效/曲绘资源随插件走：`Plug-in-code/assets/sfx/*.ogg`（来自 Phira `assets/`）。

## 6.1 `extra.json`（后处理特效，坑最多）

结构：`{ bpm: BpmForm, effects: [ExtEffect], videos: [ExtVideo] }`（源码 `parse/extra.rs`）。

- **`bpm: BpmForm = Single(f64) | List([{ time: Triple, bpm }])`**
  —— 字段名是 **`time`**（Triple），**不是** `chart.json` 的 `startTime`。
  写成 RPE 的 `[{bpm, startTime}]` → 整个文件被 serde 拒绝，客户端报
  `Failed to parse extra` + `data did not match any variant of untagged enum BpmForm`，
  表现就是**整张谱面加载失败**。常量 BPM 直接写数字最省事。
- `ExtEffect = { start: Triple, end: Triple, shader: String, vars?: {name: Variable}, global?: bool }`；
  `shader` 以 `/` 开头 → 读包内同名 glsl 文件。
- **`Variable = Float(ExtAnim<f32>) | Vec2(ExtAnim<(f32,f32)>) | Color(ExtAnim<[u8;4]>)`**
  —— `vec4` 参数在 extra.json 里是 **0–255 整数**（`[u8;4]`），
  写成 0~1 浮点（如 `[1,0.62,0.78,1]`）会让整个文件解析失败。`vignette.color` 是唯一内置 vec4。
- `ExtAnim = Default | Fixed(V) | Keyframes([ExtKeyframe])`：裸数字引擎接受（Fixed），
  但插件校验器/预览要求关键帧数组；缺省值由 shader 注释 `// %默认%` 提供。
- 关键帧字段（camelCase）：`easingLeft? easingRight? easingType start end startTime endTime`；
  `startTime/endTime` 是拍三元组，用 **extra 自己的 bpm** 换成秒（与 chart.json 的 BPMList 无关）。
- 自定义 shader 的 uniform 必须能匹配 `uniform\s+(\w+)\s+(\w+);\s*//\s*%([^%]+)%`，
  即 `uniform <type> <name>; // %默认值%`；`#version 100` + `precision mediump float;`，
  varying `uv`、纹理 `screenTexture`。参数表以 `src/core/shaders/*.glsl` 的声明为准。

## 7. 校验器该拦什么（`lib/validate.js` 已实现）

1. `empty-event-array`（error）：原始 JSON 里第 2+ 层同键空数组 → 删键。
2. `zero-duration-event`（warn）：透明度闸门失效的常见原因。
3. `unsorted-events`（warn）：乱序会让后面的关键帧失效。
4. `missing-asset`（error）：`info.yml` 引用的文件不存在。
5. `numofnotes`（info）：`numOfNotes` 与实际真音符数不符（口径：非 fake，含 Hold）。
6. `hold-overlap`（warn/strict→error）：同一条线上两根长条时间重叠且横向重叠。
7. `hold-inner`（warn/strict→error）：音符落在同线长条身体时段内且横向重叠。
8. `fingers`（warn/strict→error）：同刻真音符数超过难度上限（<15 → 2，<17 → 3，<18 → 5）。
9. `collision`（warn/strict→error）：同线同刻点击类音符横向抢判定。

> 判定口径：图上是几根手指，取决于**同刻真音符数**（假音符不占手）；长条与音符的冲突看
> 「同线 + 时间包含 + 横向距离 < 音符宽×1.2」。

## 8. 已踩过的坑（别再踩）

| 现象 | 根因 |
|---|---|
| 时间轴整体错位 | **事件 `st/et` 存的是拍数，却被当成秒**（已修：normalize 时 `bpm.at()`） |
| 线"一直都在" | 零时长 alpha 事件被跳过 / 兜底事件挡住后续关键帧 |
| 一进游戏就闪退 | 事件层里的空数组（见 §2） |
| 水印常驻 & 位置居中 | 文字没有清屏事件 + `applyAIMark` 覆盖了 moveY |
| 流速突然翻倍 | layer1 写了绝对值而不是增量（跨层相加） |
| 判定线跑到屏幕外 | 平移时把增量层也整体平移了 |
| 音符方向不对 | 曾误判为渲染问题，实际是拍/秒单位错 |
| **整张谱面加载失败**：`Failed to parse extra` / `untagged enum BpmForm` | extra.json 的 `bpm` 写成了 RPE 的 `[{bpm,startTime}]`；必须是裸数字或 `[{time,bpm}]`（见 §6.1） |
| extra.json 报 `data did not match any variant` 但 bpm 是对的 | 某个 `vec4` 参数写成了 0~1 浮点，必须是 0–255 整数（见 §6.1） |

## 9. 怎么快速验证

```bash
node test/source_check.mjs   # 常量/语义与源码一致性（18 项，含空数组/extra bpm/Drag 判定）
node test/units_check.mjs    # 事件时间必须是秒
node test/run.mjs            # 25 个参考谱面回归
node test/smoke.mjs          # 工具冒烟
```

## 后处理特效与"整屏闪"排查（实机验证）

- **vignette 公式**：`vig = (u(1-u)·v(1-v)·radius)^extend`，`mix(color, screen, vig)`。
  `u(1-u)·v(1-v)` 最大 1/16 → **radius > 16 时中心 vig > 1**，画面被提亮（过曝/闪烁）；默认 radius 15。
- **压音假线的每拍 `scaleY` 压缩会让整屏闪烁**（实机复现：去掉压缩即正常）。压音线只做 alpha 出现/消失。
- **Phira 的「着色器」开关只关自定义 glsl**；内置 `vignette/chromatic/glitch/fisheye/...` 仍生效。
- **`isCover:1` → `show_below:false`**（判定线以下的音符不再绘制），不影响背景。
- 整屏闪的排查顺序：去曲绘背景 → 去压音假线 → 去 extra.json 全部特效 → 去 alpha 事件，逐层做变体包。
