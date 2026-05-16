let allColumns = [];
let numericColumns = [];
/** 参考表列名（上传参考表后由服务端返回） */
let lookupAllColumns = [];
let lookupNumericColumns = [];
let currentTheme = "light";
let currentFileLoaded = false;
/** 列顺序与是否显示（与后端 GLOBAL_DATA['mapped_columns'] 对齐） */
let mappedColumns = [];
let mappingColumnSortable = null;
/** 列映射弹窗：用户点击「确认分析」关闭时为 true，用于区分「取消关闭」与「确认关闭」 */
let mappingModalConfirmed = false;
let currentType = null;
let activeCharts = {};

/** 全局展示币种（智能表格金额折算与符号） */
let displayCurrency = localStorage.getItem("dashboard_display_currency") || "CNY";

/** 星期按钮文案与 pandas dt.weekday 一致：0=周一 … 6=周日 */
const DATE_FILTER_WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

let dateFilterRefreshTimer = null;

/** 图表点击联动：当前分类维度列与取值（与星期/日期区间 AND） */
let globalDrillCategory = null;

let smartTableTemplateTargetCard = null;

/** 模拟：银行网关返回的销售/回款明细（列结构与销售模板一致） */
const PRESET_BANK_FLOW_ROWS = [
    {"日期":"2026-05-01","地区":"华东","产品类型":"批发","科目":"6001 主营业务收入","销售额":125800,"利润":12580,"销量":420,"备注":"银行网关同步"},
    {"日期":"2026-05-02","地区":"华北","产品类型":"零售","科目":"6001 主营业务收入","销售额":45200.5,"利润":3616,"销量":210,"备注":"银行网关同步"},
    {"日期":"2026-05-03","地区":"华南","产品类型":"电子产品","科目":"6401 主营业务成本","销售额":98800,"利润":14820,"销量":330,"备注":"银行网关同步"}
];

/** 模拟：支付宝 / 微信聚合账单 */
const PRESET_MOBILE_WALLET_ROWS = [
    {"日期":"2026-05-01","地区":"华东","产品类型":"到家业务","科目":"6001 主营业务收入","销售额":8900.25,"利润":712,"销量":95,"备注":"支付宝"},
    {"日期":"2026-05-02","地区":"西南","产品类型":"扫码付","科目":"6401 主营业务成本","销售额":15600,"利润":1248,"销量":188,"备注":"微信"},
    {"日期":"2026-05-03","地区":"华东","产品类型":"小程序","科目":"6001 主营业务收入","销售额":6788,"利润":611,"销量":72,"备注":"支付宝小程序"}
];

/** 底部原始数据表完整 HTML，用于科目穿透筛选后还原 */
let rawDataTableOriginalHtml = "";

/** 画布卡片拖拽/缩放：全局单例，避免每张卡片重复绑定 document 监听 */
const cardInteraction = {
    card: null,
    mode: null,
    startX: 0,
    startY: 0,
    startLeft: 0,
    startTop: 0,
    startW: 0,
    startH: 0,
    rafResize: 0
};

function parsePx(val) {
    const n = parseFloat(String(val).replace("px", ""));
    return Number.isFinite(n) ? n : 0;
}

function bindCanvasInteractionGlobals() {
    document.addEventListener("mousemove", e => {
        const st = cardInteraction;
        if (!st.card || !st.mode) return;
        if (st.mode === "drag") {
            st.card.style.left = st.startLeft + (e.clientX - st.startX) + "px";
            st.card.style.top = st.startTop + (e.clientY - st.startY) + "px";
            return;
        }
        if (st.mode === "resize") {
            /* 右下角缩放：锚定左上角，Top/Left 不随拖拽偏移 */
            st.card.style.left = st.startLeft + "px";
            st.card.style.top = st.startTop + "px";
            st.card.style.width = Math.max(100, st.startW + (e.clientX - st.startX)) + "px";
            st.card.style.height = Math.max(100, st.startH + (e.clientY - st.startY)) + "px";
            if (st.rafResize) cancelAnimationFrame(st.rafResize);
            st.rafResize = requestAnimationFrame(() => {
                st.rafResize = 0;
                refreshPlotlyInCard(st.card);
            });
        }
    });
    document.addEventListener("mouseup", () => {
        const st = cardInteraction;
        if (st.card && (st.mode === "drag" || st.mode === "resize")) refreshPlotlyInCard(st.card);
        if (st.rafResize) cancelAnimationFrame(st.rafResize);
        st.rafResize = 0;
        st.card = null;
        st.mode = null;
        document.body.style.userSelect = "";
    });
}

// ================= 看板 Dock：拖拽 / 缩放 / 删除 / 归一化持久化 =================
const DOCK_LAYOUT_STORAGE_KEY = "dashboard_dock_layout_v2";
const DOCK_MIN = { W: 120, H: 80 };
const DOCK_IDS = ["dock-kpi", "dock-charts", "dock-rank"];
/** 无数据且未勾选「显示指标卡」时隐藏 KPI 条（localStorage === '1' 表示始终显示） */
const DASHBOARD_SHOW_KPI_EMPTY_KEY = "dashboard_show_kpi_when_empty";
const REPORT_VISIBILITY_STORAGE_KEY = "report_visibility_v1";
/** 看板根区域随块下移扩展时的底部留白 */
const DOCK_ROOT_DRAG_PAD_PX = 200;
const DOCK_ROOT_MIN_VH_FRAC = 0.8;
/** 类 GridStack：横向 12 列 + 纵向行高，用于磁吸与 compact */
const DOCK_GRID_COLS = 12;
const DOCK_ROW_H = 12;
const DOCK_GRID_GAP = 10;
/** 仅当与网格目标相差 ≤ 此值（px）时才磁吸 l/t，减轻拖拽抖动 */
const DOCK_SNAP_POSITION_THRESHOLD_PX = 20;
/** 与样式表 `.dashboard-dock-widget { z-index: 1 }` 对齐；点击面板时递增并赋给当前项 */
let maxZIndex = 1;

function getDashboardDockRoot() {
    return document.getElementById("dashboardDockRoot");
}

function resetDockWidgetStacking() {
    const root = getDashboardDockRoot();
    if (!root) return;
    maxZIndex = 1;
    root.querySelectorAll(".dashboard-dock-widget[data-dock-id]").forEach((el) => {
        el.style.zIndex = "";
        el.classList.remove("dashboard-dock-widget--front");
    });
}

function bringDockWidgetToFront(widget) {
    const root = getDashboardDockRoot();
    if (!root || !widget || !root.contains(widget)) return;
    maxZIndex++;
    widget.style.zIndex = String(maxZIndex);
    root.querySelectorAll(".dashboard-dock-widget--front").forEach((el) => {
        if (el !== widget) el.classList.remove("dashboard-dock-widget--front");
    });
    widget.classList.add("dashboard-dock-widget--front");
}

/** 列映射等场景下将 KPI dock 提到最前并短暂高亮（依赖 bringDockWidgetToFront） */
function bringKpiDockToFrontWithMetricsFlash() {
    const kpi =
        document.querySelector('[data-dock-id="dock-kpi"]') ||
        document.getElementById("biStatTotalSales")?.closest(".dashboard-dock-widget[data-dock-id]");
    if (!kpi || kpi.style.display === "none") return;
    bringDockWidgetToFront(kpi);
    try {
        kpi.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    } catch (e) {
        kpi.scrollIntoView(false);
    }
    kpi.classList.remove("dashboard-dock-widget--metrics-flash");
    void kpi.offsetWidth;
    kpi.classList.add("dashboard-dock-widget--metrics-flash");
    const cleanup = () => kpi.classList.remove("dashboard-dock-widget--metrics-flash");
    kpi.addEventListener("animationend", cleanup, { once: true });
    window.setTimeout(cleanup, 1100);
}

function getShowKpiWhenEmpty() {
    try {
        return localStorage.getItem(DASHBOARD_SHOW_KPI_EMPTY_KEY) === "1";
    } catch (e) {
        return false;
    }
}

function isKpiDockSuppressed() {
    return !currentFileLoaded && !getShowKpiWhenEmpty();
}

function getReportModuleVisibility() {
    const d = { kpi: true, charts: true, rank: true, summary: true };
    try {
        const raw = localStorage.getItem(REPORT_VISIBILITY_STORAGE_KEY);
        if (!raw) return d;
        const o = JSON.parse(raw);
        if (typeof o.kpi === "boolean") d.kpi = o.kpi;
        if (typeof o.charts === "boolean") d.charts = o.charts;
        if (typeof o.rank === "boolean") d.rank = o.rank;
        if (typeof o.summary === "boolean") d.summary = o.summary;
    } catch (e) {
        /* ignore */
    }
    return d;
}

function persistReportModuleVisibility(v) {
    try {
        localStorage.setItem(REPORT_VISIBILITY_STORAGE_KEY, JSON.stringify(v));
    } catch (e) {
        /* ignore */
    }
}

function syncReportModuleCheckboxesToState() {
    const v = getReportModuleVisibility();
    const pairs = [
        ["chkReportModuleKpi", "kpi"],
        ["chkReportModuleCharts", "charts"],
        ["chkReportModuleRank", "rank"],
        ["chkReportModuleSummary", "summary"]
    ];
    pairs.forEach(([id, key]) => {
        const el = document.getElementById(id);
        if (el) el.checked = v[key];
    });
}

function readReportModuleVisibilityFromCheckboxes() {
    return {
        kpi: !!document.getElementById("chkReportModuleKpi")?.checked,
        charts: !!document.getElementById("chkReportModuleCharts")?.checked,
        rank: !!document.getElementById("chkReportModuleRank")?.checked,
        summary: !!document.getElementById("chkReportModuleSummary")?.checked
    };
}

function applyDockKpiDisplayMode() {
    const kpi = document.querySelector('[data-dock-id="dock-kpi"]');
    if (!kpi) return;
    const v = getReportModuleVisibility();
    const allowKpi = v.kpi && !isKpiDockSuppressed();
    kpi.style.display = allowKpi ? "" : "none";
}

function expandVisibleDockWidgetsHorizontally(root) {
    const rootEl = root || getDashboardDockRoot();
    if (!rootEl) return;
    const rr = rootEl.getBoundingClientRect();
    const rootW = rr.width;
    if (rootW < 64) return;
    const gap = DOCK_GRID_GAP;
    const charts = rootEl.querySelector('[data-dock-id="dock-charts"]');
    const rank = rootEl.querySelector('[data-dock-id="dock-rank"]');
    if (!charts && !rank) return;
    const chartsVis = charts && charts.style.display !== "none";
    const rankVis = rank && rank.style.display !== "none";
    if (chartsVis && !rankVis && charts) {
        const t = charts.offsetTop;
        charts.style.left = "0px";
        charts.style.width = `${Math.max(DOCK_MIN.W, Math.round(rootW))}px`;
        charts.style.top = `${Math.round(t)}px`;
        return;
    }
    if (!chartsVis && rankVis && rank) {
        const t = rank.offsetTop;
        rank.style.left = "0px";
        rank.style.width = `${Math.max(DOCK_MIN.W, Math.round(rootW))}px`;
        rank.style.top = `${Math.round(t)}px`;
        return;
    }
    if (chartsVis && rankVis && charts && rank) {
        const innerW = Math.max(0, rootW - gap);
        const chartW = (innerW * 7) / 12;
        const rankW = innerW - chartW;
        const top = Math.min(charts.offsetTop, rank.offsetTop);
        charts.style.left = "0px";
        charts.style.top = `${Math.round(top)}px`;
        charts.style.width = `${Math.round(Math.max(DOCK_MIN.W, chartW))}px`;
        rank.style.left = `${Math.round(chartW + gap)}px`;
        rank.style.top = `${Math.round(top)}px`;
        rank.style.width = `${Math.round(Math.max(DOCK_MIN.W, rankW))}px`;
    }
}

function syncRawDataPanelWithReportModules() {
    const panel = document.getElementById("rawDataPanel");
    if (!panel) return;
    if (!currentFileLoaded) {
        panel.style.display = "none";
        return;
    }
    panel.style.display = getReportModuleVisibility().summary ? "block" : "none";
}

function applyReportModuleVisibility() {
    const v = getReportModuleVisibility();
    const charts = document.querySelector('[data-dock-id="dock-charts"]');
    const rank = document.querySelector('[data-dock-id="dock-rank"]');
    if (charts) charts.style.display = v.charts ? "" : "none";
    if (rank) rank.style.display = v.rank ? "" : "none";
    syncRawDataPanelWithReportModules();
    applyDockKpiDisplayMode();
    const root = getDashboardDockRoot();
    finalizeDockCompactAndSave();
    expandVisibleDockWidgetsHorizontally(root);
    syncDashboardDockRootContentHeight();
    saveLayout();
    dispatchWindowResize();
}

function initReportModuleToolbar() {
    syncReportModuleCheckboxesToState();
    ["chkReportModuleKpi", "chkReportModuleCharts", "chkReportModuleRank", "chkReportModuleSummary"].forEach(
        (id) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener("change", () => {
                persistReportModuleVisibility(readReportModuleVisibilityFromCheckboxes());
                applyReportModuleVisibility();
            });
        }
    );
}

const DEFAULT_REPORT_TITLES = {
    charts: "主趋势与图表",
    rank: "各省份 / 区域销售额排名",
    rankDimTh: "省份 / 区域",
    rankSalesTh: "销售额"
};

function restoreDefaultReportTitles() {
    const c = document.getElementById("biDockChartsTitle");
    if (c) c.textContent = DEFAULT_REPORT_TITLES.charts;
    const r = document.getElementById("biDockRankTitle");
    if (r) r.textContent = DEFAULT_REPORT_TITLES.rank;
    const dth = document.getElementById("biProvinceRankDimTh");
    if (dth) dth.textContent = DEFAULT_REPORT_TITLES.rankDimTh;
    const sth = document.getElementById("biProvinceRankSalesTh");
    if (sth) sth.textContent = DEFAULT_REPORT_TITLES.rankSalesTh;
    const md = document.getElementById("biMultiDimDimTh");
    if (md) md.textContent = "维度";
    const tot = document.getElementById("biMultiDimTotalTh");
    if (tot) tot.textContent = "合计";
    const avg = document.getElementById("biMultiDimAvgTh");
    if (avg) avg.textContent = "平均";
}

function updateReportTitlesFromDimension(meta) {
    if (!meta || !meta.region_col) {
        restoreDefaultReportTitles();
        return;
    }
    const dim = String(meta.region_col).trim();
    const sales = meta.sales_col ? String(meta.sales_col).trim() : "销售额";
    const chartsEl = document.getElementById("biDockChartsTitle");
    if (chartsEl) chartsEl.textContent = `${dim}销售分布`;
    const rankT = document.getElementById("biDockRankTitle");
    if (rankT) rankT.textContent = `${dim}排名情况`;
    const dimTh = document.getElementById("biProvinceRankDimTh");
    if (dimTh) dimTh.textContent = dim;
    const saleTh = document.getElementById("biProvinceRankSalesTh");
    if (saleTh) saleTh.textContent = sales;
    const mdTh = document.getElementById("biMultiDimDimTh");
    if (mdTh) mdTh.textContent = dim;
    const tot = document.getElementById("biMultiDimTotalTh");
    if (tot) tot.textContent = `合计(${sales})`;
    const avg = document.getElementById("biMultiDimAvgTh");
    if (avg) avg.textContent = `平均(${sales})`;
}

function syncDashboardDockRootContentHeight() {
    const root = getDashboardDockRoot();
    if (!root) return;
    const minFromVh = window.innerHeight * DOCK_ROOT_MIN_VH_FRAC;
    let maxBottom = 0;
    root.querySelectorAll(".dashboard-dock-widget[data-dock-id]").forEach((el) => {
        if (el.style.display === "none") return;
        maxBottom = Math.max(maxBottom, el.offsetTop + el.offsetHeight);
    });
    const needed = maxBottom + DOCK_ROOT_DRAG_PAD_PX;
    root.style.minHeight = `${Math.max(Math.ceil(minFromVh), Math.ceil(needed))}px`;
}

function collectDockPixelRects(root) {
    if (!root) return { rects: [], rootW: 0, rootH: 0 };
    const rr = root.getBoundingClientRect();
    const rootW = rr.width;
    const rootH = rr.height;
    const rects = [];
    root.querySelectorAll(".dashboard-dock-widget[data-dock-id]").forEach((el) => {
        if (el.style.display === "none") return;
        const wr = el.getBoundingClientRect();
        if (wr.width < 1 || wr.height < 1) return;
        rects.push({
            id: el.dataset.dockId,
            l: wr.left - rr.left,
            t: wr.top - rr.top,
            w: wr.width,
            h: wr.height
        });
    });
    return { rects, rootW, rootH };
}

function clampDockRectInRoot(r, rootW, rootH) {
    let { l, t, w, h } = r;
    w = Math.max(DOCK_MIN.W, Math.min(w, rootW));
    h = Math.max(DOCK_MIN.H, Math.min(h, rootH));
    l = Math.max(0, Math.min(l, rootW - w));
    t = Math.max(0, Math.min(t, rootH - h));
    r.l = l;
    r.t = t;
    r.w = w;
    r.h = h;
}

function snapDockRectToGrid(r, rootW, rootH) {
    const colW = rootW / Math.max(1, DOCK_GRID_COLS);
    const out = { id: r.id, l: r.l, t: r.t, w: r.w, h: r.h };
    let l = Math.round(out.l / colW) * colW;
    let t = Math.round(out.t / DOCK_ROW_H) * DOCK_ROW_H;
    let w = Math.max(DOCK_MIN.W, Math.round(out.w / colW) * colW);
    let h = Math.max(DOCK_MIN.H, Math.round(out.h / DOCK_ROW_H) * DOCK_ROW_H);
    if (w > rootW) w = rootW;
    if (h > rootH) h = rootH;
    if (l + w > rootW) l = Math.max(0, rootW - w);
    if (t + h > rootH) t = Math.max(0, rootH - h);
    out.l = Math.max(0, l);
    out.t = Math.max(0, t);
    out.w = w;
    out.h = h;
    clampDockRectInRoot(out, rootW, rootH);
    return out;
}

/**
 * 对 l/t 应用磁吸死区：离网格吸附点超过 thresholdPx 时保持原坐标，减轻「疯狂抖动」。
 * 默认保留传入的 w/h（拖拽中锁定宽度时与 snap 后的宽高解耦）。
 */
