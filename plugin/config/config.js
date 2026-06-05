(function() {
  'use strict';

  var PLUGIN_ID = kintone.$PLUGIN_ID;

  // ウィジェット種別の定義
  var WIDGET_TYPES = {
    number_card: { label: '数値カード', icon: '🔢' },
    table:       { label: 'テーブル',   icon: '📋' },
    bar_chart:   { label: '棒グラフ',   icon: '📊' },
    pie_chart:   { label: '円グラフ',   icon: '🥧' },
    filter:      { label: 'フィルタ',   icon: '🔍' }
  };

  var fieldCache = [];      // kintoneから取得したフィールド一覧
  var widgets = [];         // 現在の設定ウィジェット一覧
  var editingIndex = -1;    // 編集中ウィジェットのインデックス（-1=新規追加）

  // ---- 初期化 ----
  function init() {
    var config = kintone.plugin.app.getConfig(PLUGIN_ID);
    if (config.settings) {
      try {
        var settings = JSON.parse(config.settings);
        document.getElementById('api-token').value  = settings.apiToken   || '';
        document.getElementById('app-id').value     = settings.appId      || '';
        document.getElementById('target-view').value = settings.targetView || '';
        widgets = settings.widgets || [];
        renderWidgetList();
      } catch (e) {
        console.error('設定の読み込みに失敗しました', e);
      }
    }
    bindEvents();
  }

  // ---- イベントバインド ----
  function bindEvents() {
    document.getElementById('load-fields-btn').addEventListener('click', loadFields);
    document.getElementById('load-views-btn').addEventListener('click', loadViews);
    document.getElementById('add-widget-btn').addEventListener('click', openAddModal);
    document.getElementById('modal-save-btn').addEventListener('click', saveWidget);
    document.getElementById('modal-cancel-btn').addEventListener('click', closeModal);
    document.getElementById('save-btn').addEventListener('click', saveConfig);
    document.getElementById('cancel-btn').addEventListener('click', function() {
      history.back();
    });
    document.getElementById('widget-type').addEventListener('change', onWidgetTypeChange);
  }

  // ---- ビュー読み込み ----
  function loadViews() {
    var appId    = document.getElementById('app-id').value.trim();
    var statusEl = document.getElementById('view-load-status');
    if (!appId) { showStatus(statusEl, 'アプリIDを入力してください', 'error'); return; }

    showStatus(statusEl, '読み込み中...', '');
    kintone.api(kintone.api.url('/k/v1/app/views', true), 'GET', { app: appId }, function(resp) {
      var sel = document.getElementById('target-view');
      var cur = sel.value;
      sel.innerHTML = '<option value="">すべての一覧に表示</option>';
      Object.keys(resp.views).forEach(function(name) {
        var opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        sel.appendChild(opt);
      });
      if (cur) sel.value = cur;
      showStatus(statusEl, 'ビューを ' + Object.keys(resp.views).length + ' 件読み込みました', 'success');
    }, function(err) {
      showStatus(statusEl, 'ビューの読み込みに失敗しました: ' + (err.message || ''), 'error');
    });
  }

  // ---- フィールド読み込み ----
  function loadFields() {
    var token = document.getElementById('api-token').value.trim();
    var appId = document.getElementById('app-id').value.trim();
    var statusEl = document.getElementById('field-load-status');

    if (!token || !appId) {
      showStatus(statusEl, 'APIトークンとアプリIDを入力してください', 'error');
      return;
    }

    showStatus(statusEl, '読み込み中...', '');

    kintone.api(kintone.api.url('/k/v1/app/form/fields', true), 'GET', { app: appId }, function(resp) {
      fieldCache = [];
      Object.keys(resp.properties).forEach(function(code) {
        var prop = resp.properties[code];
        fieldCache.push({ code: code, label: prop.label, type: prop.type });
      });
      showStatus(statusEl, 'フィールドを ' + fieldCache.length + ' 件読み込みました', 'success');
      updateFieldSelects();
    }, function(err) {
      showStatus(statusEl, 'フィールドの読み込みに失敗しました: ' + (err.message || JSON.stringify(err)), 'error');
    });
  }

  // ---- フィールドセレクトを更新 ----
  function updateFieldSelects() {
    var numericTypes = ['NUMBER', 'CALC', 'RECORD_NUMBER'];
    var textTypes    = ['SINGLE_LINE_TEXT', 'DROP_DOWN', 'RADIO_BUTTON', 'MULTI_LINE_TEXT'];
    var dateTypes    = ['DATE', 'DATETIME'];
    var allFields    = fieldCache;
    var numFields    = fieldCache.filter(function(f) { return numericTypes.indexOf(f.type) !== -1; });
    var strFields    = fieldCache.filter(function(f) { return textTypes.indexOf(f.type) !== -1; });
    var dateFields   = fieldCache.filter(function(f) { return dateTypes.indexOf(f.type) !== -1; });
    var dropFields   = fieldCache.filter(function(f) { return ['DROP_DOWN', 'RADIO_BUTTON'].indexOf(f.type) !== -1; });

    populateSelect('nc-field',     numFields.concat(allFields));
    populateSelect('bar-x',        strFields.concat(allFields));
    populateSelect('bar-y',        numFields);
    populateSelect('pie-label',    strFields.concat(allFields));
    populateSelect('pie-value',    numFields);
    populateSelect('filter-field', allFields);

    // テーブル用チェックボックス
    var container = document.getElementById('table-fields');
    container.innerHTML = '';
    allFields.forEach(function(f) {
      var lbl = document.createElement('label');
      var chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.value = f.code;
      chk.dataset.label = f.label;
      lbl.appendChild(chk);
      lbl.appendChild(document.createTextNode(f.label));
      container.appendChild(lbl);
    });
  }

  function populateSelect(id, fields) {
    var sel = document.getElementById(id);
    var current = sel.value;
    sel.innerHTML = '<option value="">フィールドを選択</option>';
    fields.forEach(function(f) {
      var opt = document.createElement('option');
      opt.value = f.code;
      opt.textContent = f.label + ' (' + f.code + ')';
      sel.appendChild(opt);
    });
    if (current) sel.value = current;
  }

  // ---- ウィジェット一覧を描画 ----
  function renderWidgetList() {
    var listEl = document.getElementById('widget-list');
    if (widgets.length === 0) {
      listEl.innerHTML = '<p class="empty-message">ウィジェットがまだ追加されていません</p>';
      return;
    }
    listEl.innerHTML = '';
    widgets.forEach(function(w, i) {
      var typeInfo = WIDGET_TYPES[w.type] || { label: w.type, icon: '❓' };
      var item = document.createElement('div');
      item.className = 'widget-item';
      item.innerHTML =
        '<span class="widget-icon">' + typeInfo.icon + '</span>' +
        '<div class="widget-info">' +
          '<div class="widget-name">' + escapeHtml(w.title || '（タイトルなし）') + '</div>' +
          '<div class="widget-type">' + typeInfo.label + '</div>' +
        '</div>' +
        '<div class="widget-actions">' +
          '<button class="btn btn-secondary btn-small" data-action="edit" data-index="' + i + '">編集</button>' +
          '<button class="btn btn-danger btn-small" data-action="delete" data-index="' + i + '">削除</button>' +
        '</div>';
      listEl.appendChild(item);
    });

    listEl.querySelectorAll('[data-action="edit"]').forEach(function(btn) {
      btn.addEventListener('click', function() { openEditModal(parseInt(btn.dataset.index)); });
    });
    listEl.querySelectorAll('[data-action="delete"]').forEach(function(btn) {
      btn.addEventListener('click', function() { deleteWidget(parseInt(btn.dataset.index)); });
    });
  }

  // ---- モーダル操作 ----
  function openAddModal() {
    editingIndex = -1;
    document.getElementById('modal-title').textContent = 'ウィジェットを追加';
    resetModal();
    document.getElementById('widget-modal').classList.remove('hidden');
  }

  function openEditModal(index) {
    editingIndex = index;
    document.getElementById('modal-title').textContent = 'ウィジェットを編集';
    var w = widgets[index];
    resetModal();
    document.getElementById('widget-type').value  = w.type  || 'number_card';
    document.getElementById('widget-title').value = w.title || '';
    onWidgetTypeChange();

    // 種別ごとの設定値を復元
    switch (w.type) {
      case 'number_card':
        setValue('nc-field', w.field);
        setValue('nc-agg',   w.aggregation);
        setValue('nc-unit',  w.unit);
        break;
      case 'table':
        setValue('table-limit', w.limit);
        (w.fields || []).forEach(function(code) {
          var chk = document.querySelector('#table-fields input[value="' + code + '"]');
          if (chk) chk.checked = true;
        });
        break;
      case 'bar_chart':
        setValue('bar-x',   w.xField);
        setValue('bar-y',   w.yField);
        setValue('bar-agg', w.aggregation);
        break;
      case 'pie_chart':
        setValue('pie-label', w.labelField);
        setValue('pie-value', w.valueField);
        setValue('pie-agg',   w.aggregation);
        break;
      case 'filter':
        setValue('filter-type',  w.filterType);
        setValue('filter-field', w.field);
        break;
    }
    document.getElementById('widget-modal').classList.remove('hidden');
  }

  function closeModal() {
    document.getElementById('widget-modal').classList.add('hidden');
  }

  function resetModal() {
    document.getElementById('widget-type').value  = 'number_card';
    document.getElementById('widget-title').value = '';
    setValue('nc-field', ''); setValue('nc-agg', 'COUNT'); setValue('nc-unit', '');
    setValue('table-limit', '20');
    document.querySelectorAll('#table-fields input[type="checkbox"]').forEach(function(c) { c.checked = false; });
    setValue('bar-x', ''); setValue('bar-y', ''); setValue('bar-agg', 'SUM');
    setValue('pie-label', ''); setValue('pie-value', ''); setValue('pie-agg', 'SUM');
    setValue('filter-type', 'date_range'); setValue('filter-field', '');
    onWidgetTypeChange();
  }

  function onWidgetTypeChange() {
    var type = document.getElementById('widget-type').value;
    document.querySelectorAll('.widget-config').forEach(function(el) {
      el.classList.add('hidden');
    });
    var target = document.getElementById('config-' + type);
    if (target) target.classList.remove('hidden');
  }

  // ---- ウィジェット保存（モーダル内） ----
  function saveWidget() {
    var type  = document.getElementById('widget-type').value;
    var title = document.getElementById('widget-title').value.trim();

    if (!title) {
      alert('タイトルを入力してください');
      return;
    }

    var widget = { type: type, title: title };

    switch (type) {
      case 'number_card':
        widget.field       = document.getElementById('nc-field').value;
        widget.aggregation = document.getElementById('nc-agg').value;
        widget.unit        = document.getElementById('nc-unit').value;
        if (!widget.field) { alert('集計フィールドを選択してください'); return; }
        break;
      case 'table':
        widget.fields = [];
        document.querySelectorAll('#table-fields input:checked').forEach(function(c) {
          widget.fields.push(c.value);
        });
        widget.limit = parseInt(document.getElementById('table-limit').value) || 20;
        if (widget.fields.length === 0) { alert('表示フィールドを1つ以上選択してください'); return; }
        break;
      case 'bar_chart':
        widget.xField      = document.getElementById('bar-x').value;
        widget.yField      = document.getElementById('bar-y').value;
        widget.aggregation = document.getElementById('bar-agg').value;
        if (!widget.xField || !widget.yField) { alert('X軸・Y軸フィールドを選択してください'); return; }
        break;
      case 'pie_chart':
        widget.labelField  = document.getElementById('pie-label').value;
        widget.valueField  = document.getElementById('pie-value').value;
        widget.aggregation = document.getElementById('pie-agg').value;
        if (!widget.labelField || !widget.valueField) { alert('分類フィールドと数値フィールドを選択してください'); return; }
        break;
      case 'filter':
        widget.filterType = document.getElementById('filter-type').value;
        widget.field      = document.getElementById('filter-field').value;
        if (!widget.field) { alert('対象フィールドを選択してください'); return; }
        break;
    }

    if (editingIndex === -1) {
      widgets.push(widget);
    } else {
      // レイアウト情報を引き継ぐ
      widget.layout = widgets[editingIndex].layout;
      widgets[editingIndex] = widget;
    }

    renderWidgetList();
    closeModal();
  }

  function deleteWidget(index) {
    if (!confirm('このウィジェットを削除しますか？')) return;
    widgets.splice(index, 1);
    renderWidgetList();
  }

  // ---- 設定保存 ----
  function saveConfig() {
    var token = document.getElementById('api-token').value.trim();
    var appId = document.getElementById('app-id').value.trim();

    if (!token) { alert('APIトークンを入力してください'); return; }
    if (!appId) { alert('対象アプリIDを入力してください'); return; }

    var settings = {
      apiToken:   token,
      appId:      appId,
      targetView: document.getElementById('target-view').value,
      widgets:    widgets
    };

    kintone.plugin.app.setConfig({ settings: JSON.stringify(settings) }, function() {
      alert('設定を保存しました');
      history.back();
    });
  }

  // ---- ユーティリティ ----
  function setValue(id, val) {
    var el = document.getElementById(id);
    if (el && val !== undefined && val !== null) el.value = val;
  }

  function showStatus(el, msg, cls) {
    el.textContent = msg;
    el.className   = 'status-message ' + (cls || '');
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---- 起動 ----
  kintone.events.on('app.record.index.show', function() {});
  init();

})();
