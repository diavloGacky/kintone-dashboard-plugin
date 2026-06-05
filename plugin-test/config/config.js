(function() {
  'use strict';
  document.getElementById('save-btn').addEventListener('click', function() {
    kintone.plugin.app.setConfig({}, function() { history.back(); });
  });
})();