function snapDockRectToGridWithPositionThreshold(r, rootW, rootH, thresholdPx, opts) {
    const keepSize = opts && opts.keepSize;
    const base = keepSize ? { id: r.id, l: r.l, t: r.t, w: r.w, h: r.h } : { ...r };
    const full = snapDockRectToGrid(base, rootW, rootH);
    const th = Number(thresholdPx) || 0;
    if (th <= 0) return full;
    const out = {
        id: r.id,
        l: full.l,
        t: full.t,
        w: keepSize ? r.w : full.w,
        h: keepSize ? r.h : full.h
    };
    if (Math.abs(full.l - r.l) > th) out.l = r.l;
    if (Math.abs(full.t - r.t) > th) out.t = r.t;
    clampDockRectInRoot(out, rootW, rootH);
    return out;
}

/** 优先横向错开 mover 与 fixed；失败则返回 false（由调用方做纵向推开）。 */
function trySeparateDockRectHorizontally(mover, fixed, gap, rootW, rootH) {
    if (!dockRectsOverlap(mover, fixed, gap)) return true;
    const orig = { l: mover.l, t: mover.t, w: mover.w, h: mover.h };
    const candidates = [];
    const rightL = fixed.l + fixed.w + gap;
    if (rightL + mover.w <= rootW + 0.5) {
        const d = Math.abs(rightL - orig.l);
        candidates.push({ l: rightL, t: mover.t, d });
    }
    const leftL = fixed.l - mover.w - gap;
    if (leftL >= -0.5) {
        const d = Math.abs(leftL - orig.l);
        candidates.push({ l: leftL, t: mover.t, d });
    }
    if (!candidates.length) return false;
    candidates.sort((a, b) => a.d - b.d);
    for (const c of candidates) {
        mover.l = c.l;
        mover.t = c.t;
        clampDockRectInRoot(mover, rootW, rootH);
        if (!dockRectsOverlap(mover, fixed, gap)) return true;
    }
    mover.l = orig.l;
    mover.t = orig.t;
    mover.w = orig.w;
    mover.h = orig.h;
    return false;
}

function dockRectsOverlap(a, b, gap) {
    return !(
        a.l + a.w + gap <= b.l ||
        b.l + b.w + gap <= a.l ||
        a.t + a.h + gap <= b.t ||
        b.t + b.h + gap <= a.t
    );
}

function resolveDockOverlapsPinned(pinnedId, rects, gap, rootW, rootH) {
    const list = rects.map((r) => ({ ...r }));
    for (let iter = 0; iter < 30; iter++) {
        let moved = false;
        for (let i = 0; i < list.length; i++) {
            for (let j = 0; j < list.length; j++) {
                if (i === j) continue;
                const A = list[i];
                const B = list[j];
                if (!dockRectsOverlap(A, B, gap)) continue;
                if (pinnedId && A.id === pinnedId) {
                    if (!trySeparateDockRectHorizontally(B, A, gap, rootW, rootH)) {
                        const nt = Math.max(B.t, A.t + A.h + gap);
                        const clamped = Math.min(nt, rootH - B.h);
                        if (Math.abs(clamped - B.t) > 0.5) {
                            B.t = clamped;
                            moved = true;
                        }
                    } else {
                        moved = true;
                    }
                } else if (pinnedId && B.id === pinnedId) {
                    if (!trySeparateDockRectHorizontally(A, B, gap, rootW, rootH)) {
                        const nt = Math.max(A.t, B.t + B.h + gap);
                        const clamped = Math.min(nt, rootH - A.h);
                        if (Math.abs(clamped - A.t) > 0.5) {
                            A.t = clamped;
                            moved = true;
                        }
                    } else {
                        moved = true;
                    }
                } else if (!pinnedId) {
                    if (A.t <= B.t) {
                        if (!trySeparateDockRectHorizontally(B, A, gap, rootW, rootH)) {
                            const nt = Math.max(B.t, A.t + A.h + gap);
                            const clamped = Math.min(nt, rootH - B.h);
                            if (Math.abs(clamped - B.t) > 0.5) {
                                B.t = clamped;
                                moved = true;
                            }
                        } else {
                            moved = true;
                        }
                    } else {
                        if (!trySeparateDockRectHorizontally(A, B, gap, rootW, rootH)) {
                            const nt = Math.max(A.t, B.t + B.h + gap);
                            const clamped = Math.min(nt, rootH - A.h);
                            if (Math.abs(clamped - A.t) > 0.5) {
                                A.t = clamped;
                                moved = true;
                            }
                        } else {
                            moved = true;
                        }
                    }
                } else {
                    const lower = A.t >= B.t ? A : B;
                    const upper = A.t >= B.t ? B : A;
                    if (!trySeparateDockRectHorizontally(lower, upper, gap, rootW, rootH)) {
                        const nt = Math.max(lower.t, upper.t + upper.h + gap);
                        const clamped = Math.min(nt, rootH - lower.h);
                        if (Math.abs(clamped - lower.t) > 0.5) {
                            lower.t = clamped;
                            moved = true;
                        }
                    } else {
                        moved = true;
                    }
                }
            }
        }
        if (!moved) break;
    }
    list.forEach((r) => clampDockRectInRoot(r, rootW, rootH));
    return list;
}

function compactDockRectsUpward(rects, gap, rootW, rootH) {
    const list = rects.map((r) => ({ ...r }));
    const step = DOCK_ROW_H;
    for (let pass = 0; pass < 48; pass++) {
        let moved = false;
        list.sort((a, b) => a.t - b.t || a.l - b.l);
        for (const r of list) {
            const others = list.filter((x) => x.id !== r.id);
            while (r.t - step >= 0) {
                const test = { ...r, t: r.t - step };
                clampDockRectInRoot(test, rootW, rootH);
                let ok = test.t >= 0 && test.l + test.w <= rootW + 0.5 && test.t + test.h <= rootH + 0.5;
                if (ok) {
                    for (const o of others) {
                        if (dockRectsOverlap(test, o, gap)) {
                            ok = false;
                            break;
                        }
                    }
                }
                if (!ok) break;
                r.t = test.t;
                moved = true;
            }
        }
        if (!moved) break;
    }
    list.forEach((r) => clampDockRectInRoot(r, rootW, rootH));
    return list;
}

function ensureDockLayoutPlaceholder(root) {
    if (!root) return null;
    let el = root.querySelector(".dashboard-dock-layout-placeholder");
    if (!el) {
        el = document.createElement("div");
        el.className = "dashboard-dock-layout-placeholder";
        el.setAttribute("aria-hidden", "true");
        root.appendChild(el);
    }
    return el;
}

function updateDockLayoutPlaceholder(rect, root, visible) {
    const ph = ensureDockLayoutPlaceholder(root);
    if (!ph) return;
    if (!visible || !rect) {
        ph.classList.remove("is-visible");
        return;
    }
    ph.classList.add("is-visible");
    ph.style.left = `${Math.round(rect.l)}px`;
    ph.style.top = `${Math.round(rect.t)}px`;
    ph.style.width = `${Math.round(rect.w)}px`;
    ph.style.height = `${Math.round(rect.h)}px`;
}

function hideDockLayoutPlaceholder() {
    const root = getDashboardDockRoot();
    const ph = root?.querySelector(".dashboard-dock-layout-placeholder");
    if (ph) ph.classList.remove("is-visible");
}

function applyDockRectsToElements(rects, root) {
    if (!root || !Array.isArray(rects)) return;
    rects.forEach((r) => {
        const el = root.querySelector(`[data-dock-id="${r.id}"]`);
        if (!el || el.style.display === "none") return;
        el.style.left = `${Math.round(r.l)}px`;
        el.style.top = `${Math.round(r.t)}px`;
        el.style.width = `${Math.round(r.w)}px`;
        el.style.height = `${Math.round(r.h)}px`;
    });
}

function dockPixelLayoutHasIssues(root) {
    const { rects, rootW, rootH } = collectDockPixelRects(root);
    if (!rects.length) return false;
    const gap = DOCK_GRID_GAP;
    for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (r.l < -0.5 || r.t < -0.5 || r.l + r.w > rootW + 0.5 || r.t + r.h > rootH + 0.5) return true;
        for (let j = i + 1; j < rects.length; j++) {
            if (dockRectsOverlap(rects[i], rects[j], gap)) return true;
        }
    }
    return false;
}

function finalizeDockCompactAndSave() {
    const root = getDashboardDockRoot();
    if (!root) return;
    hideDockLayoutPlaceholder();
    const { rects, rootW, rootH } = collectDockPixelRects(root);
    if (!rects.length || rootW < 64 || rootH < 64) {
        syncDashboardDockRootContentHeight();
        saveLayout();
        return;
    }
    let list = rects.map((r) => snapDockRectToGrid(r, rootW, rootH));
    list = resolveDockOverlapsPinned(null, list, DOCK_GRID_GAP, rootW, rootH);
    list = compactDockRectsUpward(list, DOCK_GRID_GAP, rootW, rootH);
    list = resolveDockOverlapsPinned(null, list, DOCK_GRID_GAP, rootW, rootH);
    applyDockRectsToElements(list, root);
    syncDashboardDockRootContentHeight();
    saveLayout();
}

function applyInteractingDockLayout(pinnedId) {
    const root = getDashboardDockRoot();
    if (!root || !pinnedId) return;
    const { rects, rootW, rootH } = collectDockPixelRects(root);
    if (rootW < 64 || rootH < 64) return;
    const pinned = rects.find((r) => r.id === pinnedId);
    if (!pinned) return;
    const ghost = snapDockRectToGridWithPositionThreshold(
        pinned,
        rootW,
        rootH,
        DOCK_SNAP_POSITION_THRESHOLD_PX,
        { keepSize: true }
    );
    updateDockLayoutPlaceholder(ghost, root, true);
    if (rects.length < 2) return;
    const list = rects.map((r) => ({ ...r }));
    const lwMap = dockDragState.lockedWidths;
    if (lwMap) {
        list.forEach((r) => {
            const lw = lwMap[r.id];
            if (lw != null) r.w = lw;
        });
    }
    const resolved = resolveDockOverlapsPinned(pinnedId, list, DOCK_GRID_GAP, rootW, rootH);
    const others = resolved.filter((r) => r.id !== pinnedId);
    compactDockRectsUpward(others, DOCK_GRID_GAP, rootW, rootH);
    others.forEach((r) => {
        const el = root.querySelector(`[data-dock-id="${r.id}"]`);
        if (!el || el.classList.contains("is-dragging")) return;
        const lw = lwMap && lwMap[r.id];
        const wpx = lw != null ? lw : r.w;
        el.style.left = `${Math.round(r.l)}px`;
        el.style.top = `${Math.round(r.t)}px`;
        el.style.width = `${Math.round(wpx)}px`;
        el.style.height = `${Math.round(r.h)}px`;
    });
}

function filterDockWidgetsLayoutForApply(widgets) {
    if (!Array.isArray(widgets)) return widgets;
    if (!isKpiDockSuppressed()) return widgets;
    return widgets.filter((w) => w.id !== "dock-kpi");
}

function computeDefaultDockPixelsTwoPanel(rootW, rootH) {
    const gap = 10;
    const topPad = 10;
    const innerW = Math.max(0, rootW - gap);
    const chartW = (innerW * 7) / 12;
    const rankW = innerW - chartW;
    const vert = Math.max(0, rootH - topPad - gap);
    const h = Math.max(DOCK_MIN.H, vert);
    return {
        charts: { l: 0, t: topPad, w: chartW, h },
        rank: { l: chartW + gap, t: topPad, w: rankW, h }
    };
}

function parseStoredDockLayout(raw) {
    if (!raw) return null;
    try {
        const o = JSON.parse(raw);
        if (o && o.v === 3 && Array.isArray(o.widgets)) return { kind: "v3", widgets: o.widgets };
        if (o && o.v === 2 && o.nodes) return { kind: "v2", nodes: o.nodes };
    } catch (e) {
        return null;
    }
    return null;
}

/** 默认可视区：KPI 置顶；下方图表:排名 = 7:5。KPI 高度需容纳 2×2 卡片 + 副文案，避免默认出现体内滚动条 */
function computeDefaultDockPixels(rootW, rootH) {
    const gap = 10;
    const minChartsH = 200;
    const kpiIdeal = Math.max(292, Math.min(rootH * 0.28, rootH * 0.4));
    const kpiMaxByViewport = rootH - gap - minChartsH;
    const kpiH = Math.min(kpiIdeal, Math.max(DOCK_MIN.H, kpiMaxByViewport));
    const top2 = kpiH + gap;
    const restH = Math.max(minChartsH, rootH - top2);
    const innerW = Math.max(0, rootW - gap);
    const chartW = (innerW * 7) / 12;
    const rankW = innerW - chartW;
    return {
        kpi: { l: 0, t: 0, w: rootW, h: kpiH },
        charts: { l: 0, t: top2, w: chartW, h: restH },
        rank: { l: chartW + gap, t: top2, w: rankW, h: restH }
    };
}

function pixelsToNorm(px, rootW, rootH) {
    const rw = Math.max(1, rootW);
    const rh = Math.max(1, rootH);
    const out = {};
    ["kpi", "charts", "rank"].forEach((k) => {
        const r = px[k];
        out[k] = { xl: r.l / rw, yt: r.t / rh, xw: r.w / rw, xh: r.h / rh };
    });
    return out;
}

function normToPixels(norm, rootW, rootH) {
    const out = {};
    ["kpi", "charts", "rank"].forEach((k) => {
        const r = norm[k];
        if (!r) return;
        out[k] = {
            l: r.xl * rootW,
            t: r.yt * rootH,
            w: r.xw * rootW,
            h: r.xh * rootH
        };
    });
    return out;
}

function clampDockPixels(px, rootW, rootH) {
    const minW = DOCK_MIN.W;
    const minH = DOCK_MIN.H;
    const out = {};
    ["kpi", "charts", "rank"].forEach((k) => {
        if (!px[k]) return;
        let { l, t, w, h } = px[k];
        w = Math.max(minW, Math.min(w, rootW));
        h = Math.max(minH, Math.min(h, rootH));
        l = Math.max(0, Math.min(l, rootW - w));
        t = Math.max(0, Math.min(t, rootH - h));
        out[k] = { l, t, w, h };
    });
    return out;
}

function pixelsMapToWidgetObjects(pxMap, rootW, rootH) {
    const keyToId = { kpi: "dock-kpi", charts: "dock-charts", rank: "dock-rank" };
    const out = [];
    ["kpi", "charts", "rank"].forEach((k) => {
        if (!pxMap[k]) return;
        const r = pxMap[k];
        out.push({
            id: keyToId[k],
            x_percent: r.l / rootW,
            y_percent: r.t / rootH,
            w_percent: r.w / rootW,
            h_percent: r.h / rootH
        });
    });
    return out;
}

function collectWidgetsLayoutFromDom() {
    const root = getDashboardDockRoot();
    if (!root) return [];
    const rr = root.getBoundingClientRect();
    const rw = rr.width;
    const rh = rr.height;
    if (rw < 1 || rh < 1) return [];
    const arr = [];
    root.querySelectorAll(".dashboard-dock-widget[data-dock-id]").forEach((el) => {
        if (el.style.display === "none") return;
        const wr = el.getBoundingClientRect();
        if (wr.width < 1 && wr.height < 1) return;
        arr.push({
            id: el.dataset.dockId,
            x_percent: (wr.left - rr.left) / rw,
            y_percent: (wr.top - rr.top) / rh,
            w_percent: wr.width / rw,
            h_percent: wr.height / rh
        });
    });
    return arr;
}

function saveLayout() {
    const widgets = collectWidgetsLayoutFromDom();
    try {
        localStorage.setItem(DOCK_LAYOUT_STORAGE_KEY, JSON.stringify({ v: 3, widgets }));
    } catch (e) {
        /* ignore */
    }
    fetch("/save-layout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout: { kind: "dashboard_dock", widgets } })
    }).catch(() => {});
}

/** 供图表与 KPI 等在布局提交后统一感知尺寸变化（勿在 window resize 回调内再派发，以免循环）。 */
function dispatchWindowResize() {
    window.dispatchEvent(new Event("resize"));
}

