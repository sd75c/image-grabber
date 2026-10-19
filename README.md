# 图提取 ImageGrab

一个基于 Chrome Manifest V3 的电商图片提取扩展：在淘宝 / 天猫 / 京东 / 拼多多商品详情页右下角放一个悬浮按钮，扫描页面上的商品图，打开独立画廊筛选、批量下载，并在用户授权图片域名后尽量转换为 PNG。

## 功能

- 仅在受支持的商品详情页注入右下角「获取图片」悬浮按钮，页面其余区域不受影响。
- 从以下来源收集图片：
  - `img` 的 `src` / `currentSrc` / `srcset`
  - `data-src`、`data-original`、`data-lazy-src`、`data-origin`、`data-ks-lazyload` 等懒加载属性
  - `picture > source[srcset]`
  - 内联样式和站点常见容器上的 `background-image`
- 按站点使用不同的主图 / 缩略图 / 详情图选择器，而不是假设四个站点结构一致。
- 归并同一张图的 CDN 缩略图与原图（阿里 `_430x430q90.jpg` 后缀、京东 `/n1/s450x450_jfs/` 路径等），并优先保留原图 URL。
- 过滤小于门槛的图标、文件名明显的占位图 / logo / 二维码，以及重复图片。
- 画廊页显示缩略图、真实像素尺寸、复选框、全选、反选和已选数量。
- 下载选中图片，支持将 JPEG / WebP / AVIF 等转换为 PNG；GIF 和 SVG 保留原格式。
- 下载过程显示整体进度、每张图的处理状态和最终结果；失败项可再次下载。
- 工具栏图标也可触发扫描，并在图标上显示本次提取数量。

## 文件结构

```text
image-grabber/
├── manifest.json      # MV3 配置、权限、内容脚本匹配规则、图标
├── content.js         # 站点适配、图片扫描/去重/测量、悬浮按钮与消息发送
├── content.css        # 悬浮按钮与提示条样式（全部限定在 #igrab-host 内）
├── background.js      # Service Worker：保存提取结果、打开画廊、角标、转发扫描指令
├── gallery.html       # 画廊页面结构
├── gallery.js         # 画廊渲染、选择状态、权限申请、PNG 转换、下载与进度
├── gallery.css        # 画廊暗色/亮色主题、网格、工具栏、响应式样式
├── README.md
├── .gitignore
├── icons/             # 16/32/48/128 像素扩展图标
└── tools/             # 仅开发自测使用，扩展运行时不引用
    ├── serve.js             # 本地静态服务器（默认 127.0.0.1:8123）
    ├── content-harness.html # 图片提取逻辑自测
    ├── content-ui-harness.html # 悬浮按钮 / 消息自测
    ├── gallery-harness.html # 画廊下载 / 权限 / 转换自测（mock chrome API）
    ├── background-harness.js # Node 环境下的 Service Worker 逻辑自测
    ├── make-fixtures.js / make-icons.js / png.js
    └── fixtures/            # 自测用本地图片
```

## 技术方案

### 为什么拆成三层

- **Content Script**：只有它能读取商品页 DOM、计算元素样式、预加载图片并拿到真实尺寸。它负责采集和页面内 UI。
- **Service Worker**：内容脚本不能打开扩展页面。由它接收采集结果、写入 `chrome.storage.session`、用 `chrome.tabs.create` 打开画廊，并维护最多 5 次提取记录。
- **扩展页面（gallery.html）**：独立的安全上下文，负责展示、选择、权限申请、跨域读取图片、Canvas 转 PNG 和调用 `chrome.downloads`。

消息协议：

```text
content.js  --IGRAB_CAPTURE(payload)-->  background.js
                                           ├─ chrome.storage.session["capture:<id>"] = payload
                                           ├─ chrome.tabs.create("gallery.html?id=<id>")
                                           └─ 工具栏角标 = 图片数量

工具栏图标点击 --> background.js --IGRAB_TRIGGER--> content.js
```

采集结果只保存在 `storage.session`，关闭浏览器即清空；画廊通过 URL 中的 `id` 读取对应记录。

### 扫描流程

