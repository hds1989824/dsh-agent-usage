/**
 * Client half of the Agent usage bundle.
 *
 * Registers a left-sidebar panel entry (sidebar.panellist) whose id addresses
 * a main panel (main) rendering the day's session count and token consumption
 * per local agent client. The panel reads the Host route
 * /plugins/agent-usage/today and refreshes it periodically.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-agent-usage',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const NS = 'agentUsage';
    const ROUTE = '/plugins/agent-usage/today';
    const DETAILS_ID = 'agent-usage-details';

    const en = {
      'panel.title': 'Agent usage',
      'panel.subtitle': 'Sessions and token consumption across your local agent clients.',
      'panel.range': 'Time range',
      'panel.rangeToday': 'Today',
      'panel.rangeWeek': 'This week',
      'panel.rangeMonth': 'This month',
      'panel.refresh': 'Refresh',
      'panel.loading': 'Loading…',
      'panel.error': 'Could not load usage data.',
      'panel.errorAuth': 'Your sign-in expired. Reload the page to sign in again.',
      'panel.errorHost': 'The host scan failed. Try again in a moment.',
      'panel.sessions': 'Sessions',
      'panel.input': 'Input tokens',
      'panel.output': 'Output tokens',
      'panel.cacheRead': 'Cache read',
      'panel.cacheCreation': 'Cache creation',
      'panel.total': 'Total tokens',
      'panel.platform': 'Agent client',
      'panel.session': 'Session',
      'panel.lastActivity': 'Last activity',
      'panel.empty': 'No agent sessions recorded in this range.',
      'panel.composition': 'Usage by agent',
      'panel.donutLabel': 'Token usage share by agent',
      'panel.note': 'Reads local session logs only. Qwen Work token counts come from its local session database. WorkBuddy input tokens already include its cache reads, so its cache columns are zero.',
      'panel.updated': 'Updated',
      'panel.showDetails': 'Show session detail',
      'panel.hideDetails': 'Hide session detail',
    };
    const zh = {
      'panel.title': 'Agent 用量',
      'panel.subtitle': '本地各 Agent 客户端的会话数与 token 消耗。',
      'panel.range': '时间范围',
      'panel.rangeToday': '今天',
      'panel.rangeWeek': '本周',
      'panel.rangeMonth': '本月',
      'panel.refresh': '刷新',
      'panel.loading': '加载中…',
      'panel.error': '无法加载用量数据。',
      'panel.errorAuth': '登录已过期，请重新加载页面并登录。',
      'panel.errorHost': '主机扫描失败，请稍后重试。',
      'panel.sessions': '会话数',
      'panel.input': '输入 tokens',
      'panel.output': '输出 tokens',
      'panel.cacheRead': '缓存读取',
      'panel.cacheCreation': '缓存创建',
      'panel.total': '总 tokens',
      'panel.platform': 'Agent 客户端',
      'panel.session': '会话',
      'panel.lastActivity': '最近活动',
      'panel.empty': '该时间范围内没有记录到 Agent 会话。',
      'panel.composition': '各 Agent 用量构成',
      'panel.donutLabel': '各 Agent token 用量占比',
      'panel.note': '仅读取本地会话日志。千问办公的 token 数来自其本地会话数据库；WorkBuddy 的输入 tokens 已包含缓存读取，因此其缓存列显示为 0。',
      'panel.updated': '更新于',
      'panel.showDetails': '显示会话明细',
      'panel.hideDetails': '隐藏会话明细',
    };

    const styles = {
      wrap: {
        padding: '20px 22px 32px',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
      },
      header: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        marginBottom: 16,
      },
      title: { margin: 0, fontSize: 18, fontWeight: 650 },
      subtitle: { margin: '4px 0 0', fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' },
      refresh: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 8,
        padding: '6px 12px',
        fontSize: 12.5,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      cards: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 10,
        marginBottom: 18,
      },
      card: {
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        padding: '12px 14px',
      },
      cardKey: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      cardValue: { fontSize: 21, fontWeight: 700, marginTop: 4, fontVariantNumeric: 'tabular-nums' },
      sectionTitle: { fontSize: 14, fontWeight: 650, margin: '20px 0 10px' },
      tableScroll: { overflowX: 'auto', WebkitOverflowScrolling: 'touch' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
      th: {
        textAlign: 'left',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        fontWeight: 600,
        padding: '7px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        whiteSpace: 'nowrap',
      },
      td: {
        padding: '8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      },
      tdSession: {
        padding: '8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        maxWidth: 180,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
      },
      num: { textAlign: 'right' },
      note: { marginTop: 18, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 },
      errorBanner: {
        margin: '0 0 12px',
        padding: '8px 12px',
        border: '1px solid var(--dsw-alias-state-error-primary)',
        borderRadius: 8,
        color: 'var(--dsw-alias-state-error-primary)',
        fontSize: 12.5,
      },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13 },
      detailsToggle: {
        appearance: 'none',
        border: 'none',
        background: 'none',
        color: 'var(--dsw-alias-brand-primary)',
        padding: '4px 0',
        fontSize: 12.5,
        cursor: 'pointer',
      },
      rangeSwitch: {
        display: 'inline-flex',
        gap: 4,
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        padding: 3,
        marginBottom: 16,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      rangeButton: {
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        borderRadius: 6,
        padding: '5px 14px',
        fontSize: 12.5,
        cursor: 'pointer',
      },
      rangeButtonActive: {
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 600,
      },
      donutWrap: {
        display: 'flex',
        alignItems: 'center',
        gap: 20,
        flexWrap: 'wrap',
      },
      legend: { listStyle: 'none', margin: 0, padding: 0, fontSize: 12.5, minWidth: 190 },
      legendItem: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' },
      legendSwatch: { width: 10, height: 10, borderRadius: 3, display: 'inline-block', flex: '0 0 auto' },
      legendValue: { marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-secondary)' },
    };

    const SEGMENT_COLORS = [
      'var(--dsw-alias-brand-primary)',
      'var(--dsw-alias-state-success-primary)',
      'var(--dsw-alias-state-warn-primary)',
      'var(--dsw-alias-state-idle-primary)',
      'var(--dsw-alias-state-error-primary)',
    ];

    function fmtTokens(n) {
      const v = Number(n) || 0;
      if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
      if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
      if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
      return String(v);
    }

    function fmtClock(epoch) {
      if (!epoch) return '—';
      const d = new Date(epoch * 1000);
      const pad = (x) => String(x).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function fmtUpdated(ms) {
      const d = new Date(ms);
      const pad = (x) => String(x).padStart(2, '0');
      const now = new Date();
      const sameDay = d.getFullYear() === now.getFullYear()
        && d.getMonth() === now.getMonth()
        && d.getDate() === now.getDate();
      const datePart = sameDay ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `;
      return `${datePart}${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function describeError(e, t) {
      const msg = String(e && e.message ? e.message : e);
      if (msg.includes('401')) return t('panel.errorAuth');
      if (msg.includes('500')) return t('panel.errorHost');
      return msg;
    }

    function Card({ label, value }) {
      return h('div', { style: styles.card },
        h('div', { style: styles.cardKey }, label),
        h('div', { style: styles.cardValue, title: String(value) }, fmtTokens(value)));
    }

    function TokenCell({ value }) {
      return h('td', { style: { ...styles.td, ...styles.num }, title: String(value) }, fmtTokens(value));
    }

    function UsageDonut({ items, label }) {
      const total = items.reduce((sum, p) => sum + (p.value || 0), 0);
      if (total <= 0) return null;
      const radius = 15.915494309189534; // circumference = 100
      const circumference = 2 * Math.PI * radius;
      let offset = 0;
      const arcs = items.map((p) => {
        const frac = (p.value || 0) / total;
        const dash = frac * circumference;
        const arc = { ...p, dash, offset, pct: frac * 100 };
        offset += dash;
        return arc;
      });
      return h('div', { style: styles.donutWrap },
        h('svg', { width: 132, height: 132, viewBox: '0 0 42 42', role: 'img', 'aria-label': label },
          h('circle', {
            cx: 21, cy: 21, r: radius, fill: 'none', strokeWidth: 6,
            style: { stroke: 'var(--dsw-alias-bg-layer-2)' },
          }),
          arcs.map((arc, i) => h('circle', {
            key: arc.id,
            cx: 21, cy: 21, r: radius, fill: 'none', strokeWidth: 6,
            strokeDasharray: `${arc.dash} ${circumference - arc.dash}`,
            strokeDashoffset: -arc.offset,
            transform: 'rotate(-90 21 21)',
            style: { stroke: SEGMENT_COLORS[i % SEGMENT_COLORS.length] },
          }))),
        h('ul', { style: styles.legend },
          arcs.map((arc, i) => h('li', { key: arc.id, style: styles.legendItem },
            h('span', { style: { ...styles.legendSwatch, background: SEGMENT_COLORS[i % SEGMENT_COLORS.length] } }),
            h('span', null, arc.label),
            h('span', { style: styles.legendValue }, `${arc.pct.toFixed(1)}%`)))));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'agent-usage: dictionaries');

        function PanelIcon({ size, active }) {
          return h('svg', {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            'aria-hidden': true,
            style: { display: 'block', opacity: active ? 1 : 0.72 },
          },
            h('rect', {
              x: 3, y: 4, width: 18, height: 16, rx: 3,
              stroke: 'currentColor', strokeWidth: 1.6, fill: 'none',
            }),
            h('rect', { x: 7, y: 13, width: 3, height: 5, rx: 0.8, fill: 'currentColor' }),
            h('rect', { x: 11, y: 9, width: 3, height: 9, rx: 0.8, fill: 'currentColor' }),
            h('rect', { x: 15, y: 6, width: 3, height: 12, rx: 0.8, fill: 'currentColor' }));
        }

        function Panel() {
          const [data, setData] = useState(null);
          const [error, setError] = useState(null);
          const [loading, setLoading] = useState(true);
          const [updated, setUpdated] = useState(null);
          const [showDetails, setShowDetails] = useState(false);
          const [range, setRange] = useState('today');
          const seqRef = useRef(0);
          const tRef = useRef(t);
          const rangeRef = useRef('today');
          tRef.current = t;

          const load = useCallback(async (force) => {
            const seq = ++seqRef.current;
            setLoading(true);
            setError(null);
            try {
              const url = `${ROUTE}?range=${rangeRef.current}${force ? '&force=1' : ''}`;
              const res = await fetch(url, { headers: { accept: 'application/json' } });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const json = await res.json();
              if (seq !== seqRef.current) return;
              setData(json);
              setUpdated(Date.now());
            } catch (e) {
              if (seq !== seqRef.current) return;
              setError(describeError(e, tRef.current));
            } finally {
              if (seq === seqRef.current) setLoading(false);
            }
          }, []);

          const selectRange = (next) => {
            if (next === rangeRef.current) return;
            rangeRef.current = next;
            setRange(next);
            void load(true);
          };

          useEffect(() => {
            void load(false);
            const timer = setInterval(() => void load(false), 60_000);
            return () => clearInterval(timer);
          }, [load]);

          const rows = [];
          if (data) {
            for (const p of data.platforms || []) {
              for (const d of p.details || []) rows.push({ platform: p.label, ...d });
            }
            rows.sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
          }

          const renderData = () => {
            if (!data) return null;
            const totals = data.totals || { sessions: 0, usage: {} };
            const tu = totals.usage || {};
            return h('div', null,
              h('div', { style: styles.cards },
                h(Card, { label: t('panel.sessions'), value: totals.sessions }),
                h(Card, { label: t('panel.input'), value: tu.input }),
                h(Card, { label: t('panel.output'), value: tu.output }),
                h(Card, { label: t('panel.cacheRead'), value: tu.cacheRead }),
                h(Card, { label: t('panel.cacheCreation'), value: tu.cacheCreation }),
                h(Card, { label: t('panel.total'), value: tu.total })),
              h('h3', { style: styles.sectionTitle }, t('panel.composition')),
              h(UsageDonut, {
                items: (data.platforms || [])
                  .map((p) => ({ id: p.id, label: p.label, value: (p.usage || {}).total || 0 }))
                  .filter((p) => p.value > 0),
                label: t('panel.donutLabel'),
              }),
              h('h3', { style: styles.sectionTitle }, t('panel.platform')),
              h('div', { style: styles.tableScroll },
                h('table', { style: styles.table },
                  h('thead', null, h('tr', null,
                    h('th', { style: styles.th, scope: 'col' }, t('panel.platform')),
                    h('th', { style: { ...styles.th, ...styles.num }, scope: 'col' }, t('panel.sessions')),
                    h('th', { style: { ...styles.th, ...styles.num }, scope: 'col' }, t('panel.input')),
                    h('th', { style: { ...styles.th, ...styles.num }, scope: 'col' }, t('panel.output')),
                    h('th', { style: { ...styles.th, ...styles.num }, scope: 'col' }, t('panel.cacheRead')),
                    h('th', { style: { ...styles.th, ...styles.num }, scope: 'col' }, t('panel.cacheCreation')),
                    h('th', { style: { ...styles.th, ...styles.num }, scope: 'col' }, t('panel.total')))),
                  h('tbody', null, (data.platforms || []).map((p) => {
                    const u = p.usage || {};
                    return h('tr', { key: p.id },
                      h('td', { style: styles.td }, p.label),
                      h('td', { style: { ...styles.td, ...styles.num, title: String(p.sessions) } }, String(p.sessions)),
                      h(TokenCell, { value: u.input }),
                      h(TokenCell, { value: u.output }),
                      h(TokenCell, { value: u.cacheRead }),
                      h(TokenCell, { value: u.cacheCreation }),
                      h(TokenCell, { value: u.total }));
                  })))),
              rows.length > 0
                ? h('div', null,
                    h('button', {
                      type: 'button',
                      style: styles.detailsToggle,
                      'aria-expanded': showDetails,
                      'aria-controls': DETAILS_ID,
                      onClick: () => setShowDetails((v) => !v),
                    }, showDetails ? t('panel.hideDetails') : t('panel.showDetails')),
                    showDetails
                      ? h('div', { style: styles.tableScroll, id: DETAILS_ID },
                          h('table', { style: { ...styles.table, marginTop: 8 } },
                            h('thead', null, h('tr', null,
                              h('th', { style: styles.th, scope: 'col' }, t('panel.platform')),
                              h('th', { style: styles.th, scope: 'col' }, t('panel.session')),
                              h('th', { style: styles.th, scope: 'col' }, t('panel.lastActivity')),
                              h('th', { style: { ...styles.th, ...styles.num }, scope: 'col' }, t('panel.input')),
                              h('th', { style: { ...styles.th, ...styles.num }, scope: 'col' }, t('panel.output')),
                              h('th', { style: { ...styles.th, ...styles.num }, scope: 'col' }, t('panel.cacheRead')),
                              h('th', { style: { ...styles.th, ...styles.num }, scope: 'col' }, t('panel.total')))),
                            h('tbody', null, rows.map((r, i) => {
                              const u = r.usage || {};
                              return h('tr', { key: `${r.platform}-${r.session}-${i}` },
                                h('td', { style: styles.td }, r.platform),
                                h('td', { style: styles.tdSession, title: r.session }, r.session),
                                h('td', { style: styles.td }, fmtClock(r.last)),
                                h(TokenCell, { value: u.input }),
                                h(TokenCell, { value: u.output }),
                                h(TokenCell, { value: u.cacheRead }),
                                h(TokenCell, { value: u.total }));
                            }))))
                      : null)
                : h('p', { style: { ...styles.muted, marginTop: 12 } }, t('panel.empty')));
          };

          return h('div', { style: styles.wrap },
            h('div', { style: styles.header },
              h('div', null,
                h('h2', { style: styles.title }, t('panel.title')),
                h('p', { style: styles.subtitle },
                  data ? `${data.date} · ${t('panel.subtitle')}` : t('panel.subtitle'))),
              h('button', {
                type: 'button',
                style: styles.refresh,
                disabled: loading,
                onClick: () => void load(true),
              }, t('panel.refresh'))),
            h('div', { style: styles.rangeSwitch, role: 'group', 'aria-label': t('panel.range') },
              h('button', {
                type: 'button',
                style: range === 'today' ? { ...styles.rangeButton, ...styles.rangeButtonActive } : styles.rangeButton,
                onClick: () => selectRange('today'),
              }, t('panel.rangeToday')),
              h('button', {
                type: 'button',
                style: range === 'week' ? { ...styles.rangeButton, ...styles.rangeButtonActive } : styles.rangeButton,
                onClick: () => selectRange('week'),
              }, t('panel.rangeWeek')),
              h('button', {
                type: 'button',
                style: range === 'month' ? { ...styles.rangeButton, ...styles.rangeButtonActive } : styles.rangeButton,
                onClick: () => selectRange('month'),
              }, t('panel.rangeMonth'))),
            loading && !data ? h('div', { style: styles.muted }, t('panel.loading')) : null,
            error ? h('div', { style: styles.errorBanner }, `${t('panel.error')} ${error}`) : null,
            renderData(),
            data ? h('p', { style: styles.note },
              updated ? `${t('panel.updated')} ${fmtUpdated(updated)} · ` : '',
              t('panel.note')) : null);
        }

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'agent-usage',
          order: 20,
          label: () => t('panel.title'),
        }, PanelIcon));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'agent-usage',
        }, Panel));
      },
    };
  },
});