function showLayoutSaveToast(message) {
    const text = message || "布局已同步至服务器";
    let el = document.getElementById("layoutSaveToast");
    if (!el) {
        el = document.createElement("div");
        el.id = "layoutSaveToast";
        el.className = "app-toast app-toast--layout";
        el.setAttribute("role", "status");
        el.setAttribute("aria-live", "polite");
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add("app-toast--visible");
    clearTimeout(showLayoutSaveToast._t);
    showLayoutSaveToast._t = setTimeout(() => {
        el.classList.remove("app-toast--visible");
    }, 2400);
}

function saveLayoutWithToast() {
    finalizeDockCompactAndSave();
    showLayoutSaveToast();
}

function applyWidgetsLayout(widgets, rootW, rootH) {
    const root = getDashboardDockRoot();
    if (!root || !Array.isArray(widgets)) return;
    const MIN_W = DOCK_MIN.W;
    const MIN_H = DOCK_MIN.H;
    widgets.forEach((w) => {
        const el = root.querySelector(`[data-dock-id="${w.id}"]`);
        if (!el || el.style.display === "none") return;
        let left = w.x_percent * rootW;
        let top = w.y_percent * rootH;
        let width = w.w_percent * rootW;
        let height = w.h_percent * rootH;
        width = Math.max(MIN_W, Math.min(width, rootW));
        height = Math.max(MIN_H, Math.min(height, rootH));
        left = Math.max(0, Math.min(left, rootW - width));
        top = Math.max(0, Math.min(top, rootH - height));
        el.style.left = `${Math.round(left)}px`;
        el.style.top = `${Math.round(top)}px`;
        el.style.width = `${Math.round(width)}px`;
        el.style.height = `${Math.round(height)}px`;
    });
}

function measureAndApplyDockLayout() {
    const root = getDashboardDockRoot();
    if (!root) return;
    applyDockKpiDisplayMode();
    const rect = root.getBoundingClientRect();
    const rootW = rect.width;
    const rootH = rect.height;
    if (rootW < 64 || rootH < 64) {
        syncDashboardDockRootContentHeight();
        return;
    }

    let raw = null;
    try {
        raw = localStorage.getItem(DOCK_LAYOUT_STORAGE_KEY);
    } catch (e) {
        raw = null;
    }
    const parsed = parseStoredDockLayout(raw);

    if (!isKpiDockSuppressed() && parsed && parsed.kind === "v2" && parsed.nodes && parsed.nodes.kpi && parsed.nodes.charts && parsed.nodes.rank) {
        const px = clampDockPixels(normToPixels(parsed.nodes, rootW, rootH), rootW, rootH);
        applyWidgetsLayout(pixelsMapToWidgetObjects(px, rootW, rootH), rootW, rootH);
        if (dockPixelLayoutHasIssues(root)) finalizeDockCompactAndSave();
        else {
            syncDashboardDockRootContentHeight();
            saveLayout();
        }
        return;
    }

    if (!isKpiDockSuppressed() && parsed && parsed.kind === "v3" && parsed.widgets.length) {
        const inDom = parsed.widgets.filter((w) => root.querySelector(`[data-dock-id="${w.id}"]`));
        const existing = filterDockWidgetsLayoutForApply(inDom);
        if (existing.length) {
            applyWidgetsLayout(existing, rootW, rootH);
            if (dockPixelLayoutHasIssues(root)) {
                finalizeDockCompactAndSave();
            } else {
                syncDashboardDockRootContentHeight();
            }
            return;
        }
    }

    const pxDefault = clampDockPixels(
        (isKpiDockSuppressed() ? computeDefaultDockPixelsTwoPanel : computeDefaultDockPixels)(rootW, rootH),
        rootW,
        rootH
    );
    applyWidgetsLayout(pixelsMapToWidgetObjects(pxDefault, rootW, rootH), rootW, rootH);
    if (dockPixelLayoutHasIssues(root)) finalizeDockCompactAndSave();
    else syncDashboardDockRootContentHeight();
}

function createDockWidgetElement(dockId) {
    const t = document.createElement("template");
    if (dockId === "dock-kpi") {
        t.innerHTML =
            '<div id="dockWidgetKpi" class="dashboard-dock-widget bi-panel" data-dock-widget="kpi" data-dock-id="dock-kpi">' +
            '<div class="dashboard-dock-drag-zone" data-dock-drag="1" title="悬停标题栏拖拽整块">' +
            '<span class="bi-panel-title">关键指标</span>' +
            '<button type="button" class="dashboard-dock-delete" data-dock-delete="1" title="移除此面板" aria-label="删除">×</button>' +
            "</div>" +
            '<div class="dashboard-dock-widget-body dashboard-dock-kpi-body px-3 pb-3 pt-0">' +
            '<div class="dashboard-dock-kpi-grid">' +
            '<div class="dashboard-dock-kpi-cell"><div class="bi-stat-card bi-stat-card--blue"><div class="bi-stat-label">总销售额</div><div class="bi-stat-value" id="biStatTotalSales">待上传</div></div></div>' +
            '<div class="dashboard-dock-kpi-cell"><div class="bi-stat-card bi-stat-card--green"><div class="bi-stat-label">环比增长</div><div class="bi-stat-value" id="biStatMom">待上传</div></div></div>' +
            '<div class="dashboard-dock-kpi-cell"><div class="bi-stat-card bi-stat-card--amber" title="载入数据后统计行数或订单号去重"><div class="bi-stat-label">订单总数</div><div class="bi-stat-value" id="biStatOrders">待上传</div><div class="bi-stat-hint" id="biStatOrdersHint">载入数据后统计行数或订单号去重</div></div></div>' +
            '<div class="dashboard-dock-kpi-cell"><div class="bi-stat-card bi-stat-card--rose" title="含负销售额、离群波动等"><div class="bi-stat-label">预警项数</div><div class="bi-stat-value" id="biStatWarnings">待上传</div><div class="bi-stat-hint">含负销售额、离群波动等</div></div></div>' +
            "</div></div>" +
            '<div class="resizer" data-dock-resize="1" title="拖动调整大小" aria-hidden="true"></div>' +
            "</div>";
        return t.content.firstElementChild;
    }
    if (dockId === "dock-charts") {
        t.innerHTML =
            '<div id="dockWidgetCharts" class="dashboard-dock-widget bi-panel bi-panel--canvas" data-dock-widget="charts" data-dock-id="dock-charts">' +
            '<div class="dashboard-dock-drag-zone" data-dock-drag="1" title="悬停标题栏拖拽整块 · 拖拽左侧组件到下方画布">' +
            '<div class="dashboard-dock-drag-titles"><span class="bi-panel-title" id="biDockChartsTitle" data-report-title-role="charts">主趋势与图表</span><span class="bi-panel-sub">拖拽左侧组件到下方画布</span></div>' +
            '<button type="button" class="dashboard-dock-delete" data-dock-delete="1" title="移除此面板" aria-label="删除">×</button>' +
            "</div>" +
            '<div class="dashboard-dock-widget-body dashboard-dock-widget-body--fill"></div>' +
            '<div class="resizer" data-dock-resize="1" title="拖动调整大小" aria-hidden="true"></div>' +
            "</div>";
        return t.content.firstElementChild;
    }
    if (dockId === "dock-rank") {
        t.innerHTML =
            '<div id="dockWidgetRank" class="dashboard-dock-widget bi-panel bi-panel--side" data-dock-widget="rank" data-dock-id="dock-rank">' +
            '<div class="dashboard-dock-drag-zone" data-dock-drag="1" title="悬停标题栏拖拽整块">' +
            '<span class="bi-panel-title" id="biDockRankTitle" data-report-title-role="rank">各省份 / 区域销售额排名</span>' +
            '<button type="button" class="dashboard-dock-delete" data-dock-delete="1" title="移除此面板" aria-label="删除">×</button>' +
            "</div>" +
            '<div class="dashboard-dock-widget-body bi-rank-body flex-grow-1">' +
            '<table class="table table-sm table-hover align-middle mb-0" id="biProvinceRankTable">' +
            '<thead class="table-light"><tr><th class="text-muted" style="width:3rem">#</th><th id="biProvinceRankDimTh">省份 / 区域</th><th class="text-end" id="biProvinceRankSalesTh">销售额</th></tr></thead>' +
            '<tbody id="biProvinceRankBody"><tr class="text-secondary"><td colspan="3" class="small py-4 px-3">上传数据后将按「省 / 区域」列与销售额类数值列自动汇总</td></tr></tbody>' +
            "</table></div>" +
            '<div class="resizer" data-dock-resize="1" title="拖动调整大小" aria-hidden="true"></div>' +
            "</div>";
        return t.content.firstElementChild;
    }
    return null;
}

function ensureAllDockWidgets() {
    const root = getDashboardDockRoot();
    if (!root) return;
    DOCK_IDS.forEach((id) => {
        if (!root.querySelector(`[data-dock-id="${id}"]`)) {
            const el = createDockWidgetElement(id);
            if (el) root.appendChild(el);
        }
    });
    const cg = document.getElementById("canvasGrid");
    const shell = document.getElementById("dockWidgetCharts");
    if (cg && shell) {
        const body = shell.querySelector(".dashboard-dock-widget-body--fill");
        if (body && !body.contains(cg)) {
            body.appendChild(cg);
            cg.style.cssText = "";
        }
    }
}

function removeDockWidget(widget) {
    if (!widget || !widget.parentNode) return;
    const id = widget.dataset.dockId;
    if (id === "dock-charts") {
        const cg = document.getElementById("canvasGrid");
        const root = getDashboardDockRoot();
        if (cg && root) {
            root.appendChild(cg);
            cg.style.position = "absolute";
            cg.style.left = "12px";
            cg.style.right = "12px";
            cg.style.top = "12px";
            cg.style.bottom = "12px";
            cg.style.width = "auto";
            cg.style.height = "auto";
        }
    }
    widget.remove();
    finalizeDockCompactAndSave();
    void refreshDashboardMetrics();
    requestAnimationFrame(() => {
        document.querySelectorAll(".chart-card").forEach(refreshPlotlyInCard);
    });
}

const dockDragState = {
    widget: null,
    startX: 0,
    startY: 0,
    base: null,
    /** 拖拽开始时各 dock 块宽度，交互布局中强制保持，避免「变窄→判放不下→整行下沉」 */
    lockedWidths: null
};

function beginDockDrag(widget, e) {
    if (presentationMode) return;
    const root = getDashboardDockRoot();
    if (!root || !widget || !root.contains(widget)) return;
    e.preventDefault();
    e.stopPropagation();
    const rr = root.getBoundingClientRect();
    const wr = widget.getBoundingClientRect();
    dockDragState.widget = widget;
    dockDragState.startX = e.clientX;
    dockDragState.startY = e.clientY;
    dockDragState.base = {
        l: wr.left - rr.left,
        t: wr.top - rr.top,
        w: wr.width,
        h: wr.height
    };
    const lockedWidths = {};
    root.querySelectorAll(".dashboard-dock-widget[data-dock-id]").forEach((el) => {
        if (el.style.display === "none") return;
        const id = el.dataset.dockId;
        if (!id) return;
        lockedWidths[id] = el.getBoundingClientRect().width;
    });
    dockDragState.lockedWidths = lockedWidths;
    widget.classList.add("is-dragging");
    root.classList.add("is-dock-dragging", "is-dock-grabbing");
    document.body.classList.add("is-adjusting");
    document.body.style.userSelect = "none";
    ensureDockLayoutPlaceholder(root);
    document.addEventListener("mousemove", onDockDragMove);
    document.addEventListener("mouseup", onDockDragEnd, true);
}

function onDockDragMove(e) {
    const st = dockDragState;
    if (!st.widget || !st.base) return;
    const root = getDashboardDockRoot();
    if (!root) return;
    const rr = root.getBoundingClientRect();
    const rootW = rr.width;
    const rootH = rr.height;
    const dx = e.clientX - st.startX;
    const dy = e.clientY - st.startY;
    let l = st.base.l + dx;
    let t = st.base.t + dy;
    const w = st.base.w;
    const h = st.base.h;
    l = Math.max(0, Math.min(l, rootW - w));
    t = Math.max(0, Math.min(t, rootH - h));
    st.widget.style.left = `${Math.round(l)}px`;
    st.widget.style.top = `${Math.round(t)}px`;
    st.widget.style.width = `${Math.round(w)}px`;
    st.widget.style.height = `${Math.round(h)}px`;
    applyInteractingDockLayout(st.widget.dataset.dockId);
}

function onDockDragEnd() {
    document.removeEventListener("mousemove", onDockDragMove);
    document.removeEventListener("mouseup", onDockDragEnd, true);
    document.body.classList.remove("is-adjusting");
    document.body.style.userSelect = "";
    const root = getDashboardDockRoot();
    if (root) root.classList.remove("is-dock-dragging", "is-dock-grabbing");
    const w = dockDragState.widget;
    dockDragState.widget = null;
    dockDragState.base = null;
    dockDragState.lockedWidths = null;
    if (w) {
        w.classList.remove("is-dragging");
        const root = getDashboardDockRoot();
        if (root) {
            const { rects, rootW, rootH } = collectDockPixelRects(root);
            const live = rects.find((r) => r.id === w.dataset.dockId);
            if (live && rootW >= 64 && rootH >= 64) {
                const sn = snapDockRectToGridWithPositionThreshold(
                    live,
                    rootW,
                    rootH,
                    DOCK_SNAP_POSITION_THRESHOLD_PX,
                    { keepSize: true }
                );
                w.style.left = `${Math.round(sn.l)}px`;
                w.style.top = `${Math.round(sn.t)}px`;
                w.style.width = `${Math.round(sn.w)}px`;
                w.style.height = `${Math.round(sn.h)}px`;
            }
        }
    }
    finalizeDockCompactAndSave();
    requestAnimationFrame(() => {
        document.querySelectorAll(".chart-card").forEach(refreshPlotlyInCard);
    });
}

const dockResizeState = {
    widget: null,
    startX: 0,
    startY: 0,
    startW: 0,
    startH: 0,
    startL: 0,
    startT: 0,
    lastClientX: 0,
    lastClientY: 0,
    scheduled: false,
    pendingEvent: null,
    rafId: 0
};

function flushDockResize() {
    dockResizeState.scheduled = false;
    const ev = dockResizeState.pendingEvent;
    dockResizeState.pendingEvent = null;
    const st = dockResizeState;
    if (!ev || !st.widget) return;
    const root = getDashboardDockRoot();
    if (!root) return;
    const rr = root.getBoundingClientRect();
    const dx = ev.clientX - st.startX;
    const dy = ev.clientY - st.startY;
    let nw = Math.max(DOCK_MIN.W, st.startW + dx);
    let nh = Math.max(DOCK_MIN.H, st.startH + dy);
    nw = Math.min(nw, rr.width - st.startL);
    nh = Math.min(nh, rr.height - st.startT);
    /* 右下角缩放：锚定左上角，禁止 Top/Left 在拖拽过程中漂移 */
    st.widget.style.left = `${Math.round(st.startL)}px`;
    st.widget.style.top = `${Math.round(st.startT)}px`;
    st.widget.style.width = `${Math.round(nw)}px`;
    st.widget.style.height = `${Math.round(nh)}px`;
    if (st.widget.dataset.dockId) applyInteractingDockLayout(st.widget.dataset.dockId);
}

function onDockResizeMove(e) {
    dockResizeState.lastClientX = e.clientX;
    dockResizeState.lastClientY = e.clientY;
    dockResizeState.pendingEvent = e;
    if (!dockResizeState.scheduled) {
        dockResizeState.scheduled = true;
        dockResizeState.rafId = requestAnimationFrame(flushDockResize);
    }
}

function beginDockResize(widget, e) {
    if (presentationMode) return;
    const root = getDashboardDockRoot();
    if (!root || !widget || !root.contains(widget)) return;
    e.preventDefault();
    e.stopPropagation();
    const rr = root.getBoundingClientRect();
    const wr = widget.getBoundingClientRect();
    dockResizeState.widget = widget;
    dockResizeState.startX = e.clientX;
    dockResizeState.startY = e.clientY;
    dockResizeState.startW = wr.width;
    dockResizeState.startH = wr.height;
    dockResizeState.startL = wr.left - rr.left;
    dockResizeState.startT = wr.top - rr.top;
    dockResizeState.lastClientX = e.clientX;
    dockResizeState.lastClientY = e.clientY;
    widget.classList.add("is-dragging");
    root.classList.add("is-dock-dragging", "is-dock-grabbing");
    document.body.classList.add("is-adjusting");
    document.body.style.userSelect = "none";
    ensureDockLayoutPlaceholder(root);
    document.addEventListener("mousemove", onDockResizeMove);
    document.addEventListener("mouseup", onDockResizeEnd, true);
}

function onDockResizeEnd() {
    if (dockResizeState.rafId) cancelAnimationFrame(dockResizeState.rafId);
    dockResizeState.rafId = 0;
    dockResizeState.scheduled = false;
    const w = dockResizeState.widget;
    /* 最后一帧 mousemove 可能未进入 rAF：用 lastClient 再刷一次宽高与锚点 */
    if (w) {
        dockResizeState.widget = w;
        dockResizeState.pendingEvent = {
            clientX: dockResizeState.lastClientX,
            clientY: dockResizeState.lastClientY
        };
        flushDockResize();
    }
    dockResizeState.pendingEvent = null;
    document.removeEventListener("mousemove", onDockResizeMove);
    document.removeEventListener("mouseup", onDockResizeEnd, true);
    document.body.classList.remove("is-adjusting");
    document.body.style.userSelect = "";
    const root = getDashboardDockRoot();
    if (root) root.classList.remove("is-dock-dragging", "is-dock-grabbing");
    dockResizeState.widget = null;
    if (w) w.classList.remove("is-dragging");
    finalizeDockCompactAndSave();
    requestAnimationFrame(() => {
        document.querySelectorAll(".chart-card").forEach(refreshPlotlyInCard);
    });
}

function onDockRootPointerDown(e) {
    const root = getDashboardDockRoot();
    if (e.button === 0 && root) {
        const hit = e.target.closest(".dashboard-dock-widget");
        if (hit && hit.dataset.dockId && root.contains(hit)) bringDockWidgetToFront(hit);
    }
    if (e.target.closest(".dashboard-dock-delete")) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const w = e.target.closest(".dashboard-dock-widget");
        if (w) removeDockWidget(w);
        return;
    }
    if (e.target.closest("[data-dock-resize]")) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const w = e.target.closest(".dashboard-dock-widget");
        if (w) beginDockResize(w, e);
        return;
    }
    const dz = e.target.closest("[data-dock-drag]");
    if (dz && e.button === 0) {
        if (e.target.closest(".dashboard-dock-delete")) return;
        const w = dz.closest(".dashboard-dock-widget");
        if (w) beginDockDrag(w, e);
    }
}

function initDashboardDock() {
    const root = getDashboardDockRoot();
    if (!root || root.dataset.dockDelegated === "1") return;
    root.dataset.dockDelegated = "1";
    root.addEventListener("mousedown", onDockRootPointerDown, true);
    requestAnimationFrame(() => {
        measureAndApplyDockLayout();
        applyReportModuleVisibility();
        resetDockWidgetStacking();
        syncKpiPlaceholderUi();
        requestAnimationFrame(() => {
            dispatchWindowResize();
        });
    });
}

/** 深色多维汇总表：行底边框悬停预览、点击切换「确定 / 淡化」 */
function initMultiDimSummaryRowInteractions() {
    const table = document.getElementById("biMultiDimSummaryTable");
    if (!table || table.dataset.mdRowOutlineBound === "1") return;
    table.dataset.mdRowOutlineBound = "1";
    table.addEventListener("click", (e) => {
        const tr = e.target.closest("tbody tr");
        if (!tr || !table.contains(tr)) return;
        tr.classList.toggle("multi-dim-summary-row--line-active");
    });
}

window.saveLayout = saveLayout;
window.saveLayoutToLocalStorage = saveLayout;
window.dispatchWindowResize = dispatchWindowResize;
window.saveLayoutWithToast = saveLayoutWithToast;
// ================= 工具函数 =================
function safeParseChart(chart) {
    return typeof chart === "string" ? JSON.parse(chart) : chart;
}

function buildLayout(layout = {}) {
    const isDark = currentTheme === "dark";
    const baseTitle = layout.title && typeof layout.title === "object" ? layout.title : {};
    return {
        ...layout,
        autosize: true,
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
        font: { color: isDark ? "#f9fafb" : "#111827" },
        title: {
            ...baseTitle,
            font: { ...(baseTitle.font || {}), color: isDark ? "#f9fafb" : "#111827" }
        },
        xaxis: { color: isDark ? "#f9fafb" : "#111827", gridcolor: isDark ? "#374151" : "#e5e7eb" },
        yaxis: { color: isDark ? "#f9fafb" : "#111827", gridcolor: isDark ? "#374151" : "#e5e7eb" },
        legend: { font: { color: isDark ? "#f9fafb" : "#111827" } }
    };
}

