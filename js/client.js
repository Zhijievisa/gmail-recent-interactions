/* Connector: registers the single capability this Power-Up uses. */
(function () {
  'use strict';

  var ICON = new URL('./img/icon-gray.svg', window.location.href).href;

  window.TrelloPowerUp.initialize({
    'card-back-section': function (t) {
      return {
        title: 'Recent interactions',
        icon: ICON, // Trello requires a gray icon here
        content: {
          type: 'iframe',
          url: t.signUrl('./section.html'),
          height: 72 // starting height; section.js resizes to fit its content
        }
      };
    }
  });
})();
