# dsh-line-patch

按「行号 + 行哈希 + 整文件哈希」三重锚定修改文件的 DSH 插件。给两个模型可见工具：`read_hash` 与 `patch_hash`。

## 为什么需要它

内置 `edit` 用字面量 `old_string` 定位，**定位费按输出 token 计价**。本机 308 个会话、891 次 `edit` 的实测数据：

| 指标 | 数值 |
|---|---|
| `old_string` 累计 | 285,035 字符 ≈ **81,439 输出 token** |
| 占 `new_string` 的比例 | **36%** |
| 引文 >30 行的调用 | 4.6% |
| `edit` 失败构成 | 未先读 2.9% / 文件已变 2.8% / **原文找不到仅 0.7%** |

也就是说：抄原文这件事本身就吃掉了三成输出，而它换来的定位可靠性只解决 0.7% 的失败。`patch_hash` 把这部分换成「行号 + 两个 4 字符 hash」，定位费降到个位数 token。

同时它和 DSH 内置的版本守卫**互补而非重复**：

| 场景 | 内置 stat 版本 | 本插件 sha256 |
|---|---|---|
| 内容改了且 mtime 变了 | 拒绝 ✅ | 拒绝 ✅ |
| 内容改了但 mtime/size 没变（`cp -p`、备份还原） | **漏判 ❌** | 拒绝 ✅ |
| 内容没变只是被 touch / 重新构建 | **误伤 ❌** | 放行 ✅ |

## 安装

```bash
dsh plugin --profile desktop add /path/to/dsh-line-patch
```

改完 `lib/` 后需要重新加载：touch 一下 `~/.dsh/profiles/desktop/cordis.patch.yml` 触发 HMR，或重启宿主。

## 用法

```text
read_hash { file_path: "app.py" }
→ file_hash: 7bb7a279c235cef2
  1/f3c2: import os
  2/7182: def main():
  ...

patch_hash {
  file_path: "app.py",
  file_hash: "7bb7a279c235cef2",
  line_start: 2, hash_start: "7182",
  line_end: 3,  hash_end: "251e",
  replace: "def run():"
}
→ patched app.py: lines 2-3 replaced (line shift -1). new file_hash: d119fac30942d216
```

- `file_hash`、`hash_start`、`hash_end` **三项必填**，缺一项 schema 层就拒绝。
- `replace: ""` 表示删除该行区间。
- 替换后返回 `new_file_hash` 与 `line_shift`，连续修改时不必整段重读。
- CRLF 文件按原风格写回；末行无换行符的状态保持。

## 锚点核实（每轮自动）

`read_hash` 发出的每个锚点会登记下来，之后每次模型请求前（`agent/request`）复核一次，只覆盖**最近 3 个用户回合**内的文件：

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

## 已验证

在真实宿主（desktop profile）上跑通：

- `read_hash` 返回逐行 `行号/hash` 与 `file_hash`
- `patch_hash` 正常替换、行数位移计算正确
- 过期 `file_hash` → `file_hash mismatch ... read it again`
- 错误行 hash → `line N hash mismatch ... the line numbers shifted`
- `replace: ""` 删除区间，文件内容与行位移正确
- 写入确实经过 `replaceIfVersion` intent（stub 测试断言）

锚点核实也做了真机验证：读文件 → 用 bash 在 `ctx.fs` 之外改写内容 → 下一次模型请求前，会话日志里出现

```
tool/result seq=1055  surfaceOp={"op":"replace","startSeq":1046,"endSeq":1046}  sources=[1046]
→ "[line-patch] …/line-patch-reval.txt was modified after it was read
   (file_hash 4cdfa7d498707b8f -> 417e4745306cbe22). … call read_hash again before patching."
```

即原来的 read 结果（seq 1046）被准确替换。

离线测试：`npm test` — 32 个用例（核心逻辑 17 + 工具胶水 10 + 锚点核实 5），全部通过。

## 尚未实现

- `presentCall` / `presentResult` 的 diff 卡片（目前是纯文本渲染）。
- 只核对「本会话登记过的、3 个用户回合内」的文件；更早的锚点按设计丢弃，不做长期追踪。

## 已知限制

- 单文件 5 MB 上限。
- `read_hash` 单次最多 2000 行。
- `fs/write-intent` 不可用时退化为自行构造的 `replaceIfVersion`；再不可用则退化为无条件写（此时只剩 sha256 与行 hash 保护）。
- 若 `@deepseek-ai/dsh-tools` 无法解析，`defineTool` 退化为恒等函数：工具仍可用，但参数校验交给插件自己。

## 许可

MIT