// ================= 初始化 =================
let presentationMode = false;

document.addEventListener("DOMContentLoaded", () => {
    bindCanvasInteractionGlobals();
    initSidebar();
    initDrag();
    initDateFilterToolbar();
    fetchReportTemplates();
    initGlobalCurrencyToolbar();
    initSmartTableSubjectDrillDelegation();
    initKpiEmptyPreferenceCheckbox();
    initReportModuleToolbar();
    initDashboardDock();
    initMultiDimSummaryRowInteractions();
    (async () => {
        await restorePersistedSession();
        await loadDashboard();
    })();
    window.addEventListener("resize", () => {
        requestAnimationFrame(() => {
            measureAndApplyDockLayout();
            expandVisibleDockWidgetsHorizontally(getDashboardDockRoot());
            syncDashboardDockRootContentHeight();
            document.querySelectorAll(".chart-card").forEach(refreshPlotlyInCard);
        });
    });
});

// ================= 侧边栏 =================
function initSidebar() {
    const btn = document.getElementById("sidebarToggle");
    if (!btn) return;
    btn.onclick = () => document.getElementById("sidebar").classList.toggle("collapsed");
}

function initGlobalCurrencyToolbar() {
    const sel = document.getElementById("globalCurrencySelect");
    if (!sel) return;
    sel.value = displayCurrency;
    sel.addEventListener("change", onGlobalCurrencyChange);
}

async function onGlobalCurrencyChange() {
    const sel = document.getElementById("globalCurrencySelect");
    if (!sel) return;
    displayCurrency = sel.value;
    localStorage.setItem("dashboard_display_currency", displayCurrency);
    try {
        const rateRes = await fetch("/api/mock-rates");
        const rateData = await rateRes.json();
        if (rateData.status === "success" && rateData.rates_to_cny) {
            const tip = document.getElementById("statusTip");
            if (tip) {
                tip.innerText = `展示币种：${displayCurrency} · 已加载 mock 汇率基准（CNY）`;
            }
        }
    } catch (e) {
        console.error(e);
    }
    await refreshAllSmartTables();
}

async function refreshAllSmartTables() {
    const cards = document.querySelectorAll('.chart-card[data-smart-table="1"]');
    for (const card of cards) {
        let vis = null;
        try {
            if (card.dataset.columnVisibility) {
                vis = JSON.parse(card.dataset.columnVisibility);
            }
        } catch (e) {
            vis = null;
        }
        await fetchAndApplySmartTable(card, card.dataset.templateId, vis);
    }
}

async function runExternalIntegrationLoad(rows, label, loadingHint) {
    const overlay = document.getElementById("integrationLoadingOverlay");
    const textEl = overlay?.querySelector(".integration-loading-text");
    if (textEl && loadingHint) textEl.innerText = loadingHint;
    if (overlay) overlay.style.display = "flex";
    await new Promise((r) => setTimeout(r, 2000));
    try {
        const res = await fetch("/api/session-manual", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rows, label })
        });
        const data = await res.json();
        if (overlay) overlay.style.display = "none";
        if (data.status !== "success") return alert(data.msg || "载入失败");
        resetChartDrillState();
        applyLoadedDataset({
            all_columns: data.all_columns,
            numeric_columns: data.numeric_columns,
            filename: label,
            raw_data_html: data.raw_data_html,
            mapped_columns: data.mapped_columns,
            msg: "外部数据已写入会话（模拟 API）",
            clearCanvas: false
        });
        const tip = document.getElementById("statusTip");
        if (tip) tip.innerText = `${label} · 已就绪，可拖拽智能表格查看`;
    } catch (e) {
        if (overlay) overlay.style.display = "none";
        console.error(e);
        alert("同步失败");
    }
}

async function syncExternalBankFlow() {
    await runExternalIntegrationLoad(
        PRESET_BANK_FLOW_ROWS,
        "(银行流水同步)",
        "正在从银行网关同步流水…"
    );
}

async function syncExternalMobileWallet() {
    await runExternalIntegrationLoad(
        PRESET_MOBILE_WALLET_ROWS,
        "(支付宝/微信同步)",
        "正在从支付宝 / 微信开放平台拉取账单…"
    );
}

// ================= VLOOKUP 参考表 =================
function fillOptionSelect(selectEl, columns, placeholder) {
    if (!selectEl) return;
    const prev = selectEl.value;
    selectEl.innerHTML = "";
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = placeholder || "请选择";
    selectEl.appendChild(ph);
    (columns || []).forEach((c) => {
        const o = document.createElement("option");
        o.value = c;
        o.textContent = c;
        selectEl.appendChild(o);
    });
    if (prev && [...selectEl.options].some((opt) => opt.value === prev)) {
        selectEl.value = prev;
    }
}

function syncMappedColumnsAfterDatasetLoad(allCols, mappedFromServer) {
    if (!allCols || !allCols.length) {
        mappedColumns = [];
        return;
    }
    if (Array.isArray(mappedFromServer) && mappedFromServer.length) {
        const set = new Set(allCols);
        mappedColumns = mappedFromServer
            .filter((x) => x && x.name != null && set.has(String(x.name)))
            .map((x) => ({ name: String(x.name), visible: x.visible !== false }));
        for (const c of allCols) {
            if (!mappedColumns.some((m) => m.name === c)) {
                mappedColumns.push({ name: c, visible: true });
            }
        }
        return;
    }
    if (!mappedColumns.length) {
        mappedColumns = allCols.map((name) => ({ name, visible: true }));
        return;
    }
    const setAll = new Set(allCols);
    mappedColumns = mappedColumns.filter((o) => setAll.has(o.name));
    const seen = new Set(mappedColumns.map((o) => o.name));
    for (const c of allCols) {
        if (!seen.has(c)) {
            mappedColumns.push({ name: c, visible: true });
            seen.add(c);
        }
    }
}

function destroyMappingColumnSortable() {
    if (mappingColumnSortable) {
        try {
            mappingColumnSortable.destroy();
        } catch (e) {
            /* ignore */
        }
        mappingColumnSortable = null;
    }
}

function syncMappedColumnOrderFromDom() {
    const list = document.getElementById("mappingColumnSortList");
    if (!list) return;
    const next = [];
    [...list.children].forEach((el) => {
        if (!el.classList || !el.classList.contains("mapping-col-sort-item")) return;
        const i = parseInt(el.getAttribute("data-col-idx"), 10);
        if (!Number.isNaN(i) && mappedColumns[i]) {
            next.push({ name: mappedColumns[i].name, visible: !!mappedColumns[i].visible });
        }
    });
    if (next.length === mappedColumns.length) {
        mappedColumns = next;
    }
}

function renderMappingColumnSortPanel() {
    const list = document.getElementById("mappingColumnSortList");
    if (!list) return;
    destroyMappingColumnSortable();
    if (!mappedColumns.length) {
        list.innerHTML =
            '<div class="list-group-item text-secondary small">暂无列信息，请先上传数据</div>';
        return;
    }
    list.innerHTML = mappedColumns
        .map((row, idx) => {
            const label = _escapeHtmlBi(row.name);
            const checked = row.visible ? " checked" : "";
            return `<div class="list-group-item mapping-col-sort-item d-flex align-items-center gap-2 py-2" data-col-idx="${idx}">
                <span class="mapping-col-drag-handle" title="拖动排序" aria-hidden="true">⋮⋮</span>
                <span class="mapping-col-name flex-grow-1 text-truncate" title="${label}">${label}</span>
                <div class="form-check form-switch m-0 flex-shrink-0">
                    <input class="form-check-input mapping-col-visible" type="checkbox" role="switch" data-col-idx="${idx}"${checked} aria-label="显示列 ${label}">
                </div>
            </div>`;
        })
        .join("");
    list.querySelectorAll(".mapping-col-visible").forEach((inp) => {
        inp.addEventListener("change", onMappingColVisibleChange);
    });
    initMappingColumnSortable();
}

function initMappingColumnSortable() {
    const list = document.getElementById("mappingColumnSortList");
    if (!list || typeof Sortable === "undefined") return;
    mappingColumnSortable = Sortable.create(list, {
        animation: 150,
        handle: ".mapping-col-drag-handle",
        ghostClass: "mapping-col-ghost",
        onEnd() {
            syncMappedColumnOrderFromDom();
            renderMappingColumnSortPanel();
        }
    });
}

function onMappingColVisibleChange(ev) {
    const inp = ev.target;
    if (!inp || !inp.classList.contains("mapping-col-visible")) return;
    const idx = parseInt(inp.getAttribute("data-col-idx"), 10);
    if (Number.isNaN(idx) || !mappedColumns[idx]) return;
    const name = mappedColumns[idx].name;
    const md = document.getElementById("mapSelectDate")?.value;
    const mv = document.getElementById("mapSelectValue")?.value;
    const mdm = document.getElementById("mapSelectDim")?.value;
    if (!inp.checked && (name === md || name === mv || name === mdm)) {
        inp.checked = true;
        alert("该列已选为日期 / 指标或维度映射，请保持显示开启。");
        return;
    }
    mappedColumns[idx].visible = inp.checked;
}

function ensureMappingTripletSwitchesOn() {
    const md = document.getElementById("mapSelectDate")?.value;
    const mv = document.getElementById("mapSelectValue")?.value;
    const mdm = document.getElementById("mapSelectDim")?.value;
    [md, mv, mdm].forEach((n) => {
        if (!n) return;
        const row = mappedColumns.find((o) => o.name === n);
        if (row) row.visible = true;
    });
    renderMappingColumnSortPanel();
}

function showVlookupSection() {
    const sec = document.getElementById("vlookupSection");
    if (sec) sec.style.display = "block";
}

function hideVlookupSection() {
    const sec = document.getElementById("vlookupSection");
    if (sec) sec.style.display = "none";
}

function resetVlookupClientState() {
    lookupAllColumns = [];
    lookupNumericColumns = [];
    const box = document.getElementById("lookupUploadBox");
    const card = document.getElementById("lookupFileCard");
    if (box) box.style.display = "";
    if (card) card.style.display = "none";
    const inp = document.getElementById("lookupFileInput");
    if (inp) inp.value = "";
    fillOptionSelect(document.getElementById("vlookupLookupKey"), [], "请先上传参考表");
    fillOptionSelect(document.getElementById("vlookupPriceCol"), [], "请先上传参考表");
}

function populateVlookupMainSelects() {
    fillOptionSelect(document.getElementById("vlookupMainKey"), allColumns, "主表关联键");
    fillOptionSelect(document.getElementById("vlookupQtyCol"), allColumns, "数量列");
}

function populateVlookupLookupSelects(lookupCols, numericCols) {
    if (Array.isArray(lookupCols)) lookupAllColumns = lookupCols;
    if (Array.isArray(numericCols)) lookupNumericColumns = numericCols;
    const priceChoices = lookupNumericColumns.length ? lookupNumericColumns : lookupAllColumns;
    fillOptionSelect(document.getElementById("vlookupLookupKey"), lookupAllColumns, "参考表关联键");
    fillOptionSelect(document.getElementById("vlookupPriceCol"), priceChoices, "单价列");
}

async function removeLookupFile() {
    try {
        await fetch("/clear-lookup", { method: "POST" });
    } catch (e) {
        console.error(e);
    }
    resetVlookupClientState();
    const tip = document.getElementById("statusTip");
    if (tip) tip.innerText = "已移除参考表，主表数据未变";
}

async function applyLookupMerge() {
    const mainKey = document.getElementById("vlookupMainKey")?.value;
    const lookupKey = document.getElementById("vlookupLookupKey")?.value;
    const qtyCol = document.getElementById("vlookupQtyCol")?.value;
    const priceCol = document.getElementById("vlookupPriceCol")?.value;
    if (!mainKey || !lookupKey || !qtyCol || !priceCol) {
        return alert("请选择主表关联键、参考表关联键、数量列与单价列");
    }
    const tip = document.getElementById("statusTip");
    if (tip) tip.innerText = "正在关联…";
    try {
        const res = await fetch("/apply-lookup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                main_key: mainKey,
                lookup_key: lookupKey,
                qty_col: qtyCol,
                price_col: priceCol
            })
        });
        const data = await res.json();
        if (data.status !== "success") {
            if (tip) tip.innerText = data.msg || "关联失败";
            return alert(data.msg || "关联失败");
        }
        applyLoadedDataset({
            all_columns: data.all_columns,
            numeric_columns: data.numeric_columns,
            filename: data.filename,
            raw_data_html: data.raw_data_html,
            mapped_columns: data.mapped_columns,
            msg: data.msg || "关联完成",
            clearCanvas: false,
            resetLookup: false
        });
    } catch (e) {
        console.error(e);
        if (tip) tip.innerText = "关联请求失败";
        alert("网络错误");
    }
}

const lookupFileInput = document.getElementById("lookupFileInput");
if (lookupFileInput) {
    lookupFileInput.addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (!currentFileLoaded) {
            lookupFileInput.value = "";
            return alert("请先上传主表数据");
        }
        const fd = new FormData();
        fd.append("file", file);
        const tip = document.getElementById("statusTip");
        if (tip) tip.innerText = "正在解析参考表…";
        try {
            const res = await fetch("/upload-lookup", { method: "POST", body: fd });
            const data = await res.json();
            lookupFileInput.value = "";
            if (data.status !== "success") {
                if (tip) tip.innerText = data.msg || "参考表上传失败";
                return alert(data.msg || "参考表上传失败");
            }
            lookupAllColumns = data.lookup_all_columns || [];
            lookupNumericColumns = data.lookup_numeric_columns || [];
            const box = document.getElementById("lookupUploadBox");
            const card = document.getElementById("lookupFileCard");
            const nameEl = document.getElementById("lookupFileName");
            if (box) box.style.display = "none";
            if (card) card.style.display = "flex";
            if (nameEl) nameEl.innerText = data.filename || "参考表";
            populateVlookupLookupSelects(lookupAllColumns, lookupNumericColumns);
            populateVlookupMainSelects();
            if (tip) tip.innerText = data.msg || "参考表已就绪，请选择列后点击「应用关联与计算」";
        } catch (err) {
            console.error(err);
            if (tip) tip.innerText = "参考表上传失败";
            alert("网络错误");
        }
    });
}

/** 内置主表 + 参考表（与 generate_mock_data / TestData 一致），与文件上传二选一可切换 */
async function generateDemoDataset() {
    if (
        typeof currentFileLoaded !== "undefined" &&
        currentFileLoaded &&
        !confirm(
            "将清空当前看板图表，并用内置测试主表（默认 1000 行）及参考表替换当前会话中的主表与参考表。是否继续？"
        )
    ) {
        return;
    }
    const tip = document.getElementById("statusTip");
    if (tip) tip.innerText = "正在生成测试数据…";
    try {
        const res = await fetch("/api/generate-demo-dataset", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ n_rows: 1000, seed: 42, include_lookup: true })
        });
        const data = await res.json();
        if (data.status !== "success") {
            if (tip) tip.innerText = data.msg || "生成失败";
            alert(data.msg || "生成失败");
            return;
        }

        if (Array.isArray(data.lookup_all_columns) && data.lookup_all_columns.length) {
            lookupAllColumns = data.lookup_all_columns;
            lookupNumericColumns = Array.isArray(data.lookup_numeric_columns)
                ? data.lookup_numeric_columns
                : [];
        }

        const canvas = document.getElementById("canvasGrid");
        canvas.innerHTML = `<div class="canvas-placeholder" id="canvasPlaceholder">拖拽组件到这里</div>`;
        activeCharts = {};
        resetChartDrillState();

        const hasLookup = !!(data.lookup_all_columns && data.lookup_all_columns.length);
        applyLoadedDataset({
            all_columns: data.all_columns,
            numeric_columns: data.numeric_columns,
            filename: data.filename,
            filesize: data.filesize,
            raw_data_html: data.raw_data_html,
            mapped_columns: data.mapped_columns,
            msg: data.msg || "测试数据已就绪",
            clearCanvas: false,
            resetLookup: !hasLookup,
            // 内置数据已在服务端完成列推断，与弹窗预填一致，可直接拉 KPI / 排名 / 多维表
            skipDashboardMetrics: false
        });

        if (hasLookup) {
            populateVlookupLookupSelects(lookupAllColumns, lookupNumericColumns);
            populateVlookupMainSelects();
            const box = document.getElementById("lookupUploadBox");
            const card = document.getElementById("lookupFileCard");
            const nameEl = document.getElementById("lookupFileName");
            if (box) box.style.display = "none";
            if (card) card.style.display = "flex";
            if (nameEl) nameEl.innerText = data.lookup_filename || "参考表";
        }

        openColumnMappingModalAfterUpload(data);
        if (tip) tip.innerText = data.msg || "测试数据已就绪";
    } catch (e) {
        console.error(e);
        if (tip) tip.innerText = "请求失败";
        alert("网络错误，请检查服务是否已启动");
    }
}

// ================= 上传 =================
document.getElementById("fileInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    document.getElementById("statusTip").innerText = "解析中...";
    const res = await fetch("/upload", { method: "POST", body: fd });
    const data = await res.json();
    if (data.status !== "success") return alert(data.msg);

    const canvas = document.getElementById("canvasGrid");
    canvas.innerHTML = `<div class="canvas-placeholder" id="canvasPlaceholder">拖拽组件到这里</div>`;
    activeCharts = {};
    resetChartDrillState();

    applyLoadedDataset({
        all_columns: data.all_columns,
        numeric_columns: data.numeric_columns,
        filename: data.filename,
        filesize: data.filesize,
        raw_data_html: data.raw_data_html,
        mapped_columns: data.mapped_columns,
        msg: "上传成功 ✓",
        clearCanvas: false,
        resetLookup: true,
        skipDashboardMetrics: true
    });
    openColumnMappingModalAfterUpload(data);
});

/** ========== 智能表格「科目」穿透 → 底部原始数据筛选 ========== */
function ensureRawDataPanelOpen() {
    const panel = document.getElementById("rawDataContent");
    const icon = document.getElementById("panelIcon");
    if (panel && !panel.classList.contains("open")) {
        panel.classList.add("open");
        if (icon) icon.style.transform = "rotate(180deg)";
        requestAnimationFrame(() => syncMultiDimSummaryLayoutAfterBody());
    }
}

