# Gmail Recent Interactions — Trello 私有 Power-Up

在 Trello 卡片背面加一个 "Recent interactions" 区块：打开卡片时，实时列出你的 Gmail 里与该卡片客户邮箱最近往来的 8 封邮件（收到的和发出的各占一行，显示主题、收/发、日期），点击直达 Gmail 里对应的会话。行数可在 `js/config.js` 的 `MAX_ROWS` 调整，上限 20。

- 只读（`gmail.readonly`），只取邮件头（主题、日期），不取正文。
- 邮件内容不写入 Trello，也不经过任何第三方服务器：浏览器直接问 Gmail。
- 写入 Trello 的只有一样东西：这张卡片的客户邮箱地址（看板成员可见）。

## 部署（三步，约 15 分钟）

下文假设 GitHub 账号与 Matter fee manager 相同（`Zhijievisa`）。若不同，把 `zhijievisa.github.io` 换成你的。

### A. Google Cloud：建 OAuth Client ID

> **已完成（2026-11-17）。** 项目 `trello-gmail`（`trello-gmail-515001`），Audience 为 Internal，Client 名称 `Trello Power-Up`，Client ID 已写入 `js/config.js`。以下步骤仅作记录，或将来换 GitHub 账号、重建时参考。

用**拥有该邮箱的 Google 账号**登录 <https://console.cloud.google.com/>。

1. 新建一个项目（名字随意，例如 `trello-gmail`）。
2. **APIs & Services → Library** → 搜 **Gmail API** → **Enable**。
3. **APIs & Services → OAuth consent screen**（新版界面叫 **Google Auth Platform**）：
   - **Audience / User type**
     - 邮箱是 Google Workspace 账号 → 选 **Internal**。不需要 Google 审核，最省事。
     - 不是 Workspace → 只能选 **External**，状态保持 **Testing**，并在 **Test users** 里加上要用的邮箱。此模式下授权大约每 7 天要重新同意一次。
   - **Data Access / Scopes** → Add → 勾 `https://www.googleapis.com/auth/gmail.readonly`。
4. **Clients / Credentials → Create client → OAuth client ID**
   - Application type：**Web application**
   - **Authorized JavaScript origins**：`https://zhijievisa.github.io`（只到域名，不带路径，不带结尾斜杠）
   - Authorized redirect URIs：留空
5. 复制生成的 **Client ID**（形如 `1234-abc.apps.googleusercontent.com`），粘贴到 `js/config.js` 的 `GOOGLE_CLIENT_ID`。Client ID 不是密钥，可以公开；Client secret 用不到，不要放进代码。
6. 如果是 Workspace，可把域名填进 `WORKSPACE_DOMAIN`（可选）。

### B. GitHub Pages：托管

1. 新建**公开**仓库，例如 `gmail-recent-interactions`。
2. 把本文件夹内的全部内容上传到仓库根目录（`index.html` 在根目录）。
3. **Settings → Pages → Deploy from a branch → main / (root)** → Save。
4. 一两分钟后访问 `https://zhijievisa.github.io/gmail-recent-interactions/index.html`，能打开（空白页）即成功。

### C. Trello：注册私有 Power-Up

1. 打开 <https://trello.com/power-ups/admin> → **New**。
2. 名称随意（如 `Gmail Recent Interactions`），选你的 Workspace，**Iframe connector URL** 填：
   `https://zhijievisa.github.io/gmail-recent-interactions/index.html`
3. **Capabilities** 页只打开一个：**Card back section**。
4. 到看板 → **Power-Ups → Custom** → 添加它。**不要**提交公开上架。

## 使用

1. 打开任意卡片 → "Recent interactions" 区块 → 输入客户邮箱 → **Add**。若卡片标题或描述里写了邮箱，会出现 "Use xxx" 一键采用。一张卡最多 5 个地址。
2. 第一次点 **Connect Gmail** → Google 弹窗 → 选邮箱 → 同意只读权限。
3. 之后打开任何已填邮箱的卡片都会自动显示。Google 给浏览器端的授权约 1 小时过期，过期后点一次 **Reconnect Gmail**（通常弹窗一闪即关）。

每位同事看到的是**自己登录的那个邮箱**里的往来；客户邮箱地址则是全看板共享的。

## 已知限制

| 项目 | 说明 |
|---|---|
| 1 小时会话 | 纯前端方案拿不到 refresh token。要免重连，需要加一个保存 refresh token 的后端，安全面更大，本版本没做。 |
| 卡内弹窗未在真实 Trello 中验证 | 代码已用模拟的 Trello / Google / Gmail 在 Chrome 中跑通，但 Google 弹窗从 Trello 的 iframe 里弹出这一步只能上线后验证。若被拦，区块会出现 "Trouble? Use the sign-in window" 备用入口（独立窗口登录）。 |
| Gmail 深链 | 链接格式为 `mail.google.com/mail/u/?authuser=<邮箱>#all/<线程ID>`。浏览器里同时登录多个 Google 账号时依赖 `authuser` 参数选对账号。 |
| 搜索范围 | `from / to / cc / bcc` 等于该地址的每一封邮件，不含草稿、垃圾箱、垃圾邮件。只搜当前登录的这个邮箱：同事从自己邮箱发给客户、又没有抄送本邮箱的邮件不会出现。客户换邮箱发信就搜不到，需要把新地址也加到卡片。 |

## 文件

```
index.html        Trello 连接器（隐藏加载）
section.html      卡片背面区块
auth.html         备用登录窗口
js/config.js      ← 唯一需要改的文件
js/client.js      注册 card-back-section
js/gmail.js       Gmail 查询与解析
js/section.js     区块界面与登录流程
js/auth.js        备用登录窗口逻辑
css/section.css   样式（跟随 Trello 明/暗主题）
img/icon-gray.svg 区块图标
```

## 数据去向

| 数据 | 存放位置 |
|---|---|
| 客户邮箱地址 | Trello 卡片的 Power-Up 数据（card / shared） |
| Google access token | 仅当前浏览器的 localStorage，经 Trello 客户端库加密（`t.storeSecret`），约 1 小时失效 |
| 邮件主题、日期 | 只在页面内存中，关闭卡片即消失 |
| 邮件正文、附件 | 从不请求 |
