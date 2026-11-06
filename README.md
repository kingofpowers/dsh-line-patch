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

| 场景 | 内置 stat 版本（本机 provider：`dev:ino:size:mtimeNs:ctimeNs`） | 本插件 file_hash |
|---|---|---|
| 内容改了 | 拒绝 ✅ | 拒绝 ✅ |
| 版本只含 mtime/size 的 provider 上，内容改了而 mtime/size 未变（`cp -p`、备份还原） | **漏判 ❌** | 拒绝 ✅ |
| 内容没变只是被 touch / 重新构建 | **误伤 ❌**（版本变了） | 放行 ✅（内容一致） |

本机 provider 的版本含 `ctimeNs`，而写文件必然改 ctime，所以「改了内容却版本不变」只会在粗时间戳文件系统或自定义 provider 上出现；`file_hash` 的价值是**不依赖 provider 的版本语义**：内容一样就放行，内容不一样就拒绝。它也正好是 `patch` 能在不重读的前提下自纠的依据（见「失败怎么读」）。

### 为什么不是逐行 hash

0.2.x 给每行加了 `行号/4位hash` 标记。对 agentVillage 那次 2,794 次请求的长会话逐行核算后：

| 项 | 一次性 token | 折算（含缓存命中与上下文驻留） |
|---|---|---|
| 读取侧逐行锚点 (+2.55 tok/行，读取量 +9.6%) | +31,264 | **+4.15M 输入当量** |
| `patch` 省下 `old_string` | −14,004 | −3.80M |

逐行锚点的读税**几乎正好吃掉**补丁的全部收益，而且它在安全性上是冗余的：`patch` 第一步校验整文件 hash，hash 对得上就说明文件与读取时一致（6 位前缀足以覆盖日常改动，概率数字见「已知限制」）。所以 0.3.0 只保留**整文件 6 位 hash**，边界改用**行内内容切片**（前 16 / 末 16 字符），模型照抄即可，读取侧零额外标记。

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

- `file_hash` 取自**最近一次** `read`/`write`/`edit` 该文件结果末尾那行，或上一次 `patch` 结果里回的那行；三处都可以连续接龙。
- `start_anchor` = 起始行的前 16 个字符，`end_anchor` = 结束行的末 16 个字符，**抄 read 结果里 `N: ` 前缀之后的那段文字**（前缀本身不是锚点的一部分）；行短于 16 字符时整行就是锚点。
- `start_anchor` 是否带缩进决定比较方式：带了按缩进严格比（`if (err) {` ≠ `    if (err) {`，挡「层级看错、行号差一行」）；不带就与折叠空白后的行比较。内部空白与行尾空白始终折叠。**建议总是连缩进一起抄。**
- `end_anchor` 是行尾切片，前后空白都折叠后按后缀比较（行尾的空白字符不算内容）。
- 空白行用空字符串 `""` 作锚点；缩进超过 16 列的行，前 16 字符全是空白，工具会提示改从第一个非空白字符开始抄。
- 单行修改（`line_start == line_end`）两个锚点落在同一行：`start_anchor` 按前缀比，`end_anchor` 允许后缀或前缀。
- 锚点必须抄满（16 字符，或整行），只抄前几个字符会被 `ANCHOR_TOO_SHORT` 拒绝。
- 若 16 字符锚点同时命中多行（例如两行都以 `const value = co` 开头），工具会以 `ANCHOR_AMBIGUOUS` 拒绝，并给出**已保证唯一的更长锚点**（可能是整行）——照它再发一次即可，不必重读。start 和 end 各有一个歧义时，各需要一次重发。
- `replace: ""` 删除该行区间；`line_shift` 给出位移，连续修改不必整段重读。
- CRLF 文件按原风格写回；末行无换行符的状态保持。

## 失败怎么读

| 错误 | 含义 | 模型该做什么 |
|---|---|---|
| `file_hash mismatch` | 文件真被改了 | **重读**（不可省） |
| `RANGE_INVALID` | 行号超出文件范围 | 改行号重试，**不要重读** |
| `ANCHOR_TOO_SHORT` | 锚点没抄满，或整段是空白 | 按错误给出的范围重抄，**不要重读** |
| `ANCHOR_AMBIGUOUS` | 16 字符锚点命中多行 | 照错误给出的更长锚点重发，**不要重读** |
| `LINE_ANCHOR_MISMATCH` | 文件没变，但该行不是你说的内容 | 错误里会回显该行**真正的锚点**；改锚点或行号重试，**不要重读** |
| `BAD_ARGUMENT` | 行号不是整数、`replace` 不是字符串、或 `file_hash` 不是 6 位小写十六进制 | 修正参数后重试；若从未见过 `file_hash` 行，说明注解没生效，改用 `edit`/`write` |

