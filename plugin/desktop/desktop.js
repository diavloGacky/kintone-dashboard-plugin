(function() {
  'use strict';

  var PLUGIN_ID = kintone.$PLUGIN_ID;

  var settings   = null;   // プラグイン設定
  var records    = [];     // 取得済みレコード
  var filterVals = {};     // 現在のフィルタ値
  var gridObj    = null;   // gridstackインスタンス
  var chartObjs  = {};     // Chart.jsインスタンス（キー=ウィジェットID）
  var editMode   = false;  // 編集モードフラグ

  // ---- 一覧画面表示イベント ----
  kintone.events.on('app.record.index.show', function(event) {
    // 設定読み込み
    var config = kintone.plugin.app.getConfig(PLUGIN_ID);
    if (!config.settings) return;

    try {
      settings = JSON.parse(config.settings);
    } catch(e) {
      console.error('ダッシュボード設定の解析に失敗しました', e);
      return;
    }

    if (!settings.widgets || settings.widgets.length === 0) return;

    // 表示ビューのフィルタ
    if (settings.targetView && event.viewName !== settings.targetView) return;

    // ダッシュボードDOM構築
    buildDashboardDOM();

    // データ取得して描画
    fetchAllRecords().then(function(recs) {
      records = recs;
      renderFilters();
      renderAllWidgets();
    });
  });

  // ---- DOM構築 ----
  function buildDashboardDOM() {
    if (document.getElementById('kintone-dashboard')) return;

    var dash = document.createElement('div');
    dash.id = 'kintone-dashboard';

    // ツールバー
    var toolbar = document.createElement('div');
    toolbar.id = 'dashboard-toolbar';
    toolbar.innerHTML =
      '<span class="toolbar-title">📊 ダッシュボード</span>' +
      '<button id="db-refresh-btn" class="db-btn db-btn-secondary">更新</button>' +
      '<button id="db-edit-btn" class="db-btn db-btn-primary">編集モード</button>';
    dash.appendChild(toolbar);

    // フィルタエリア
    var filterArea = document.createElement('div');
    filterArea.id = 'dashboard-filters';
    filterArea.className = 'hidden';
    dash.appendChild(filterArea);

    // グリッドエリア
    var grid = document.createElement('div');
    grid.id = 'dashboard-grid';
    grid.className = 'grid-stack';
    dash.appendChild(grid);

    // 一覧画面上部に挿入
    var header = kintone.app.getHeaderSpaceElement();
    header.appendChild(dash);

    // gridstack初期化
    gridObj = GridStack.init({
      column:      12,
      cellHeight:  80,
      handle:      '.widget-header',
      draggable:   { enabled: false },
      resizable:   { enabled: false },
      staticGrid:  true
    }, '#dashboard-grid');

    // ボタンイベント
    document.getElementById('db-refresh-btn').addEventListener('click', refreshDashboard);
    document.getElementById('db-edit-btn').addEventListener('click', toggleEditMode);
  }

  // ---- データ取得 ----
  function fetchAllRecords() {
    return new Promise(function(resolve, reject) {
      var allRecords = [];
      var query = buildQuery();

      function fetchPage(offset) {
        var params = {
          app:    settings.appId,
          query:  query + ' limit 500 offset ' + offset,
          totalCount: true
        };

        kintone.api(kintone.api.url('/k/v1/records', true), 'GET', params, function(resp) {
          allRecords = allRecords.concat(resp.records);
          if (resp.records.length === 500 && allRecords.length < resp.totalCount) {
            fetchPage(offset + 500);
          } else {
            resolve(allRecords);
          }
        }, function(err) {
          console.error('レコード取得エラー', err);
          reject(err);
        });
      }

      fetchPage(0);
    });
  }

  // ---- クエリ構築（フィルタ反映） ----
  function buildQuery() {
    var conditions = [];

    Object.keys(filterVals).forEach(function(widgetId) {
      var fv = filterVals[widgetId];
      if (!fv || !fv.field) return;

      var field = fv.field;
      switch (fv.type) {
        case 'date_range':
          if (fv.from) conditions.push(field + ' >= "' + fv.from + '"');
          if (fv.to)   conditions.push(field + ' <= "' + fv.to   + '"');
          break;
        case 'dropdown':
          if (fv.value) conditions.push(field + ' = "' + fv.value + '"');
          break;
        case 'text':
          if (fv.value) conditions.push(field + ' like "' + fv.value + '"');
          break;
      }
    });

    return conditions.length > 0 ? conditions.join(' and ') : '';
  }

  // ---- フィルタウィジェット描画 ----
  function renderFilters() {
    var filterWidgets = settings.widgets.filter(function(w) { return w.type === 'filter'; });
    var filterArea = document.getElementById('dashboard-filters');

    if (filterWidgets.length === 0) {
      filterArea.classList.add('hidden');
      return;
    }

    filterArea.innerHTML = '';
    filterArea.classList.remove('hidden');

    filterWidgets.forEach(function(w, i) {
      var item = document.createElement('div');
      item.className = 'filter-item';

      var lbl = document.createElement('label');
      lbl.textContent = w.title;
      item.appendChild(lbl);

      switch (w.filterType) {
        case 'date_range':
          var fromInput = makeInput('date', function(v) { setFilter(i, w, 'from', v); });
          var toInput   = makeInput('date', function(v) { setFilter(i, w, 'to',   v); });
          item.appendChild(fromInput);
          item.appendChild(document.createTextNode(' 〜 '));
          item.appendChild(toInput);
          break;
        case 'dropdown':
          var ddValues = getDistinctValues(records, w.field);
          var sel = document.createElement('select');
          sel.innerHTML = '<option value="">すべて</option>';
          ddValues.forEach(function(v) {
            var opt = document.createElement('option');
            opt.value = v; opt.textContent = v;
            sel.appendChild(opt);
          });
          sel.addEventListener('change', function() { setFilter(i, w, 'value', sel.value); });
          item.appendChild(sel);
          break;
        case 'text':
          var txt = makeInput('text', function(v) { setFilter(i, w, 'value', v); });
          txt.placeholder = '検索...';
          item.appendChild(txt);
          break;
      }

      filterArea.appendChild(item);
    });
  }

  function makeInput(type, onChange) {
    var inp = document.createElement('input');
    inp.type = type;
    var timer;
    inp.addEventListener('input', function() {
      clearTimeout(timer);
      timer = setTimeout(function() { onChange(inp.value); }, 400);
    });
    return inp;
  }

  function setFilter(index, widget, key, value) {
    if (!filterVals[index]) {
      filterVals[index] = { type: widget.filterType, field: widget.field };
    }
    filterVals[index][key] = value;
    refreshDashboard();
  }

  // ---- 全ウィジェット描画 ----
  function renderAllWidgets() {
    var gridEl = document.getElementById('dashboard-grid');
    gridEl.innerHTML = '';
    chartObjs = {};

    settings.widgets.forEach(function(w, i) {
      if (w.type === 'filter') return; // フィルタはフィルタエリアに表示

      var layout = w.layout || getDefaultLayout(i);
      var itemEl = document.createElement('div');
      itemEl.className = 'grid-stack-item';
      itemEl.setAttribute('gs-x',  layout.x);
      itemEl.setAttribute('gs-y',  layout.y);
      itemEl.setAttribute('gs-w',  layout.w);
      itemEl.setAttribute('gs-h',  layout.h);
      itemEl.setAttribute('gs-id', String(i));

      var contentEl = document.createElement('div');
      contentEl.className = 'grid-stack-item-content';
      contentEl.innerHTML = renderWidgetHeader(w) + '<div class="widget-body" id="widget-body-' + i + '"></div>';
      itemEl.appendChild(contentEl);
      gridEl.appendChild(itemEl);
    });

    gridObj.load(getGridItems());

    settings.widgets.forEach(function(w, i) {
      if (w.type === 'filter') return;
      renderWidgetContent(w, i, records);
    });
  }

  function getGridItems() {
    var items = [];
    settings.widgets.forEach(function(w, i) {
      if (w.type === 'filter') return;
      var layout = w.layout || getDefaultLayout(i);
      items.push({ id: String(i), x: layout.x, y: layout.y, w: layout.w, h: layout.h });
    });
    return items;
  }

  function getDefaultLayout(index) {
    var col = (index % 2) * 6;
    var row = Math.floor(index / 2) * 4;
    return { x: col, y: row, w: 6, h: 4 };
  }

  function renderWidgetHeader(w) {
    var TYPES = {
      number_card: '数値カード', table: 'テーブル',
      bar_chart: '棒グラフ', pie_chart: '円グラフ'
    };
    return '<div class="widget-header">' +
      escapeHtml(w.title || '') +
      '<span class="widget-type-badge">' + (TYPES[w.type] || w.type) + '</span>' +
    '</div>';
  }

  // ---- ウィジェット内容描画 ----
  function renderWidgetContent(widget, id, recs) {
    var body = document.getElementById('widget-body-' + id);
    if (!body) return;

    body.innerHTML = '<div class="widget-loading">読み込み中...</div>';

    try {
      switch (widget.type) {
        case 'number_card': body.innerHTML = renderNumberCard(widget, recs);  break;
        case 'table':       body.innerHTML = '';
                            body.style.padding = '0';
                            body.style.overflow = 'auto';
                            body.style.display = 'block';
                            body.appendChild(renderTable(widget, recs));       break;
        case 'bar_chart':   renderBarChart(widget, id, body, recs);           break;
        case 'pie_chart':   renderPieChart(widget, id, body, recs);           break;
        default:            body.innerHTML = '<div class="widget-no-data">未対応のウィジェット種別</div>';
      }
    } catch(e) {
      console.error('ウィジェット描画エラー', e);
      body.innerHTML = '<div class="widget-error">描画エラー: ' + escapeHtml(e.message) + '</div>';
    }
  }

  // ---- 数値カード ----
  function renderNumberCard(widget, recs) {
    var value = aggregate(recs, widget.field, widget.aggregation);
    var disp  = widget.aggregation === 'AVG'
      ? (Math.round(value * 10) / 10).toLocaleString()
      : value.toLocaleString();
    return '<div class="number-card">' +
      '<div class="number-value">' + disp + '</div>' +
      '<div class="number-unit">' + escapeHtml(widget.unit || '') + '</div>' +
    '</div>';
  }

  // ---- テーブル ----
  function renderTable(widget, recs) {
    var displayRecs = recs.slice(0, widget.limit || 20);
    var fields = widget.fields || [];

    var table = document.createElement('table');
    table.className = 'dashboard-table';

    // ヘッダー
    var thead = document.createElement('thead');
    var tr = document.createElement('tr');
    fields.forEach(function(code) {
      var th = document.createElement('th');
      th.textContent = code;
      tr.appendChild(th);
    });
    thead.appendChild(tr); table.appendChild(thead);

    // ボディ
    var tbody = document.createElement('tbody');
    displayRecs.forEach(function(rec) {
      var row = document.createElement('tr');
      fields.forEach(function(code) {
        var td = document.createElement('td');
        td.textContent = getFieldValue(rec, code);
        row.appendChild(td);
      });
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    return table;
  }

  // ---- 棒グラフ ----
  function renderBarChart(widget, id, body, recs) {
    var grouped = groupBy(recs, widget.xField, widget.yField, widget.aggregation);
    var labels  = Object.keys(grouped);
    var values  = labels.map(function(k) { return grouped[k]; });

    body.innerHTML = '<canvas id="chart-' + id + '"></canvas>';
    body.style.display = 'block';
    body.style.padding = '8px';

    if (chartObjs[id]) chartObjs[id].destroy();

    chartObjs[id] = new Chart(document.getElementById('chart-' + id), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: widget.title,
          data: values,
          backgroundColor: 'rgba(0, 102, 204, 0.7)',
          borderColor: 'rgba(0, 102, 204, 1)',
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { display: false } }
      }
    });
  }

  // ---- 円グラフ ----
  function renderPieChart(widget, id, body, recs) {
    var grouped = groupBy(recs, widget.labelField, widget.valueField, widget.aggregation);
    var labels  = Object.keys(grouped);
    var values  = labels.map(function(k) { return grouped[k]; });

    body.innerHTML = '<canvas id="chart-' + id + '"></canvas>';
    body.style.display = 'block';
    body.style.padding = '8px';

    var colors = labels.map(function(_, i) {
      var hue = (i * 47) % 360;
      return 'hsl(' + hue + ', 70%, 60%)';
    });

    if (chartObjs[id]) chartObjs[id].destroy();

    chartObjs[id] = new Chart(document.getElementById('chart-' + id), {
      type: 'pie',
      data: {
        labels: labels,
        datasets: [{
          data: values,
          backgroundColor: colors
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { position: 'right' } }
      }
    });
  }

  // ---- 編集モード ----
  function toggleEditMode() {
    editMode = !editMode;
    var dash   = document.getElementById('kintone-dashboard');
    var editBtn = document.getElementById('db-edit-btn');

    if (editMode) {
      dash.classList.add('edit-mode');
      editBtn.textContent = '編集完了';
      editBtn.className   = 'db-btn db-btn-success';
      gridObj.setStatic(false);
      gridObj.enableMove(true, true);
      gridObj.enableResize(true, true);
    } else {
      dash.classList.remove('edit-mode');
      editBtn.textContent = '編集モード';
      editBtn.className   = 'db-btn db-btn-primary';
      gridObj.setStatic(true);
      saveLayout();
    }
  }

  // ---- レイアウト保存 ----
  function saveLayout() {
    var items = gridObj.save();
    items.forEach(function(item) {
      var idx = parseInt(item.id);
      if (!isNaN(idx) && settings.widgets[idx]) {
        settings.widgets[idx].layout = { x: item.x, y: item.y, w: item.w, h: item.h };
      }
    });

    var config = kintone.plugin.app.getConfig(PLUGIN_ID);
    var current = {};
    try { current = JSON.parse(config.settings || '{}'); } catch(e) {}
    current.widgets = settings.widgets;
    kintone.plugin.app.setConfig({ settings: JSON.stringify(current) });
  }

  // ---- 更新 ----
  function refreshDashboard() {
    fetchAllRecords().then(function(recs) {
      records = recs;
      renderFilters();
      settings.widgets.forEach(function(w, i) {
        if (w.type === 'filter') return;
        renderWidgetContent(w, i, records);
      });
    });
  }

  // ---- 集計ユーティリティ ----
  function aggregate(recs, fieldCode, method) {
    if (method === 'COUNT') return recs.length;
    var nums = recs.map(function(r) { return parseFloat(getFieldValue(r, fieldCode)); }).filter(function(n) { return !isNaN(n); });
    if (nums.length === 0) return 0;
    if (method === 'SUM') return nums.reduce(function(a, b) { return a + b; }, 0);
    if (method === 'AVG') return nums.reduce(function(a, b) { return a + b; }, 0) / nums.length;
    return 0;
  }

  function groupBy(recs, labelField, valueField, method) {
    var groups = {};
    recs.forEach(function(r) {
      var key = getFieldValue(r, labelField) || '(空)';
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    });
    var result = {};
    Object.keys(groups).forEach(function(k) {
      result[k] = aggregate(groups[k], valueField, method);
    });
    return result;
  }

  function getDistinctValues(recs, fieldCode) {
    var seen = {};
    var vals = [];
    recs.forEach(function(r) {
      var v = getFieldValue(r, fieldCode);
      if (v && !seen[v]) { seen[v] = true; vals.push(v); }
    });
    return vals.sort();
  }

  function getFieldValue(record, fieldCode) {
    if (!record[fieldCode]) return '';
    var v = record[fieldCode].value;
    if (v === null || v === undefined) return '';
    return String(v);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

})();