1. 按当前 URL 选择站点适配器（淘宝/天猫、京东、拼多多）；在非商品详情页不挂载按钮。
2. 先扫描站点主图 / 缩略图 / 详情图容器，再兜底扫描全页 `img`、`picture source`，最后扫描背景图。
3. URL 归一化：补全协议相对地址、HTML 实体、去掉 hash，过滤 `data:` / `blob:` / `javascript:` / SVG / ICO。
4. 用 `dedupeKey()` 把同一张图的尺寸变体归并；用 `urlQuality()` 识别原图与缩放图，原图优先。
5. 对尺寸未知的候选图片做并发受限（8）的预加载测量，单张超时 6 秒。
6. 按以下门槛过滤：
   - 面积 ≥ 60,000 像素
   - 短边 ≥ 80 像素
   - 长边 ≥ 300 像素
   这样能过滤 48×48 图标，同时保留 600×120 这类详情长图切片。
7. 站点主图即使预加载失败也会保留（可能是防盗链导致测量失败，但下载仍可能成功）。
8. 按「站点主图优先 → 已知面积从大到小」排序，最多返回 120 张。

### 去重与画质

`dedupeKey()` 的规则：

- 阿里 CDN：`xxx.jpg_430x430q90.jpg` → `xxx.jpg`
- 京东 CDN：`/n1/s450x450_jfs/...`、`/n0/jfs/...` 统一为 `/jfs/...`；`xxx.jpg!q70.dpg` → `xxx.jpg`
- 拼多多 / 七牛：去掉缩放类查询参数
- 其他站点：去掉 `utm_*`、`spm`、`width`、`height`、`w`、`h` 等常见尺寸/追踪参数，其余参数排序后保留

`urlQuality()` 会判断 URL 是原图还是 CDN 缩放图。合并同一 key 时：

- 已加载的小缩略图不会覆盖尺寸未知、可能是原图的地址；
- 原图地址会替换缩放图地址，并重新测量；
- 如果原图地址测量失败或反而更小，退回此前已知可用的缩放图。

### 下载与 PNG 转换

- 默认勾选「转换为 PNG」。
- 点击下载时，先对本次涉及的所有图片域名调用 `chrome.permissions.request()`；该调用发生在按钮点击的同一个任务中，满足 Chrome 的用户手势要求。
- 授权成功：
  - `fetch` 原图 → `createImageBitmap` 解码 → Canvas 绘制 → `canvas.toBlob('image/png')`；
  - 已经是 PNG 的直接下载；GIF / SVG 保留原格式；
  - 解码失败、Canvas 不支持或像素超过约 2400 万时，回退为原格式下载；
  - 响应内容不像图片（例如防盗链返回 HTML）时标记失败，避免把 HTML 保存成 `.png`。
- 拒绝授权或 `fetch` 失败：
  - 使用 `chrome.downloads.download()` 直接下载原始 URL，不做转换；
  - 画廊会明确提示「原图直下」。
- 下载完成后通过 `chrome.downloads.onChanged` 回写状态；对极快完成或监听器注册前完成的任务，再用 `downloads.search()` 补偿查询。
- 文件保存到 `Downloads/ImageGrab/<站点>/<商品标题>-<序号>.<扩展名>`，重名时自动加后缀。

### 权限说明

`manifest.json` 只声明：

```json
"permissions": ["storage", "downloads"],
"optional_host_permissions": ["*://*/*"]
```

- `storage`：保存本次提取结果（当前实现使用 `storage.session`，关闭浏览器即清空）。
- `downloads`：调用下载 API 并读取下载状态。
- `optional_host_permissions`：安装时不申请任意网站访问权。内容脚本只注入 `matches` 声明的淘宝 / 天猫 / 京东 / 拼多多域名；只有在用户点击「下载选中」并勾选 PNG 时，才针对图片所在域名申请最小范围的主机权限（例如 `https://img.alicdn.com/*`），成功后 Chrome 会记住该授权。
- 内容脚本的 `matches` 只用于声明注入范围，不读取页面历史、Cookie 或标签页列表。
- 没有申请 `tabs`、`scripting`、`webRequest` 等额外权限。

## 安装（Chrome）

1. 打开 `chrome://extensions`。
2. 右上角开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择包含 `manifest.json` 的目录：
   `d:\project\image-grabber`
4. 建议把「图提取 ImageGrab」固定到工具栏。
5. 安装或重新加载扩展后，**刷新已经打开的商品页**；内容脚本不会自动注入到旧标签页。

要求 Chrome 102 或更高版本（`storage.session`）。Edge 等 Chromium 浏览器也可用同样方式加载。