function clearRawDataSubjectFilter(opts) {
    const silent = opts && opts.silent === true;
    const toolbar = document.getElementById("rawDataDrillToolbar");
    const label = document.getElementById("rawDataDrillLabel");
    if (toolbar) toolbar.classList.add("hidden");
    if (label) label.textContent = "";
    if (silent) return;
    const container = document.getElementById("rawDataContainer");
    if (!container) return;
    if (rawDataTableOriginalHtml) {
        container.innerHTML = rawDataTableOriginalHtml;
    } else {
        container.querySelectorAll("tbody tr").forEach((tr) => {
            tr.style.display = "";
        });
    }
}

function normalizeCellText(s) {
    return String(s || "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function filterRawDataBySubjectColumn(columnName, filterValue) {
    const container = document.getElementById("rawDataContainer");
    if (!container) return;
    const fv = normalizeCellText(filterValue);
    if (!fv) return;

    if (!rawDataTableOriginalHtml) {
        rawDataTableOriginalHtml = container.innerHTML;
    } else {
        container.innerHTML = rawDataTableOriginalHtml;
    }

    const table = container.querySelector("table");
    if (!table) {
        alert("当前没有可筛选的原始数据表。");
        return;
    }

    const headerRow = table.querySelector("thead tr");
    if (!headerRow) return;

    const headers = [...headerRow.querySelectorAll("th")].map((th) =>
        normalizeCellText(th.textContent)
    );
    let colIdx = headers.findIndex((h) => h === normalizeCellText(columnName));
    if (colIdx < 0) {
        colIdx = headers.findIndex((h) => h.includes("科目"));
    }
    if (colIdx < 0) {
        alert(
            "原始数据表中未找到与「" +
                columnName +
                "」或「科目」对应的列，无法穿透筛选。"
        );
        return;
    }

    const bodyRows = table.querySelectorAll("tbody tr");
    let shown = 0;
    bodyRows.forEach((tr) => {
        const cells = tr.querySelectorAll("td");
        const cell = cells[colIdx];
        const text = normalizeCellText(cell ? cell.textContent : "");
        const match = text === fv;
        tr.style.display = match ? "" : "none";
        if (match) shown += 1;
    });

    const toolbar = document.getElementById("rawDataDrillToolbar");
    const label = document.getElementById("rawDataDrillLabel");
    if (toolbar) toolbar.classList.remove("hidden");
    if (label) {
        label.textContent =
            "穿透筛选：" +
            columnName +
            " = 「" +
            fv +
            "」 · 显示 " +
            shown +
            " / " +
            bodyRows.length +
            " 行";
    }

    ensureRawDataPanelOpen();
    const tip = document.getElementById("statusTip");
    if (tip) {
        tip.innerText =
            "已根据智能表格中的科目穿透筛选底部原始数据（" + shown + " 行）。";
    }
}

function initSmartTableSubjectDrillDelegation() {
    const grid = document.getElementById("canvasGrid");
    if (!grid || grid.dataset.subjectDrillBound === "1") return;
    grid.dataset.subjectDrillBound = "1";
    grid.addEventListener("click", (ev) => {
        const cell = ev.target.closest(".smart-drill-cell");
        if (!cell || !grid.contains(cell)) return;
        const column = cell.getAttribute("data-drill-column");
        const value = cell.getAttribute("data-drill-value");
        if (!column) return;
        ev.preventDefault();
        filterRawDataBySubjectColumn(column, value || "");
    });
}

/** 上传 / 模板示例 / 手动 JSON 共用：写入列信息与原始数据面板 */
function applyLoadedDataset({
    all_columns,
    numeric_columns,
    filename,
    filesize,
    raw_data_html,
    msg,
    mapped_columns,
    clearCanvas = false,
    resetLookup = true,
    skipDashboardMetrics = false
}) {
    if (resetLookup) {
        resetVlookupClientState();
    }
    allColumns = all_columns || [];
    numericColumns = numeric_columns || [];
    syncMappedColumnsAfterDatasetLoad(allColumns, mapped_columns);
    currentFileLoaded = true;

    document.getElementById("uploadBox").style.display = "none";
    document.getElementById("fileCard").style.display = "flex";
    document.getElementById("fileName").innerText = filename || "";
    const fsEl = document.getElementById("fileSize");
    if (fsEl) {
        fsEl.textContent =
            filesize != null && filesize !== "" ? `${filesize} KB` : "";
    }
    document.getElementById("componentSection").style.display = "block";
    syncRawDataPanelWithReportModules();
    if (raw_data_html) {
        const rc = document.getElementById("rawDataContainer");
        rc.innerHTML = raw_data_html;
        rawDataTableOriginalHtml = raw_data_html;
        clearRawDataSubjectFilter({ silent: true });
    }
    document.getElementById("statusTip").innerText = msg || "就绪";

    const dateBar = document.getElementById("dateFilterBar");
    if (dateBar) dateBar.classList.remove("hidden");

    if (clearCanvas) {
        resetChartDrillState();
        const canvas = document.getElementById("canvasGrid");
        canvas.innerHTML = `<div class="canvas-placeholder" id="canvasPlaceholder">拖拽组件到这里</div>`;
        activeCharts = {};
    }

    showVlookupSection();
    populateVlookupMainSelects();
    if (!resetLookup && lookupAllColumns.length) {
        populateVlookupLookupSelects();
    }
    if (skipDashboardMetrics) {
        setKpiPendingMappingPlaceholder();
    }
    if (!skipDashboardMetrics) {
        void refreshDashboardMetrics().then(() => syncKpiPlaceholderUi());
    } else {
        syncKpiPlaceholderUi();
    }
    applyDockKpiDisplayMode();
    requestAnimationFrame(() => {
        measureAndApplyDockLayout();
        applyReportModuleVisibility();
    });
    syncExportCenterUi();
}

/**
 * 页面刷新后从服务端恢复 GLOBAL_DATA（与 data_store.json / 启动加载一致）。
 * 不修改布局算法；仅补齐与上传成功相同的前端状态并交给 loadDashboard 画图表。
 */
async function restorePersistedSession() {
    try {
        const res = await fetch("/api/session-restore");
        const data = await res.json();
        if (data.status !== "success" || !data.has_data) return;

        if (Array.isArray(data.lookup_all_columns) && data.lookup_all_columns.length) {
            lookupAllColumns = data.lookup_all_columns;
            lookupNumericColumns = Array.isArray(data.lookup_numeric_columns)
                ? data.lookup_numeric_columns
                : [];
        }

        applyLoadedDataset({
            all_columns: data.all_columns,
            numeric_columns: data.numeric_columns,
            filename: data.filename,
            filesize: data.filesize,
            raw_data_html: data.raw_data_html,
            mapped_columns: data.mapped_columns,
            msg: "已从服务端恢复会话",
            clearCanvas: false,
            resetLookup: !(data.lookup_all_columns && data.lookup_all_columns.length),
            skipDashboardMetrics: false
        });

        if (data.lookup_all_columns && data.lookup_all_columns.length) {
            populateVlookupLookupSelects(lookupAllColumns, lookupNumericColumns);
            populateVlookupMainSelects();
            const box = document.getElementById("lookupUploadBox");
            const card = document.getElementById("lookupFileCard");
            const nameEl = document.getElementById("lookupFileName");
            if (box) box.style.display = "none";
            if (card) card.style.display = "flex";
            if (nameEl) nameEl.innerText = data.lookup_filename || "参考表";
        }

        const tip = document.getElementById("statusTip");
        if (tip) tip.style.color = "#10b981";
    } catch (e) {
        console.warn("[restorePersistedSession]", e);
    }
}

function applyDatasetColumnsFromMetricsResponse(data) {
    if (!data || typeof data !== "object") return;
    if (!data.all_columns || !Array.isArray(data.all_columns)) return;
    allColumns = data.all_columns;
    numericColumns = Array.isArray(data.numeric_columns) ? data.numeric_columns : [];
    syncMappedColumnsAfterDatasetLoad(allColumns, data.mapped_columns);
    populateVlookupMainSelects();
    if (data.raw_data_html) {
        const rc = document.getElementById("rawDataContainer");
        if (rc) {
            rc.innerHTML = data.raw_data_html;
            rawDataTableOriginalHtml = data.raw_data_html;
            clearRawDataSubjectFilter({ silent: true });
        }
    }
}

function syncExportCenterUi() {
    const needData = document.querySelectorAll(".toolbar-export-center [data-requires-dataset]");
    needData.forEach((el) => {
        if (!currentFileLoaded) {
            el.classList.add("disabled");
            el.setAttribute("aria-disabled", "true");
        } else {
            el.classList.remove("disabled");
            el.removeAttribute("aria-disabled");
        }
    });
}

async function fetchReportTemplates() {
    const sel = document.getElementById("reportTemplateSelect");
    if (!sel) return;
    try {
        const res = await fetch("/api/templates");
        const data = await res.json();
        if (data.status !== "success" || !Array.isArray(data.templates)) return;
        sel.innerHTML = data.templates
            .map(
                (t) =>
                    `<option value="${String(t.id).replace(/"/g, "&quot;")}" title="${(t.description || "").replace(/"/g, "&quot;")}">${t.name}</option>`
            )
            .join("");
    } catch (e) {
        console.error(e);
    }
}

function getSelectedTemplateId() {
    const sel = document.getElementById("reportTemplateSelect");
    if (!sel || !sel.value) return "sales_hierarchical";
    return sel.value;
}

async function loadTemplateSampleData() {
    const templateId = getSelectedTemplateId();
    document.getElementById("statusTip").innerText = "载入示例…";
    const res = await fetch("/api/load-template-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_id: templateId })
    });
    const data = await res.json();
    if (data.status !== "success") return alert(data.msg || "载入失败");

    applyLoadedDataset({
        all_columns: data.all_columns,
        numeric_columns: data.numeric_columns,
        filename: data.filename || templateId,
        raw_data_html: data.raw_data_html,
        mapped_columns: data.mapped_columns,
        msg: data.msg || "已载入模板示例",
        clearCanvas: true
    });
}

async function submitManualJson() {
    const raw = document.getElementById("manualJsonInput")?.value?.trim();
    if (!raw) return alert("请输入 JSON 数组");
    let rows;
    try {
        rows = JSON.parse(raw);
    } catch (e) {
        return alert("JSON 格式无效");
    }
    if (!Array.isArray(rows) || rows.length === 0) {
        return alert("请输入对象数组，例如 [{\"列\": \"值\"}]");
    }

    document.getElementById("statusTip").innerText = "载入手动数据…";
    const res = await fetch("/api/session-manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, label: "(手动录入)" })
    });
    const data = await res.json();
    if (data.status !== "success") return alert(data.msg || "失败");

    applyLoadedDataset({
        all_columns: data.all_columns,
        numeric_columns: data.numeric_columns,
        filename: "(手动录入)",
        raw_data_html: data.raw_data_html,
        mapped_columns: data.mapped_columns,
        msg: data.msg || "已载入手动数据",
        clearCanvas: true
    });
}

// ================= 日期特征筛选（星期 / 区间 → filter_config） =================
function buildFilterConfigFromUi() {
    const fc = {};
    const chips = document.querySelectorAll("#weekdaySelector .weekday-chip");
    const selected = [];
    chips.forEach((btn) => {
        if (btn.getAttribute("aria-pressed") === "true") {
            selected.push(parseInt(btn.dataset.weekday, 10));
        }
    });
    if (selected.length > 0 && selected.length < 7) {
        fc.weekdays = selected;
    }
    const start = document.getElementById("dateFilterStart")?.value;
    const end = document.getElementById("dateFilterEnd")?.value;
    if (start || end) {
        fc.date_range = {};
        if (start) fc.date_range.start = start;
        if (end) fc.date_range.end = end;
    }
    return Object.keys(fc).length ? fc : null;
}

function buildFullFilterConfig() {
    const fc = buildFilterConfigFromUi() || {};
    if (globalDrillCategory && globalDrillCategory.column) {
        fc.category_dimension = {
            column: globalDrillCategory.column,
            value: globalDrillCategory.value
        };
    }
    return Object.keys(fc).length ? fc : null;
}

function escapeHtmlDetail(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function updateChartDrillToolbar() {
    const bar = document.getElementById("chartDrillToolbar");
    const sum = document.getElementById("chartDrillSummary");
    if (!bar || !sum) return;
    if (globalDrillCategory && globalDrillCategory.column) {
        bar.classList.remove("hidden");
        sum.textContent = `图表联动：「${globalDrillCategory.column}」= ${String(globalDrillCategory.value ?? "")}`;
    } else {
        bar.classList.add("hidden");
        sum.textContent = "";
    }
}

function resetChartDrillState() {
    globalDrillCategory = null;
    updateChartDrillToolbar();
    const el = document.getElementById("detailModal");
    if (el && typeof bootstrap !== "undefined" && bootstrap.Modal) {
        const inst = bootstrap.Modal.getInstance(el);
        if (inst) inst.hide();
    }
}

function extractPlotlyCategoryFromClick(card, ev) {
    const xcol = card.dataset.chartX;
    if (!xcol) return null;
    const pts = ev.points || [];
    if (!pts.length) return null;
    const pt = pts[0];
    const chartType = (card.dataset.chartType || "").toLowerCase();
    let raw;
    if (chartType === "pie") {
        raw = pt.label !== undefined && pt.label !== null ? pt.label : pt.x;
    } else {
        raw = pt.x !== undefined && pt.x !== null ? pt.x : pt.label;
    }
    if (raw === undefined || raw === null) {
        const labels = pt.data && pt.data.labels;
        const idx = pt.pointNumber;
        if (Array.isArray(labels) && idx != null && labels[idx] !== undefined) {
            raw = labels[idx];
        }
    }
    if (raw === undefined || raw === null) return null;
    return { column: xcol, value: raw };
}

function bindPlotlyDrillForCard(card) {
    const inner = card.querySelector(".canvas-inner");
    if (!inner || !inner.id || card.dataset.smartTable === "1") return;
    const gd = document.getElementById(inner.id);
    if (!gd || !window.Plotly) return;
    if (card._plotlyDrillHandler && typeof gd.removeListener === "function") {
        gd.removeListener("plotly_click", card._plotlyDrillHandler);
        card._plotlyDrillHandler = null;
    }
    const handler = (ev) => {
        void (async () => {
            if (!currentFileLoaded || presentationMode) return;
            const picked = extractPlotlyCategoryFromClick(card, ev);
            if (!picked) return;
            globalDrillCategory = picked;
            updateChartDrillToolbar();
            await refreshDashboardWithDateFilter();
            await openDetailModalFromFilters();
        })();
    };
    card._plotlyDrillHandler = handler;
    gd.on("plotly_click", handler);
}

async function openDetailModalFromFilters() {
    const modalEl = document.getElementById("detailModal");
    const thead = document.getElementById("detailModalHead");
    const tbody = document.getElementById("detailModalBody");
    const metaEl = document.getElementById("detailModalMeta");
    const titleEl = document.getElementById("detailModalLabel");
    if (!modalEl || !thead || !tbody) return;
    if (titleEl) {
        titleEl.textContent = globalDrillCategory
            ? `明细 · ${globalDrillCategory.column}`
            : "分类明细";
    }
    tbody.innerHTML =
        '<tr><td colspan="99" class="text-muted p-3">加载中…</td></tr>';
    thead.innerHTML = "";
    if (metaEl) {
        metaEl.textContent = globalDrillCategory
            ? `筛选：「${globalDrillCategory.column}」= ${String(globalDrillCategory.value ?? "")} · 与上方星期/日期区间同时生效`
            : "";
    }

    const fc = buildFullFilterConfig();
    try {
        const res = await fetch("/api/get-details", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filter_config: fc })
        });
        const data = await res.json();
        if (data.status !== "success") {
            tbody.innerHTML = `<tr><td class="text-danger p-3">${escapeHtmlDetail(data.msg || "加载失败")}</td></tr>`;
        } else {
            const cols = data.columns || [];
            thead.innerHTML = `<tr>${cols
                .map((c) => `<th scope="col">${escapeHtmlDetail(c)}</th>`)
                .join("")}</tr>`;
            const rows = data.rows || [];
            if (!rows.length) {
                tbody.innerHTML = `<tr><td class="text-muted p-3">无匹配行</td></tr>`;
            } else {
                tbody.innerHTML = rows
                    .map((r) => {
                        const tds = cols.map((c) => {
                            const v = r[c];
                            let disp =
                                v === null || v === undefined ? "" : v;
                            if (typeof disp === "object") {
                                try {
                                    disp = JSON.stringify(disp);
                                } catch (e) {
                                    disp = String(disp);
                                }
                            }
                            return `<td>${escapeHtmlDetail(String(disp))}</td>`;
                        });
                        return `<tr>${tds.join("")}</tr>`;
                    })
                    .join("");
            }
            if (metaEl) {
                metaEl.textContent = `共 ${data.row_count ?? rows.length} 行 · 与上方星期/日期区间同时生效`;
            }
        }
    } catch (e) {
        console.error(e);
        tbody.innerHTML =
            '<tr><td class="text-danger p-3">网络错误</td></tr>';
    }
    if (typeof bootstrap !== "undefined" && bootstrap.Modal) {
        bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }
}

function formatDateFilterSummary(fc) {
    if (!fc || Object.keys(fc).length === 0) {
        return "当前仅看：全部数据（未限定星期与区间）";
    }
    const parts = [];
    if (fc.weekdays && fc.weekdays.length) {
        const names = [...fc.weekdays]
            .sort((a, b) => a - b)
            .map((d) => DATE_FILTER_WEEKDAY_NAMES[d] || String(d));
        parts.push(names.join("、"));
    }
    if (fc.date_range && (fc.date_range.start || fc.date_range.end)) {
        parts.push(
            `区间 ${fc.date_range.start || "…"} ~ ${fc.date_range.end || "…"}`
        );
    }
    return "当前仅看：" + parts.join(" · ");
}

function updateDateFilterSummary() {
    const el = document.getElementById("dateFilterSummary");
    if (!el) return;
    el.textContent = formatDateFilterSummary(buildFilterConfigFromUi());
}

function resetDateFilterUiOnly() {
    document.querySelectorAll("#weekdaySelector .weekday-chip").forEach((btn) => {
        btn.setAttribute("aria-pressed", "true");
    });
    const s = document.getElementById("dateFilterStart");
    const e = document.getElementById("dateFilterEnd");
    if (s) s.value = "";
    if (e) e.value = "";
    updateDateFilterSummary();
}

function scheduleDateFilterRefresh() {
    updateDateFilterSummary();
    if (!currentFileLoaded) return;
    if (dateFilterRefreshTimer) clearTimeout(dateFilterRefreshTimer);
    dateFilterRefreshTimer = setTimeout(() => {
        dateFilterRefreshTimer = null;
        refreshDashboardWithDateFilter();
    }, 200);
}

