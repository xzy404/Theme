# theme —— CatchFish OJ 主题商店

给 [CatchFish OJ](https://oj.xzy404.top)（Hydro v5.0.4 / `@hydrooj/ui-default` 4.58.4）写的 addon：
让用户**自定义主题**（名称 + 背景图 + 三个液态玻璃开关），带一套**提交 → 审核 → 上架**的流程。

配合 [`cf-sidebar-nav`](../cf-sidebar-nav) 使用 —— 三个玻璃开关真正生效靠的就是它里面的 `glass.js`。

---

## 四个页面

| 路由 | 谁能看 | 干什么 |
|---|---|---|
| `/theme/store/user` | 所有人 | **主题广场**。只展示 `approved` 的主题；自己的主题（含未提交/审核中/被驳回）也能看到。可以**应用**、**取消应用**、**提交审核**、**删除**、**跳去设置**。 |
| `/theme/store/admin` | **域内 MOD**（`PERM.PERM_MOD_BADGE`） | **主题管理**。四个 tab（待审核 / 已通过 / 已驳回 / 全部），可以**通过 / 驳回（带理由）/ 下架 / 删除**，能看到所有用户的主题。 |
| `/theme/setting` | 登录用户 | **新建主题**。保存成功后 302 到 `/theme/setting/<tid>`。 |
| `/theme/setting/:tid` | 主题所有者 或 MOD | **改一个主题**。名称、背景图（传文件或填外链）、三个玻璃开关；右栏是预览 + 提交审核 / 删除。 |

> 独立域下这些路由同样可用（`/d/<域 id>/theme/...`）—— 路由注册的是**裸路径**，
> 域层（`service/layers/domain.ts`）会先把 `/d/<id>/` 剥掉再路由。页面里的链接由
> `baseUrlOf(h)` 统一加前缀，所以从独立域点一下不会掉回主域。

---

## 主题状态机

```
            ┌──────────── 保存 ────────────┐
            ▼                              │
  创建 ─▶ draft ──提交审核──▶ pending ──┬─通过─▶ approved ──下架─▶ draft
   （未提交）  ▲                          │        （广场可见）
              │                          └─驳回─▶ rejected ──改了再提交──┐
              └──────── 编辑即回到 draft（除非当前 approved，见下） ◀──────┘
```

- `draft`（未提交）：只有自己可见。
- `pending`（审核中）：自己 + MOD 可见，广场不展示。
- `approved`（已通过）：**广场所有人可见**。
- `rejected`（已驳回）：自己可见，设置页会显示驳回理由。

**审核通过后的主题再次编辑**（`requireReview` 打开时）会重新回到 `pending`；只有
`draft` 状态提交才转 `pending`，避免反复提交刷状态。

---

## 三个玻璃开关的生效链路

```
theme/index.ts  ──注入──▶  <script>window.CfTheme = { glassSide, glassBar, glassLocal, ... }</script>
                                        │
cf-sidebar-nav/public/glass.js  ◀───────┘   collect() 里按 kindOn(kind) 过滤
                                            └─▶ 被关掉的类不产出目标 → sweep() 自动摘掉画布与类
                                                → 该区域退回自身 CSS 底色
```

映射关系（`glass.js` 的 `KIND_FLAG`）：

| 开关 | 作用范围 | `glass.js` 的 kind |
|---|---|---|
| `glassSide` | 侧栏液态玻璃 | `side` → `.cf-side` |
| `glassBar` | 顶栏液态玻璃 | `bar` → `.cf-bar` |
| `glassLocal` | 局部液态玻璃 | `card` → `.slideout-panel .section`、`btn` → `.slideout-panel .btn` / `button.btn` / `.button` |

**没开主题的用户不受影响** —— `window.CfTheme` 不存在时 `kindOn()` 一律返回 `true`（全开），
和以前的行为逐字节一致。

浏览器里可以就地调试：

```js
__cfGlassTheme                  // 当前生效的主题数据（或 undefined）
__cfGlassTheme.kinds()          // { side:true, bar:true, card:true, btn:true }
__cfGlassTheme({ glassLocal: false })   // 临时关掉局部玻璃，立刻重收集（刷新即还原）
```

---

## 背景图：三条路一起写，缺一不可

`buildInjection()` 往 `</head>` 前插一段 `<style>`，同时改三处：

```css
body::before { background-image: url(...) ; background-attachment: fixed; }  /* ← Acrylic 的壁纸层 */
:root        { --acrylic-wallpaper: url(...); }                              /* ← 让读变量的消费者跟上 */
body         { background-image: url(...) ; background-attachment: fixed; }  /* ← 裸 body 兜底 */
```

**★ `background-attachment: fixed` 不能省。** `glass.js` 的 `wallpaper()` 是这么判的：

```js
fixed = /fixed/.test(backgroundAttachment) || /fixed/.test(position);
```

两条都不满足就置 `DOCMODE = true`（按文档坐标取样）→ 玻璃里的壁纸会和页面背景**错位**。
`fixed` 也是这个站点上 `body::before` 的**原生**写法，照抄它才能和 Acrylic 插件的观感一致。

**★ 注入点放在 `</head>` 前**，不要放 `</body>` 前：另一个 addon 也往 `</body>` 前插 `glass.js`，
谁先谁后取决于 `addon.json` 的排列；放 head 里样式一定早于首屏，也不依赖 addon 顺序。

背景图源：`url:<外链>` 或 `file:<storage path>`。`file:` 走 `/theme/bg/:tid`（带
`Cache-Control: public, max-age=3600`）转为 302 跳到 `StorageModel.signDownloadLink()`。

⚠ 外链背景图会被 `glass.js` 以 `crossOrigin = 'anonymous'` 加载 —— 源站不给 CORS 头时**图片会加载失败，
整个 glass.js 停摆**（连侧栏 CSS 兜底也一起停）。自建主题建议用上传的图片，或确认外链有 CORS 头。

---

## 文件结构

```
theme/
├── index.ts                              服务端：数据层 + 4 个 handler + 5 条路由 + 页面注入
├── package.json
└── templates/
    ├── theme_store.html                  广场
    ├── theme_store_admin.html            管理
    ├── theme_setting.html                设置（新建 / 编辑共用）
    └── partials/theme_style.html         三页共用 CSS（被上面三个 {% include %}）
```

数据落在三个 collection：

| collection | 用途 |
|---|---|
| `theme` | 主题本体（`tid` 唯一索引 / `owner` / `status+updateAt`） |
| `theme_active` | 每个用户当前应用的主题（`uid` → `tid`） |
| `theme_counter` | `tid` 自增发号器 |

`Config`（可在插件设置里改）：

| key | 默认 | 说明 |
|---|---|---|
| `requireReview` | `true` | 关掉则新建即 `approved`（仍可事后下架） |
| `maxThemesPerUser` | `10` | 每人主题数上限 |
| `maxUploadMB` | `4` | 背景图单文件大小上限 |

---

## 写这个插件踩过的坑（改之前先看）

1. **`/theme/setting/:tid` 的表单里绝不能有 `name="tid"`。**
   `base` 层是 `args = { domainId, ...params, ...query, ...body }` —— **body 覆盖 path 参数**，
   表单里一填 `tid`，地址栏里的编号就被冲掉了，保存会写到错误的主题上。

2. **`ThemeSettingHandler` 的保存方法叫 `postSave()`，不能叫 `post()`。**
   `framework/server.ts` 的 `register()` 里 step 列表是 `['all', method, ..., post<Operation>]`，
   而 `method` 对任何 POST 都是 `'post'` —— 类里定义 `post()` 会在**每一次 POST 上都先跑一遍**。

3. **`@param` / `@query` 装饰器在 addon 里静默失效**（addon 走 esbuild 的 TC39 装饰器语义，
   Hydro 内建源码依赖 `experimentalDecorators`）→ 一律用 `this.args`。

4. **模板是 nunjucks 不是 Jinja2**：空数组是 truthy（判空要用 `|length == 0`），
   没有 `|max` / `|min`，不能在模板里 `Date.now()`，不能写嵌套对象字面量。
   所有派生值（中文状态、URL、flag）都在 TS 里算好再交给模板。

5. **`HandlerCommon` 的 `this.args` 是实例属性**（构造函数里从 `context.HydroContext` 拷过来的），
   在 handler 里 `this.ctx.extend({ domain })` 不影响 `this.args`。

6. **权限要自己判 `PERM.PERM_MOD_BADGE`（域内），不要 `PRIV.PRIV_MOD_BADGE`（全站）。**
   管理页设了 `noCheckPermView = true` 再在 `prepare()` 里抛 `PermissionError`，
   否则框架那层 `PERM_VIEW` 会让非 MOD 拿到 403 还是 302 变得不可控。

7. **`guessImageExt` 故意不收 `svg`** —— storage 是按内容类型原样吐的，收 svg 等于开了
   同源存储型 XSS。

8. **背景图填了不像链接的内容要明确报错**，别静默忽略（用户会以为保存成功了）。

---

## 部署

```sh
# 上传 + 登记 addon.json + 重启 + 三份 md5 对拍，一步到位
HG_SSH_PASS=xxx sh tools/theme-deploy.sh
```

★★ **改任何东西都要「上传 + 重启」，缺一不可。** Hydro **只在启动时**把 addon 的 `public/`
拷进 `/root/.hydro/static/`，而 Caddy 是直接从那个目录吐静态文件的 —— 只上传不重启，
线上一点变化都没有。重启只有一种写法：`sudo bash -lc 'pm2 restart hydrooj'`。

改 `cf-sidebar-nav/public/` 下的文件时，**必须同时把 `cf-sidebar-nav/index.ts` 的 `VERSION`
换成一个没用过的值**（查询串是 CF 缓存键的一部分，`max-age=14400`）。
