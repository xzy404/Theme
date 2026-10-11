/* CatchFish OJ · 主题商店（theme）
 *
 * 四条路由（用户 2026-10-11 的需求，路径就是用户给的，不再另起名字）：
 *   /theme/store/user      主题广场   —— 所有人能看；已通过的主题公开，自己未过审的只有自己看得见
 *   /theme/store/admin     主题管理   —— 需要**当前域的 PERM_MOD_BADGE**；处理审核 + 管所有用户的主题
 *   /theme/setting         主题设置   —— 新建主题；保存成功之后 302 到 /theme/setting/<tid>
 *   /theme/setting/<tid>   编辑编号 tid 的那个主题
 * 外加一个不对外宣传的背景图路由 /theme/bg/<tid>（给注入的 CSS 用，稳定 URL + 302 到签名链接）。
 *
 * 主题本身 = 名字 + 自定义背景图 + 三个液态玻璃开关（侧栏 / 顶栏 / 局部）。
 * 视觉生效走两条路：
 *   ① 服务层往每个 HTML 页注入 <style>（背景图）和 window.CfTheme（三个开关）；
 *   ② cf-sidebar-nav 的 glass.js 读 window.CfTheme 决定哪几类区域不上玻璃。
 *      没应用任何主题时**一字节都不注入**，线上表现与装这个插件之前完全一致。
 *
 * ─── 动手前从 hydrooj@5.0.4 / @hydrooj/framework / ui-default@4.58.4 源码里核过的事实 ───
 *
 * · `server.addServerLayer(name, fn)` 是官方的全局注入点（core 自己也用它挂 public/ 和域层）。
 *   它排在 router.routes() **之前**，而 base/user 两个 handler layer 是 router 内部的中间件 ——
 *   所以 `await next()` 之后 `c.HydroContext.user` 一定是好的（已核实 service/server.ts 的
 *   userLayer 赋值 `ctx.HydroContext.user = await user.private()`）。
 * · 域层（service/layers/domain.ts）会先把 `/d/<domainId>/` 从 `ctx.request.path` 里**剥掉**再路由。
 *   所以路由一律注册裸路径，主域和独立域都能用，不需要自己拼前缀。
 * · `this.args = { domainId, ...params, ...query, ...body }` —— **body 覆盖 path 参数**。
 *   所以 `/theme/setting/:tid` 的表单里**绝不能**有 name="tid" 的字段，否则地址里的 tid 会被冲掉。
 * · `@param` / `@query` 装饰器在 addon 里会**静默失效**（addon 由 esbuild 即时编译，走 TC39 装饰器语义，
 *   而 Hydro 内建源码依赖 experimentalDecorators）→ 一律改用 `this.args`。
 * · POST 的分发键是 body 里的 `operation` → `post<首字母大写>`（framework/server.ts:519）。
 * · mongodb driver 是 7.4.0 → `findOneAndUpdate` **直接返回文档**，不再包 `{ value }`；
 *   但这里仍然两种形态都兼容一下，避免以后降级踩坑。
 * · 角色：`guest: PERM_BASIC` 与 `default: PERM_DEFAULT` 都含 `PERM_VIEW`，
 *   所以裸路径落到 system 域时，游客/普通用户访问广场不会 403。
 * · 模板是 **nunjucks 不是 Jinja2**：空数组是 truthy（要用 `|length == 0`），
 *   没有 `|max`/`|min`，模板里不能 `Date.now()`，不能写嵌套对象字面量。
 *   所有派生值（文案/URL/flag）都在 TS 里算好再交给模板。
 */

import {
    ForbiddenError, Handler, NotFoundError, PERM, PRIV, PermissionError,
    Schema, StorageModel, UserModel, ValidationError,
} from 'hydrooj';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const COLL = 'theme';
const ACTIVE = 'theme_active';
const COUNTER = 'theme_counter';

const S_DRAFT = 'draft';        // 还没提交审核
const S_PENDING = 'pending';    // 审核中
const S_APPROVED = 'approved';  // 已通过，广场可见
const S_REJECTED = 'rejected';  // 已驳回

/** 给模板用的中文状态（nunjucks 里做不了映射表，统一在 TS 里算） */
const STATUS_TEXT = {
    [S_DRAFT]: '未提交',
    [S_PENDING]: '审核中',
    [S_APPROVED]: '已通过',
    [S_REJECTED]: '已驳回',
};
/** 广场/管理页顶部的筛选标签 */
const TABS = [
    { key: 'pending', text: '待审核' },
    { key: 'approved', text: '已通过' },
    { key: 'rejected', text: '已驳回' },
    { key: 'all', text: '全部' },
];

