# AI 开发声明 / AI Development Declaration

本项目（`phira-chart-ai`）是**以 AI 生成为主**的开源项目，特此明确声明，避免使用者误解其可靠性来源。

## 谁写了什么

| 部分 | 产生方式 |
|---|---|
| `lib/`、`index.js`、`client.js`、`test/` 的代码 | **AI 生成**（DeepSeek Harness 上的 AI 代理，模型 `deepseek-v4-flash`），人类审阅后合入 |
| `docs/engine.md` 的引擎语义 | AI **阅读 prpr 源码**后提炼，逐条标注源文件与行号；人类抽查 |
| `lib/validate.js` 的 60+ 条检查 | AI 依据源码 + 实机试玩反馈逐条添加，每条都有成因说明 |
| `lib/distribution.js` 的参考统计 | AI 自动统计 24 张 RPE 谱面（排除耐力谱） |
| **需求、试玩、取舍、发布决定** | **人类** |

## 这意味着什么

- 代码**未经专业安全审计**；校验规则来自源码推演与实测，**可能有误**
- 谱面"好不好玩"最终只能由人判断，工具的分数与检查只能排除"明显错误"
- 本项目不是 Phira / TeamFlos 官方项目，与上游无隶属关系

## 对生成物的权利

用本工具生成的谱面（`chart.json` / `info.yml` / `extra.json` / `.pez`）**归生成者所有**，不受本仓库 GPL 许可证约束（谱面是数据产物，不是本项目的衍生代码）。

## 发现错误怎么办

欢迎 Issue / PR，请附：

1. 复现用的谱面片段（最小化）
2. Phira / prpr 版本
3. 具体现象（截图或报错原文）
4. 如果与 `docs/engine.md` 冲突，说明是在哪个源码文件里看到的

> 提醒：引擎行为随版本变化，`docs/engine.md` 记录的是核对时的版本（见文档开头的日期与 commit）。
