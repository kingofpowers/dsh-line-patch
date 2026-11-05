# dsh-line-patch

给 DSH 的内置文件工具加一层「锚点补丁」：`read` / `write` / `edit` 的结果末尾多一行 `file_hash`，新增一个 `patch` 工具按「整文件 hash + 行号 + 边界行内容」改文件。不新增读工具，模型仍然用它已经熟悉的 `read`。

## 为什么需要它

内置 `edit` 用字面量 `old_string` 定位，**定位费按输出 token 计价**。本机 308 个会话、891 次 `edit` 的实测数据：

| 指标 | 数值 |
|---|---|
| `old_string` 累计 | 285,035 字符 ≈ **81,439 输出 token** |
| 占 `new_string` 的比例 | **36%** |
| 引文 >30 行的调用 | 4.6% |
| `edit` 失败构成 | 未先读 2.9% / 文件已变 2.8% / **原文找不到仅 0.7%** |

也就是说：抄原文这件事吃掉了三成输出，而它换来的定位可靠性只解决 0.7% 的失败。

同时它和 DSH 内置的版本守卫**互补而非重复**：

| 场景 | 内置 stat 版本 | 本插件 file_hash |
|---|---|---|
| 内容改了且 mtime 变了 | 拒绝 ✅ | 拒绝 ✅ |
| 内容改了但 mtime/size 没变（`cp -p`、备份还原） | **漏判 ❌** | 拒绝 ✅ |
| 内容没变只是被 touch / 重新构建 | **误伤 ❌** | 放行 ✅ |

### 为什么不是逐行 hash

0.2.x 给每行加了 `行号/4位hash` 标记。对 agentVillage 那次 2,794 次请求的长会话逐行核算后：

| 项 | 一次性 token | 折算（含缓存命中与上下文驻留） |
|---|---|---|
| 读取侧逐行锚点 (+2.55 tok/行，读取量 +9.6%) | +31,264 | **+4.15M 输入当量** |
| `patch` 省下 `old_string` | −14,004 | −3.80M |

逐行锚点的读税**几乎正好吃掉**补丁的全部收益，而且它在安全性上是冗余的：`patch` 第一步校验整文件 hash，hash 对得上就意味着文件与读取时逐字节相同。所以 0.3.0 只保留**整文件 6 位 hash**，边界改用**行内内容切片**（前 16 / 末 16 字符），模型照抄即可，读取侧零额外标记。

## 安装

```bash
dsh plugin --profile desktop add /path/to/dsh-line-patch
```

改完 `lib/` 后需要重新加载：touch 一下 `~/.dsh/profiles/desktop/cordis.patch.yml` 触发 HMR，或重启宿主。

## 用法

`read` / `write` / `edit` 的结果末尾会多出一行 `file_hash: xxxxxx`（6 位十六进制）：

```text
read { file_path: "app.py" }
→ 1: import os
  2: def main():
  3:     return 0
  file_hash: 9f2c1a
```

然后直接用它改：

```text
patch {
  file_path: "app.py",
  file_hash: "9f2c1a",
  line_start: 2, start_anchor: "def main():",
  line_end: 3,   end_anchor: "return 0",
  replace: "def run():\n    return 1"
}
→ patched app.py: lines 2-3 replaced (line shift +0).
  file_hash: d119fa
```

- `file_hash` 取自**最近一次** `read`/`write`/`edit` 该文件结果末尾那行；`patch` 成功后也会回一行新的 `file_hash`，可以连续改。
- `start_anchor` = 起始行的前 16 个字符，`end_anchor` = 结束行去掉行尾空白后的末 16 个字符，**按 read 结果里显示的样子照抄**；行短于 16 字符时整行就是锚点。
- `start_anchor` 是否带缩进决定比较方式：带了按缩进严格比（`if (err) {` ≠ `    if (err) {`，挡「层级看错、行号差一行」）；不带就与折叠空白后的行比较。内部空白与行尾空白始终折叠。**建议总是连缩进一起抄。**
- `end_anchor` 是行尾切片，边缘空白属于内容，始终按折叠空白后的后缀比较。
- 空白行用空字符串 `""` 作锚点；缩进超过 16 列的行，前 16 字符全是空白，工具会提示改从第一个非空白字符开始抄。
- 单行修改（`line_start == line_end`）两个锚点落在同一行：`start_anchor` 按前缀比，`end_anchor` 允许后缀或前缀。
- 锚点必须抄满（16 字符，或整行），只抄前几个字符会被 `ANCHOR_TOO_SHORT` 拒绝。
- `replace: ""` 删除该行区间；`line_shift` 给出位移，连续修改不必整段重读。
- CRLF 文件按原风格写回；末行无换行符的状态保持。

## 失败怎么读

| 错误 | 含义 | 模型该做什么 |
|---|---|---|
| `file_hash mismatch` | 文件真被改了 | **重读**（不可省） |
| `RANGE_INVALID` | 行号超出文件范围 | 改行号重试，**不要重读** |
| `ANCHOR_TOO_SHORT` | 锚点没抄满，或整段是空白 | 按错误给出的范围重抄，**不要重读** |
| `LINE_ANCHOR_MISMATCH` | 文件没变，但该行不是你说的内容 | 错误里会回显该行**真正的锚点**；改锚点或行号重试，**不要重读** |
| `BAD_ARGUMENT` | 行号不是整数或 `replace` 不是字符串 | 修正参数类型后重试 |

只有 `file_hash mismatch` 需要重读；其余错误都在「文件没变」的前提下发生，一轮自纠即可——这正是「一次额外往返 ≈ 一整轮上下文」的价值所在。

