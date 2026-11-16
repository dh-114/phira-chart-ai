# 参考源码副本（只读）

本目录是 **prpr（Phira/RPE 引擎）** 的部分源码副本，仅作为本插件指南的阅读参考：

- 上游项目：prpr（Phira 的谱面解析/渲染/判定实现）
- 许可证：**GNU GPL v3**（见上游根目录 LICENSE）
- 用途：只读参考，**不被本插件代码 import / 编译 / 链接**；插件自身逻辑（lib/*.js）为独立实现。
- 更新方式：从上游源码按下列文件重新复制即可。

| 文件 | 上游路径 | 内容 |
|---|---|---|
| core.rs | prpr/src/core.rs | 常量：NOTE_WIDTH_RATIO_BASE、HEIGHT_RATIO |
| note.rs | prpr/src/core/note.rs | 音符求值/渲染：base、incline、above、FADEOUT、可见性 |
| line.rs | prpr/src/core/line.rs | 判定线渲染：draw_line、alpha、文字线、图层叠加 |
| anim.rs | prpr/src/core/anim.rs | 动画求值：关键帧游标、chain 相加、now_opt unwrap |
| tween.rs | prpr/src/core/tween.rs | 33 个缓动函数；索引 0 = 阶跃 |
| effect.rs | prpr/src/core/effect.rs | 后处理着色器系统（10 个内置 + uniform 解析） |
| rpe_parse.rs | prpr/src/parse/rpe.rs | RPE 解析：parse_events、音符字段、速度积分 |
| extra_parse.rs | prpr/src/parse/extra.rs | extra.json：BpmForm / ExtEffect / Variable |
| judge.rs | prpr/src/judge.rs | 判定：窗口、一维横向容差、音效播放 |
