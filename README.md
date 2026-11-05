# dsh-line-patch

按「整文件哈希 + 边界行内容锚点」修改文件的 DSH 插件。给两个模型可见工具：`read_hash` 与 `patch_hash`。

## 为什么需要它

内置 `edit` 用字面量 `old_string` 定位，**定位费按输出 token 计价**。本机 308 个会话、891 次 `edit` 的实测数据：

| 指标 | 数值 |
|---|---|
| `old_string` 累计 | 285,035 字符 ≈ **81,439 输出 token** |
| 占 `new_string` 的比例 | **36%** |
| 引文 >30 行的调用 | 4.6% |
| `edit` 失败构成 | 未先读 2.9% / 文件已变 2.8% / **原文找不到仅 0.7%** |

也就是说：抄原文这件事本身就吃掉了三成输出，而它换来的定位可靠性只解决 0.7% 的失败。

同时它和 DSH 内置的版本守卫**互补而非重复**：

| 场景 | 内置 stat 版本 | 本插件 sha256 |
|---|---|---|
| 内容改了且 mtime 变了 | 拒绝 ✅ | 拒绝 ✅ |
| 内容改了但 mtime/size 没变（`cp -p`、备份还原） | **漏判 ❌** | 拒绝 ✅ |
| 内容没变只是被 touch / 重新构建 | **误伤 ❌** | 放行 ✅ |

### 0.3.0 为什么去掉了逐行 hash

0.2.x 给每行加了 `行号/4位hash` 标记。对 agentVillage 那次 2,794 次请求的长会话逐行核算后：

| 项 | 一次性 token | 折算（含缓存命中与上下文驻留） |
|---|---|---|
| 读取侧逐行锚点 (+2.55 tok/行，读取量 +9.6%) | +31,264 | **+4.15M 输入当量** |
| `patch_hash` 省下 `old_string` | −14,004 | −3.80M |

逐行锚点的读税**几乎正好吃掉** patch 的全部收益。而且它在安全性上是冗余的：`patch_hash` 第一步就校验整文件哈希，哈希对得上就意味着文件与读取时逐字节相同，行内容必然可信。

所以 0.3.0：

- `read_hash` 只多输出一行 `file_hash`，逐行标记改为 `行号│内容`，**读取侧零锚点税**；
- 边界改用**行内内容切片**（起始行前 16 个有效字符 / 结束行末 16 个有效字符），模型直接照抄，不用算任何哈希；
- 错误按「文件变没变」分流：文件真变了才要重读，行号抄错则一轮自纠。

## 安装

```bash
dsh plugin --profile desktop add /path/to/dsh-line-patch
```

改完 `lib/` 后需要重新加载：touch 一下 `~/.dsh/profiles/desktop/cordis.patch.yml` 触发 HMR，或重启宿主。

## 用法

```text
read_hash { file_path: "app.py" }
→ file_hash: 7bb7a279c235cef2
  lines 1-3 of 3
  1│import os
  2│def main():
  3│    return 0

patch_hash {
  file_path: "app.py",
  file_hash: "7bb7a279c235cef2",
  line_start: 2, start_anchor: "def main():",
  line_end: 3,   end_anchor: "return 0",
  replace: "def run():\n    return 1"
}
→ patched app.py: lines 2-3 replaced (line shift +0). new file_hash: d119fac30942d216
```

- `file_hash`、`start_anchor`、`end_anchor` **三项必填**，缺一项 schema 层就拒绝。
- `start_anchor` = 起始行的前 16 个字符，**连缩进一起照抄**（`read_hash` 显示什么样就抄什么样）；`end_anchor` = 结束行去掉行尾空白后的末 16 个字符。行短于 16 字符时整行就是锚点。
- `start_anchor` 是否带缩进决定比较方式：**带了就按缩进严格比**（`if (err) {` ≠ `    if (err) {`，正好挡住「层级看错、行号差一行」），不带就与折叠空白后的行比较。内部空白与行尾空白始终折叠。**建议总是连缩进一起抄。**
- `end_anchor` 是行尾切片，边缘空白属于内容，因此始终按折叠空白后的后缀比较（不区分缩进）。
- 空白行用空字符串 `""` 作锚点（断言该行确实为空）；缩进超过 16 列的行，前 16 字符全是空白，工具会提示改从第一个非空白字符开始抄。
- 单行修改（`line_start == line_end`）两个锚点落在同一行上：`start_anchor` 仍按前缀比，`end_anchor` 允许后缀或前缀（所以「把行首切片同时填进两个槽」也能通过）。
- `total_lines` 可选，就是 read 头里的 `of N`，用来提前拦下行号抄错。
- `replace: ""` 表示删除该行区间；整数 `line_shift` 给出位移，连续修改时不必整段重读。
- 锚点必须抄满（16 字符，或整行）。只抄前几个字符会被 `ANCHOR_TOO_SHORT` 拒绝——否则一个 2 字符锚点等于把校验降级成通配符。
- CRLF 文件按原风格写回；末行无换行符的状态保持。

## 失败怎么读

| 错误 | 含义 | 模型该做什么 |
|---|---|---|
| `file_hash mismatch` | 文件真被改了 | **重读**（不可省） |
| `total_lines mismatch` / `RANGE_INVALID` | 行号超出或与总行数不符 | 改行号重试，**不要重读** |
| `ANCHOR_TOO_SHORT` | 锚点没抄满，或整段是空白 | 按错误给出的范围重抄，**不要重读** |
| `LINE_ANCHOR_MISMATCH` | 文件没变，但该行不是你说的内容 | 错误里会回显该行**真正的锚点**；改锚点或行号重试，**不要重读** |
| `BAD_ARGUMENT` | 行号不是整数或 `replace` 不是字符串 | 修正参数类型后重试 |

