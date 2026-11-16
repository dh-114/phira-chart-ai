# NOTICE · 第三方代码与版权

## prpr / Phira 引擎源码摘录

`docs/ref-src/` 下的 `.rs` 文件是 [Phira](https://github.com/TeamFlos/phira)（仓库 `TeamFlos/phira`，包名 prpr）源码的**摘录副本**，用于把插件的校验规则与真实引擎语义对齐。

- 版权：© TeamFlos 及 Phira 贡献者
- 许可：**GPL-3.0**（与上游一致）
- 修改：仅做片段摘取，未改动逻辑
- 摘录清单：`parse/rpe.rs`、`parse/extra.rs`、`core/line.rs`、`core/note.rs`、`core/judge.rs`、`core/effect.rs`、`core/shaders/*.glsl`、`core.rs` 等（见 `docs/ref-src/`）

因为本仓库分发 GPLv3 代码的摘录，**整个项目以 GPL-3.0-or-later 发布**（见 `LICENSE`）。

## 参考谱面统计

`lib/distribution.js` 里的分位/配比数值，来自对 **24 张 RPE 谱面**（社区作品）的自动统计，**不包含任何谱面文件本身**，只保留聚合后的统计量。耐力谱（13,868 音符）因会严重偏斜统计已被剔除。

## 不包含的内容

本仓库**不包含**任何音频、曲绘或第三方谱面文件。`docs/` 与 `test/` 里的示例数据均为程序生成。
