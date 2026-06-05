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
  var editMode     = false;
  var fieldCache   = [];

  // ================================================================
  // kintoneイベント
  // ================================================================
  kintone.events.on('app.record.index.show', function(event) {
    currentAppId = kintone.app.getId();
    sharedCfg    = loadSharedSettings();

    buildDashboardDOM();
    buildSettingsPanel();

    // 設定を読み込んでから描画
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
  // 設定の読み書き
  // ================================================================

  // 接続情報（configAppId / configApiToken）はlocalStorageに保存
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

  // 設定本体の読み込み：kintone優先、なければlocalStorage
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

  function saveToLocalStorage(cfg) {
    var save = Object.assign({}, cfg);
    delete save._recordId;
    localStorage.setItem(STORAGE_KEY_PREFIX + currentAppId, JSON.stringify(save));
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
              var rec  = resp.records[0];
              var cfg  = JSON.parse(rec.dashboard_config.value || '{}');
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

  // kintone設定アプリへ保存（新規 or 更新）
  function saveToKintone(cfg) {
    return new Promise(function(resolve) {
      if (!sharedCfg.configAppId || !sharedCfg.configApiToken) { resolve(false); return; }

      var save = Object.assign({}, cfg);
      var recordId = save._recordId;
      delete save._recordId;

      var isUpdate = !!recordId;
      var url = 'https://' + location.hostname + '/k/v1/record' + (isUpdate ? '' : 's') + '.json';
      var body = isUpdate
        ? JSON.stringify({ app: sharedCfg.configAppId, id: recordId, record: { dashboard_config: { value: JSON.stringify(save) } } })
        : JSON.stringify({ app: sharedCfg.configAppId, record: { source_app_id: { value: String(currentAppId) }, dashboard_config: { value: JSON.stringify(save) } } });

      kintone.proxy(url, isUpdate ? 'PUT' : 'POST',
        { 'X-Cybozu-API-Token': sharedCfg.configApiToken, 'Content-Type': 'application/json' },
        body,
        function(respBody) {
          try {
            var resp = JSON.parse(respBody);
            if (!isUpdate && resp.id) cfg._recordId = resp.id;
            resolve(true);
          } catch(e) { resolve(false); }
        },
        function() { resolve(false); }
      );
    });
  }

  // ================================================================
  // DOM構築
  // ================================================================
  function buildDashboardDOM() {
    if (document.getElementById('kintone-dashboard')) return;

    var dash = document.createElement('div');
    dash.id = 'kintone-dashboard';
    dash.innerHTML =
      '<div id="dashboard-toolbar">' +
        '<span class="toolbar-title">📊 ダッシュボード</span>' +
        '<button id="db-refresh-btn" class="db-btn db-btn-secondary">更新</button>' +
        '<button id="db-edit-btn" class="db-btn db-btn-primary">編集モード</button>' +
        '<button id="db-settings-btn" class="db-btn db-btn-secondary">⚙ 設定</button>' +
      '</div>' +
      '<div id="dashboard-filters" class="hidden"></div>' +
      '<div id="dashboard-grid" class="grid-stack"></div>';

    kintone.app.getHeaderSpaceElement().appendChild(dash);

    gridObj = GridStack.init({
      column: 12, cellHeight: 80, handle: '.widget-header', staticGrid: true
    }, '#dashboard-grid');

    document.getElementById('db-refresh-btn').addEventListener('click', refreshDashboard);
    document.getElementById('db-edit-btn').addEventListener('click', toggleEditMode);
    document.getElementById('db-settings-btn').addEventListener('click', openSettingsPanel);
  }

  // ================================================================
  // 設定パネル
  // ================================================================
  function buildSettingsPanel() {
    if (document.getElementById('db-settings-overlay')) return;

    var overlay = document.createElement('div');
    overlay.id = 'db-settings-overlay';
    overlay.className = 'hidden';
    overlay.innerHTML =
      '<div id="db-settings-panel">' +
        '<div class="settings-header">' +
          '<h3>ダッシュボード設定</h3>' +
          '<button id="db-settings-close" class="db-btn db-btn-secondary">✕</button>' +
        '</div>' +
        '<div class="settings-body">' +

          // ---- 共有設定 ----
          '<div class="settings-section-title">共有設定（kintone保存）</div>' +
          '<div class="form-row"><label>設定アプリID</label>' +
            '<input type="number" id="db-cfg-app-id" placeholder="例: 10" min="1">' +
          '</div>' +
          '<div class="form-row"><label>APIトークン</label>' +
            '<input type="text" id="db-cfg-api-token" placeholder="設定アプリのAPIトークン">' +
          '</div>' +
          '<button id="db-cfg-test" class="db-btn db-btn-secondary" style="margin-bottom:4px">接続テスト</button>' +
          '<div id="db-cfg-status" class="cfg-status"></div>' +

          // ---- 表示ビュー ----
          '<div class="settings-section-title" style="margin-top:20px">表示ビュー設定</div>' +
          '<div class="form-row"><label>表示するビュー</label>' +
            '<select id="db-target-view">' +
              '<option value="">すべての一覧に表示</option>' +
            '</select>' +
          '</div>' +

          // ---- ウィジェット ----
          '<div class="settings-section-title" style="margin-top:20px">ウィジェット</div>' +
          '<div id="settings-widget-list"></div>' +
          '<button id="db-add-widget-btn" class="db-btn db-btn-primary" style="width:100%;margin-top:12px">＋ ウィジェットを追加</button>' +
        '</div>' +
        '<div class="settings-footer">' +
          '<button id="db-settings-save" class="db-btn db-btn-primary btn-large">保存して適用</button>' +
        '</div>' +
      '</div>' +

      // ウィジェット追加/編集モーダル
      '<div id="db-widget-modal" class="hidden">' +
        '<div class="widget-modal-content">' +
          '<h4 id="db-modal-title">ウィジェットを追加</h4>' +
          '<div class="form-row"><label>種別</label>' +
            '<select id="db-widget-type">' +
              '<option value="number_card">数値カード</option>' +
              '<option value="table">テーブル</option>' +
              '<option value="bar_chart">棒グラフ</option>' +
              '<option value="pie_chart">円グラフ</option>' +
              '<option value="filter">フィルタ</option>' +
            '</select>' +
          '</div>' +
          '<div class="form-row"><label>タイトル</label><input type="text" id="db-widget-title"></div>' +
          '<div id="wc-number_card" class="widget-config-section">' +
            '<div class="form-row"><label>フィールド</label><select id="db-nc-field"><option value="">選択</option></select></div>' +
            '<div class="form-row"><label>集計</label><select id="db-nc-agg"><option value="COUNT">件数</option><option value="SUM">合計</option><option value="AVG">平均</option></select></div>' +
            '<div class="form-row"><label>単位</label><input type="text" id="db-nc-unit" placeholder="例: 件"></div>' +
          '</div>' +
          '<div id="wc-table" class="widget-config-section hidden">' +
            '<div class="form-row"><label>表示フィールド</label><div id="db-table-fields" class="checkbox-list"></div></div>' +
            '<div class="form-row"><label>最大件数</label><input type="number" id="db-table-limit" value="20" min="1"></div>' +
          '</div>' +
          '<div id="wc-bar_chart" class="widget-config-section hidden">' +
            '<div class="form-row"><label>X軸</label><select id="db-bar-x"><option value="">選択</option></select></div>' +
            '<div class="form-row"><label>Y軸</label><select id="db-bar-y"><option value="">選択</option></select></div>' +
            '<div class="form-row"><label>集計</label><select id="db-bar-agg"><option value="SUM">合計</option><option value="COUNT">件数</option><option value="AVG">平均</option></select></div>' +
          '</div>' +
          '<div id="wc-pie_chart" class="widget-config-section hidden">' +
            '<div class="form-row"><label>分類</label><select id="db-pie-label"><option value="">選択</option></select></div>' +
            '<div class="form-row"><label>数値</label><select id="db-pie-value"><option value="">選択</option></select></div>' +
            '<div class="form-row"><label>集計</label><select id="db-pie-agg"><option value="SUM">合計</option><option value="COUNT">件数</option></select></div>' +
          '</div>' +
          '<div id="wc-filter" class="widget-config-section hidden">' +
            '<div class="form-row"><label>種別</label><select id="db-filter-type"><option value="date_range">日付範囲</option><option value="dropdown">ドロップダウン</option><option value="text">テキスト</option></select></div>' +
            '<div class="form-row"><label>フィールド</label><select id="db-filter-field"><option value="">選択</option></select></div>' +
          '</div>' +
          '<div class="modal-actions">' +
            '<button id="db-modal-save" class="db-btn db-btn-primary">保存</button>' +
            '<button id="db-modal-cancel" class="db-btn db-btn-secondary">キャンセル</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    document.getElementById('db-settings-close').addEventListener('click', closeSettingsPanel);
    document.getElementById('db-add-widget-btn').addEventListener('click', openAddWidgetModal);
    document.getElementById('db-settings-save').addEventListener('click', applySettings);
    document.getElementById('db-modal-save').addEventListener('click', saveWidget);
    document.getElementById('db-modal-cancel').addEventListener('click', closeWidgetModal);
    document.getElementById('db-widget-type').addEventListener('change', onWidgetTypeChange);
    document.getElementById('db-cfg-test').addEventListener('click', testConnection);
  }

  function openSettingsPanel() {
    // 現在の接続設定を画面に反映
    setVal('db-cfg-app-id',    sharedCfg.configAppId);
    setVal('db-cfg-api-token', sharedCfg.configApiToken);
    renderSettingsWidgetList();
    loadViews();
    document.getElementById('db-settings-overlay').classList.remove('hidden');
  }

  function closeSettingsPanel() {
    document.getElementById('db-settings-overlay').classList.add('hidden');
  }

  // 接続テスト
  function testConnection() {
    var appId    = document.getElementById('db-cfg-app-id').value.trim();
    var apiToken = document.getElementById('db-cfg-api-token').value.trim();
    var statusEl = document.getElementById('db-cfg-status');
    if (!appId || !apiToken) { showCfgStatus('アプリIDとAPIトークンを入力してください', 'error'); return; }

    showCfgStatus('接続確認中...', '');
    var url = 'https://' + location.hostname + '/k/v1/app.json?id=' + encodeURIComponent(appId);
    kintone.proxy(url, 'GET', { 'X-Cybozu-API-Token': apiToken }, {},
      function(body) {
        try {
          var resp = JSON.parse(body);
          showCfgStatus('接続成功：' + (resp.name || appId), 'success');
        } catch(e) { showCfgStatus('接続成功（アプリ名取得失敗）', 'success'); }
      },
      function() { showCfgStatus('接続失敗。アプリIDまたはAPIトークンを確認してください', 'error'); }
    );
  }

  function showCfgStatus(msg, type) {
    var el = document.getElementById('db-cfg-status');
    el.textContent = msg;
    el.className = 'cfg-status' + (type ? ' ' + type : '');
  }

  function loadViews() {
    var sel = document.getElementById('db-target-view');
    kintone.api(kintone.api.url('/k/v1/app/views', false), 'GET', { app: currentAppId }, function(resp) {
      sel.innerHTML = '<option value="">すべての一覧に表示</option>';
      Object.keys(resp.views).forEach(function(name) {
        var opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        sel.appendChild(opt);
      });
      sel.value = (config && config.targetView) || '';
    }, function() {});
  }

  // ================================================================
  // 設定の保存・適用
  // ================================================================
  function applySettings() {
    // 接続情報を更新
    sharedCfg.configAppId    = document.getElementById('db-cfg-app-id').value.trim();
    sharedCfg.configApiToken = document.getElementById('db-cfg-api-token').value.trim();
    saveSharedSettings();

    config.targetView = document.getElementById('db-target-view').value;

    // kintoneへ保存し、失敗時はlocalStorageへフォールバック
    saveToKintone(config).then(function(ok) {
      if (!ok) saveToLocalStorage(config);
      closeSettingsPanel();
      loadFields().then(fetchRecords).then(function(recs) {
        records = recs;
        renderFilters();
        renderAllWidgets();
      });
    });
  }

  // ================================================================
  // ウィジェット一覧（設定パネル内）
  // ================================================================
  function renderSettingsWidgetList() {
    var list = document.getElementById('settings-widget-list');
    if (!config || !config.widgets || !config.widgets.length) {
      list.innerHTML = '<p style="color:#999;text-align:center;padding:16px">ウィジェットがまだありません</p>';
      return;
    }
    list.innerHTML = '';
    config.widgets.forEach(function(w, i) {
      var info = WIDGET_TYPES[w.type] || { label: w.type, icon: '❓' };
      var item = document.createElement('div');
      item.className = 'settings-widget-item';
      item.innerHTML =
        '<span class="sw-icon">' + info.icon + '</span>' +
        '<div class="sw-info"><div class="sw-name">' + escapeHtml(w.title) + '</div><div class="sw-type">' + info.label + '</div></div>' +
        '<div class="sw-actions">' +
          '<button class="db-btn db-btn-secondary db-btn-sm" data-action="edit" data-i="' + i + '">編集</button>' +
          '<button class="db-btn db-btn-danger db-btn-sm" data-action="del" data-i="' + i + '">削除</button>' +
        '</div>';
      list.appendChild(item);
    });
    list.querySelectorAll('[data-action="edit"]').forEach(function(btn) {
      btn.addEventListener('click', function() { openEditWidgetModal(parseInt(btn.dataset.i)); });
    });
    list.querySelectorAll('[data-action="del"]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        if (!confirm('削除しますか？')) return;
        config.widgets.splice(parseInt(btn.dataset.i), 1);
        renderSettingsWidgetList();
      });
    });
  }

  // ================================================================
  // ウィジェットモーダル
  // ================================================================
  var editingIndex = -1;

  function openAddWidgetModal() {
    editingIndex = -1;
    document.getElementById('db-modal-title').textContent = 'ウィジェットを追加';
    resetWidgetModal();
    document.getElementById('db-widget-modal').classList.remove('hidden');
  }

  function openEditWidgetModal(i) {
    editingIndex = i;
    var w = config.widgets[i];
    document.getElementById('db-modal-title').textContent = 'ウィジェットを編集';
    resetWidgetModal();
    setVal('db-widget-type', w.type); setVal('db-widget-title', w.title);
    onWidgetTypeChange();
    switch (w.type) {
      case 'number_card': setVal('db-nc-field', w.field); setVal('db-nc-agg', w.aggregation); setVal('db-nc-unit', w.unit); break;
      case 'table':
        (w.fields || []).forEach(function(code) {
          var chk = document.querySelector('#db-table-fields input[value="' + code + '"]');
          if (chk) chk.checked = true;
        });
        setVal('db-table-limit', w.limit || 20);
        break;
      case 'bar_chart': setVal('db-bar-x', w.xField); setVal('db-bar-y', w.yField); setVal('db-bar-agg', w.aggregation); break;
      case 'pie_chart': setVal('db-pie-label', w.labelField); setVal('db-pie-value', w.valueField); setVal('db-pie-agg', w.aggregation); break;
      case 'filter': setVal('db-filter-type', w.filterType); setVal('db-filter-field', w.field); break;
    }
    document.getElementById('db-widget-modal').classList.remove('hidden');
  }

  function closeWidgetModal() { document.getElementById('db-widget-modal').classList.add('hidden'); }

  function resetWidgetModal() {
    setVal('db-widget-type', 'number_card'); setVal('db-widget-title', '');
    setVal('db-nc-field', ''); setVal('db-nc-agg', 'COUNT'); setVal('db-nc-unit', '');
    setVal('db-table-limit', 20);
    document.querySelectorAll('#db-table-fields input').forEach(function(c) { c.checked = false; });
    setVal('db-bar-x', ''); setVal('db-bar-y', ''); setVal('db-bar-agg', 'SUM');
    setVal('db-pie-label', ''); setVal('db-pie-value', ''); setVal('db-pie-agg', 'SUM');
    setVal('db-filter-type', 'date_range'); setVal('db-filter-field', '');
    onWidgetTypeChange();
  }

  function onWidgetTypeChange() {
    var type = document.getElementById('db-widget-type').value;
    document.querySelectorAll('.widget-config-section').forEach(function(el) { el.classList.add('hidden'); });
    var sec = document.getElementById('wc-' + type);
    if (sec) sec.classList.remove('hidden');
  }

  function saveWidget() {
    var type  = document.getElementById('db-widget-type').value;
    var title = document.getElementById('db-widget-title').value.trim();
    if (!title) { alert('タイトルを入力してください'); return; }
    var w = { type: type, title: title };
    switch (type) {
      case 'number_card':
        w.field = document.getElementById('db-nc-field').value;
        w.aggregation = document.getElementById('db-nc-agg').value;
        w.unit = document.getElementById('db-nc-unit').value;
        if (!w.field) { alert('フィールドを選択してください'); return; }
        break;
      case 'table':
        w.fields = [];
        document.querySelectorAll('#db-table-fields input:checked').forEach(function(c) { w.fields.push(c.value); });
        w.limit = parseInt(document.getElementById('db-table-limit').value) || 20;
        if (!w.fields.length) { alert('フィールドを1つ以上選択してください'); return; }
        break;
      case 'bar_chart':
        w.xField = document.getElementById('db-bar-x').value;
        w.yField = document.getElementById('db-bar-y').value;
        w.aggregation = document.getElementById('db-bar-agg').value;
        if (!w.xField || !w.yField) { alert('X軸・Y軸を選択してください'); return; }
        break;
      case 'pie_chart':
        w.labelField = document.getElementById('db-pie-label').value;
        w.valueField = document.getElementById('db-pie-value').value;
        w.aggregation = document.getElementById('db-pie-agg').value;
        if (!w.labelField || !w.valueField) { alert('分類・数値フィールドを選択してください'); return; }
        break;
      case 'filter':
        w.filterType = document.getElementById('db-filter-type').value;
        w.field = document.getElementById('db-filter-field').value;
        if (!w.field) { alert('フィールドを選択してください'); return; }
        break;
    }
    if (editingIndex === -1) { config.widgets.push(w); }
    else { w.layout = config.widgets[editingIndex].layout; config.widgets[editingIndex] = w; }
    closeWidgetModal();
    renderSettingsWidgetList();
  }

  // ================================================================
  // フィールド読み込み
  // ================================================================
  function loadFields() {
    return new Promise(function(resolve) {
      kintone.api(kintone.api.url('/k/v1/app/form/fields', false), 'GET', { app: currentAppId }, function(resp) {
        fieldCache = [];
        Object.keys(resp.properties).forEach(function(code) {
          var p = resp.properties[code];
          fieldCache.push({ code: code, label: p.label, type: p.type });
        });
        updateFieldSelects();
        resolve();
      }, function() { resolve(); });
    });
  }

  function updateFieldSelects() {
    var num = fieldCache.filter(function(f) { return ['NUMBER','CALC','RECORD_NUMBER'].indexOf(f.type) !== -1; });
    var str = fieldCache.filter(function(f) { return ['SINGLE_LINE_TEXT','DROP_DOWN','RADIO_BUTTON'].indexOf(f.type) !== -1; });
    populateSelect('db-nc-field',     num.concat(fieldCache));
    populateSelect('db-bar-x',        str.concat(fieldCache));
    populateSelect('db-bar-y',        num);
    populateSelect('db-pie-label',    str.concat(fieldCache));
    populateSelect('db-pie-value',    num);
    populateSelect('db-filter-field', fieldCache);
    var container = document.getElementById('db-table-fields');
    if (container) {
      container.innerHTML = '';
      fieldCache.forEach(function(f) {
        var lbl = document.createElement('label');
        var chk = document.createElement('input');
        chk.type = 'checkbox'; chk.value = f.code;
        lbl.appendChild(chk);
        lbl.appendChild(document.createTextNode(f.label));
        container.appendChild(lbl);
      });
    }
  }

  function populateSelect(id, fields) {
    var sel = document.getElementById(id); if (!sel) return;
    var cur = sel.value;
    sel.innerHTML = '<option value="">選択してください</option>';
    fields.forEach(function(f) {
      var opt = document.createElement('option');
      opt.value = f.code; opt.textContent = f.label + ' (' + f.code + ')';
      sel.appendChild(opt);
    });
    if (cur) sel.value = cur;
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
        case 'dropdown': if (fv.value) conds.push(fv.field + ' = "' + fv.value + '"'); break;
        case 'text':     if (fv.value) conds.push(fv.field + ' like "' + fv.value + '"'); break;
      }
    });
    return conds.join(' and ');
  }

  // ================================================================
  // フィルタ描画
  // ================================================================
  function renderFilters() {
    var fw = (config.widgets || []).filter(function(w) { return w.type === 'filter'; });
    var area = document.getElementById('dashboard-filters');
    area.innerHTML = '';
    if (!fw.length) { area.classList.add('hidden'); return; }
    area.classList.remove('hidden');
    fw.forEach(function(w, i) {
      var item = document.createElement('div'); item.className = 'filter-item';
      var lbl = document.createElement('label'); lbl.textContent = w.title; item.appendChild(lbl);
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
    var t; inp.addEventListener('input', function() { clearTimeout(t); t = setTimeout(function() { onChange(inp.value); }, 400); });
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
      el.innerHTML = '<div class="grid-stack-item-content">' + widgetHeader(w) + '<div class="widget-body" id="wb-' + i + '"></div></div>';
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
    return '<div class="widget-header">' + info.icon + ' ' + escapeHtml(w.title) + '<span class="widget-badge">' + info.label + '</span></div>';
  }

  function renderWidgetBody(widget, id, recs) {
    var body = document.getElementById('wb-' + id); if (!body) return;
    try {
      switch (widget.type) {
        case 'number_card': body.innerHTML = renderNumberCard(widget, recs); break;
        case 'table': body.innerHTML = ''; body.style.cssText = 'display:block;padding:0;overflow:auto'; body.appendChild(renderTable(widget, recs)); break;
        case 'bar_chart': renderBarChart(widget, id, body, recs); break;
        case 'pie_chart': renderPieChart(widget, id, body, recs); break;
        default: body.innerHTML = '<div class="widget-msg">未対応</div>';
      }
    } catch(e) { body.innerHTML = '<div class="widget-msg error">エラー: ' + escapeHtml(e.message) + '</div>'; }
  }

  function renderNumberCard(w, recs) {
    var val = aggregate(recs, w.field, w.aggregation);
    var disp = w.aggregation === 'AVG' ? (Math.round(val * 10) / 10).toLocaleString() : val.toLocaleString();
    return '<div class="number-card"><div class="nc-value">' + disp + '</div><div class="nc-unit">' + escapeHtml(w.unit || '') + '</div></div>';
  }

  function renderTable(w, recs) {
    var labels = {}; fieldCache.forEach(function(f) { labels[f.code] = f.label; });
    var tbl = document.createElement('table'); tbl.className = 'db-table';
    var thead = document.createElement('thead'); var tr = document.createElement('tr');
    (w.fields || []).forEach(function(code) { var th = document.createElement('th'); th.textContent = labels[code] || code; tr.appendChild(th); });
    thead.appendChild(tr); tbl.appendChild(thead);
    var tbody = document.createElement('tbody');
    recs.slice(0, w.limit || 20).forEach(function(rec) {
      var row = document.createElement('tr');
      (w.fields || []).forEach(function(code) { var td = document.createElement('td'); td.textContent = getVal(rec, code); row.appendChild(td); });
      tbody.appendChild(row);
    });
    tbl.appendChild(tbody); return tbl;
  }

  function renderBarChart(w, id, body, recs) {
    var grouped = groupBy(recs, w.xField, w.yField, w.aggregation);
    var labels = Object.keys(grouped); var values = labels.map(function(k) { return grouped[k]; });
    body.innerHTML = '<canvas id="chart-' + id + '"></canvas>'; body.style.cssText = 'display:block;padding:8px';
    if (chartObjs[id]) chartObjs[id].destroy();
    chartObjs[id] = new Chart(document.getElementById('chart-' + id), {
      type: 'bar', data: { labels: labels, datasets: [{ label: w.title, data: values, backgroundColor: 'rgba(0,102,204,0.7)', borderColor: '#0066cc', borderWidth: 1 }] },
      options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { display: false } } }
    });
  }

  function renderPieChart(w, id, body, recs) {
    var grouped = groupBy(recs, w.labelField, w.valueField, w.aggregation);
    var labels = Object.keys(grouped); var values = labels.map(function(k) { return grouped[k]; });
    var colors = labels.map(function(_, i) { return 'hsl(' + (i * 47 % 360) + ',70%,60%)'; });
    body.innerHTML = '<canvas id="chart-' + id + '"></canvas>'; body.style.cssText = 'display:block;padding:8px';
    if (chartObjs[id]) chartObjs[id].destroy();
    chartObjs[id] = new Chart(document.getElementById('chart-' + id), {
      type: 'pie', data: { labels: labels, datasets: [{ data: values, backgroundColor: colors }] },
      options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { position: 'right' } } }
    });
  }

  // ================================================================
  // 編集モード
  // ================================================================
  function toggleEditMode() {
    editMode = !editMode;
    var dash = document.getElementById('kintone-dashboard');
    var btn  = document.getElementById('db-edit-btn');
    if (editMode) {
      dash.classList.add('edit-mode'); btn.textContent = '編集完了'; btn.className = 'db-btn db-btn-success';
      gridObj.setStatic(false); gridObj.enableMove(true, true); gridObj.enableResize(true, true);
    } else {
      dash.classList.remove('edit-mode'); btn.textContent = '編集モード'; btn.className = 'db-btn db-btn-primary';
      gridObj.setStatic(true);
      gridObj.save().forEach(function(item) {
        var idx = parseInt(item.id);
        if (!isNaN(idx) && config.widgets[idx]) config.widgets[idx].layout = { x: item.x, y: item.y, w: item.w, h: item.h };
      });
      saveToKintone(config).then(function(ok) { if (!ok) saveToLocalStorage(config); });
    }
  }

  function refreshDashboard() {
    fetchRecords().then(function(recs) {
      records = recs; renderFilters();
      (config.widgets || []).forEach(function(w, i) { if (w.type !== 'filter') renderWidgetBody(w, i, records); });
    });
  }

  // ================================================================
  // ユーティリティ
  // ================================================================
  function aggregate(recs, code, method) {
    if (method === 'COUNT') return recs.length;
    var nums = recs.map(function(r) { return parseFloat(getVal(r, code)); }).filter(function(n) { return !isNaN(n); });
    if (!nums.length) return 0;
    var sum = nums.reduce(function(a, b) { return a + b; }, 0);
    return method === 'AVG' ? sum / nums.length : sum;
  }

  function groupBy(recs, labelField, valueField, method) {
    var g = {};
    recs.forEach(function(r) { var k = getVal(r, labelField) || '(空)'; if (!g[k]) g[k] = []; g[k].push(r); });
    var res = {};
    Object.keys(g).forEach(function(k) { res[k] = aggregate(g[k], valueField, method); });
    return res;
  }

  function getDistinct(recs, code) {
    var seen = {}; var vals = [];
    recs.forEach(function(r) { var v = getVal(r, code); if (v && !seen[v]) { seen[v] = true; vals.push(v); } });
    return vals.sort();
  }

  function getVal(rec, code) {
    if (!rec || !rec[code]) return '';
    var v = rec[code].value;
    return v === null || v === undefined ? '' : String(v);
  }

  function setVal(id, val) {
    var el = document.getElementById(id);
    if (el && val !== undefined && val !== null) el.value = val;
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

})();