const _biSalesFmt = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const _biCountFmt = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });

function _escapeHtmlBi(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
}

/** 多维汇总表滚动区：随内容增高，硬上限避免占满视窗 */
const MULTI_DIM_TABLE_WRAP_MIN = 56;
const MULTI_DIM_TABLE_WRAP_MAX = 420;
const MULTI_DIM_RAW_PANEL_MAX = 720;

/**
 * 在 syncMultiDimSummaryBody 等更新 tbody 后调用：按表格实际高度收紧/放宽 .multi-dim-summary-table-wrap。
 * 若多维汇总位于某 .dashboard-dock-widget 内，则同步该块高度并 finalize 以便下方块上吸；
 * 否则在原始数据面板展开时放宽 #rawDataContent 的 max-height（仍受 MULTI_DIM_RAW_PANEL_MAX 约束）。
 */
function syncMultiDimSummaryLayoutAfterBody() {
    const table = document.getElementById("biMultiDimSummaryTable");
    const wrap = document.querySelector("#multiDimSummaryWrap .multi-dim-summary-table-wrap");
    if (!table || !wrap) return;

    const capTable = Math.min(
        MULTI_DIM_TABLE_WRAP_MAX,
        Math.max(MULTI_DIM_TABLE_WRAP_MIN, Math.round(window.innerHeight * 0.48))
    );
    wrap.style.maxHeight = "none";
    const natural = table.offsetHeight;
    const tableWrapH = Math.min(capTable, Math.max(MULTI_DIM_TABLE_WRAP_MIN, natural + 8));
    wrap.style.maxHeight = `${Math.round(tableWrapH)}px`;

    const anchor = document.getElementById("multiDimSummaryWrap");
    const dockWidget = anchor?.closest(".dashboard-dock-widget");
    if (dockWidget && dockWidget.dataset.dockId) {
        requestAnimationFrame(() => {
            const dragZone = dockWidget.querySelector(".dashboard-dock-drag-zone");
            const resizer = dockWidget.querySelector("[data-dock-resize]");
            const bodyEl = dockWidget.querySelector(".dashboard-dock-widget-body");
            if (!bodyEl) return;
            const innerScrollH = bodyEl.scrollHeight;
            const chrome = (dragZone?.offsetHeight || 0) + (resizer?.offsetHeight || 0) + 12;
            const maxDock = Math.min(Math.round(window.innerHeight * 0.92), 900);
            const nextH = Math.min(maxDock, Math.max(DOCK_MIN.H, Math.round(innerScrollH + chrome)));
            dockWidget.style.height = `${nextH}px`;
            finalizeDockCompactAndSave();
        });
        return;
    }

    const panel = document.getElementById("rawDataContent");
    if (panel && panel.classList.contains("open")) {
        requestAnimationFrame(() => {
            const capPanel = Math.min(MULTI_DIM_RAW_PANEL_MAX, Math.round(window.innerHeight * 0.88));
            const needed = Math.ceil(panel.scrollHeight) + 16;
            panel.style.maxHeight = `${Math.min(capPanel, Math.max(400, needed))}px`;
        });
    }
}

function syncMultiDimSummaryBody(data) {
    const tbody = document.getElementById("biMultiDimSummaryBody");
    if (!tbody) return;
    const rows = data && Array.isArray(data.multi_dim_summary) ? data.multi_dim_summary : [];
    if (!rows.length) {
        tbody.innerHTML =
            '<tr class="text-secondary"><td colspan="4" class="small py-2 px-2">当前筛选下暂无维度汇总，请先确认列映射</td></tr>';
        syncMultiDimSummaryLayoutAfterBody();
        return;
    }
    tbody.innerHTML = rows
        .map(
            (r) =>
                `<tr><td>${_escapeHtmlBi(r.name)}</td><td class="text-end" style="font-variant-numeric:tabular-nums">${_biSalesFmt.format(
                    Math.round(Number(r.total_sales) || 0)
                )}</td><td class="text-end" style="font-variant-numeric:tabular-nums">${_biSalesFmt.format(
                    Math.round(Number(r.avg_sales) || 0)
                )}</td><td class="text-end" style="font-variant-numeric:tabular-nums">${_biCountFmt.format(
                    Number(r.row_count) || 0
                )}</td></tr>`
        )
        .join("");
    syncMultiDimSummaryLayoutAfterBody();
}

function syncKpiPlaceholderUi() {
    const kpiRoot = document.querySelector('[data-dock-id="dock-kpi"]');
    const ids = ["biStatTotalSales", "biStatMom", "biStatOrders", "biStatWarnings"];
    if (currentFileLoaded) {
        if (kpiRoot) kpiRoot.classList.remove("dashboard-dock-widget--kpi-empty");
        ids.forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.classList.remove("bi-stat-value--placeholder");
        });
        return;
    }
    if (kpiRoot) {
        kpiRoot.classList.toggle(
            "dashboard-dock-widget--kpi-empty",
            !currentFileLoaded && !isKpiDockSuppressed()
        );
    }
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (!currentFileLoaded && !isKpiDockSuppressed()) {
            el.textContent = "待上传";
            el.className = "bi-stat-value bi-stat-value--placeholder";
        } else if (!currentFileLoaded) {
            el.textContent = "—";
            el.className = "bi-stat-value";
        }
    });
}

function resetBiDashboardUi() {
    const tbody = document.getElementById("biProvinceRankBody");
    if (tbody) {
        tbody.innerHTML =
            '<tr class="text-secondary"><td colspan="3" class="small py-4 px-3">上传数据后将按「省 / 区域」列与销售额类数值列自动汇总</td></tr>';
    }
    const mdBody = document.getElementById("biMultiDimSummaryBody");
    if (mdBody) {
        mdBody.innerHTML =
            '<tr class="text-secondary"><td colspan="4" class="small py-2 px-2">应用列映射后将按维度汇总</td></tr>';
    }
    syncMultiDimSummaryLayoutAfterBody();
    restoreDefaultReportTitles();
    syncKpiPlaceholderUi();
}

function setKpiPendingMappingPlaceholder() {
    const ids = ["biStatTotalSales", "biStatMom", "biStatOrders", "biStatWarnings"];
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = "—";
        el.className = "bi-stat-value";
    });
    const tbody = document.getElementById("biProvinceRankBody");
    if (tbody) {
        tbody.innerHTML =
            '<tr class="text-secondary"><td colspan="3" class="small py-3 px-3">请在弹窗中选择列映射后点击「确认分析」</td></tr>';
    }
    const mdBody = document.getElementById("biMultiDimSummaryBody");
    if (mdBody) {
        mdBody.innerHTML =
            '<tr class="text-secondary"><td colspan="4" class="small py-2 px-2">请在弹窗中选择列映射后点击「确认分析」</td></tr>';
    }
    syncMultiDimSummaryLayoutAfterBody();
}

function applyDashboardMetricsFromResponse(data) {
    if (!data || data.status !== "success") return false;

    const ts = document.getElementById("biStatTotalSales");
    const momEl = document.getElementById("biStatMom");
    const ord = document.getElementById("biStatOrders");
    const warn = document.getElementById("biStatWarnings");
    if (ts) ts.textContent = _biSalesFmt.format(Math.round(Number(data.total_sales) || 0));

    if (momEl) {
        const raw = data.mom_growth_pct;
        if (raw == null || raw === "") {
            momEl.textContent = "—";
            momEl.className = "bi-stat-value";
        } else {
            const v = Number(raw);
            const sign = v > 0 ? "+" : "";
            momEl.textContent = `${sign}${v.toFixed(1)}%`;
            momEl.className =
                "bi-stat-value " + (v >= 0 ? "bi-stat-value--up" : "bi-stat-value--down");
        }
    }
    if (ord) ord.textContent = _biCountFmt.format(Number(data.order_count) || 0);
    if (warn) warn.textContent = _biCountFmt.format(Number(data.warning_count) || 0);

    const tbody = document.getElementById("biProvinceRankBody");
    if (tbody) {
        const rows = data.province_ranking || [];
        if (!rows.length) {
            tbody.innerHTML =
                '<tr class="text-secondary"><td colspan="3" class="small py-3 px-3">当前筛选下未识别到「省份/区域」与销售额列，或暂无数据</td></tr>';
        } else {
            tbody.innerHTML = rows
                .map(
                    (r, i) =>
                        `<tr><td class="text-muted">${i + 1}</td><td>${_escapeHtmlBi(
                            r.name
                        )}</td><td class="text-end" style="font-variant-numeric:tabular-nums">${_biSalesFmt.format(
                            Math.round(Number(r.sales) || 0)
                        )}</td></tr>`
                )
                .join("");
        }
    }
    updateReportTitlesFromDimension(data.meta);
    syncMultiDimSummaryBody(data);
    return true;
}

function updateMappingConfirmButtonState() {
    const d = document.getElementById("mapSelectDate")?.value;
    const v = document.getElementById("mapSelectValue")?.value;
    const dim = document.getElementById("mapSelectDim")?.value;
    const btn = document.getElementById("btnMappingConfirm");
    if (!btn) return;
    btn.disabled = !(d && v && dim);
}

/**
 * 填充列映射弹窗（上传后与管理字段入口共用）。
 * @param {Object} columnPayload — all_columns, numeric_columns, mapped_columns, column_mapping_suggestion 或顶层 mapped_* 。
 * @param {string} [hintHtml] — 顶部说明 HTML；省略则不改动。
 */
function populateColumnMappingModalUi(columnPayload, hintHtml) {
    const hint = document.getElementById("mappingModalFileHint");
    if (hint && hintHtml) {
        hint.innerHTML = hintHtml;
    }
    const allCols = columnPayload.all_columns || [];
    const numCols =
        Array.isArray(columnPayload.numeric_columns) && columnPayload.numeric_columns.length
            ? columnPayload.numeric_columns
            : allCols;
    const sug = columnPayload.column_mapping_suggestion || {
        mapped_date_col: columnPayload.mapped_date_col,
        mapped_value_col: columnPayload.mapped_value_col,
        mapped_dim_col: columnPayload.mapped_dim_col
    };

    fillOptionSelect(document.getElementById("mapSelectDate"), allCols, "选择日期 / 时间列");
    fillOptionSelect(document.getElementById("mapSelectValue"), numCols, "选择指标数值列");
    fillOptionSelect(document.getElementById("mapSelectDim"), allCols, "选择分类维度列");

    const sd = document.getElementById("mapSelectDate");
    const sv = document.getElementById("mapSelectValue");
    const sdim = document.getElementById("mapSelectDim");
    const pick = (sel, val) => {
        if (!sel || !val) return;
        if ([...sel.options].some((o) => o.value === val)) sel.value = val;
    };
    pick(sd, sug.mapped_date_col);
    pick(sv, sug.mapped_value_col);
    pick(sdim, sug.mapped_dim_col);

    syncMappedColumnsAfterDatasetLoad(allCols, columnPayload.mapped_columns);
    ensureMappingTripletSwitchesOn();
    updateMappingConfirmButtonState();
}

function openColumnMappingModalAfterUpload(data) {
    const fnSafe = _escapeHtmlBi(data.filename || "");
    const sz = data.filesize != null ? ` · ${_escapeHtmlBi(String(data.filesize))} KB` : "";
    const hintHtml = `当前文件：<strong>${fnSafe}</strong>${sz}。请选择用于趋势、指标与排名的列，并可在下方调整列顺序与显示。`;
    populateColumnMappingModalUi(
        {
            all_columns: data.all_columns,
            numeric_columns: data.numeric_columns,
            mapped_columns: data.mapped_columns,
            column_mapping_suggestion: data.column_mapping_suggestion
        },
        hintHtml
    );
    mappingModalConfirmed = false;
    const modalEl = document.getElementById("mappingModal");
    if (modalEl && typeof bootstrap !== "undefined") {
        bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }
}

async function openColumnMappingModalFromToolbar() {
    if (!currentFileLoaded) {
        alert("请先上传或载入主表数据");
        return;
    }
    const tip = document.getElementById("statusTip");
    try {
        const res = await fetch("/api/column-mapping-state");
        const d = await res.json();
        if (d.status !== "success") {
            if (tip) tip.innerText = d.msg || "无法加载列配置";
            return alert(d.msg || "无法加载列配置");
        }
        const fnSafe = _escapeHtmlBi(d.filename || "");
        const sz = d.filesize != null ? ` · ${_escapeHtmlBi(String(d.filesize))} KB` : "";
        const hintHtml = `当前主表：<strong>${fnSafe}</strong>${sz}。可从服务端同步列顺序与显示状态（含已隐藏的列）；确认后将更新原始数据表与看板。`;
        populateColumnMappingModalUi(
            {
                all_columns: d.all_columns,
                numeric_columns: d.numeric_columns,
                mapped_columns: d.mapped_columns,
                mapped_date_col: d.mapped_date_col,
                mapped_value_col: d.mapped_value_col,
                mapped_dim_col: d.mapped_dim_col
            },
            hintHtml
        );
        mappingModalConfirmed = false;
        const modalEl = document.getElementById("mappingModal");
        if (modalEl && typeof bootstrap !== "undefined") {
            bootstrap.Modal.getOrCreateInstance(modalEl).show();
        }
        if (tip) tip.innerText = "列配置已加载，可编辑后确认";
    } catch (e) {
        console.error(e);
        if (tip) tip.innerText = "加载列配置失败";
        alert("网络错误");
    }
}

async function confirmColumnMappingAnalysis() {
    const md = document.getElementById("mapSelectDate")?.value;
    const mv = document.getElementById("mapSelectValue")?.value;
    const mdm = document.getElementById("mapSelectDim")?.value;
    if (!md || !mv || !mdm) return;
    const visNames = new Set(mappedColumns.filter((o) => o.visible).map((o) => o.name));
    if (!visNames.has(md) || !visNames.has(mv) || !visNames.has(mdm)) {
        return alert("日期、数值、维度三列必须在下方列表中保持「显示」开启。");
    }
    const fc = buildFullFilterConfig();
    const tip = document.getElementById("statusTip");
    if (tip) tip.innerText = "正在应用列映射并刷新看板…";
    try {
        const res = await fetch("/api/dashboard-metrics", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                filter_config: fc,
                mapped_date_col: md,
                mapped_value_col: mv,
                mapped_dim_col: mdm,
                mapped_columns: mappedColumns.map((o) => ({ name: o.name, visible: !!o.visible }))
            })
        });
        const data = await res.json();
        if (data.status !== "success") {
            if (tip) tip.innerText = data.msg || "应用失败";
            return alert(data.msg || "应用失败");
        }
        mappingModalConfirmed = true;
        applyDatasetColumnsFromMetricsResponse(data);
        applyDashboardMetricsFromResponse(data);
        syncKpiPlaceholderUi();
        const kpiDockEarly = document.querySelector('[data-dock-id="dock-kpi"]');
        if (kpiDockEarly && kpiDockEarly.style.display !== "none") {
            bringDockWidgetToFront(kpiDockEarly);
        }
        await refreshDashboardWithDateFilter({ skipMetrics: true });
        await refreshDashboardMetrics();
        const mEl = document.getElementById("mappingModal");
        const afterModalForKpiFocus = () => bringKpiDockToFrontWithMetricsFlash();
        if (mEl && typeof bootstrap !== "undefined") {
            const inst = bootstrap.Modal.getInstance(mEl);
            if (inst && mEl.classList.contains("show")) {
                mEl.addEventListener("hidden.bs.modal", afterModalForKpiFocus, { once: true });
                inst.hide();
            } else {
                requestAnimationFrame(() => requestAnimationFrame(afterModalForKpiFocus));
            }
        } else {
            requestAnimationFrame(() => requestAnimationFrame(afterModalForKpiFocus));
        }
        if (tip) tip.innerText = "列映射已应用，看板已更新";
    } catch (e) {
        console.error(e);
        if (tip) tip.innerText = "请求失败";
        alert("网络错误");
    }
}

function initColumnMappingModal() {
    const el = document.getElementById("mappingModal");
    if (!el || typeof bootstrap === "undefined") return;
    el.addEventListener("show.bs.modal", () => {
        const mc = el.querySelector(".modal-content");
        if (mc) {
            mc.setAttribute(
                "data-bs-theme",
                document.body.getAttribute("data-theme") === "dark" ? "dark" : "light"
            );
        }
    });
    el.addEventListener("hidden.bs.modal", () => {
        if (!mappingModalConfirmed && currentFileLoaded) {
            void refreshDashboardMetrics().then(() => syncKpiPlaceholderUi());
            void refreshDashboardWithDateFilter();
        }
        mappingModalConfirmed = false;
    });
    document.getElementById("btnMappingConfirm")?.addEventListener("click", () => {
        void confirmColumnMappingAnalysis();
    });
    ["mapSelectDate", "mapSelectValue", "mapSelectDim"].forEach((id) => {
        document.getElementById(id)?.addEventListener("change", () => {
            updateMappingConfirmButtonState();
            const mm = document.getElementById("mappingModal");
            if (mm && mm.classList.contains("show")) {
                ensureMappingTripletSwitchesOn();
            }
        });
    });
}

function initKpiEmptyPreferenceCheckbox() {
    const chk = document.getElementById("chkShowKpiWhenEmpty");
    if (!chk) return;
    chk.checked = getShowKpiWhenEmpty();
    chk.addEventListener("change", () => {
        try {
            localStorage.setItem(DASHBOARD_SHOW_KPI_EMPTY_KEY, chk.checked ? "1" : "0");
        } catch (e) {
            /* ignore */
        }
        measureAndApplyDockLayout();
        applyReportModuleVisibility();
        syncKpiPlaceholderUi();
        saveLayout();
        requestAnimationFrame(() => {
            dispatchWindowResize();
        });
    });
}