> 注意：本次用命令行启动的官方 Chrome 152 没有加载本扩展，日志显示 `--disable-extensions-except is not allowed in Google Chrome`；因此请使用上面的 `chrome://extensions` 手动加载，不要依赖命令行自动化。

## 使用

1. 打开淘宝 / 天猫 / 京东 / 拼多多的商品详情页。
2. 先向下滚动页面，让懒加载图片出现。
3. 点击右下角「获取图片」；也可以在扩展工具栏点击图标。
4. 扩展会打开新标签页展示画廊：
   - 点击卡片或左上角复选框选择图片；
   - 使用「全选」「反选」；
   - 按需关闭「转换为 PNG」；
   - 点击「下载选中」。
5. 第一次转换时会弹出图片域名访问授权。允许后开始转换；拒绝则直接下载原图。
6. 下载完成后在 Chrome 下载栏查看结果；画廊卡片会显示「已下载」「已转 PNG」「原图直下」「失败」等状态。

## 开发自测

### 静态检查

```powershell
node --check content.js
node --check background.js
node --check gallery.js
```

### 本地自测页

```powershell
node tools/serve.js
```

然后打开：

- `http://127.0.0.1:8123/tools/content-harness.html`
  验证 URL 归一化、srcset、CDN 去重、京东/拼多多画质识别、小图/占位图过滤、懒加载、背景图、原图升级和尺寸排序。
- `http://127.0.0.1:8123/tools/content-ui-harness.html`
  验证右下角按钮挂载、扫描、`IGRAB_CAPTURE` 消息和成功提示；需要手动点击一次「获取图片」。
- `http://127.0.0.1:8123/tools/gallery-harness.html?id=harness`
  使用 mock 的 `chrome.storage` / `chrome.permissions` / `chrome.downloads` 验证 PNG 转换、权限申请、进度、失败处理；不会写入真实下载目录。
- `http://127.0.0.1:8123/tools/gallery-harness.html?id=harness&deny=1`
  模拟拒绝授权，验证自动回退为原图下载。
- `node tools/background-harness.js`
  验证 Service Worker 的提取结果保存、画廊打开、角标、参数校验和「最多保留 5 次」清理。

### 本次实际验证结果

以下结果来自本仓库的自测页和 Node 脚本，使用本地图片与 mock chrome API：

| 检查 | 结果 |
| --- | --- |
| `node --check`（content / background / gallery） | 通过 |
| `tools/background-harness.js` | 8 / 8 通过 |
| `tools/content-harness.html` | 28 / 28 通过 |
| `tools/content-ui-harness.html` | 点击后全部检查通过（8 项） |
| `tools/gallery-harness.html`（授权模式） | 8 / 8 通过：3 张 PNG 下载成功，缺失图与 HTML 响应按预期失败 |
| `tools/gallery-harness.html?deny=1`（拒绝模式） | 6 / 6 通过：3 张原图直下，1 张缺失图失败 |

**未完成的部分**：本次没有在真实的淘宝 / 天猫 / 京东 / 拼多多商品页上做端到端验证，也没有在真实 Chrome 扩展环境里完成一次「加载已解压扩展 → 商品页 → 画廊 → 下载」的完整链路（官方 Chrome 152 拒绝了命令行加载未打包扩展）。真实站点 DOM、登录态、防盗链策略会随时间和 A/B 实验变化，请按下面的清单人工验证。

### 真实站点人工检查清单

- [ ] 按钮只在商品详情页出现，其他页面不出现。
- [ ] 列表页 / 搜索页 / 店铺页不会误出现按钮。
- [ ] 淘宝 / 天猫主图、缩略图、详情图都能提取，数量合理（通常 10–60 张）。
- [ ] 京东主图优先拿到 `data-origin` 的 `/n0/jfs/` 原图，而不是 450×450 缩略图。
- [ ] 拼多多商品图能提取，页面滚动后数量会增加。
- [ ] 图标、店铺 logo、二维码、占位图被过滤。
- [ ] 同一张图的缩略图与原图只出现一次。
- [ ] 画廊尺寸与图片实际尺寸一致。
- [ ] 允许域名权限后，JPEG / WebP 输出为 PNG；GIF 保持 GIF。
- [ ] 拒绝权限后，下载的是原格式，状态显示「原图直下」。
- [ ] 下载失败（防盗链、404、网络中断）有明确状态，不产生损坏文件。
- [ ] 商品页 SPA 跳转到另一个商品后，按钮状态正常，重新提取得到新商品的图。
- [ ] 关闭再打开画廊时，最近 5 次提取仍可查看；关闭浏览器后被清空。