## 锚点核实（每轮自动）

每次 `read` 都会把「文件 hash + 版本」登记下来，之后每次模型请求前（`agent/request`）复核一次，只覆盖**最近 3 个用户回合**内的文件：

```
stat 预筛（微秒级，不读文件）
├─ 版本没变            → 什么都不做
└─ 版本变了 → 算 file_hash
   ├─ 内容相同（touch / 重新构建） → 只补发 fs/observed 刷新策略底账，上下文零改动
   └─ 内容真变了                    → 把当初那条 read 结果原地替换成「已失效 + 新旧 hash + 请重读」
```

第二行是关键：内置的 stat 版本守卫会把「内容没变但 mtime 变了」误判为外部修改，这里用内容 hash 纠正它，模型不必因为一次 rebuild 就重读整个文件。

## 实现要点

- 结果标注走宿主全局 waterfall **`tools/post-execute`**：监听 `read`/`write`/`edit`，用 `{ kind: 'accept', content: [...] }` 在原结果后追加一行 hash；不改写工具本身，也不需要覆盖同名工具（宿主不允许重名注册）。
- 追加 hash 时插件会按路径**再读一次文件**（页面缓存热）——这是为了让 hash 描述文件本身，而不是工具返回的那个窗口。
- `patch` 的读取与写入走 `ctx.fs`，不直接碰 `node:fs`，沙箱与远端后端仍然有效。
- 写入复刻内置 `write` 的 intent 舞蹈：`fs/write-intent` waterfall 取意图 → `writeText(intent)` → `emit('fs/observed')`。**裸调 `writeText` 会静默绕过读后写门禁与版本 CAS**。

## 从 0.2.x 升级

0.3.0 是**破坏性改版**：`read_hash` 与 `patch_hash` 两个工具都已删除。

| 0.2.x | 0.3.0 |
|---|---|
| `read_hash` 输出 `1/f3c2: 内容` + `file_hash`（16 位） | 用内置 `read`；结果末尾多一行 `file_hash: xxxxxx`（6 位） |
| `write` / `edit` 不返回 hash | 两者的结果都追加 `file_hash` |
| `patch_hash` 工具 | `patch` 工具（`file_hash` + `line_start` + `start_anchor` + `line_end` + `end_anchor` + `replace`） |
| `hash_start` / `hash_end` | `start_anchor` / `end_anchor`（16 字符内容切片） |
| `total_lines` | 已移除 |

另外，0.3.0 新增了 `engines.dsh: ">=0.2.1-rc.1 <0.3.0"`。这不只是元数据：声明了 `engines.dsh` 之后，插件管理器只按这一条判断，`peerDependencies` 不再兜底——装到范围外的宿主上会被直接拒绝。

## 已验证

0.2.x 在真实宿主上验证过替换、行位移、过期 `file_hash`、`replace: ""` 与 `replaceIfVersion` intent；0.3.0 的 hash 标注、锚点匹配、空白宽容、缩进严格性、短行/空行、EOF/BOF、错误分流由离线测试覆盖。

离线测试：`npm test` — 70 个用例（核心逻辑 46 + 工具胶水 19 + 锚点核实 5），全部通过。测试桩严格按 cordis waterfall 语义实现（`next()` 不收参数、外层返回值即结果），并断言链路被继续、下游决策被组合。

0.3.0 **尚未在真实宿主上做端到端验证**：`tools/post-execute` 的行为是按宿主源码（`dsh-tools` 0.2.1-rc.5）核对的，首次装进 desktop profile 时应当先跑一遍 `read` → `patch`。

## 尚未实现

- `presentCall` / `presentResult` 的 diff 卡片（目前是纯文本渲染）。
- 只核对「本会话登记过的、3 个用户回合内」的文件；更早的锚点按设计丢弃，不做长期追踪。
- **无法删除内置 `edit`**：插件不能注销或覆盖已注册的全局工具，所以 `edit` 会继续存在；`patch` 只是新增的另一个选择。
- 沙箱策略：内置 `write` 会把 `sandbox.resolvePolicy('write', …)` 的结果传给 `writeText`，本插件没有传（沿用 0.2.x 的行为），在「会话级策略严于部署默认」的部署里可能被当成默认策略放行。这是既有问题，未在本次范围内修。

## 已知限制

- 单文件 5 MB 上限（追加 hash 时也按这个上限跳过）。
- **6 位 hash 只是「文件是否变过」的指示器**（24 bit，随机改动撞车概率约 6e-8），不是安全边界。
- **锚点只看边界行，且只看 16+16 个字符**。两类行仍无法靠内容区分，只能靠行号：
  1. 内容完全相同的行（两处都写 `export function `、多个孤立的 `}`、多个空行）；
  2. 前 16 字符与末 16 字符都相同、只有中间不同的行。

  整文件 hash 对这两种情况同样无能为力（它只证明「文件没变」）。带缩进一起抄能把「只差缩进」的那类行分开（缩进 ≥16 列的行例外，见上文）。
- 追加 hash 依赖宿主提供 `tools/post-execute`；宿主没有这个 waterfall 时 `read` 不带 hash，`patch` 也就无法使用（不会静默改错）。
- `fs/write-intent` 不可用时退化为自行构造的 `replaceIfVersion`；再被 provider 忽略时该次写入没有 CAS 保护。
- 若 `@deepseek-ai/dsh-tools` 无法解析，`defineTool` 退化为恒等函数：工具仍可用，但参数校验交给插件自己（核心逻辑里仍有整数/类型校验）。

## 许可

MIT