只有 `file_hash mismatch` 需要重读；其余错误都在「文件没变」的前提下发生，一轮自纠即可——这正是「一次额外往返 ≈ 一整轮上下文」的价值所在。

## 锚点核实（每轮自动）

`read_hash` 发出的锚点会登记下来，之后每次模型请求前（`agent/request`）复核一次，只覆盖**最近 3 个用户回合**内的文件：

```
stat 预筛（微秒级，不读文件）
├─ 版本没变            → 什么都不做
└─ 版本变了 → 算 sha256
   ├─ 内容相同（touch / 重新构建） → 只补发 fs/observed 刷新策略底账，上下文零改动
   └─ 内容真变了                    → 把当初那条 read 结果原地替换成「已失效 + 新旧 hash + 请重读」
```

第二行是关键：内置的 stat 版本守卫会把「内容没变但 mtime 变了」误判为外部修改，这里用内容哈希纠正它，模型不必因为一次 rebuild 就重读整个文件。

工具自己改过的文件（`patch_hash`、内置 `write`/`edit`）会先通过 `fs/observed` 把对应锚点作废，**不会被当成外部变更回报给模型**。

## 实现要点

- 所有读写走 `ctx.fs`，不直接碰 `node:fs`，沙箱与远端后端仍然有效。
- 写入复刻内置 `write` 的 intent 舞蹈：`fs/write-intent` waterfall 取意图 → `writeText(intent)` → `emit('fs/observed')`。**裸调 `writeText` 会静默绕过读后写门禁与版本 CAS**。
- 读取时同样 `emit('fs/observed')`，否则策略门禁会把目标当作「没读过」。

## 从 0.2.x 升级

0.3.0 是**破坏性改版**：

| 0.2.x | 0.3.0 |
|---|---|
| `read_hash` 输出 `1/f3c2: 内容` | `1│内容`（无逐行 hash） |
| `hash_start` / `hash_end`（4 位 md5） | `start_anchor` / `end_anchor`（16 字符内容切片） |
| 输出里的 `line_hash_chars` 字段 | 已移除（锚点长度固定 16，写在工具描述里） |

没有兼容层：旧调用会因缺少 `start_anchor`/`end_anchor` 被 schema 拒绝。重新 `read_hash` 一次即可拿到新格式。

另外，0.3.0 新增了 `engines.dsh: ">=0.2.1-rc.1 <0.3.0"`。这不只是元数据：声明了 `engines.dsh` 之后，插件管理器只按这一条判断，`peerDependencies` 不再兜底——装到范围外的宿主上会被直接拒绝。升级 DSH 到 0.3 前需要先放宽这条区间。

## 已验证

0.2.x 在真实宿主上验证过替换、行位移、过期 `file_hash`、`replace: ""` 与 `replaceIfVersion` intent；0.3.0 的边界锚点、空白宽容、缩进严格性、短行/空行、EOF/BOF、单行双锚点、错误分流由离线测试覆盖。

离线测试：`npm test` — 73 个用例（核心逻辑 50 + 工具胶水 18 + 锚点核实 5），全部通过。

0.3.0 **尚未在真实宿主上做端到端验证**（只做了离线测试，以及按真实宿主 `@deepseek-ai/dsh-tools` 的 schema 编译结果核对参数表）；首次装进 desktop profile 时应当先跑一遍 `read_hash` → `patch_hash`。

## 尚未实现

- `presentCall` / `presentResult` 的 diff 卡片（目前是纯文本渲染）。
- 只核对「本会话登记过的、3 个用户回合内」的文件；更早的锚点按设计丢弃，不做长期追踪。
- 沙箱策略：内置 `write` 会把 `sandbox.resolvePolicy('write', …)` 的结果传给 `writeText`，本插件没有传（沿用 0.2.x 的行为），在「会话级策略严于部署默认」的部署里可能被当成默认策略放行。这是既有问题，未在本次范围内修。

## 已知限制

- 单文件 5 MB 上限。
- `read_hash` 单次最多 2000 行。
- 空文件（0 行）没有可锚定的行，`patch_hash` 直接拒绝并提示改用 `write`。
- **锚点只看边界行，且只看 16+16 个字符**。因此两类行仍无法靠内容区分，只能靠行号：
  1. 内容完全相同的行（两处都写 `export function `、多个孤立的 `}`、多个空行）；
  2. 前 16 字符与末 16 字符都相同、只有中间不同的行。

  整文件哈希对这两种情况同样无能为力（它只证明「文件没变」）。带缩进一起抄能把「只差缩进」的那类行分开，这是 0.3.0 相比 0.2.x 唯一变严格的地方。
- `fs/write-intent` 不可用时退化为自行构造的 `replaceIfVersion`；再被 provider 忽略时该次写入没有 CAS 保护（只剩 sha256 与内容锚点保护）。
- 若 `@deepseek-ai/dsh-tools` 无法解析，`defineTool` 退化为恒等函数：工具仍可用，但参数校验交给插件自己（核心逻辑里仍有整数/类型校验）。

## 许可

MIT