async function refreshDashboardMetrics(extraBody) {
    if (!currentFileLoaded) return;
    const fc = buildFullFilterConfig();
    const body = Object.assign(
        { filter_config: fc },
        extraBody && typeof extraBody === "object" ? extraBody : {}
    );
    try {
        const res = await fetch("/api/dashboard-metrics", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        applyDashboardMetricsFromResponse(data);
    } catch (e) {
        console.error(e);
    }
}

async function refreshDashboardWithDateFilter(opts) {
    if (!opts || !opts.skipMetrics) {
        await refreshDashboardMetrics();
    }
    const grid = document.getElementById("canvasGrid");
    if (!grid) return;
    const fc = buildFullFilterConfig();
    if (grid.querySelector(".canvas-placeholder")) return;

    const cards = grid.querySelectorAll(".chart-card");
    for (const card of cards) {
        if (card.dataset.smartTable === "1") {
            let vis = null;
            try {
                if (card.dataset.columnVisibility) {
                    vis = JSON.parse(card.dataset.columnVisibility);
                }
            } catch (e) {
                vis = null;
            }
            await fetchAndApplySmartTable(card, card.dataset.templateId, vis);
            continue;
        }
        const ctype = card.dataset.chartType;
        const cx = card.dataset.chartX;
        let yList = [];
        try {
            yList = JSON.parse(card.dataset.chartY || "[]");
        } catch (e) {
            yList = [];
        }
        const inner = card.querySelector(".canvas-inner");
        if (!inner || !ctype || !cx || !yList.length) continue;

        const res = await fetch("/api/chart-render", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                type: ctype,
                x: cx,
                yList,
                theme: currentTheme,
                filter_config: fc
            })
        });
        const data = await res.json();
        if (data.status !== "success") continue;

        const chartObj = safeParseChart(data.chart);
        const layout = buildLayout(chartObj.layout);
        if (!layout.yaxis) layout.yaxis = {};
        layout.yaxis.autorange = true;

        if (window.Plotly) {
            await Plotly.react(inner.id, chartObj.data, layout, { responsive: true });
        }

        bindPlotlyDrillForCard(card);

        const insights = data.insights || [];
        const html = `<div class="insight-box">${insights
            .map((i) => `<div class="insight-item">• ${i}</div>`)
            .join("")}</div>`;
        const box = card.querySelector(".insight-box");
        if (box) box.outerHTML = html;
        else inner.insertAdjacentHTML("afterend", html);
    }
}

function bindWeekdayChip(btn) {
    btn.addEventListener("click", () => {
        const on = btn.getAttribute("aria-pressed") === "true";
        btn.setAttribute("aria-pressed", on ? "false" : "true");
        const anyOn = [...document.querySelectorAll("#weekdaySelector .weekday-chip")].some(
            (b) => b.getAttribute("aria-pressed") === "true"
        );
        if (!anyOn) {
            document.querySelectorAll("#weekdaySelector .weekday-chip").forEach((b) => {
                b.setAttribute("aria-pressed", "true");
            });
        }
        scheduleDateFilterRefresh();
    });
}

function initDateFilterToolbar() {
    const wrap = document.getElementById("weekdaySelector");
    if (!wrap) return;
    wrap.querySelectorAll(".weekday-chip").forEach(bindWeekdayChip);

    const start = document.getElementById("dateFilterStart");
    const end = document.getElementById("dateFilterEnd");
    const onRange = () => scheduleDateFilterRefresh();
    if (start) start.addEventListener("change", onRange);
    if (end) end.addEventListener("change", onRange);

    const resetBtn = document.getElementById("dateFilterReset");
    if (resetBtn) {
        resetBtn.addEventListener("click", () => {
            resetDateFilterUiOnly();
            scheduleDateFilterRefresh();
        });
    }
    const drillClear = document.getElementById("chartDrillClear");
    if (drillClear) {
        drillClear.addEventListener("click", () => {
            resetChartDrillState();
            scheduleDateFilterRefresh();
        });
    }
    updateDateFilterSummary();
}

// ================= 拖拽 =================
function initDrag() {
    const canvas = document.getElementById("canvasGrid");
    canvas.style.position = "relative";

    document.querySelectorAll(".component-item").forEach(el => {
        el.addEventListener("dragstart", e => {
            currentType = e.target.closest("[data-type]")?.dataset.type;
        });
    });

    canvas.addEventListener("dragover", e => e.preventDefault());
    canvas.addEventListener("drop", e => {
        e.preventDefault();
        if (!currentFileLoaded) return alert("先上传文件");
        if (currentType === "table") loadSmartTable();
        else openConfig();
    });
}

// ================= 配置弹窗 =================
function openConfig() {
    document.getElementById("chartConfigModal").style.display = "flex";
    document.getElementById("xAxis").innerHTML = allColumns.map(c => `<option>${c}</option>`).join("");
    document.getElementById("yAxis").innerHTML = numericColumns.map(c => `<option>${c}</option>`).join("");
}
function closeConfig() { document.getElementById("chartConfigModal").style.display = "none"; }
function confirmConfig() {
    const x = document.getElementById("xAxis").value;
    const y = document.getElementById("yAxis").value;
    createChart(currentType, x, [y]);
    closeConfig();
}

// ================= 创建通用卡片 =================
function createCanvasCard({
    type,
    id,
    width = "300px",
    height = "200px",
    top = "50px",
    left = "50px",
    smartTableTemplateId = null,
    chartSpec = null
}) {
    const card = document.createElement('div');
    card.className = 'chart-card';
    card.style.width = width;
    card.style.height = height;
    card.style.top = top;
    card.style.left = left;
    card.style.position = 'absolute';
    card.dataset.chartId = id;

    const header = document.createElement('div');
    header.className = 'dash-chart-header';
    const toolbar = smartTableTemplateId
        ? `<div class="dash-chart-toolbar">
            <button type="button" class="smart-table-template-btn" title="切换报表模板">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
                    <rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>
                </svg>
            </button>
            <button type="button" class="smart-table-config-btn" title="列显示配置">配置</button>
           </div>`
        : "";
    header.innerHTML = `<span class="dash-chart-type">${type}</span>${toolbar}
                        <button class="del-btn" onclick="deleteCanvasCard('${id}')">×</button>`;
    card.appendChild(header);

    const inner = document.createElement('div');
    inner.className = 'canvas-inner';
    inner.id = id;
    card.appendChild(inner);

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'dash-chart-resize-handle';
    card.appendChild(resizeHandle);

    if (smartTableTemplateId) {
        card.dataset.smartTable = "1";
        card.dataset.templateId = smartTableTemplateId;
        const tplBtn = header.querySelector(".smart-table-template-btn");
        if (tplBtn) {
            tplBtn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                openSmartTableTemplateModal(card);
            });
        }
        const cfgBtn = header.querySelector(".smart-table-config-btn");
        if (cfgBtn) {
            cfgBtn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                openSmartTableConfigModal(card);
            });
        }
    }

    if (
        chartSpec &&
        chartSpec.type &&
        chartSpec.x &&
        Array.isArray(chartSpec.yList) &&
        chartSpec.yList.length
    ) {
        card.dataset.chartType = String(chartSpec.type);
        card.dataset.chartX = String(chartSpec.x);
        card.dataset.chartY = JSON.stringify(chartSpec.yList);
    }

    makeDraggableAndResizable(card);

    return card;
}

// ================= Plotly：卡片内图表在移动/缩放后重绘 =================
function refreshPlotlyInCard(card) {
    const inner = card.querySelector(".canvas-inner");
    if (!inner || !inner.id || !activeCharts[inner.id]) return;
    const el = document.getElementById(inner.id);
    if (el && window.Plotly) Plotly.Plots.resize(el);
}

function relayoutAllPlotlyCharts() {
    if (!window.Plotly) return;
    Object.keys(activeCharts).forEach((id) => {
        if (!activeCharts[id]) return;
        const el = document.getElementById(id);
        if (el) Plotly.relayout(el, buildLayout(el.layout || {}));
    });
}

function makeDraggableAndResizable(card) {
    const header = card.querySelector('.dash-chart-header');
    const resizeHandle = card.querySelector('.dash-chart-resize-handle');

    header.addEventListener('mousedown', e => {
        if (e.target.classList.contains('del-btn')) return;
        if (e.target.closest(".dash-chart-toolbar")) return;
        cardInteraction.mode = "drag";
        cardInteraction.card = card;
        cardInteraction.startX = e.clientX;
        cardInteraction.startY = e.clientY;
        cardInteraction.startLeft = parsePx(card.style.left);
        cardInteraction.startTop = parsePx(card.style.top);
        document.body.style.userSelect = 'none';
    });

    resizeHandle.addEventListener('mousedown', e => {
        cardInteraction.mode = "resize";
        cardInteraction.card = card;
        cardInteraction.startX = e.clientX;
        cardInteraction.startY = e.clientY;
        cardInteraction.startW = card.offsetWidth;
        cardInteraction.startH = card.offsetHeight;
        cardInteraction.startLeft = parsePx(card.style.left);
        cardInteraction.startTop = parsePx(card.style.top);
        e.stopPropagation();
        document.body.style.userSelect = 'none';
    });
}

// ================= 删除卡片 =================
function deleteCanvasCard(id) {
    const el = document.querySelector(`[data-chart-id="${id}"]`);
    if (el) el.remove();
    delete activeCharts[id];
}

// ================= 创建图表 =================
async function createChart(type, x, yList) {
    const filterConfig = buildFullFilterConfig();
    const res = await fetch("/add-chart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            type,
            x,
            yList,
            theme: currentTheme,
            filter_config: filterConfig
        })
    });
    const data = await res.json();
    if (data.status !== "success") return alert("失败");

    const chartMeta = data.chart;
    const chartObj = safeParseChart(chartMeta.chart);
    const id = chartMeta.id;
    const canvas = document.getElementById("canvasGrid");

    const placeholder = canvas.querySelector(".canvas-placeholder");
    if (placeholder) placeholder.remove();

    const div = createCanvasCard({
        type,
        id,
        top: "20px",
        left: "20px",
        chartSpec: { type: chartMeta.type, x: chartMeta.x, yList: chartMeta.y }
    });
    const insights = data.insights || [];
    div.querySelector(".canvas-inner").insertAdjacentHTML(
        "afterend",
        `<div class="insight-box">${insights.map((i) => `<div class="insight-item">• ${i}</div>`).join("")}</div>`
    );

    canvas.appendChild(div);

    const layout = buildLayout(chartObj.layout);
    if (!layout.yaxis) layout.yaxis = {};
    layout.yaxis.autorange = true;
    Plotly.newPlot(id, chartObj.data, layout, { responsive: true });

    activeCharts[id] = true;
    bindPlotlyDrillForCard(div);
}

// ================= 加载仪表盘 =================
async function loadDashboard() {
    const res = await fetch("/get-dashboard");
    const data = await res.json();
    if (!data.charts || data.charts.length === 0) return;

    const canvas = document.getElementById("canvasGrid");
    canvas.innerHTML = "";
    canvas.style.position = "relative";
    activeCharts = {};
    resetChartDrillState();

    data.charts.forEach(item => {
        const chartObj = safeParseChart(item.chart);
        const id = item.id || ("c_" + Date.now() + Math.random());
        const div = createCanvasCard({
            type: item.type || "Chart",
            id: id,
            width: item.pos?.w != null ? item.pos.w * 50 + "px" : "300px",
            height: item.pos?.h != null ? item.pos.h * 50 + "px" : "200px",
            top: item.pos?.y != null ? `${item.pos.y}px` : "20px",
            left: item.pos?.x != null ? `${item.pos.x}px` : "20px",
            chartSpec: { type: item.type, x: item.x, yList: item.y || [] }
        });
        const inner = div.querySelector(".canvas-inner");
        const insights = item.insights || [];
        if (insights.length && inner) {
            inner.insertAdjacentHTML(
                "afterend",
                `<div class="insight-box">${insights
                    .map((i) => `<div class="insight-item">• ${i}</div>`)
                    .join("")}</div>`
            );
        }
        canvas.appendChild(div);
        const layout = buildLayout(chartObj.layout);
        if (!layout.yaxis) layout.yaxis = {};
        layout.yaxis.autorange = true;
        Plotly.newPlot(id, chartObj.data, layout, { responsive: true });
        activeCharts[id] = true;
    });
    const fc = buildFullFilterConfig();
    if (fc) {
        await refreshDashboardWithDateFilter();
    } else {
        canvas.querySelectorAll(".chart-card").forEach((card) => {
            if (card.dataset.smartTable !== "1") bindPlotlyDrillForCard(card);
        });
        await refreshDashboardMetrics();
    }
}

// ================= 智能表格（多级表头 / 币种 / 模板 / 列筛选） =================
let smartTableConfigTargetCard = null;


/** 智能表格插入 DOM 后：强制布局计算，若高度塌陷则注入 min-height，并打印实测尺寸 */
function finalizeSmartTableRenderLayout(card, inner) {
    if (!inner) return;
    const wrap = inner.querySelector(".table-wrapper");
    const table = wrap ? wrap.querySelector("table") : null;

    void card.offsetHeight;
    void inner.offsetHeight;
    if (wrap) void wrap.offsetHeight;

    let innerH = inner.offsetHeight;
    if (innerH === 0) {
        inner.style.minHeight = "300px";
        void inner.offsetHeight;
        innerH = inner.offsetHeight;
    }
    if (wrap && wrap.offsetHeight === 0) {
        wrap.style.minHeight = "300px";
        void wrap.offsetHeight;
    }
    if (innerH === 0 && card) {
        card.style.minHeight = "340px";
        card.style.height = "auto";
        void card.offsetHeight;
        innerH = inner.offsetHeight;
    }

    const tw = table ? table.offsetWidth : 0;
    const th = table ? table.offsetHeight : 0;
    const ww = wrap ? wrap.offsetWidth : 0;
    const wh = wrap ? wrap.offsetHeight : 0;
    console.log(
        "[SmartTable] 渲染后尺寸 — card:",
        card.offsetWidth,
        "x",
        card.offsetHeight,
        "inner:",
        inner.offsetWidth,
        "x",
        inner.offsetHeight,
        "wrapper:",
        ww,
        "x",
        wh,
        "table:",
        tw,
        "x",
        th
    );
}

