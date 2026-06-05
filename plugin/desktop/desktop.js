(function() {
  'use strict';

  /* ----------------------------------------------------------------
     ライセンス検証（config.js・generate_license.html と同じソルト）
     ---------------------------------------------------------------- */
  var _SALT = 'guke4jmzvkzlqodelp6wr4ygvdti6rrhyte9yrsr';

  function _computeHash(domain) {
    var str = domain.toLowerCase().trim() + _SALT;
    var hash = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return ('0000000' + hash.toString(16)).slice(-8);
  }

  function _validateLicense(key, hostname) {
    if (!key || !key.trim()) {
      return { ok: false, msg: '🔑 ライセンスキーが設定されていません。プラグイン設定画面で入力してください。' };
    }
    var parts = key.trim().split('-');
    if (parts.length !== 4 || parts[0] !== 'KDP' ||
        !/^\d{4}$/.test(parts[1]) || !/^\d{4}$/.test(parts[2])) {
      return { ok: false, msg: '🔑 ライセンスキーの形式が正しくありません。設定画面で再確認してください。' };
    }
    if (hostname === 'localhost') return { ok: true };
    if (!/\.(cybozu\.com|cybozu-dev\.com|cybozu\.cn|kintone\.com)$/.test(hostname)) {
      return { ok: false, msg: '⚠ このプラグインは kintone 環境以外では動作しません。' };
    }
    if (parts[3].toLowerCase() !== _computeHash(hostname)) {
      return { ok: false, msg: '🔑 このドメインではご利用いただけません。ご購入時のドメイン用ライセンスキーをご確認ください。' };
    }
    return { ok: true };
  }

  function _showLicenseError(msg) {
    var sp = kintone.app.getHeaderSpaceElement();
    if (sp) sp.innerHTML = '<div class="db-license-error">' + msg + '</div>';
  }

  var PLUGIN_ID = kintone.$PLUGIN_ID;

  var GRID_COLS = 12;        // グリッド列数
  var CELL_H    = 40;        // セル高さ（px）

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

    // ライセンス検証
    var licResult = _validateLicense(settings.licenseKey, location.hostname);
    if (!licResult.ok) {
      _showLicenseError(licResult.msg);
      return;
    }

    if (!settings.widgets || settings.widgets.length === 0) return;

    // 表示ビューのフィルタ
    if (settings.targetView && event.viewName !== settings.targetView) return;

    // セル高さ変更（80px→40px）に伴うY座標・H値のマイグレーション
    var savedCellH = settings.gridCellH || 80;
    if (savedCellH !== CELL_H) {
      var hFactor = savedCellH / CELL_H;
      settings.widgets = settings.widgets.map(function(w) {
        if (w.layout) {
          w.layout = {
            x: w.layout.x,
            y: Math.round(w.layout.y * hFactor),
            w: w.layout.w,
            h: Math.max(2, Math.round(w.layout.h * hFactor))
          };
        }
        return w;
      });
    }

    // ダッシュボードDOM構築
    buildDashboardDOM();

    // データ取得して描画
    fetchAllRecords()
      .then(function(recs) {
        records = recs;
        renderFilters();
        renderAllWidgets();
      })
      .catch(function(err) {
        console.error('初期データ取得エラー', err);
        var grid = document.getElementById('dashboard-grid');
        if (grid) grid.innerHTML = '<div style="padding:24px;color:#cc0000;text-align:center">データの取得に失敗しました。APIトークンとアプリIDをご確認ください。</div>';
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

    var dashGrid = document.getElementById('dashboard-grid');
    gridObj = GridStack.init({
      column:      GRID_COLS,
      cellHeight:  CELL_H,
      handle:      '.widget-header, .widget-drag-handle',
      draggable:   { enabled: false },
      resizable:   { enabled: false },
      staticGrid:  true
    }, '#dashboard-grid');

    // 背景色適用
    if (settings.dashboardBgColor) {
      dash.style.setProperty('--db-bg', settings.dashboardBgColor);
    }

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
        case 'radio':
          if (fv.value) conditions.push(field + ' = "' + fv.value.replace(/"/g, '\\"') + '"');
          break;
        case 'text':
          if (fv.value) conditions.push(field + ' like "' + fv.value + '"');
          break;
        case 'checkbox':
          if (fv.values && fv.values.length > 0) {
            conditions.push(field + ' in ("' + fv.values.map(function(v) { return v.replace(/"/g, '\\"'); }).join('","') + '")');
          }
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
        case 'checkbox':
          (function(idx, widget) {
            var cbVals = getDistinctValues(records, widget.field);
            var cbGroup = document.createElement('div');
            cbGroup.className = 'filter-check-group';
            cbVals.forEach(function(v) {
              var lbl = document.createElement('label');
              lbl.className = 'filter-check-label';
              var chk = document.createElement('input');
              chk.type = 'checkbox'; chk.value = v;
              chk.addEventListener('change', function() {
                var selected = [];
                cbGroup.querySelectorAll('input:checked').forEach(function(c) { selected.push(c.value); });
                if (!filterVals[idx]) filterVals[idx] = { type: 'checkbox', field: widget.field };
                filterVals[idx].values = selected;
                refreshDashboard();
              });
              lbl.appendChild(chk);
              lbl.appendChild(document.createTextNode(' ' + v));
              cbGroup.appendChild(lbl);
            });
            item.appendChild(cbGroup);
          }(i, w));
          break;
        case 'radio':
          (function(idx, widget) {
            var rdVals = getDistinctValues(records, widget.field);
            var rdGroup = document.createElement('div');
            rdGroup.className = 'filter-check-group';
            var allLbl = document.createElement('label');
            allLbl.className = 'filter-check-label';
            var allRad = document.createElement('input');
            allRad.type = 'radio'; allRad.name = 'frd-' + idx; allRad.value = ''; allRad.checked = true;
            allRad.addEventListener('change', function() { setFilter(idx, widget, 'value', ''); });
            allLbl.appendChild(allRad);
            allLbl.appendChild(document.createTextNode(' すべて'));
            rdGroup.appendChild(allLbl);
            rdVals.forEach(function(v) {
              var lbl = document.createElement('label');
              lbl.className = 'filter-check-label';
              var rad = document.createElement('input');
              rad.type = 'radio'; rad.name = 'frd-' + idx; rad.value = v;
              rad.addEventListener('change', function() { setFilter(idx, widget, 'value', v); });
              lbl.appendChild(rad);
              lbl.appendChild(document.createTextNode(' ' + v));
              rdGroup.appendChild(lbl);
            });
            item.appendChild(rdGroup);
          }(i, w));
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
    gridObj.removeAll(true);
    chartObjs = {};

    var gridEl = document.getElementById('dashboard-grid');

    settings.widgets.forEach(function(w, i) {
      if (w.type === 'filter') return;

      var layout = w.layout || getDefaultLayout(i);
      var itemEl = document.createElement('div');
      itemEl.className = 'grid-stack-item';
      itemEl.setAttribute('gs-x',  layout.x);
      itemEl.setAttribute('gs-y',  layout.y);
      itemEl.setAttribute('gs-w',  layout.w);
      itemEl.setAttribute('gs-h',  layout.h);
      itemEl.setAttribute('gs-id', String(i));
      var isDecoration = (w.type === 'text_box' || w.type === 'shape');
      if (isDecoration) itemEl.classList.add('is-decoration');
      itemEl.innerHTML =
        '<div class="grid-stack-item-content">' +
          (isDecoration ? '<div class="widget-drag-handle">⠿</div>' : '') +
          renderWidgetHeader(w) +
          '<div class="widget-body" id="widget-body-' + i + '"></div>' +
        '</div>';

      gridEl.appendChild(itemEl);
      gridObj.makeWidget(itemEl);
    });

    settings.widgets.forEach(function(w, i) {
      if (w.type === 'filter') return;
      renderWidgetContent(w, i, records);
    });
  }

  function getDefaultLayout(index) {
    var col = (index % 2) * 6;
    var row = Math.floor(index / 2) * 8;
    return { x: col, y: row, w: 6, h: 8 };
  }

  function renderWidgetHeader(w) {
    if (w.type === 'text_box' || w.type === 'shape') return '';
    if (w.showTitle === false) return '';
    var TYPES = {
      number_card: '数値カード', table: 'テーブル',
      bar_chart: '棒グラフ', pie_chart: '円グラフ', filter: 'フィルタ'
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
        case 'text_box':    renderTextBox(widget, body);                      break;
        case 'shape':       renderShape(widget, body);                        break;
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
    var labels = widget.fieldLabels || {};
    fields.forEach(function(code) {
      var th = document.createElement('th');
      th.textContent = labels[code] || code;
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

  // ---- テキストボックス ----
  function renderTextBox(widget, body) {
    body.style.cssText = [
      'display:block', 'overflow:auto', 'padding:12px',
      'font-size:' + (widget.fontSize || 14) + 'px',
      'color:' + (widget.textColor || '#333'),
      'background:' + (widget.bgColor || 'transparent'),
      'text-align:' + (widget.textAlign || 'left'),
      widget.bold ? 'font-weight:bold' : 'font-weight:normal',
      'line-height:1.7', 'white-space:pre-wrap', 'word-break:break-word'
    ].join(';');
    body.textContent = widget.content || '';
  }

  // ---- 図形 ----
  function renderShape(widget, body) {
    body.innerHTML = ''; // 読み込み中... をクリア
    var isLine = widget.shapeType === 'line';
    body.style.cssText = isLine
      ? 'display:flex;align-items:center;justify-content:center;padding:0;width:100%;height:100%;'
      : 'display:block;padding:0;width:100%;height:100%;';
    var d = document.createElement('div');
    var r = widget.shapeType === 'circle' ? '50%'
          : isLine ? '0'
          : (widget.borderRadius || 0) + 'px';
    d.style.cssText = [
      'width:100%',
      'height:' + (isLine ? (widget.lineHeight || 4) + 'px' : '100%'),
      'background:' + (widget.fillColor || '#0066cc'),
      'border-radius:' + r,
      'opacity:' + (widget.opacity !== undefined ? widget.opacity : 1)
    ].join(';');
    body.appendChild(d);
  }

  // ---- 棒グラフ（折れ線・積み上げ含む） ----
  function renderBarChart(widget, id, body, recs) {
    body.innerHTML = '<canvas id="chart-' + id + '"></canvas>';
    body.style.display = 'block';
    body.style.padding = '8px';
    if (chartObjs[id]) chartObjs[id].destroy();
    chartObjs[id] = new Chart(
      document.getElementById('chart-' + id),
      buildBarChartConfig(widget, recs)
    );
  }

  var CHART_PALETTE = [
    'rgba(0,102,204,0.75)', 'rgba(220,80,60,0.75)', 'rgba(40,160,80,0.75)',
    'rgba(255,160,0,0.75)', 'rgba(120,60,180,0.75)', 'rgba(0,180,200,0.75)',
    'rgba(230,100,150,0.75)', 'rgba(80,140,60,0.75)'
  ];

  function buildBarChartConfig(widget, recs) {
    var subType   = widget.chartSubType || 'bar';
    var isStacked = subType === 'stacked_bar' || subType === 'stacked_horizontal';
    var isHoriz   = subType === 'horizontal_bar' || subType === 'stacked_horizontal';
    var isLine    = subType === 'line';
    var chartType = isLine ? 'line' : 'bar';

    var xVals, datasets;
    if (isStacked && widget.stackField) {
      xVals = [];
      recs.forEach(function(r) {
        var v = getFieldValue(r, widget.xField) || '(空)';
        if (xVals.indexOf(v) === -1) xVals.push(v);
      });
      xVals = xVals.slice(0, 20);
      var stackGroups = {};
      recs.forEach(function(r) {
        var sk = getFieldValue(r, widget.stackField) || '(空)';
        if (!stackGroups[sk]) stackGroups[sk] = [];
        stackGroups[sk].push(r);
      });
      var stackKeys = Object.keys(stackGroups).slice(0, 10);
      datasets = stackKeys.map(function(sk, i) {
        var values = xVals.map(function(xv) {
          var sub = stackGroups[sk].filter(function(r) { return (getFieldValue(r, widget.xField) || '(空)') === xv; });
          return aggregate(sub, widget.yField, widget.aggregation);
        });
        return { label: sk, data: values, backgroundColor: CHART_PALETTE[i % CHART_PALETTE.length], borderWidth: 1 };
      });
    } else {
      var grouped = groupBy(recs, widget.xField, widget.yField, widget.aggregation);
      xVals = Object.keys(grouped).slice(0, 20);
      var vals = xVals.map(function(k) { return grouped[k]; });
      datasets = [{ label: widget.title, data: vals, backgroundColor: CHART_PALETTE[0], borderColor: CHART_PALETTE[0].replace('0.75', '1'), borderWidth: 1 }];
    }

    if (isLine) {
      datasets.forEach(function(ds) { ds.tension = 0.3; ds.fill = false; ds.pointRadius = 3; });
    }

    var options = {
      responsive: true, maintainAspectRatio: true,
      plugins: { legend: { display: datasets.length > 1 } }
    };
    if (isHoriz) options.indexAxis = 'y';
    if (isStacked) {
      options.scales = { x: { stacked: true }, y: { stacked: true } };
    }

    return { type: chartType, data: { labels: xVals, datasets: datasets }, options: options };
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

  // ---- 更新（フィルタUIは再描画しない：入力値が消えるバグ防止） ----
  function refreshDashboard() {
    fetchAllRecords()
      .then(function(recs) {
        records = recs;
        settings.widgets.forEach(function(w, i) {
          if (w.type === 'filter') return;
          renderWidgetContent(w, i, records);
        });
      })
      .catch(function(err) {
        console.error('データ取得エラー', err);
        settings.widgets.forEach(function(w, i) {
          if (w.type === 'filter') return;
          var body = document.getElementById('widget-body-' + i);
          if (body) body.innerHTML = '<div class="widget-error">データ取得に失敗しました</div>';
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
