(function() {
  'use strict';

  var PLUGIN_ID = kintone.$PLUGIN_ID;

  var WIDGET_TYPES = {
    number_card: { label: '数値カード', icon: '🔢' },
    table:       { label: 'テーブル',   icon: '📋' },
    bar_chart:   { label: '棒グラフ',   icon: '📊' },
    pie_chart:   { label: '円グラフ',   icon: '🥧' },
    filter:      { label: 'フィルタ',   icon: '🔍' }
  };

  var widgets     = [];      // 配置済みウィジェット配列
  var fieldCache  = [];      // フィールド一覧
  var records     = [];      // 取得済みレコード（プレビュー用）
  var gridObj     = null;    // gridstackインスタンス
  var chartObjs   = {};      // Chart.jsインスタンス
  var selectedId  = null;    // 選択中ウィジェットID
  var widgetCount = 0;       // ウィジェットID採番用

  // ================================================================
  // 初期化
  // ================================================================
  (function init() {
    var config = kintone.plugin.app.getConfig(PLUGIN_ID);
    if (config.settings) {
      try {
        var s = JSON.parse(config.settings);
        setVal('api-token', s.apiToken || '');
        setVal('app-id',    s.appId   || '');
        widgets = (s.widgets || []).map(function(w) {
          widgetCount++;
          w.id = w.id || ('w' + widgetCount);
          return w;
        });
        if (s.targetView) {
          var opt = document.createElement('option');
          opt.value = s.targetView; opt.textContent = s.targetView;
          document.getElementById('target-view').appendChild(opt);
          setVal('target-view', s.targetView);
        }
      } catch(e) {}
    }

    initGrid();
    bindEvents();

    // 保存済みウィジェットがある場合はキャンバスに復元
    if (widgets.length > 0) {
      widgets.forEach(function(w) { addWidgetToCanvas(w, false); });
      hideEmpty();
      // データがあればプレビューも試みる
      var token = getVal('api-token');
      var appId = getVal('app-id');
      if (token && appId) loadData(false);
    }
  })();

  // ================================================================
  // gridstack 初期化
  // ================================================================
  function initGrid() {
    gridObj = GridStack.init({
      column:     12,
      cellHeight: 80,
      handle:     '.wp-header',
      margin:     8
    }, '#cfg-grid');

    gridObj.on('change', function() { syncLayoutFromGrid(); });
  }

  function syncLayoutFromGrid() {
    gridObj.save().forEach(function(item) {
      var w = widgets.find(function(x) { return x.id === item.id; });
      if (w) w.layout = { x: item.x, y: item.y, w: item.w, h: item.h };
    });
  }

  // ================================================================
  // イベントバインド
  // ================================================================
  function bindEvents() {
    document.getElementById('btn-load-data').addEventListener('click', function() { loadData(true); });
    document.getElementById('btn-save').addEventListener('click', saveConfig);
    document.getElementById('btn-cancel').addEventListener('click', function() { history.back(); });
    document.getElementById('props-close').addEventListener('click', closeProps);
    document.getElementById('btn-apply-props').addEventListener('click', applyProps);
    document.getElementById('btn-delete-widget').addEventListener('click', deleteSelected);

    // パレット：クリックでウィジェット追加
    document.querySelectorAll('.palette-item').forEach(function(item) {
      item.addEventListener('click', function() {
        addNewWidget(item.dataset.type);
      });
    });

    // プロパティパネル：変更時にリアルタイム更新
    ['p-title','p-nc-agg','p-nc-unit','p-bar-agg','p-pie-agg','p-filter-type'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', applyProps);
    });
    var titleEl = document.getElementById('p-title');
    if (titleEl) titleEl.addEventListener('input', applyProps);
  }

  // ================================================================
  // データ読み込み（フィールド + レコード）
  // ================================================================
  function loadData(showMsg) {
    var token = getVal('api-token').trim();
    var appId = getVal('app-id').trim();
    if (!token || !appId) {
      if (showMsg) setLoadStatus('APIトークンとアプリIDを入力してください', 'err');
      return;
    }
    if (showMsg) setLoadStatus('読み込み中...', '');

    var done = 0;
    function check() { if (++done === 2 && showMsg) { setLoadStatus('読み込み完了', 'ok'); refreshAllPreviews(); } }

    // フィールド取得
    kintone.api(kintone.api.url('/k/v1/app/form/fields', true), 'GET', { app: appId },
      function(resp) {
        fieldCache = [];
        Object.keys(resp.properties).forEach(function(code) {
          var p = resp.properties[code];
          fieldCache.push({ code: code, label: p.label, type: p.type });
        });
        updatePropSelects();

        // ビュー取得も同時に
        kintone.api(kintone.api.url('/k/v1/app/views', true), 'GET', { app: appId },
          function(vResp) {
            var sel = document.getElementById('target-view');
            var cur = sel.value;
            sel.innerHTML = '<option value="">すべての一覧に表示</option>';
            Object.keys(vResp.views).forEach(function(name) {
              var opt = document.createElement('option');
              opt.value = name; opt.textContent = name; sel.appendChild(opt);
            });
            if (cur) sel.value = cur;
          }, function() {}
        );
        check();
      },
      function(err) {
        if (showMsg) setLoadStatus('フィールド取得失敗: ' + (err.message || ''), 'err');
      }
    );

    // レコード取得（最大100件：プレビュー用）
    kintone.api(kintone.api.url('/k/v1/records', true), 'GET', { app: appId, query: 'limit 100' },
      function(resp) { records = resp.records; check(); },
      function()     { records = []; check(); }
    );
  }

  // ================================================================
  // ウィジェット追加
  // ================================================================
  function addNewWidget(type) {
    widgetCount++;
    var id = 'w' + widgetCount;
    var info = WIDGET_TYPES[type] || { label: type, icon: '❓' };
    var w = {
      id:    id,
      type:  type,
      title: info.label,
      layout: { x: 0, y: 0, w: 6, h: 4 }
    };
    if (type === 'number_card') { w.field = ''; w.aggregation = 'COUNT'; w.unit = ''; }
    if (type === 'table')       { w.fields = []; w.limit = 20; }
    if (type === 'bar_chart')   { w.xField = ''; w.yField = ''; w.aggregation = 'SUM'; }
    if (type === 'pie_chart')   { w.labelField = ''; w.valueField = ''; w.aggregation = 'SUM'; }
    if (type === 'filter')      { w.filterType = 'date_range'; w.field = ''; }
    widgets.push(w);
    addWidgetToCanvas(w, true);
    hideEmpty();
    selectWidget(id);
  }

  function addWidgetToCanvas(w, focus) {
    var info   = WIDGET_TYPES[w.type] || { label: w.type, icon: '❓' };
    var layout = w.layout || { x: 0, y: 0, w: 6, h: 4 };

    var el = document.createElement('div');
    el.className = 'grid-stack-item';
    el.setAttribute('gs-id', w.id);
    el.setAttribute('gs-x',  layout.x);
    el.setAttribute('gs-y',  layout.y);
    el.setAttribute('gs-w',  layout.w);
    el.setAttribute('gs-h',  layout.h);
    el.innerHTML =
      '<div class="grid-stack-item-content" id="wc-' + w.id + '">' +
        '<div class="wp-header">' +
          '<span class="wp-badge">' + info.icon + '</span>' +
          '<span class="wp-title" id="wt-' + w.id + '">' + escHtml(w.title) + '</span>' +
          '<button class="wp-del" data-id="' + w.id + '" title="削除">✕</button>' +
        '</div>' +
        '<div class="wp-body" id="wb-' + w.id + '">' +
          '<div class="wp-placeholder">設定してプレビューを表示</div>' +
        '</div>' +
      '</div>';

    var grid = document.getElementById('cfg-grid');
    grid.appendChild(el);
    gridObj.makeWidget(el);

    // クリックで選択
    el.querySelector('.grid-stack-item-content').addEventListener('click', function(e) {
      if (e.target.closest('.wp-del')) return;
      selectWidget(w.id);
    });

    // 削除ボタン
    el.querySelector('.wp-del').addEventListener('click', function(e) {
      e.stopPropagation();
      removeWidget(w.id);
    });

    if (focus) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    renderWidgetPreview(w);
  }

  // ================================================================
  // ウィジェット選択 → プロパティパネル
  // ================================================================
  function selectWidget(id) {
    selectedId = id;
    var w = widgets.find(function(x) { return x.id === id; });
    if (!w) return;

    // 選択ハイライト
    document.querySelectorAll('.grid-stack-item-content').forEach(function(el) {
      el.classList.remove('selected');
    });
    var wc = document.getElementById('wc-' + id);
    if (wc) wc.classList.add('selected');

    // プロパティパネルを表示
    var panel = document.getElementById('cfg-props');
    panel.classList.remove('hidden');

    var info = WIDGET_TYPES[w.type] || { label: w.type, icon: '❓' };
    document.getElementById('props-title-label').textContent = info.icon + ' ' + info.label + '設定';

    // フォームに現在値をセット
    setVal('p-title', w.title || '');
    document.querySelectorAll('.prop-section').forEach(function(s) { s.classList.remove('active'); });
    var sec = document.getElementById('ps-' + w.type);
    if (sec) sec.classList.add('active');

    switch(w.type) {
      case 'number_card':
        setVal('p-nc-field', w.field || '');
        setVal('p-nc-agg',   w.aggregation || 'COUNT');
        setVal('p-nc-unit',  w.unit || '');
        break;
      case 'table':
        setVal('p-table-limit', w.limit || 20);
        document.querySelectorAll('#p-table-fields input').forEach(function(c) {
          c.checked = (w.fields || []).indexOf(c.value) !== -1;
        });
        break;
      case 'bar_chart':
        setVal('p-bar-x',   w.xField || '');
        setVal('p-bar-y',   w.yField || '');
        setVal('p-bar-agg', w.aggregation || 'SUM');
        break;
      case 'pie_chart':
        setVal('p-pie-label', w.labelField || '');
        setVal('p-pie-value', w.valueField || '');
        setVal('p-pie-agg',   w.aggregation || 'SUM');
        break;
      case 'filter':
        setVal('p-filter-type',  w.filterType || 'date_range');
        setVal('p-filter-field', w.field || '');
        break;
    }
  }

  function closeProps() {
    selectedId = null;
    document.getElementById('cfg-props').classList.add('hidden');
    document.querySelectorAll('.grid-stack-item-content').forEach(function(el) {
      el.classList.remove('selected');
    });
  }

  // ================================================================
  // プロパティ適用
  // ================================================================
  function applyProps() {
    if (!selectedId) return;
    var w = widgets.find(function(x) { return x.id === selectedId; });
    if (!w) return;

    w.title = getVal('p-title') || WIDGET_TYPES[w.type].label;
    var titleEl = document.getElementById('wt-' + selectedId);
    if (titleEl) titleEl.textContent = w.title;

    switch(w.type) {
      case 'number_card':
        w.field       = getVal('p-nc-field');
        w.aggregation = getVal('p-nc-agg');
        w.unit        = getVal('p-nc-unit');
        break;
      case 'table':
        w.fields = [];
        document.querySelectorAll('#p-table-fields input:checked').forEach(function(c) { w.fields.push(c.value); });
        w.limit = parseInt(getVal('p-table-limit')) || 20;
        break;
      case 'bar_chart':
        w.xField      = getVal('p-bar-x');
        w.yField      = getVal('p-bar-y');
        w.aggregation = getVal('p-bar-agg');
        break;
      case 'pie_chart':
        w.labelField  = getVal('p-pie-label');
        w.valueField  = getVal('p-pie-value');
        w.aggregation = getVal('p-pie-agg');
        break;
      case 'filter':
        w.filterType = getVal('p-filter-type');
        w.field      = getVal('p-filter-field');
        break;
    }
    renderWidgetPreview(w);
  }

  // ================================================================
  // ウィジェット削除
  // ================================================================
  function deleteSelected() {
    if (selectedId) removeWidget(selectedId);
  }

  function removeWidget(id) {
    var el = document.querySelector('[gs-id="' + id + '"]');
    if (el) gridObj.removeWidget(el);
    if (chartObjs[id]) { chartObjs[id].destroy(); delete chartObjs[id]; }
    widgets = widgets.filter(function(w) { return w.id !== id; });
    if (selectedId === id) closeProps();
    if (widgets.length === 0) showEmpty();
  }

  // ================================================================
  // プレビュー描画
  // ================================================================
  function refreshAllPreviews() {
    widgets.forEach(function(w) { renderWidgetPreview(w); });
  }

  function renderWidgetPreview(w) {
    var body = document.getElementById('wb-' + w.id);
    if (!body) return;

    if (records.length === 0) {
      body.innerHTML = '<div class="wp-placeholder">データ読み込み後に表示されます</div>';
      return;
    }

    try {
      switch(w.type) {
        case 'number_card': renderPreviewNumber(w, body);  break;
        case 'table':       renderPreviewTable(w, body);   break;
        case 'bar_chart':   renderPreviewBar(w, body);     break;
        case 'pie_chart':   renderPreviewPie(w, body);     break;
        case 'filter':      renderPreviewFilter(w, body);  break;
        default: body.innerHTML = '<div class="wp-placeholder">未対応</div>';
      }
    } catch(e) {
      body.innerHTML = '<div class="wp-placeholder" style="color:#c00">エラー: ' + escHtml(e.message) + '</div>';
    }
  }

  function renderPreviewNumber(w, body) {
    if (!w.field && w.aggregation !== 'COUNT') {
      body.innerHTML = '<div class="wp-placeholder">フィールドを選択してください</div>'; return;
    }
    var val  = aggregate(records, w.field, w.aggregation);
    var disp = w.aggregation === 'AVG'
      ? (Math.round(val * 10) / 10).toLocaleString()
      : val.toLocaleString();
    body.style.cssText = 'display:flex;align-items:center;justify-content:center;';
    body.innerHTML =
      '<div class="number-card">' +
        '<div class="nc-value">' + disp + '</div>' +
        '<div class="nc-unit">'  + escHtml(w.unit || '') + '</div>' +
      '</div>';
  }

  function renderPreviewTable(w, body) {
    if (!w.fields || !w.fields.length) {
      body.innerHTML = '<div class="wp-placeholder">フィールドを選択してください</div>'; return;
    }
    var labels = {};
    fieldCache.forEach(function(f) { labels[f.code] = f.label; });
    var tbl   = document.createElement('table'); tbl.className = 'db-table';
    var thead = document.createElement('thead'); var tr = document.createElement('tr');
    w.fields.forEach(function(code) {
      var th = document.createElement('th'); th.textContent = labels[code] || code; tr.appendChild(th);
    });
    thead.appendChild(tr); tbl.appendChild(thead);
    var tbody = document.createElement('tbody');
    records.slice(0, w.limit || 20).forEach(function(rec) {
      var row = document.createElement('tr');
      w.fields.forEach(function(code) {
        var td = document.createElement('td'); td.textContent = getFieldVal(rec, code); row.appendChild(td);
      });
      tbody.appendChild(row);
    });
    tbl.appendChild(tbody);
    body.style.cssText = 'display:block;padding:0;overflow:auto;';
    body.innerHTML = '';
    body.appendChild(tbl);
  }

  function renderPreviewBar(w, body) {
    if (!w.xField || !w.yField) {
      body.innerHTML = '<div class="wp-placeholder">X軸・Y軸を選択してください</div>'; return;
    }
    var grouped = groupBy(records, w.xField, w.yField, w.aggregation);
    var labels  = Object.keys(grouped).slice(0, 20);
    var values  = labels.map(function(k) { return grouped[k]; });
    body.style.cssText = 'display:block;padding:8px;';
    body.innerHTML = '<canvas id="cv-' + w.id + '"></canvas>';
    if (chartObjs[w.id]) { chartObjs[w.id].destroy(); }
    chartObjs[w.id] = new Chart(document.getElementById('cv-' + w.id), {
      type: 'bar',
      data: { labels: labels, datasets: [{
        data: values, backgroundColor: 'rgba(0,102,204,0.7)',
        borderColor: '#0066cc', borderWidth: 1
      }]},
      options: { responsive: true, maintainAspectRatio: true,
        plugins: { legend: { display: false } },
        scales: { x: { ticks: { maxRotation: 45 } } }
      }
    });
  }

  function renderPreviewPie(w, body) {
    if (!w.labelField || !w.valueField) {
      body.innerHTML = '<div class="wp-placeholder">分類・数値フィールドを選択してください</div>'; return;
    }
    var grouped = groupBy(records, w.labelField, w.valueField, w.aggregation);
    var labels  = Object.keys(grouped).slice(0, 15);
    var values  = labels.map(function(k) { return grouped[k]; });
    var colors  = labels.map(function(_, i) { return 'hsl(' + (i * 47 % 360) + ',70%,60%)'; });
    body.style.cssText = 'display:block;padding:8px;';
    body.innerHTML = '<canvas id="cv-' + w.id + '"></canvas>';
    if (chartObjs[w.id]) { chartObjs[w.id].destroy(); }
    chartObjs[w.id] = new Chart(document.getElementById('cv-' + w.id), {
      type: 'pie',
      data: { labels: labels, datasets: [{ data: values, backgroundColor: colors }]},
      options: { responsive: true, maintainAspectRatio: true,
        plugins: { legend: { position: 'right', labels: { font: { size: 10 } } } }
      }
    });
  }

  function renderPreviewFilter(w, body) {
    var fieldLabel = '';
    fieldCache.forEach(function(f) { if (f.code === w.field) fieldLabel = f.label; });
    body.style.cssText = 'display:flex;align-items:center;justify-content:center;flex-direction:column;gap:6px;';
    body.innerHTML =
      '<div style="font-size:11px;color:#888">フィルタ: ' + escHtml(w.filterType || '') + '</div>' +
      '<div style="font-size:13px;font-weight:bold">' + escHtml(fieldLabel || w.field || '(フィールド未選択)') + '</div>';
  }

  // ================================================================
  // プロパティパネルのセレクト更新
  // ================================================================
  function updatePropSelects() {
    var nums = fieldCache.filter(function(f) { return ['NUMBER','CALC','RECORD_NUMBER'].indexOf(f.type) !== -1; });
    var strs = fieldCache.filter(function(f) { return ['SINGLE_LINE_TEXT','DROP_DOWN','RADIO_BUTTON','STATUS'].indexOf(f.type) !== -1; });

    fillSel('p-nc-field',     dedup(nums.concat(fieldCache)));
    fillSel('p-bar-x',        dedup(strs.concat(fieldCache)));
    fillSel('p-bar-y',        nums);
    fillSel('p-pie-label',    dedup(strs.concat(fieldCache)));
    fillSel('p-pie-value',    nums);
    fillSel('p-filter-field', fieldCache);

    var box = document.getElementById('p-table-fields');
    if (box) {
      var checked = [];
      box.querySelectorAll('input:checked').forEach(function(c) { checked.push(c.value); });
      box.innerHTML = '';
      fieldCache.forEach(function(f) {
        var lbl = document.createElement('label');
        var chk = document.createElement('input');
        chk.type = 'checkbox'; chk.value = f.code;
        chk.checked = checked.indexOf(f.code) !== -1;
        lbl.appendChild(chk);
        lbl.appendChild(document.createTextNode(' ' + f.label));
        box.appendChild(lbl);
      });
    }

    // 選択中ウィジェットがあれば再セレクト
    if (selectedId) selectWidget(selectedId);
  }

  function fillSel(id, list) {
    var sel = document.getElementById(id); if (!sel) return;
    var cur = sel.value;
    sel.innerHTML = '<option value="">選択してください</option>';
    list.forEach(function(f) {
      var opt = document.createElement('option');
      opt.value = f.code; opt.textContent = f.label + ' (' + f.code + ')';
      sel.appendChild(opt);
    });
    if (cur) sel.value = cur;
  }

  function dedup(arr) {
    var seen = {}, out = [];
    arr.forEach(function(f) { if (!seen[f.code]) { seen[f.code] = true; out.push(f); } });
    return out;
  }

  // ================================================================
  // 設定保存
  // ================================================================
  function saveConfig() {
    syncLayoutFromGrid();
    var token = getVal('api-token').trim();
    var appId = getVal('app-id').trim();
    if (!token) { alert('APIトークンを入力してください'); return; }
    if (!appId) { alert('アプリIDを入力してください'); return; }

    var settings = {
      apiToken:   token,
      appId:      appId,
      targetView: getVal('target-view'),
      widgets:    widgets
    };
    kintone.plugin.app.setConfig({ settings: JSON.stringify(settings) }, function() {
      alert('設定を保存しました');
      history.back();
    });
  }

  // ================================================================
  // キャンバス空表示の制御
  // ================================================================
  function showEmpty() { document.getElementById('canvas-empty').classList.remove('hidden'); }
  function hideEmpty() { document.getElementById('canvas-empty').classList.add('hidden'); }

  // ================================================================
  // 集計ユーティリティ
  // ================================================================
  function aggregate(recs, code, method) {
    if (method === 'COUNT') return recs.length;
    var nums = recs.map(function(r) { return parseFloat(getFieldVal(r, code)); }).filter(function(n) { return !isNaN(n); });
    if (!nums.length) return 0;
    var sum = nums.reduce(function(a, b) { return a + b; }, 0);
    return method === 'AVG' ? sum / nums.length : sum;
  }

  function groupBy(recs, labelField, valueField, method) {
    var g = {};
    recs.forEach(function(r) {
      var k = getFieldVal(r, labelField) || '(空)';
      if (!g[k]) g[k] = []; g[k].push(r);
    });
    var res = {};
    Object.keys(g).forEach(function(k) { res[k] = aggregate(g[k], valueField, method); });
    return res;
  }

  function getFieldVal(rec, code) {
    if (!rec || !rec[code]) return '';
    var v = rec[code].value;
    return (v === null || v === undefined) ? '' : String(v);
  }

  // ================================================================
  // ユーティリティ
  // ================================================================
  function getVal(id) { var el = document.getElementById(id); return el ? el.value : ''; }
  function setVal(id, v) { var el = document.getElementById(id); if (el && v != null) el.value = v; }
  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function setLoadStatus(msg, cls) {
    var el = document.getElementById('load-status');
    el.textContent = msg;
    el.className = 'load-status' + (cls ? ' ' + cls : '');
  }

})();