只有 `file_hash mismatch` 需要重读；其余错误都在「文件没变」的前提下发生，一轮自纠即可——这正是「一次额外往返 ≈ 一整轮上下文」的价值所在。

## 漂移检测（每个 step 前自动）

每次 `read`/`write`/`edit`/`patch` 的结果都会把「文件 hash + 版本」登记下来，之后每个模型请求前（`agent/pre-step`）复核一次，只覆盖**最近 3 个用户回合**内的文件：

```
stat 预筛（微秒级，不读文件）
├─ 版本没变            → 什么都不做
└─ 版本变了 → 算 file_hash
   ├─ 内容相同（touch / 重新构建） → 只补发 fs/observed 刷新策略底账，上下文零改动
   └─ 内容真变了                    → 在下一个请求里追加一条 notice：
                                      「这些文件在你读过/写过之后变了（只列文件名）：
                                        之前的行号与 file_hash 作废，改前请重读」
```

**不改写任何工具结果**：原来读到的内容仍留在历史里可回看，notice 只是告诉模型「别再用它的行号」。因此 read、write、edit、patch 的 hash 一视同仁地被覆盖。

**每个会话只有一条 notice**（状态按 `agent.session` 隔离，子 agent 与主会话互不串扰）：它描述的是「此刻仍然过期的文件集合」。集合变了就把这条**原地替换**（host 的 surface 只有 `replace`、没有 `delete`），等模型把文件都重读、集合空了，就替换成一句「已无过期文件」收尾。

两条边界：

- **锚点过期 ≠ 已重读**。超过 3 个用户回合的锚点会被丢弃，但 notice **不会**因此改成「已无过期文件」——那是在没有证据的情况下宣布文件没问题。丢弃只是停止追踪，`patch` 的 hash 校验仍是最后一道。
- **replace 失败会退回追加**。notice 可能被别的插件（比如 compaction）覆盖掉，此时原地替换会失败；插件会忘掉旧序号并**追加一条新的**，而不是从此沉默。

**notice 里只写文件名（去重），不写新旧 hash**。这是刻意的：如果告诉模型「新 hash 是 X」，它很容易拿这个新 hash 配旧行号去 `patch`——整文件校验会通过，只有锚点兜底；一旦变更不在边界行上，就会改错位置。只报文件名，模型唯一的正确做法就是重读。`patch` 的 `FILE_HASH_MISMATCH` 同理，**不回显当前 hash**。

这样做还有个副作用是好的：内置的 stat 版本守卫会把「内容没变但 mtime 变了」误判为外部修改，这里用内容 hash 纠正它，模型不必因为一次 rebuild 就重读整个文件。

> 0.3.1 起改用 `agent/pre-step`。0.3.0 用的 `agent/request` 在 DSH 0.2.2-rc.1 中已被移除，导致漂移检测在 0.2.2 上静默失效；`agent/pre-step` 在 0.2.1 与 0.2.2 上都存在。

## 实现要点

- 结果标注走宿主全局 waterfall **`tools/post-execute`**：监听 `read`/`write`/`edit`，把 hash 行**并入最后一个 text block**（不新增 block，否则会打断 `dsh-context-archive` 这类要求单 block 的注解插件）；不改写工具本身，也不需要覆盖同名工具（宿主不允许重名注册）。
- cordis 的 `waterfall` 里 `next()` **不收参数**，最外层监听器的返回值才是宿主应用的结果，所以监听器是 `const d = await next(); return { ...d, content: ... }`。
- 漂移通知走 **`agent/pre-step`**：监听器 `await next()` 拿到 `{ kind, messages }`，再把一条 user 消息追加到 `messages` 末尾（`createUserMessage`），不改历史。
- 追加 hash 时插件会按路径**再读一次文件**（页面缓存热），并比对工具自己广播的 `fs/observed` 版本：版本在「工具读取」与「插件复核」之间变过就**不标注**，避免把模型没看过的字节的 hash 交给它。
- `patch` 的读取与写入走 `ctx.fs`，不直接碰 `node:fs`，沙箱与远端后端仍然有效；相对路径按会话工作目录解析（与内置 fs 工具一致）。
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

**0.3.1**：漂移检测从 `agent/request` 迁到 `agent/pre-step`（前者在 DSH 0.2.2-rc.1 已被移除），并从「原地替换旧结果」改成「追加一条通知」，因此 read/write/edit/patch 的 hash 都会被覆盖，且不再改写任何历史内容。工具契约不变，无需迁移。

## 已验证

0.2.x 在真实宿主上验证过替换、行位移、过期 `file_hash`、`replace: ""` 与 `replaceIfVersion` intent；0.3.0 的 hash 标注、锚点匹配、空白宽容、缩进严格性、短行/空行、EOF/BOF、错误分流由离线测试覆盖。

