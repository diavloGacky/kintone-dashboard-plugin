(function() {
  'use strict';

  // ---- 定数 ----
  var STORAGE_KEY_PREFIX = 'kintone_dashboard_';
  var WIDGET_TYPES = {
    number_card: { label: '数値カード', icon: '🔢' },
    table:       { label: 'テーブル',   icon: '📋' },
    bar_chart:   { label: '棒グラフ',   icon: '📊' },
    pie_chart:   { label: '円グラフ',   icon: '🥧' },
    filter:      { label: 'フィルタ',   icon: '🔍' }
  };

  // ---- 状態 ----
  var currentAppId = null;
  var config       = null;   // { targetView, widgets, _recordId }
  var sharedCfg    = null;   // { configAppId, configApiToken } ← localStorageに保存
  var records      = [];
  var filterVals   = {};
  var gridObj      = null;
  var chartObjs    = {};
  var fieldCache   = [];

  // ================================================================
  // kintoneイベント
  // ================================================================
  kintone.events.on('app.record.index.show', function(event) {
    currentAppId = kintone.app.getId();
    sharedCfg    = loadSharedSettings();

    buildDashboardDOM();
    buildConnectionModal();

    loadConfig().then(function(cfg) {
      config = cfg;

      var dash = document.getElementById('kintone-dashboard');
      var targetView = config.targetView || '';
      if (targetView && event.viewName !== targetView) {
        if (dash) dash.style.display = 'none';
        return;
      }
      if (dash) dash.style.display = '';

      if (config.widgets && config.widgets.length > 0) {
        loadFields().then(fetchRecords).then(function(recs) {
          records = recs;
          renderFilters();
          renderAllWidgets();
        });
      }
    });

    return event;
  });

  // ================================================================
  // 接続設定の読み書き（localStorage）
  // ================================================================
  function loadSharedSettings() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY_PREFIX + 'shared');
      if (raw) return JSON.parse(raw);
    } catch(e) {}
    return { configAppId: '', configApiToken: '' };
  }

  function saveSharedSettings() {
    localStorage.setItem(STORAGE_KEY_PREFIX + 'shared', JSON.stringify(sharedCfg));
  }

  // ================================================================
  // 設定の読み込み（kintone優先、なければlocalStorage）
  // ================================================================
  function loadConfig() {
    return loadFromKintone().then(function(cfg) {
      if (cfg) return cfg;
      return loadFromLocalStorage();
    });
  }

  function loadFromLocalStorage() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY_PREFIX + currentAppId);
      if (raw) return JSON.parse(raw);
    } catch(e) {}
    return { widgets: [] };
  }

  // kintone設定アプリから読み込み
  function loadFromKintone() {
    return new Promise(function(resolve) {
      if (!sharedCfg.configAppId || !sharedCfg.configApiToken) { resolve(null); return; }

      var url = 'https://' + location.hostname + '/k/v1/records.json' +
        '?app=' + encodeURIComponent(sharedCfg.configAppId) +
        '&query=' + encodeURIComponent('source_app_id = "' + currentAppId + '" limit 1');

      kintone.proxy(url, 'GET', { 'X-Cybozu-API-Token': sharedCfg.configApiToken }, {},
        function(body) {
          try {
            var resp = JSON.parse(body);
            if (resp.records && resp.records.length > 0) {
              var rec = resp.records[0];
              var cfg = JSON.parse(rec.dashboard_config.value || '{}');
              cfg._recordId = rec.$id.value;
              resolve(cfg);
            } else {
              resolve(null);
            }
          } catch(e) { resolve(null); }
        },
        function() { resolve(null); }
      );
    });
  }

  // ================================================================
  // DOM構築（ツールバーのみ。設定はビルダーアプリで行う）
  // ================================================================
  function buildDashboardDOM() {
    if (document.getElementById('kintone-dashboard')) return;

    var dash = document.createElement('div');
    dash.id = 'kintone-dashboard';
    dash.innerHTML =
      '<div id="dashboard-toolbar">' +
        '<span class="toolbar-title">📊 ダッシュボード</span>' +
        '<button id="db-refresh-btn" class="db-btn db-btn-secondary">更新</button>' +
        '<button id="db-conn-btn"    class="db-btn db-btn-secondary">⚙ 接続設定</button>' +
      '</div>' +
      '<div id="dashboard-filters" class="hidden"></div>' +
      '<div id="dashboard-grid" class="grid-stack"></div>';

    kintone.app.getHeaderSpaceElement().appendChild(dash);

    gridObj = GridStack.init({
      column: 12, cellHeight: 80, handle: '.widget-header', staticGrid: true
    }, '#dashboard-grid');

    document.getElementById('db-refresh-btn').addEventListener('click', refreshDashboard);
    document.getElementById('db-conn-btn').addEventListener('click', openConnectionModal);
  }

  // ================================================================
  // 接続設定モーダル（設定アプリID + APIトークンをlocalStorageへ保存）
  // ================================================================
  function buildConnectionModal() {
    if (document.getElementById('db-conn-overlay')) return;

    var overlay = document.createElement('div');
    overlay.id = 'db-conn-overlay';
    overlay.className = 'hidden';
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10000;' +
      'display:flex;align-items:center;justify-content:center';
    overlay.innerHTML =
      '<div style="background:#fff;border-radius:8px;padding:24px;width:440px;' +
          'max-width:95vw;box-shadow:0 8px 32px rgba(0,0,0,0.2)">' +
        '<h3 style="margin:0 0 4px;color:#0066cc;font-size:16px">⚙ 接続設定</h3>' +
        '<p style="font-size:12px;color:#888;margin:0 0 20px;line-height:1.6">' +
          'ダッシュボード設定を保存しているkintoneアプリの情報を入力してください。<br>' +
          '設定はこのブラウザのみに保存されます。' +
        '</p>' +
        '<div class="form-row">' +
          '<label>設定アプリID</label>' +
          '<input type="number" id="db-conn-app-id" placeholder="例: 10" min="1">' +
        '</div>' +
        '<div class="form-row">' +
          '<label>APIトークン</label>' +
          '<input type="text" id="db-conn-token" placeholder="設定アプリのAPIトークン">' +
        '</div>' +
        '<div id="db-conn-status" style="font-size:12px;min-height:18px;margin:8px 0;color:#cc0000"></div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">' +
          '<button id="db-conn-cancel" class="db-btn db-btn-secondary">キャンセル</button>' +
          '<button id="db-conn-save"   class="db-btn db-btn-primary">保存して反映</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    document.getElementById('db-conn-cancel').addEventListener('click', closeConnectionModal);
    document.getElementById('db-conn-save').addEventListener('click', saveConnectionAndReload);
  }

  function openConnectionModal() {
    setVal('db-conn-app-id', sharedCfg.configAppId);
    setVal('db-conn-token',  sharedCfg.configApiToken);
    document.getElementById('db-conn-status').textContent = '';
    document.getElementById('db-conn-overlay').classList.remove('hidden');
  }

  function closeConnectionModal() {
    document.getElementById('db-conn-overlay').classList.add('hidden');
  }

  function saveConnectionAndReload() {
    var appId = document.getElementById('db-conn-app-id').value.trim();
    var token = document.getElementById('db-conn-token').value.trim();
    if (!appId || !token) {
      document.getElementById('db-conn-status').textContent = 'アプリIDとAPIトークンを入力してください';
      return;
    }
    sharedCfg.configAppId    = appId;
    sharedCfg.configApiToken = token;
    saveSharedSettings();
    closeConnectionModal();

    // 接続設定を更新後に再読み込みして描画
    loadConfig().then(function(cfg) {
      config = cfg;
      if (config.widgets && config.widgets.length > 0) {
        loadFields().then(fetchRecords).then(function(recs) {
          records = recs;
          renderFilters();
          renderAllWidgets();
        });
      } else {
        var grid = document.getElementById('dashboard-grid');
        if (grid) grid.innerHTML = '<div style="padding:32px;text-align:center;color:#999">ウィジェットがありません。ダッシュボードビルダーで設定してください。</div>';
      }
    });
  }

  // ================================================================
  // フィールド読み込み（テーブルのラベル表示に使用）
  // ================================================================
  function loadFields() {
    return new Promise(function(resolve) {
      kintone.api(kintone.api.url('/k/v1/app/form/fields', false), 'GET', { app: currentAppId },
        function(resp) {
          fieldCache = [];
          Object.keys(resp.properties).forEach(function(code) {
            var p = resp.properties[code];
            fieldCache.push({ code: code, label: p.label, type: p.type });
          });
          resolve();
        },
        function() { resolve(); }
      );
    });
  }

  // ================================================================
  // レコード取得
  // ================================================================
  function fetchRecords() {
    return new Promise(function(resolve, reject) {
      var all = []; var query = buildQuery();
      function page(offset) {
        kintone.api(kintone.api.url('/k/v1/records', false), 'GET', {
          app: currentAppId,
          query: (query ? query + ' ' : '') + 'limit 500 offset ' + offset,
          totalCount: true
        }, function(resp) {
          all = all.concat(resp.records);
          if (resp.records.length === 500 && all.length < resp.totalCount) { page(offset + 500); }
          else { resolve(all); }
        }, function(err) { reject(err); });
      }
      page(0);
    });
  }

  function buildQuery() {
    var conds = [];
    Object.keys(filterVals).forEach(function(k) {
      var fv = filterVals[k]; if (!fv || !fv.field) return;
      switch (fv.type) {
        case 'date_range':
          if (fv.from) conds.push(fv.field + ' >= "' + fv.from + '"');
          if (fv.to)   conds.push(fv.field + ' <= "' + fv.to   + '"');
          break;
        case 'dropdown': if (fv.value) conds.push(fv.field + ' = "'    + fv.value + '"'); break;
        case 'text':     if (fv.value) conds.push(fv.field + ' like "' + fv.value + '"'); break;
      }
    });
    return conds.join(' and ');
  }

  // ================================================================
  // フィルタ描画
  // ================================================================
  function renderFilters() {
    var fw   = (config.widgets || []).filter(function(w) { return w.type === 'filter'; });
    var area = document.getElementById('dashboard-filters');
    area.innerHTML = '';
    if (!fw.length) { area.classList.add('hidden'); return; }
    area.classList.remove('hidden');
    fw.forEach(function(w, i) {
      var item = document.createElement('div'); item.className = 'filter-item';
      var lbl  = document.createElement('label'); lbl.textContent = w.title; item.appendChild(lbl);
      switch (w.filterType) {
        case 'date_range':
          item.appendChild(mkInput('date', function(v) { setFilter(i, w, 'from', v); }));
          item.appendChild(document.createTextNode(' 〜 '));
          item.appendChild(mkInput('date', function(v) { setFilter(i, w, 'to', v); }));
          break;
        case 'dropdown':
          var sel = document.createElement('select');
          sel.innerHTML = '<option value="">すべて</option>';
          getDistinct(records, w.field).forEach(function(v) {
            var o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o);
          });
          sel.addEventListener('change', function() { setFilter(i, w, 'value', sel.value); });
          item.appendChild(sel);
          break;
        case 'text':
          var txt = mkInput('text', function(v) { setFilter(i, w, 'value', v); });
          txt.placeholder = '検索...'; item.appendChild(txt);
          break;
      }
      area.appendChild(item);
    });
  }

  function mkInput(type, onChange) {
    var inp = document.createElement('input'); inp.type = type;
    var t;
    inp.addEventListener('input', function() {
      clearTimeout(t); t = setTimeout(function() { onChange(inp.value); }, 400);
    });
    return inp;
  }

  function setFilter(idx, w, key, val) {
    if (!filterVals[idx]) filterVals[idx] = { type: w.filterType, field: w.field };
    filterVals[idx][key] = val;
    refreshDashboard();
  }

  // ================================================================
  // ウィジェット描画
  // ================================================================
  function renderAllWidgets() {
    var grid = document.getElementById('dashboard-grid');
    grid.innerHTML = ''; chartObjs = {};
    var items = [];
    (config.widgets || []).forEach(function(w, i) {
      if (w.type === 'filter') return;
      var layout = w.layout || { x: (i % 2) * 6, y: Math.floor(i / 2) * 4, w: 6, h: 4 };
      var el = document.createElement('div');
      el.className = 'grid-stack-item';
      el.setAttribute('gs-x', layout.x); el.setAttribute('gs-y', layout.y);
      el.setAttribute('gs-w', layout.w); el.setAttribute('gs-h', layout.h);
      el.setAttribute('gs-id', String(i));
      el.innerHTML =
        '<div class="grid-stack-item-content">' +
          widgetHeader(w) +
          '<div class="widget-body" id="wb-' + i + '"></div>' +
        '</div>';
      grid.appendChild(el);
      items.push({ id: String(i), x: layout.x, y: layout.y, w: layout.w, h: layout.h });
    });
    gridObj.load(items);
    (config.widgets || []).forEach(function(w, i) {
      if (w.type !== 'filter') renderWidgetBody(w, i, records);
    });
  }

  function widgetHeader(w) {
    var info = WIDGET_TYPES[w.type] || { label: w.type, icon: '❓' };
    return '<div class="widget-header">' +
      info.icon + ' ' + escapeHtml(w.title) +
      '<span class="widget-badge">' + info.label + '</span>' +
    '</div>';
  }

  function renderWidgetBody(widget, id, recs) {
    var body = document.getElementById('wb-' + id); if (!body) return;
    try {
      switch (widget.type) {
        case 'number_card':
          body.innerHTML = renderNumberCard(widget, recs);
          break;
        case 'table':
          body.innerHTML = '';
          body.style.cssText = 'display:block;padding:0;overflow:auto';
          body.appendChild(renderTable(widget, recs));
          break;
        case 'bar_chart': renderBarChart(widget, id, body, recs); break;
        case 'pie_chart': renderPieChart(widget, id, body, recs); break;
        default: body.innerHTML = '<div class="widget-msg">未対応</div>';
      }
    } catch(e) {
      body.innerHTML = '<div class="widget-msg error">エラー: ' + escapeHtml(e.message) + '</div>';
    }
  }

  function renderNumberCard(w, recs) {
    var val  = aggregate(recs, w.field, w.aggregation);
    var disp = w.aggregation === 'AVG'
      ? (Math.round(val * 10) / 10).toLocaleString()
      : val.toLocaleString();
    return '<div class="number-card">' +
      '<div class="nc-value">' + disp + '</div>' +
      '<div class="nc-unit">'  + escapeHtml(w.unit || '') + '</div>' +
    '</div>';
  }

  function renderTable(w, recs) {
    var labels = {};
    fieldCache.forEach(function(f) { labels[f.code] = f.label; });
    var tbl   = document.createElement('table'); tbl.className = 'db-table';
    var thead = document.createElement('thead'); var tr = document.createElement('tr');
    (w.fields || []).forEach(function(code) {
      var th = document.createElement('th'); th.textContent = labels[code] || code; tr.appendChild(th);
    });
    thead.appendChild(tr); tbl.appendChild(thead);
    var tbody = document.createElement('tbody');
    recs.slice(0, w.limit || 20).forEach(function(rec) {
      var row = document.createElement('tr');
      (w.fields || []).forEach(function(code) {
        var td = document.createElement('td'); td.textContent = getFieldVal(rec, code); row.appendChild(td);
      });
      tbody.appendChild(row);
    });
    tbl.appendChild(tbody); return tbl;
  }

  function renderBarChart(w, id, body, recs) {
    var grouped = groupBy(recs, w.xField, w.yField, w.aggregation);
    var labels  = Object.keys(grouped);
    var values  = labels.map(function(k) { return grouped[k]; });
    body.innerHTML = '<canvas id="chart-' + id + '"></canvas>';
    body.style.cssText = 'display:block;padding:8px';
    if (chartObjs[id]) chartObjs[id].destroy();
    chartObjs[id] = new Chart(document.getElementById('chart-' + id), {
      type: 'bar',
      data: { labels: labels, datasets: [{
        label: w.title, data: values,
        backgroundColor: 'rgba(0,102,204,0.7)', borderColor: '#0066cc', borderWidth: 1
      }]},
      options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { display: false } } }
    });
  }

  function renderPieChart(w, id, body, recs) {
    var grouped = groupBy(recs, w.labelField, w.valueField, w.aggregation);
    var labels  = Object.keys(grouped);
    var values  = labels.map(function(k) { return grouped[k]; });
    var colors  = labels.map(function(_, i) { return 'hsl(' + (i * 47 % 360) + ',70%,60%)'; });
    body.innerHTML = '<canvas id="chart-' + id + '"></canvas>';
    body.style.cssText = 'display:block;padding:8px';
    if (chartObjs[id]) chartObjs[id].destroy();
    chartObjs[id] = new Chart(document.getElementById('chart-' + id), {
      type: 'pie',
      data: { labels: labels, datasets: [{ data: values, backgroundColor: colors }]},
      options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { position: 'right' } } }
    });
  }

  function refreshDashboard() {
    fetchRecords().then(function(recs) {
      records = recs;
      renderFilters();
      (config.widgets || []).forEach(function(w, i) {
        if (w.type !== 'filter') renderWidgetBody(w, i, records);
      });
    });
  }

  // ================================================================
  // ユーティリティ
  // ================================================================
  function aggregate(recs, code, method) {
    if (method === 'COUNT') return recs.length;
    var nums = recs
      .map(function(r) { return parseFloat(getFieldVal(r, code)); })
      .filter(function(n) { return !isNaN(n); });
    if (!nums.length) return 0;
    var sum = nums.reduce(function(a, b) { return a + b; }, 0);
    return method === 'AVG' ? sum / nums.length : sum;
  }

  function groupBy(recs, labelField, valueField, method) {
    var g = {};
    recs.forEach(function(r) {
      var k = getFieldVal(r, labelField) || '(空)';
      if (!g[k]) g[k] = [];
      g[k].push(r);
    });
    var res = {};
    Object.keys(g).forEach(function(k) { res[k] = aggregate(g[k], valueField, method); });
    return res;
  }

  function getDistinct(recs, code) {
    var seen = {}, vals = [];
    recs.forEach(function(r) {
      var v = getFieldVal(r, code);
      if (v && !seen[v]) { seen[v] = true; vals.push(v); }
    });
    return vals.sort();
  }

  function getFieldVal(rec, code) {
    if (!rec || !rec[code]) return '';
    var v = rec[code].value;
    return (v === null || v === undefined) ? '' : String(v);
  }

  function setVal(id, val) {
    var el = document.getElementById(id);
    if (el && val !== undefined && val !== null) el.value = val;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

})();