export const Config = Schema.object({
    requireReview: Schema.boolean().default(true)
        .description('新建/改过的主题必须经 MOD 审核才能出现在广场。关掉则新建即通过（仍可事后下架）。'),
    maxThemesPerUser: Schema.number().default(10).min(1)
        .description('每个用户最多能拥有多少个主题。'),
    maxUploadMB: Schema.number().default(4).min(1)
        .description('自定义背景图的单文件大小上限（MB）。'),
});

/* ------------------------------------------------------------------ *
 * 数据层
 * ------------------------------------------------------------------ */

let coll: any;
let activeColl: any;
let counterColl: any;

function initModel(c: any) {
    coll = c.db.collection(COLL);
    activeColl = c.db.collection(ACTIVE);
    counterColl = c.db.collection(COUNTER);
    /* ensureIndexes 只在 NODE_APP_INSTANCE === '0' 的进程里真正建索引（core 的行为），
       多 worker 下不会互相打架。
       ★ 它是 async 的：**必须把返回的 Promise 挂上 catch**。Node 18+ 默认
         `--unhandled-rejections=throw`，一个未处理的拒绝会直接让进程退出 ——
         这里失败顶多是"少个索引"，绝不该拿整站去赌。 */
    try {
        const p = c.db.ensureIndexes(
            coll,
            { name: 'tid', key: { tid: 1 }, unique: true },
            { name: 'owner', key: { owner: 1 } },
            { name: 'status_update', key: { status: 1, updateAt: -1 } },
        );
        if (p && typeof p.catch === 'function') {
            p.catch((e: any) => console.error('[theme] ensureIndexes failed:', e?.message || e));
        }
    } catch (e: any) {
        console.error('[theme] ensureIndexes failed:', e?.message || e);
    }
}