## 已知限制

1. **站点 DOM 会变化**：淘宝、天猫、京东、拼多多频繁改版和 A/B 测试；选择器与背景图启发式规则可能漏图。可在 `content.js` 的 `SITES` 中补充选择器。
2. **只扫描当前 DOM**：未滚动到的懒加载图片、需要交互才渲染的图片、Canvas/WebGL 绘制的图片、`data:`/`blob:` 图片不会被提取。
3. **不进入 iframe 和 Shadow DOM**：`all_frames: false`，且不遍历 shadow root；某些拼多多页面或内嵌详情页可能拿不到图片，悬浮按钮也不会出现在 iframe 内。
4. **跨域与防盗链**：PNG 转换需要图片域名的主机权限。部分 CDN 会校验 Referer / Cookie，扩展 `fetch` 可能 403；此时回退为直接下载，直接下载仍可能失败。转换流程会识别「200 + HTML」的防盗链响应并标记失败。
5. **PNG 转换有边界**：超过约 2400 万像素的图片跳过转换以控制内存；超大图还可能触发浏览器 Canvas 尺寸限制。GIF/SVG 为保留动画与矢量特性不做转换。
6. **权限可能被拒绝**：用户拒绝域名授权、企业策略限制或 Chrome 不弹出授权时，只下载原图。
7. **下载期间不要关闭画廊标签页**：转换为 PNG 时使用页面内 `blob:` URL 交给下载器；提前关闭页面可能导致下载中断。已完成的下载不受影响。
8. **存储是临时的**：提取结果只保存在 `chrome.storage.session`，关闭浏览器即清空；最多保留最近 5 次。用历史记录重新打开旧画廊会提示结果不存在。
9. **文件名与格式**：下载目录为 `Downloads/ImageGrab/...`；同名文件由 Chrome 自动加序号。直接下载模式下扩展名根据 URL 猜测，URL 没有扩展名时默认 `.jpg`，可能与真实格式不一致。
10. **移动端 / 特殊页面**：只匹配桌面常见的商品详情 URL；移动端专用域名、App 内 WebView、需要登录或验证码的页面可能无法使用。
11. **按钮位置固定**：悬浮按钮固定在右下角，可能和站点自身的客服/购物车浮层重叠，但不会修改页面其他元素。
12. **Chrome 版本**：需要 Chrome 102+；本次用命令行启动的官方 Chrome 152 未加载本扩展，必须通过 `chrome://extensions` 手动加载。

## 常见问题

**按钮没有出现？**

- 确认当前 URL 是商品详情页，而不是列表页或首页。
- 打开 `chrome://extensions` 确认扩展已启用且没有报错。
- 重新加载扩展后刷新商品页。
- 查看页面控制台是否有 `[ImageGrab]` 开头的错误。

**点击「获取图片」提示没有找到图片？**

- 先滚动页面，等待懒加载图片出现，再点击一次。
- 部分详情图在折叠区域或需要点击「展开」后才渲染。
- 商品页可能把图片放在 iframe / Shadow DOM 中，当前版本无法读取。

**PNG 转换失败？**

- 检查是否拒绝了图片域名授权；拒绝后会自动改为原图下载。
- 图片可能受防盗链保护，或尺寸超过 Canvas 上限；卡片会标记失败或「原格式下载」。
- 可以在画廊关闭「转换为 PNG」后重新下载。

**下载后文件名是 `.jpg` 但内容是 PNG？**

- 直接下载模式根据 URL 猜测扩展名；转换模式会按实际输出格式命名。遇到这种情况可在下载后自行改扩展名。

## 开发约定

- 不引入构建工具和第三方运行时依赖，所有文件可直接加载。
- 页面内 UI 全部使用 `#igrab-host` 前缀和 `all: initial`，避免污染宿主页面样式。
- 画廊渲染使用 `textContent` / DOM 属性写入数据，不拼接用户可控 HTML。
- 下载前校验 URL 协议和响应内容；错误统一显示在卡片状态、进度文案或提示条中。
- 修改 `content.js` / `gallery.js` / `background.js` 后，请在 `chrome://extensions` 点击扩展卡片上的刷新按钮，再刷新商品页。
