(function() {
  'use strict';
  kintone.events.on('app.record.index.show', function(event) {
    console.log('テストプラグイン動作中');
    return event;
  });
})();