/** 自增 tid。mongodb driver ≥6 直接返回文档；这里两种形态都兜一下。 */
async function nextTid(): Promise<number> {
    const r: any = await counterColl.findOneAndUpdate(
        { _id: 'tid' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' },
    );
    const seq = r && (typeof r.seq === 'number' ? r.seq : (r.value && r.value.seq));
    return typeof seq === 'number' && seq > 0 ? seq : 1;
}

function pickFlags(src: any) {
    return {
        name: String(src.name ?? '').trim().slice(0, 60),
        background: String(src.background ?? '').trim().slice(0, 500),
        glassSide: !!src.glassSide,
        glassBar: !!src.glassBar,
        glassLocal: !!src.glassLocal,
    };
}

async function createTheme(owner: number, input: any) {
    const f = pickFlags(input);
    const tid = await nextTid();
    const now = new Date();
    const doc: any = {
        tid,
        owner,
        ...f,
        status: S_DRAFT,
        rejectReason: '',
        createAt: now,
        updateAt: now,
    };
    await coll.insertOne(doc);
    return doc;
}

function getTheme(tid: number) {
    return coll.findOne({ tid });
}

function getOwnThemes(uid: number) {
    return coll.find({ owner: uid }).sort({ updateAt: -1 }).toArray();
}

function countOwn(uid: number) {
    return coll.countDocuments({ owner: uid });
}

async function updateTheme(tid: number, patch: any) {
    await coll.updateOne({ tid }, { $set: { ...patch, updateAt: new Date() } });
}

async function deleteTheme(tid: number) {
    await coll.deleteOne({ tid });
    /* 顺带把"应用了它"的记录也清掉，不然那些人会一直挂着一个不存在的主题 */
    await activeColl.deleteMany({ tid });
}

/** 主题对某个人是否可见：已通过的公开，自己的随便看，MOD 都能看。 */
function visibleTo(doc: any, uid: number, isMod: boolean) {
    if (!doc) return false;
    if (doc.status === S_APPROVED) return true;
    if (isMod) return true;
    return !!uid && doc.owner === uid;
}

async function getActiveTid(uid: number): Promise<number | null> {
    if (!uid) return null;
    const r = await activeColl.findOne({ _id: uid });
    return r && typeof r.tid === 'number' ? r.tid : null;
}

async function setActive(uid: number, tid: number) {
    await activeColl.updateOne(
        { _id: uid }, { $set: { tid, updateAt: new Date() } }, { upsert: true },
    );
}

async function clearActive(uid: number) {
    await activeColl.deleteOne({ _id: uid });
}

/**
 * 删掉一个不再被引用的上传文件（`file:` 形态的背景图）。
 * 只要有别的主题（除了 exceptTid）还引用同一个 storage 路径就不删 —— 用户可能
 * 把同一张图传到了两个主题里，或者复制了主题。
 */
async function dropUnusedFile(owner: number, background: string, exceptTid = 0) {
    if (!background.startsWith('file:')) return;
    const target = background.slice(5);
    const stillUsed = await coll.countDocuments({ owner, background, tid: { $ne: exceptTid } });
    if (stillUsed) return;
    try {
        await StorageModel.del([target], owner);
    } catch (e) { /* 文件已经不在了也没关系 */ }
}

/* ---------- 背景图 ---------- *
 * doc.background 的取值：
 *   ''                    没设
 *   'url:https://…'       外链
 *   'file:theme/12/x.jpg' 上传到 Hydro storage 的文件（存的是**完整 storage 路径**，
 *                         这样不用靠 owner 去反推，主题转手也不会找错文件）      */

async function bgUrlFor(doc: any): Promise<string> {
    const bg = doc && doc.background;
    if (!bg) return '';
    if (bg.startsWith('url:')) return bg.slice(4);
    if (bg.startsWith('file:')) {
        const target = bg.slice(5);
        try {
            /* noExpire=true → 本地 storage 给 7 天有效期。**每次渲染现签**，
               不能缓存进 DB；稳定 URL 由 /theme/bg/<tid> 那一层负责。 */
            return await StorageModel.signDownloadLink(target, '', true);
        } catch (e) {
            return '';
        }
    }
    return '';
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 把对象变成可以直接写进 <script> 的 JS 对象字面量。 */
function jsonForScript(obj: unknown): string {
    return JSON.stringify(obj ?? null)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

/** 写进 CSS url("…") 的安全化。 */
function cssUrl(u: string): string {
    return `url("${String(u).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '')}")`;
}

function intArg(v: any, def = 0): number {
    const n = Number.parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) ? n : def;
}

function strArg(v: any, max = 200): string {
    return String(v ?? '').trim().slice(0, max);
}

/** 背景图查询串：改了主题就让 /theme/bg 的浏览器缓存失效 */
function bgVersion(doc: any): string {
    return String(doc?.updateAt instanceof Date ? doc.updateAt.getTime() : Date.now());
}

/**
 * 页面内部链接的域前缀。
 *
 * 独立域下用户看到的是 `/d/<域 id>/theme/...`；域层（service/layers/domain.ts）会把
 * `/d/<id>/` 从 request.path 上剥掉再路由，所以**注册**裸路径就够了 —— 但**生成**链接
 * 必须自己带上前缀，否则用户从独立域点一下链接就掉回主域（侧栏那套 linkTo() 同理）。
 * `args.domainId` 由 service/layers/base.ts 组装：`{ domainId, ...params, ...query, ...body }`。
 */
function baseUrlOf(h: any): string {
    const id = h?.args?.domainId;
    return id && id !== 'system' ? `/d/${id}` : '';
}

/**
 * 交给模板/CSS 的安全背景图 URL。
 *   · 上传的文件 → 走自己的稳定路由 /theme/bg/<tid>（不带任何用户内容）
 *   · 外链       → 必须 http(s)，且**不允许出现引号/括号/反斜杠/空白**，
 *                  否则就能从 style="background-image:url(…)" 里跳出去做 CSS/HTML 注入。
 *                  校验不过就返回 ''，页面退化成"没有背景图"，绝不原样输出。
 * ⚠ 用**裸路径**：域层（service/layers/domain.ts）路由前会把 /d/<domainId>/ 从
 *   request.path 上剥掉，所以 /theme/bg/x 在任何域下都能命中，不需要自己拼前缀。
 */
function safeBgUrl(bg: string, tid: number, version: string): string {
    if (!bg) return '';
    if (bg.startsWith('file:')) return `/theme/bg/${tid}?v=${version}`;
    if (bg.startsWith('url:')) {
        const u = bg.slice(4);
        if (!/^https?:\/\//i.test(u)) return '';
        if (/["'<>()\\\s]/.test(u)) return '';
        return u;
    }
    return '';
}

/* ------------------------------------------------------------------ *
 * 处理器
 * ------------------------------------------------------------------ */

class ThemeBase extends Handler {
    /** 主题是站点级的东西，不跟着域走；但权限判定仍然按**当前域**的角色来。 */
    get isMod(): boolean {
        return this.user.hasPerm(PERM.PERM_MOD_BADGE);
    }
}

/* ---- 主题广场 ---- */
class ThemeStoreHandler extends ThemeBase {
    async get() {
        const uid = this.user._id;
        const isMod = this.isMod;
        const page = Math.max(1, intArg(this.args.page, 1));

        /* 广场的可见性规则：
             · 已通过的 → 所有人可见
             · 其他人的任何未通过主题 → 不可见（这就是"只能自己访问"）
             · 自己的 → 无论什么状态都可见（带状态标记） */
        const filter = uid ? { $or: [{ status: S_APPROVED }, { owner: uid }] } : { status: S_APPROVED };

        const [ddocs, numPages, count] = await this.paginate(
            coll.find(filter).sort({ updateAt: -1 }), page, 'theme',
        );

        const uids = Array.from(new Set(ddocs.map((d: any) => d.owner))).filter((i) => !!i);
        const udict: any = uids.length ? await UserModel.getList(this.args.domainId, uids) : {};

        const activeTid = await getActiveTid(uid);
        const rows = [];
        for (const d of ddocs) {
            const udoc = udict[d.owner];
            rows.push({
                tid: d.tid,
                name: d.name || '未命名主题',
                owner: d.owner,
                ownerName: (udoc && (udoc.uname || `#${d.owner}`)) || `#${d.owner}`,
                status: d.status,
                statusText: STATUS_TEXT[d.status] || d.status,
                rejectReason: d.rejectReason || '',
                glassSide: !!d.glassSide,
                glassBar: !!d.glassBar,
                glassLocal: !!d.glassLocal,
                hasBg: !!d.background,
                bgPreview: safeBgUrl(String(d.background || ''), d.tid, bgVersion(d)),
                mine: d.owner === uid,
                active: activeTid === d.tid,
                /* 自己 + 驳回/未提交 → 可以再提交一次审核 */
                canSubmit: d.owner === uid && (d.status === S_DRAFT || d.status === S_REJECTED),
                canEdit: d.owner === uid,
                canDelete: d.owner === uid || isMod,
                canApply: d.status === S_APPROVED || d.owner === uid,
                updateAtText: d.updateAt ? new Date(d.updateAt).toLocaleString('zh-CN') : '',
            });
        }

        this.response.template = 'theme_store.html';
        this.response.body = {
            page_name: 'theme_store',
            baseUrl: baseUrlOf(this),
            rows,
            page,
            numPages,
            count,
            activeTid,
            isMod,
            loggedIn: !!uid,
            canCreate: !!uid && this.user.hasPriv(PRIV.PRIV_USER_PROFILE),
        };
    }

    /** 未登录点了"应用"能给出人话提示，而不是 302 到登录页 */
    prepare() {
        const need = ['apply', 'unapply', 'submit', 'delete'];
        const op = strArg(this.args.operation, 20);
        if (need.includes(op)) this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    async postApply() {
        const tid = intArg(this.args.tid, 0);
        const doc = await getTheme(tid);
        if (!doc || !visibleTo(doc, this.user._id, this.isMod)) throw new NotFoundError(`theme ${tid}`);
        if (!(doc.status === S_APPROVED || doc.owner === this.user._id)) {
            throw new ForbiddenError('这个主题还没有通过审核');
        }
        await setActive(this.user._id, tid);
        this.back();
    }

    async postUnapply() {
        await clearActive(this.user._id);
        this.back();
    }

    async postSubmit() {
        const tid = intArg(this.args.tid, 0);
        const doc = await getTheme(tid);
        if (!doc || doc.owner !== this.user._id) throw new NotFoundError(`theme ${tid}`);
        if (doc.status === S_APPROVED) throw new ForbiddenError('这个主题已经通过了');
        await updateTheme(tid, { status: S_PENDING, rejectReason: '' });
        this.back();
    }

    async postDelete() {
        const tid = intArg(this.args.tid, 0);
        const doc = await getTheme(tid);
        if (!doc) throw new NotFoundError(`theme ${tid}`);
        if (doc.owner !== this.user._id && !this.isMod) throw new PermissionError(PERM.PERM_MOD_BADGE);
        await deleteTheme(tid);
        await dropUnusedFile(doc.owner, String(doc.background || ''), tid);
        this.back();
    }
}

/* ---- 主题管理（MOD） ---- */
class ThemeAdminHandler extends ThemeBase {
    /* 自己判 PERM_MOD_BADGE，不要框架那层 PERM_VIEW —— 否则非 MOD 拿到的是
       "没有 PERM_VIEW" 这种驴唇不对马嘴的报错。 */
    noCheckPermView = true;

    prepare() {
        if (!this.isMod) throw new PermissionError(PERM.PERM_MOD_BADGE);
    }

    async get() {
        const page = Math.max(1, intArg(this.args.page, 1));
        const tab = TABS.some((t) => t.key === strArg(this.args.tab, 20))
            ? strArg(this.args.tab, 20) : 'pending';

        const filter = tab === 'all' ? {} : { status: tab };
        const [ddocs, numPages, count] = await this.paginate(
            coll.find(filter).sort({ updateAt: -1 }), page, 'theme',
        );

        const uids = Array.from(new Set(ddocs.map((d: any) => d.owner))).filter((i) => !!i);
        const udict: any = uids.length ? await UserModel.getList(this.args.domainId, uids) : {};

        const rows = ddocs.map((d: any) => {
            const udoc = udict[d.owner];
            return {
                tid: d.tid,
                name: d.name || '未命名主题',
                owner: d.owner,
                ownerName: (udoc && (udoc.uname || `#${d.owner}`)) || `#${d.owner}`,
                status: d.status,
                statusText: STATUS_TEXT[d.status] || d.status,
                rejectReason: d.rejectReason || '',
                background: d.background || '',
                glassSide: !!d.glassSide,
                glassBar: !!d.glassBar,
                glassLocal: !!d.glassLocal,
                hasBg: !!d.background,
                bgPreview: safeBgUrl(String(d.background || ''), d.tid, bgVersion(d)),
                canApprove: d.status !== S_APPROVED,
                canReject: d.status !== S_REJECTED,
                updateAtText: d.updateAt ? new Date(d.updateAt).toLocaleString('zh-CN') : '',
            };
        });

        /* 各状态的计数给标签页用 —— 分页只在当前 tab 内生效 */
        const counts: any = { all: 0 };
        for (const t of TABS) counts[t.key] = 0;
        counts.all = await coll.countDocuments({});
        for (const t of TABS) {
            if (t.key === 'all') continue;
            counts[t.key] = await coll.countDocuments({ status: t.key });
        }

        this.response.template = 'theme_store_admin.html';
        this.response.body = {
            page_name: 'theme_store_admin',
            baseUrl: baseUrlOf(this),
            rows,
            page,
            numPages,
            count,
            tab,
            tabs: TABS.map((t) => ({ key: t.key, text: t.text, count: counts[t.key] || 0, on: t.key === tab })),
            totalText: `${counts.all} 个主题 · 待审核 ${counts[S_PENDING] || 0} 个`,
            pageQs: `tab=${tab}`,
        };
    }

    async postApprove() {
        const tid = intArg(this.args.tid, 0);
        const doc = await getTheme(tid);
        if (!doc) throw new NotFoundError(`theme ${tid}`);
        await updateTheme(tid, { status: S_APPROVED, rejectReason: '' });
        this.back();
    }

    async postReject() {
        const tid = intArg(this.args.tid, 0);
        const doc = await getTheme(tid);
        if (!doc) throw new NotFoundError(`theme ${tid}`);
        await updateTheme(tid, { status: S_REJECTED, rejectReason: strArg(this.args.reason, 300) });
        this.back();
    }

    /** 下架：已经通过的主题撤回到"未提交"，但保留用户的应用记录（用户那边会自然失效） */
    async postUnpublish() {
        const tid = intArg(this.args.tid, 0);
        const doc = await getTheme(tid);
        if (!doc) throw new NotFoundError(`theme ${tid}`);
        await updateTheme(tid, { status: S_DRAFT });
        this.back();
    }

    async postDelete() {
        const tid = intArg(this.args.tid, 0);
        const doc = await getTheme(tid);
        if (!doc) throw new NotFoundError(`theme ${tid}`);
        await deleteTheme(tid);
        await dropUnusedFile(doc.owner, String(doc.background || ''), tid);
        this.back();
    }
}

/* ---- 主题设置（新建 / 编辑） ---- */
class ThemeSettingHandler extends ThemeBase {
    tdoc: any = null;

    async prepare() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        /* ⚠ 这里只能读 args.tid，而 args 里 body 会覆盖 path —— 所以表单里
           绝对不能出现 name="tid" 的字段（模板里已经刻意没有）。 */
        const tid = intArg(this.args.tid, 0);
        if (!tid) return;
        const doc = await getTheme(tid);
        if (!doc) throw new NotFoundError(`theme ${tid}`);
        if (doc.owner !== this.user._id && !this.isMod) throw new PermissionError(PERM.PERM_MOD_BADGE);
        this.tdoc = doc;
    }

    async get() {
        const doc = this.tdoc;
        const ownCount = await countOwn(this.user._id);
        const bgPreview = doc ? safeBgUrl(String(doc.background || ''), doc.tid, bgVersion(doc)) : '';

        this.response.template = 'theme_setting.html';
        this.response.body = {
            page_name: 'theme_setting',
            baseUrl: baseUrlOf(this),
            isNew: !doc,
            tid: doc ? doc.tid : 0,
            name: doc ? doc.name : '',
            background: doc && String(doc.background).startsWith('url:') ? String(doc.background).slice(4) : '',
            hasBg: !!(doc && doc.background),
            glassSide: doc ? !!doc.glassSide : true,
            glassBar: doc ? !!doc.glassBar : true,
            glassLocal: doc ? !!doc.glassLocal : true,
            status: doc ? doc.status : '',
            statusText: doc ? (STATUS_TEXT[doc.status] || doc.status) : '',
            rejectReason: doc ? (doc.rejectReason || '') : '',
            bgPreview,
            bgIsFile: !!(doc && String(doc.background).startsWith('file:')),
            ownCount,
            maxThemes: countLimit(this.ctx),
            canUpload: this.user.hasPriv(PRIV.PRIV_CREATE_FILE),
            maxUploadMB: (this.ctx as any).setting.get('theme.maxUploadMB') || 4,
            canSubmit: !!(doc && (doc.status === S_DRAFT || doc.status === S_REJECTED)),
            canDelete: !!doc,
            /* 被 MOD 驳回 / 已通过时给一句人话提示 */
            notice: !doc ? ''
                : doc.status === S_PENDING ? '正在审核中，审核通过之后会出现在主题广场。'
                    : doc.status === S_APPROVED ? '已通过审核。再改任何内容都会退回「未提交」，需要重新提交审核。'
                        : doc.status === S_REJECTED ? '这个主题被驳回了，改好之后可以重新提交审核。'
                            : '还没有提交审核 —— 只有你自己能看到它。',
        };
    }

    /**
     * 保存（表单里固定带 operation=save）。
     *
     * ★ 方法名**绝不能**叫 `post`。
     *   framework/server.ts 的 step 列表是 `['all', method, ..., post<Operation>]` ——
     *   `method` 对任何 POST 都是 'post'，所以 `post()` 会在**每一次** POST 上先跑一遍
     *   （内核里 DiscussionDetailHandler.post 就是这么当"公共闸门"用的）。
     *   叫 post 的话，「提交审核 / 删除」都会先执行一次保存逻辑。
     */
    async postSave() {
        const name = strArg(this.args.name, 60);
        if (!name) throw new ValidationError('name', null, '主题名称不能为空');

        /* 背景图：优先用本次上传的文件，其次用文本框里的 URL，都没有就沿用原值 */
        let background: string | null = null;
        const uploaded = await this.uploadBackground();
        if (uploaded) background = uploaded;
        else {
            const raw = strArg(this.args.background, 500);
            if (raw) {
                /* 填了但不像链接就明确报错 —— 静默忽略会让人以为"保存成功了"。 */
                if (!/^https?:\/\//i.test(raw)) throw new ValidationError('background', null, '图片链接必须以 http:// 或 https:// 开头');
                background = `url:${raw}`;
            }
        }
        /* "清空背景图" 勾上就强制置空 */
        if (strArg(this.args.clearBackground, 4) === '1') background = '';

        const patch: any = {
            name,
            glassSide: strArg(this.args.glassSide, 4) === '1',
            glassBar: strArg(this.args.glassBar, 4) === '1',
            glassLocal: strArg(this.args.glassLocal, 4) === '1',
        };
        if (background !== null) patch.background = background;

        if (!this.tdoc) {
            /* 新建 */
            if (await countOwn(this.user._id) >= countLimit(this.ctx)) {
                throw new ForbiddenError(`最多只能有 ${countLimit(this.ctx)} 个主题`);
            }
            const doc = await createTheme(this.user._id, {
                ...patch,
                background: patch.background || '',
                name,
            });
            if (!requireReview(this.ctx)) {
                await updateTheme(doc.tid, { status: S_APPROVED });
            }
            this.response.redirect = this.url('theme_setting_tid', { tid: doc.tid });
            return;
        }

        /* 编辑：**内容变了就回到未提交**，避免"过了审再偷偷改内容"。
           改回草稿之后用户得重新提交审核。 */
        const before = `${this.tdoc.name}|${this.tdoc.background}|${!!this.tdoc.glassSide}|${!!this.tdoc.glassBar}|${!!this.tdoc.glassLocal}`;
        const next = { ...this.tdoc, ...patch };
        const after = `${next.name}|${next.background}|${!!next.glassSide}|${!!next.glassBar}|${!!next.glassLocal}`;
        if (before !== after && this.tdoc.status === S_APPROVED) {
            patch.status = S_DRAFT;
        }
        await updateTheme(this.tdoc.tid, patch);
        /* 换了背景图 → 把上一张上传的文件清掉（还被别的主题引用就留着） */
        const oldBg = String(this.tdoc.background || '');
        if (patch.background !== undefined && patch.background !== oldBg) {
            await dropUnusedFile(this.tdoc.owner, oldBg, this.tdoc.tid);
        }
        this.response.redirect = this.url('theme_setting_tid', { tid: this.tdoc.tid });
    }

    async postSubmit() {
        if (!this.tdoc) throw new NotFoundError('theme');
        if (this.tdoc.status === S_APPROVED) throw new ForbiddenError('这个主题已经通过了');
        await updateTheme(this.tdoc.tid, { status: S_PENDING, rejectReason: '' });
        this.response.redirect = this.url('theme_setting_tid', { tid: this.tdoc.tid });
    }

    async postDelete() {
        if (!this.tdoc) throw new NotFoundError('theme');
        const tid = this.tdoc.tid;
        const owner = this.tdoc.owner;
        const bg = String(this.tdoc.background || '');
        await deleteTheme(tid);
        await dropUnusedFile(owner, bg, tid);
        this.response.redirect = this.url('theme_store');
    }

    /* ---- 上传 ---- */

    private async uploadBackground(): Promise<string | null> {
        const files: any = (this.request as any).files;
        const file = files && (files.bgfile || files.file);
        if (!file || !file.filepath) return null;
        this.checkPriv(PRIV.PRIV_CREATE_FILE);

        const mime = String(file.mimetype || file.type || '');
        const name = String(file.originalFilename || file.name || '');
        const ext = guessImageExt(mime, name);
        if (!ext) throw new ValidationError('bgfile', null, '只支持 png / jpg / webp / gif / avif 这几种图片');

        const maxMB = (this.ctx as any).setting.get('theme.maxUploadMB') || 4;
        if (Number(file.size) > maxMB * 1024 * 1024) {
            throw new ValidationError('bgfile', null, `图片不能超过 ${maxMB} MB`);
        }

        const base = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const target = `theme/${this.user._id}/${base}`;
        await StorageModel.put(target, file.filepath, this.user._id);
        return `file:${target}`;
    }
}

/* ---- 背景图：稳定 URL → 302 到现签的下载链接 ---- */
class ThemeBgHandler extends ThemeBase {
    noCheckPermView = true;

    async get() {
        const tid = intArg(this.args.tid, 0);
        const doc = await getTheme(tid);
        if (!doc || !String(doc.background || '').startsWith('file:')) throw new NotFoundError('background');
        /* 私有的（未过审且不是自己的）不给看背景图 */
        if (!visibleTo(doc, this.user._id, this.isMod)) throw new NotFoundError('background');
        const url = await bgUrlFor(doc);
        if (!url) throw new NotFoundError('background');
        /* 稳定 URL 一定要能被浏览器缓存，否则签名链接每次都变 → 每页都重新下载背景图 */
        this.response.addHeader('Cache-Control', 'public, max-age=3600');
        this.response.redirect = url;
    }
}

function guessImageExt(mime: string, filename: string): string {
    const map: Record<string, string> = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'image/avif': 'avif',
        /* ⚠ 故意**不收 svg**：storage 是按内容类型原样吐回来的（同源），
           一个带 <script> 的 .svg 打开就是同源存储型 XSS。 */
    };
    if (map[mime]) return map[mime];
    const m = /\.([A-Za-z0-9]{2,5})$/.exec(filename || '');
    const ext = m ? m[1].toLowerCase() : '';
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
    return '';
}

function requireReview(ctx: any): boolean {
    return ctx.setting.get('theme.requireReview') !== false;
}
function countLimit(ctx: any): number {
    const n = Number(ctx.setting.get('theme.maxThemesPerUser'));
    return Number.isFinite(n) && n > 0 ? n : 10;
}

/* ------------------------------------------------------------------ *
 * 视觉生效：往每个 HTML 页面注入背景图 + window.CfTheme
 * ------------------------------------------------------------------ */

function buildInjection(doc: any, bgUrl: string): string {
    let out = '';
    if (bgUrl) {
        const u = cssUrl(bgUrl);
        /* 三层一起写，尽量不依赖其它插件：
             ① body::before → 本站壁纸以前挂在这一层（Hydro-Acrylic 的
                position:fixed / z-index:-1），直接覆盖它最稳，而且 glass.js 的壁纸探测
                读的第一个候选就是 body::before 的计算值；
             ② --acrylic-wallpaper → 让读这个变量的消费者保持一致（Acrylic 就是这么挂壁纸的）；
             ③ body 自身背景 → 真正可见的那一层，也是没有 Acrylic 时的唯一一层。

           ⚠⚠ ① 里**必须**写 background-attachment: fixed。
              glass.js 的 wallpaper() 判断"这层背景是不是钉在视口上"的规则是
              `background-attachment 含 fixed  **或** 伪元素自身 position 是 fixed`；
              两条都不满足它就会设 DOCMODE=true（按文档坐标取样）。
              而我们的伪元素没有 position（没 content 根本不会渲染），
              于是取样坐标会跟着滚动位移 → 玻璃里的壁纸和页面背景**错位**。
              写了 fixed 之后探测结果 { fixed: true }，走视口坐标，和 body 上
              `background-attachment: fixed` 的实际观感一致。 */
        out += `<style id="cf-theme-bg">`
            + `body::before{background-image:${u} !important;`
            + `background-size:cover !important;background-position:center center !important;`
            + `background-attachment:fixed !important;}`
            + `:root{--acrylic-wallpaper:${u} !important;}`
            + `body{background-image:${u} !important;background-size:cover !important;`
            + `background-position:center center !important;background-repeat:no-repeat !important;`
            + `background-attachment:fixed !important;}`
            + `</style>`;
    }
    const flags = {
        tid: doc.tid,
        name: doc.name || '',
        glassSide: !!doc.glassSide,
        glassBar: !!doc.glassBar,
        glassLocal: !!doc.glassLocal,
        bg: bgUrl,
    };
    /* 必须排在 glass.js 之前 —— 它是服务端注入的 <script>，DOMContentLoaded 就跑，
       所以这个内联脚本放在 </body> 之前是够的（DOMContentLoaded 之前会执行）。 */
    out += `<script id="cf-theme-data">window.CfTheme=${jsonForScript(flags)};</script>`;
    return out;
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

export function apply(ctx: any, config: any) {
    /* Config 里的每一项会以 `theme.<key>` 存进系统设置，运行时一律用
       ctx.setting.get('theme.<key>') 读（见 requireReview / countLimit），
       所以这里不需要把 config 再传下去。 */
    ctx.inject(['db'], (c: any) => {
        initModel(c);
    });

    /* 服务层：每个 HTML 响应都过一遍。
       ⚠ 只有"当前用户真的应用了主题"才注入；没有就一个字节都不加，
         保证不装主题时线上表现和装这个插件之前完全一致。 */
    ctx.inject(['server'], ({ server }: any) => {
        server.addServerLayer('cf-theme', async (c: any, next: any) => {
            /* next() 的异常照常往外抛（那是路由自己的错误，不该被这里吞掉）；
               只把**注入逻辑**包起来 —— 注入失败顶多"这次页面没主题"，
               绝不能让整站 500。 */
            await next();
            try {
                if (!coll) return;
                if (typeof c.body !== 'string') return;
                const type = `${c.response?.type || ''}`;
                if (type && !type.includes('html')) return;

                const uid = c.HydroContext?.user?._id || 0;
                const tid = await getActiveTid(uid);
                if (!tid) return;

                const doc = await getTheme(tid);
                /* 主题被删了 / 被下架了 / 过了审又被改回草稿 → 静默失效，不报错 */
                if (!doc) return;
                if (!(doc.status === S_APPROVED || doc.owner === uid)) return;

                const bgUrl = safeBgUrl(String(doc.background || ''), doc.tid, bgVersion(doc));

                const tag = buildInjection(doc, bgUrl);
                /* 注入到 </head> 之前，两个好处：
                     ① 样式早于首屏绘制，不会先闪一下默认背景；
                     ② 不依赖插件加载顺序 —— 另一个插件（cf-sidebar-nav）是往 </head> 后面的
                        </body> 前塞 <script src="/glass.js"> 的，两个 addon 在 addon.json 里的
                        先后会决定谁先插；插到 head 就不可能落在 glass.js 后面。
                     （就算落后了其实也没事：glass.js 是 DOMContentLoaded + 120ms 才 boot，
                       内联脚本一定在那之前执行完；head 只是更保险。） */
                const i = c.body.lastIndexOf('</head>');
                c.body = i >= 0 ? c.body.slice(0, i) + tag + c.body.slice(i) : c.body + tag;
            } catch (e: any) {
                console.error('[theme] inject failed:', e?.message || e);
            }
        });
    });

    ctx.Route('theme_store', '/theme/store/user', ThemeStoreHandler);
    ctx.Route('theme_store_admin', '/theme/store/admin', ThemeAdminHandler);
    ctx.Route('theme_setting', '/theme/setting', ThemeSettingHandler);
    ctx.Route('theme_setting_tid', '/theme/setting/:tid', ThemeSettingHandler);
    ctx.Route('theme_bg', '/theme/bg/:tid', ThemeBgHandler);
}