/** 修改 1: 确保智能表格加载时完全清除之前的筛选干扰 */
async function fetchAndApplySmartTable(card, templateId, columnVisibility) {
    const inner = card.querySelector(".canvas-inner");
    if (!inner) return false;
    
    const payload = {
        template_id: templateId,
        display_currency: displayCurrency || "CNY",
        filter_config: buildFullFilterConfig()
    };
    if (columnVisibility && typeof columnVisibility === "object") {
        payload.column_visibility = columnVisibility;
    }

    try {
        const res = await fetch("/smart-table", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        
        if (data.status !== "success") {
            console.error("SmartTable Error:", data.msg);
            alert(data.msg || "生成失败");
            return false;
        }

        // --- 核心修复点 1: 填充内容 ---
        // 确保使用 table-wrapper 包裹，并且强制移除所有隐藏类
        inner.innerHTML = `
            <div class="table-wrapper" style="display:block !important; visibility:visible !important;">
                ${data.html}
            </div>
            <div class="insight-box">${(data.insights || [])
                .map((i) => `<div class="insight-item">• ${i}</div>`)
                .join("")}</div>`;

        console.log("智能表格渲染成功，HTML长度:", data.html.length);
        finalizeSmartTableRenderLayout(card, inner);

        return true;
    } catch (e) {
        console.error("Fetch SmartTable Failed:", e);
        return false;
    }
}

/** 修改 2: 修正加载逻辑，防止穿透逻辑“误杀”新生成的表格 */
async function loadSmartTable() {
    const templateId = getSelectedTemplateId();
    const canvas = document.getElementById("canvasGrid");
    
    // 移除占位符
    const placeholder = canvas.querySelector(".canvas-placeholder");
    if (placeholder) placeholder.remove();

    const id = "c_" + Date.now();
    const div = createCanvasCard({
        type: "智能表格",
        id,
        top: "20px",
        left: "20px",
        width: "420px",
        height: "280px",
        smartTableTemplateId: templateId
    });

    // 先把卡片挂载到 DOM，再填充数据（防止 Plotly 或其他库找不到容器）
    canvas.appendChild(div);

    const ok = await fetchAndApplySmartTable(div, templateId, null);
    if (!ok) {
        div.remove(); // 如果失败则移除，防止空卡片堆积
        return;
    }
    
    // --- 核心修复点 3: 强制刷新可见性 ---
    // 运行一次强力显示，防止被全局 CSS 隐藏
    div.querySelectorAll('tr').forEach(tr => {
        tr.style.display = '';
        tr.style.visibility = 'visible';
    });
}

function buildColumnTreeDom(container, column_tree, visibilityDefaults) {
    const ul = document.createElement("ul");
    ul.className = "column-tree-root";
    for (const grp of column_tree) {
        const li = document.createElement("li");
        li.className = "column-tree-group";
        const grpLabel = grp.label || grp.id || "";
        const children = grp.children || [];

        const leafInputs = [];
        const subUl = document.createElement("ul");
        subUl.className = "column-tree-leaves";

        for (const ch of children) {
            const col = ch.column;
            if (!col) continue;
            const li2 = document.createElement("li");
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.dataset.column = col;
            cb.checked = visibilityDefaults[col] !== false;
            leafInputs.push(cb);
            const lab = document.createElement("label");
            lab.className = "column-tree-leaf-label";
            lab.appendChild(cb);
            lab.appendChild(document.createTextNode(" " + (ch.label || col)));
            li2.appendChild(lab);
            subUl.appendChild(li2);
        }

        const grpCb = document.createElement("input");
        grpCb.type = "checkbox";
        grpCb.className = "column-tree-group-cb";
        grpCb.checked =
            leafInputs.length > 0 && leafInputs.every((i) => i.checked);
        grpCb.addEventListener("change", () => {
            const on = grpCb.checked;
            leafInputs.forEach((i) => {
                i.checked = on;
            });
        });
        for (const inp of leafInputs) {
            inp.addEventListener("change", () => {
                grpCb.checked = leafInputs.every((i) => i.checked);
            });
        }

        const grpLab = document.createElement("label");
        grpLab.className = "column-tree-group-label";
        grpLab.appendChild(grpCb);
        grpLab.appendChild(document.createTextNode(" " + grpLabel));

        li.appendChild(grpLab);
        li.appendChild(subUl);
        ul.appendChild(li);
    }
    container.appendChild(ul);
}

async function openSmartTableConfigModal(card) {
    smartTableConfigTargetCard = card;
    const tid = card.dataset.templateId;
    const modal = document.getElementById("smartTableConfigModal");
    const container = document.getElementById("smartTableColumnTree");
    const emptyTip = document.getElementById("smartTableTreeEmpty");
    if (!modal || !container) return;
    container.innerHTML = "";
    if (emptyTip) emptyTip.classList.add("hidden");

    const res = await fetch(
        `/api/template-column-tree?template_id=${encodeURIComponent(tid)}`
    );
    const data = await res.json();
    if (
        data.status !== "success" ||
        !data.column_tree ||
        data.column_tree.length === 0
    ) {
        if (emptyTip) emptyTip.classList.remove("hidden");
        modal.style.display = "flex";
        return;
    }

    let saved = {};
    try {
        if (card.dataset.columnVisibility) {
            saved = JSON.parse(card.dataset.columnVisibility);
        }
    } catch (e) {
        saved = {};
    }

    buildColumnTreeDom(container, data.column_tree, saved);
    modal.style.display = "flex";
}

function closeSmartTableConfigModal() {
    const modal = document.getElementById("smartTableConfigModal");
    if (modal) modal.style.display = "none";
    smartTableConfigTargetCard = null;
}

async function confirmSmartTableColumnConfig() {
    const card = smartTableConfigTargetCard;
    if (!card) return closeSmartTableConfigModal();

    const modal = document.getElementById("smartTableConfigModal");
    const inputs = modal.querySelectorAll("#smartTableColumnTree input[data-column]");
    const visibility = {};
    let anyChecked = false;
    inputs.forEach((inp) => {
        visibility[inp.dataset.column] = inp.checked;
        if (inp.checked) anyChecked = true;
    });
    if (!anyChecked) {
        alert("请至少保留一列");
        return;
    }
    card.dataset.columnVisibility = JSON.stringify(visibility);
    await fetchAndApplySmartTable(card, card.dataset.templateId, visibility);
    closeSmartTableConfigModal();
}

async function openSmartTableTemplateModal(card) {
    smartTableTemplateTargetCard = card;
    const modal = document.getElementById("smartTableTemplateModal");
    const picker = document.getElementById("smartTableTemplatePicker");
    if (!modal || !picker) return;
    try {
        const res = await fetch("/api/templates");
        const data = await res.json();
        if (data.status !== "success" || !Array.isArray(data.templates)) {
            alert("无法加载模板列表");
            return;
        }
        picker.innerHTML = data.templates
            .map(
                (t) =>
                    `<option value="${String(t.id).replace(/"/g, "&quot;")}">${t.name}</option>`
            )
            .join("");
        picker.value = card.dataset.templateId || "";
    } catch (e) {
        console.error(e);
        alert("加载模板失败");
        return;
    }
    modal.style.display = "flex";
}

function closeSmartTableTemplateModal() {
    const modal = document.getElementById("smartTableTemplateModal");
    if (modal) modal.style.display = "none";
    smartTableTemplateTargetCard = null;
}

async function confirmSmartTableTemplateSwitch() {
    const card = smartTableTemplateTargetCard;
    const picker = document.getElementById("smartTableTemplatePicker");
    if (!card || !picker) return closeSmartTableTemplateModal();
    const newId = picker.value;
    if (!newId) return alert("请选择模板");
    resetChartDrillState();
    card.dataset.templateId = newId;
    delete card.dataset.columnVisibility;
    await fetchAndApplySmartTable(card, newId, null);
    closeSmartTableTemplateModal();
}

// ================= 工具栏 / 主题 / 导出（供 HTML onclick 使用） =================
async function toggleTheme() {
    try {
        const res = await fetch("/toggle-theme", { method: "POST" });
        const data = await res.json();
        currentTheme = data.theme || currentTheme;
        document.body.setAttribute("data-theme", currentTheme === "dark" ? "dark" : "light");
        relayoutAllPlotlyCharts();
        const mapMc = document.querySelector("#mappingModal .modal-content");
        if (mapMc) {
            mapMc.setAttribute("data-bs-theme", currentTheme === "dark" ? "dark" : "light");
        }
        const btn = document.getElementById("themeBtn");
        if (btn) btn.textContent = currentTheme === "dark" ? "浅色主题" : "深色主题";
    } catch (e) {
        console.error(e);
    }
}

function togglePresentationMode() {
    presentationMode = !presentationMode;
    document.getElementById("sidebar")?.classList.toggle("collapsed", presentationMode);
    document.getElementById("canvasGrid")?.classList.toggle("fullscreen", presentationMode);
    requestAnimationFrame(() => {
        measureAndApplyDockLayout();
        applyReportModuleVisibility();
        dispatchWindowResize();
        document.querySelectorAll(".chart-card").forEach(refreshPlotlyInCard);
    });
}

async function resetLayout() {
    try {
        localStorage.removeItem(DOCK_LAYOUT_STORAGE_KEY);
    } catch (e) {
        /* ignore */
    }
    ensureAllDockWidgets();
    measureAndApplyDockLayout();
    resetDockWidgetStacking();
    syncKpiPlaceholderUi();
    finalizeDockCompactAndSave();
    void refreshDashboardMetrics();
    requestAnimationFrame(() => {
        applyReportModuleVisibility();
        dispatchWindowResize();
        document.querySelectorAll(".chart-card").forEach(refreshPlotlyInCard);
    });
}

async function resetDashboardChartsOnly() {
    if (!confirm("确定清空画布上的所有图表卡片？")) return;
    resetChartDrillState();
    await fetch("/reset-dashboard", { method: "POST" });
    const canvas = document.getElementById("canvasGrid");
    if (canvas) {
        canvas.innerHTML =
            '<div class="canvas-placeholder" id="canvasPlaceholder">拖拽左侧图表组件到此处生成报表</div>';
    }
    activeCharts = {};
}

let exportCenterBusy = false;

function showExportLoading(message) {
    const el = document.getElementById("exportLoadingOverlay");
    const textEl = document.getElementById("exportLoadingText");
    if (textEl && message) textEl.textContent = message;
    if (el) {
        el.style.display = "flex";
        el.setAttribute("aria-hidden", "false");
    }
}

function hideExportLoading() {
    const el = document.getElementById("exportLoadingOverlay");
    if (el) {
        el.style.display = "none";
        el.setAttribute("aria-hidden", "true");
    }
}

function closeExportCenterDropdown() {
    const btn = document.getElementById("exportCenterBtn");
    if (btn && typeof bootstrap !== "undefined" && bootstrap.Dropdown) {
        const inst = bootstrap.Dropdown.getInstance(btn);
        if (inst) inst.hide();
    }
}

function filenameFromContentDisposition(cd) {
    if (!cd) return null;
    const mStar = cd.match(/filename\*=UTF-8''([^;\n]+)/i);
    if (mStar) {
        try {
            return decodeURIComponent(mStar[1].trim());
        } catch (e) {
            return mStar[1].trim();
        }
    }
    const m = cd.match(/filename="([^"\n]+)"/i);
    if (m) return m[1].trim();
    const m2 = cd.match(/filename=([^;\n]+)/i);
    return m2 ? m2[1].trim().replace(/^"+|"+$/g, "") : null;
}

async function exportCanvasAsPng() {
    const grid = document.getElementById("canvasGrid");
    if (!grid || typeof html2canvas === "undefined") {
        throw new Error("当前环境无法截取看板（缺少 html2canvas）");
    }
    const canvas = await html2canvas(grid, {
        scale: 2,
        useCORS: true,
        backgroundColor: document.body.getAttribute("data-theme") === "dark" ? "#111827" : "#f9fafb"
    });
    const link = document.createElement("a");
    link.download = "dashboard_canvas.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
}

async function downloadStructuredExport(format) {
    const res = await fetch(`/api/export?format=${encodeURIComponent(format)}`);
    if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.msg || `导出失败（HTTP ${res.status}）`);
    }
    const blob = await res.blob();
    let name = filenameFromContentDisposition(res.headers.get("Content-Disposition"));
    if (!name) {
        const ext = format === "excel" ? "xlsx" : format === "pdf" ? "pdf" : "csv";
        name = `export_data.${ext}`;
    }
    if (format === "pdf" && res.headers.get("X-Export-Pdf-Font") === "fallback") {
        alert(
            "PDF 未检测到可用的中文字体，中文可能显示为方框。请将 SimHei.ttf 或 msyh.ttc 放入项目根目录下的 fonts 文件夹（若无该文件夹请新建），或在 Windows 的「字体」设置中安装黑体/微软雅黑后重试。"
        );
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
}

async function runExportCenterAction(action) {
    if (exportCenterBusy) return;
    const needsDataset = action !== "canvas-png";
    if (needsDataset && !currentFileLoaded) {
        return alert("请先上传或载入主表数据后再导出结构化文件。");
    }
    exportCenterBusy = true;
    closeExportCenterDropdown();
    showExportLoading(action === "canvas-png" ? "正在截取看板…" : "正在生成文件…");
    try {
        if (action === "canvas-png") {
            await exportCanvasAsPng();
        } else {
            await downloadStructuredExport(action);
        }
    } catch (e) {
        console.error(e);
        alert(e.message || String(e));
    } finally {
        hideExportLoading();
        exportCenterBusy = false;
    }
}

function initExportCenter() {
    const root = document.querySelector(".toolbar-export-center");
    if (!root) return;
    root.addEventListener("click", (ev) => {
        const item = ev.target.closest("[data-export-action]");
        if (!item || !root.contains(item)) return;
        ev.preventDefault();
        if (item.classList.contains("disabled")) {
            alert("请先上传或载入主表数据后再导出结构化文件。");
            return;
        }
        const action = item.getAttribute("data-export-action");
        if (!action) return;
        void runExportCenterAction(action);
    });
    syncExportCenterUi();
}

function toggleRawData() {
    const panel = document.getElementById("rawDataContent");
    const icon = document.getElementById("panelIcon");
    const wasOpen = panel?.classList.contains("open");
    panel?.classList.toggle("open");
    // syncMultiDimSummaryLayoutAfterBody 在展开时会写入内联 max-height；若关闭时不移除，会覆盖
    // .panel-content 的 max-height:0，导致面板无法收起并可能遮挡下方 KPI 区域。
    if (panel && !panel.classList.contains("open")) {
        panel.style.maxHeight = "";
    }
    if (icon) icon.style.transform = panel?.classList.contains("open") ? "rotate(180deg)" : "";
    if (panel && !wasOpen && panel.classList.contains("open")) {
        requestAnimationFrame(() => syncMultiDimSummaryLayoutAfterBody());
    }
}

function resetLocalDatasetUi() {
    resetChartDrillState();
    destroyMappingColumnSortable();
    mappedColumns = [];
    const mm = document.getElementById("mappingModal");
    if (mm && typeof bootstrap !== "undefined") {
        const inst = bootstrap.Modal.getInstance(mm);
        if (inst) inst.hide();
    }
    currentFileLoaded = false;
    allColumns = [];
    numericColumns = [];
    hideVlookupSection();
    resetVlookupClientState();
    activeCharts = {};
    document.getElementById("uploadBox").style.display = "";
    document.getElementById("fileCard").style.display = "none";
    document.getElementById("componentSection").style.display = "none";
    document.getElementById("rawDataPanel").style.display = "none";
    document.getElementById("rawDataContainer").innerHTML = "";
    rawDataTableOriginalHtml = "";
    const drillBar = document.getElementById("rawDataDrillToolbar");
    if (drillBar) drillBar.classList.add("hidden");
    const drillLabel = document.getElementById("rawDataDrillLabel");
    if (drillLabel) drillLabel.textContent = "";
    document.getElementById("canvasGrid").innerHTML =
        '<div class="canvas-placeholder" id="canvasPlaceholder">拖拽左侧图表组件到此处生成报表</div>';
    const input = document.getElementById("fileInput");
    if (input) input.value = "";
    document.getElementById("statusTip").innerText = "请先上传 Excel 文件";
    const dateBar = document.getElementById("dateFilterBar");
    if (dateBar) {
        dateBar.classList.add("hidden");
        resetDateFilterUiOnly();
    }
    resetBiDashboardUi();
    applyDockKpiDisplayMode();
    requestAnimationFrame(() => {
        measureAndApplyDockLayout();
        applyReportModuleVisibility();
        saveLayout();
    });
    syncExportCenterUi();
}

function escapeHtmlForUi(s) {
    if (s === null || s === undefined) return "";
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function buildAnomalyReportBodyHtml(report) {
    const parts = [];
    const nullCount = report.null_count ?? 0;
    if (nullCount > 0 && Array.isArray(report.null_rows) && report.null_rows.length) {
        parts.push('<h6 class="mt-2 text-body">空值明细（最多 20 行）</h6>');
        parts.push(
            '<div class="table-responsive"><table class="table table-sm table-bordered align-middle mb-0"><thead><tr><th>行索引</th><th>缺失列</th></tr></thead><tbody>'
        );
        for (const row of report.null_rows) {
            const cols = Array.isArray(row.columns) ? row.columns.map(escapeHtmlForUi).join("，") : "";
            parts.push(
                `<tr><td>${escapeHtmlForUi(row.row_index)}</td><td>${cols}</td></tr>`
            );
        }
        parts.push("</tbody></table></div>");
    } else if (nullCount > 0) {
        parts.push(
            `<p class="small text-secondary mb-0">空值共 ${escapeHtmlForUi(nullCount)} 个（本页未展开逐行明细）。</p>`
        );
    }

    if (Array.isArray(report.extreme_values) && report.extreme_values.length) {
        parts.push('<h6 class="mt-3 text-body">数值极值（3σ，最多 20 条）</h6>');
        parts.push(
            '<div class="table-responsive"><table class="table table-sm table-bordered align-middle mb-0"><thead><tr><th>行</th><th>列</th><th>值</th><th>类型</th><th>|z|</th><th>边界</th></tr></thead><tbody>'
        );
        for (const r of report.extreme_values) {
            const z =
                r.z_score != null && Number.isFinite(Number(r.z_score))
                    ? Number(r.z_score).toFixed(2)
                    : "";
            const b = r.bound != null ? escapeHtmlForUi(JSON.stringify(r.bound)) : "";
            parts.push(
                `<tr><td>${escapeHtmlForUi(r.row_index)}</td><td>${escapeHtmlForUi(r.column)}</td><td>${escapeHtmlForUi(r.value)}</td><td>${escapeHtmlForUi(r.type)}</td><td>${escapeHtmlForUi(z)}</td><td class="text-break small">${b}</td></tr>`
            );
        }
        parts.push("</tbody></table></div>");
    }

    if (Array.isArray(report.negative_values) && report.negative_values.length) {
        parts.push('<h6 class="mt-3 text-body">不应为负的字段中的负数</h6>');
        parts.push(
            '<div class="table-responsive"><table class="table table-sm table-bordered align-middle mb-0"><thead><tr><th>行</th><th>列</th><th>值</th></tr></thead><tbody>'
        );
        for (const r of report.negative_values) {
            parts.push(
                `<tr><td>${escapeHtmlForUi(r.row_index)}</td><td>${escapeHtmlForUi(r.column)}</td><td>${escapeHtmlForUi(r.value)}</td></tr>`
            );
        }
        parts.push("</tbody></table></div>");
    }

    if (Array.isArray(report.invalid_chars) && report.invalid_chars.length) {
        parts.push('<h6 class="mt-3 text-body">可疑字符串（不可打印 / 控制字符）</h6>');
        parts.push(
            '<div class="table-responsive"><table class="table table-sm table-bordered align-middle mb-0"><thead><tr><th>行</th><th>列</th><th>类型</th><th>片段</th></tr></thead><tbody>'
        );
        for (const r of report.invalid_chars) {
            parts.push(
                `<tr><td>${escapeHtmlForUi(r.row_index)}</td><td>${escapeHtmlForUi(r.column)}</td><td>${escapeHtmlForUi(r.type)}</td><td class="text-break">${escapeHtmlForUi(r.value)}</td></tr>`
            );
        }
        parts.push("</tbody></table></div>");
    }

    if (Array.isArray(report.duplicate_dimensions) && report.duplicate_dimensions.length) {
        parts.push('<h6 class="mt-3 text-body">维度列重复值（启发式列，最多 20 条）</h6>');
        parts.push(
            '<div class="table-responsive"><table class="table table-sm table-bordered align-middle mb-0"><thead><tr><th>行</th><th>列</th><th>值</th></tr></thead><tbody>'
        );
        for (const r of report.duplicate_dimensions) {
            parts.push(
                `<tr><td>${escapeHtmlForUi(r.row_index)}</td><td>${escapeHtmlForUi(r.column)}</td><td class="text-break">${escapeHtmlForUi(r.value)}</td></tr>`
            );
        }
        parts.push("</tbody></table></div>");
    }

    if (!parts.length) {
        return '<p class="small text-secondary mb-0">未发现需分项展示的质量项；结论见上方摘要。</p>';
    }
    return parts.join("");
}

async function openAnomalyReportModal() {
    const modalEl = document.getElementById("anomalyReportModal");
    const summaryEl = document.getElementById("anomalyReportSummary");
    const bodyEl = document.getElementById("anomalyReportBody");
    if (!modalEl || !summaryEl || !bodyEl) return;
    if (typeof bootstrap === "undefined") {
        alert("Bootstrap 未加载，无法显示检测报告");
        return;
    }
    summaryEl.textContent = "正在分析当前主表…";
    bodyEl.innerHTML =
        '<p class="text-secondary small mb-0">请求 <code>/api/detect-anomalies</code> …</p>';
    bootstrap.Modal.getOrCreateInstance(modalEl).show();
    try {
        const res = await fetch("/api/detect-anomalies", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.status === "success" && data.report) {
            const r = data.report;
            summaryEl.textContent = r.summary || "检测完成";
            const meta =
                r.total_anomalies != null
                    ? `<p class="small text-muted mb-2">分项展示的记录类条目合计：<strong>${escapeHtmlForUi(r.total_anomalies)}</strong>（与摘要中各类计数口径一致；各表最多 20 行）。</p>`
                    : '<p class="small text-muted mb-2">基于会话内<strong>全量主表</strong>的启发式扫描；与 KPI「预警项数」等前端汇总口径可能略有差异。</p>';
            bodyEl.innerHTML = meta + buildAnomalyReportBodyHtml(r);
            return;
        }
        summaryEl.textContent = data.msg || `请求失败（HTTP ${res.status}）`;
        bodyEl.innerHTML = "";
    } catch (e) {
        console.error(e);
        summaryEl.textContent = "网络错误或服务不可达";
        bodyEl.innerHTML = `<pre class="small mb-0 text-danger">${escapeHtmlForUi(e.message || e)}</pre>`;
    }
}

async function clearSessionAndUi() {
    try {
        const res = await fetch("/api/clear-session", { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (data.status !== "success") {
            return alert(data.msg || "清理失败");
        }
        resetLocalDatasetUi();
        alert("缓存已清理");
    } catch (e) {
        console.error(e);
        alert("网络错误，清理失败");
    }
}

async function removeFile() {
    await fetch("/clear-upload", { method: "POST" });
    resetLocalDatasetUi();
}

/** 弹窗或其它容器复用：与主画布相同的卡片结构、拖拽与缩放 */
window.createDashboardCard = createCanvasCard;

initExportCenter();
initColumnMappingModal();