**0.3.0 已在真实宿主（DSH 0.2.1-rc.5）端到端跑通**：`write`/`read` 结果带 `file_hash`，`patch` 成功并回新 hash，旧 hash 报 `FILE_HASH_MISMATCH`，外部改动后旧 read 结果被打上「已改动」。**0.3.1 的漂移通知尚未在真实宿主上验证**（离线测试覆盖）；`agent/pre-step` 的接线按 0.2.1 与 0.2.2-rc.1 的宿主源码核对，两版一致。

离线测试：`npm test` — 100 个用例（核心逻辑 55 + 工具胶水 23 + 漂移检测 22），全部通过。测试桩严格按 cordis waterfall 语义实现（`next()` 不收参数、外层返回值即结果），并断言链路被继续、下游决策被组合、注解落在单个 text block 内。

## 尚未实现

- `presentCall` / `presentResult` 的 diff 卡片（目前是纯文本渲染）。
- 只核对「本会话登记过的、3 个用户回合内」的文件；更早的锚点按设计丢弃，不做长期追踪。
- **无法删除内置 `edit`**：插件不能注销或覆盖已注册的全局工具，所以 `edit` 会继续存在；`patch` 只是新增的另一个选择。
- 沙箱策略：内置 `write` 会把 `sandbox.resolvePolicy('write', …)` 的结果传给 `writeText`，本插件没有传（沿用 0.2.x 的行为），在「会话级策略严于部署默认」的部署里可能被当成默认策略放行。这是既有问题，未在本次范围内修。

## 已知限制

- 单文件 5 MB 上限：超过上限的文件不标注 hash（模型只会看到「没有 `file_hash` 行」），`patch` 也会拒绝；此时请用 `edit`/`write`。
- **6 位 hash 是「文件是否变过」的检测器，不是防篡改凭证**。它挡的是没人针对你的改动（并发写、格式化、构建、别人保存）：随机撞车 1/1600 万，可忽略。能写这个文件的人本来也不需要骗过它——那种场景靠 provider 的版本 CAS（含 ctime）与备份，不在这层。需要更长的检测位可调 `FILE_HASH_CHARS`。
- **锚点只看边界行，且只看 16+16 个字符**。两类行仍无法靠内容区分，只能靠行号：
  1. 整行内容完全相同的行（多个孤立的 `}`、多个空行、重复的 `export function `）；
  2. 前 16 字符与末 16 字符都相同、只有中间不同的行——这类现在会被 `ANCHOR_AMBIGUOUS` 拦下并给出更长锚点，除非整行本身就重复。

  整文件 hash 对这两种情况同样无能为力（它只证明「文件没变」）。带缩进一起抄能把「只差缩进」的那类行分开（缩进 ≥16 列的行例外，见上文）。
- 追加 hash 依赖宿主提供 `tools/post-execute`；宿主没有这个 waterfall 时 `read` 不带 hash，`patch` 也就无法使用（不会静默改错）。
- 漂移通知依赖宿主提供 `agent/pre-step`；没有这个 hook 时插件仍能标注与 patch，但不会提醒「旧 hash 已作废」，只剩 `patch` 的 mismatch 兜底。
- 插件重载 / 会话恢复后，内存里的 notice 序号会丢失；插件会扫描会话 surface 收编那条旧 notice（避免多出一条），但被压缩遮罩过的旧 notice 收不回来。
- notice 是**追加到请求末尾的一条 user 消息**，不会重复（同一份新内容只提醒一次）；但它不会修改历史，模型若忽略仍会先撞一次 `FILE_HASH_MISMATCH`。
- 「版本守卫」只在 provider 广播 `fs/observed` 且带版本时生效；不广播的 provider 上插件会直接标注（此时只剩 `patch` 自己的内容 hash 校验）。
- **带 hash 的 `read` 结果在 Web UI 里会退化成通用文本卡片**（代码高亮/行号卡片需要结果文本以 `</content>` 结尾，追加的一行破坏了该判定）。只影响显示，不影响模型看到的文本。
- **PTC（`run_code`）模式拿不到这个 hash**：程序侧只收到工具的 `{ isError, value }`，而内置 `read` 的 value schema（`additionalProperties: false`）里没有 hash 字段，插件无法追加。PTC 会话里请直接用 `edit`/`write`。
- 若文件在「工具读取」与「插件复核」之间被改，插件不标注 hash（见实现要点）；更窄的窗口（插件 stat 之后、写入之前）仍由 provider 版本 CAS 兜底。
- `fs/write-intent` 不可用时退化为自行构造的 `replaceIfVersion`；再被 provider 忽略时该次写入没有 CAS 保护。
- 若 `@deepseek-ai/dsh-tools` 无法解析，`defineTool` 退化为恒等函数：工具仍可用，但参数校验交给插件自己（核心逻辑里仍有整数/类型/哈希格式校验）。

## 许可

MIT
