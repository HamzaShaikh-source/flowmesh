/* FlowMesh Guide page: the voice command list, generated from the grammar and the page pilot so the
   guide cannot drift from what the page understands. Each phrase is a button that tries it. A phrase
   goes through exactly the path a spoken sentence takes (handleText), so nothing here can do more than
   saying it would. Everything is built with textContent. */
(function () {
  'use strict';

  var UI = window.FlowMeshUI;
  if (!UI) return;
  var $ = function (id) { return document.getElementById(id); };
  var el = UI.el;
  var built = false;

  /** The command groups, merged from the grammar and the pilot, with parenthesised notes left as plain text. */
  function groups() {
    var out = [];
    [window.FlowMeshGrammar && window.FlowMeshGrammar.HELP_LIST, window.FlowMeshPilotCore && window.FlowMeshPilotCore.HELP].forEach(function (list) {
      (list || []).forEach(function (group) { out.push(group); });
    });
    return out;
  }

  function render() {
    var holder = $('guideCommands');
    holder.replaceChildren();
    groups().forEach(function (group) {
      var box = el('div');
      box.appendChild(el('h4', null, group[0]));
      var list = el('ul');
      group[1].forEach(function (example) {
        var item = el('li');
        if (/\(/.test(example)) {
          item.className = 'note';
          item.textContent = example;
        } else {
          var button = el('button', null);
          button.type = 'button';
          button.appendChild(el('span', null, '“' + example + '”'));
          var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          icon.setAttribute('class', 'ico sm');
          var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
          use.setAttribute('href', '#i-arrow');
          icon.appendChild(use);
          button.appendChild(icon);
          button.setAttribute('aria-label', 'Try saying: ' + example);
          button.addEventListener('click', function () {
            if (window.FlowMeshVoice && window.FlowMeshVoice.tryPhrase) window.FlowMeshVoice.tryPhrase(example);
          });
          item.appendChild(button);
        }
        list.appendChild(item);
      });
      box.appendChild(list);
      holder.appendChild(box);
    });
    built = true;
  }

  function enter() {
    if (!built) render();
  }

  function init() {
    $('guideHelp').addEventListener('click', function () {
      if (window.FlowMeshVoice && window.FlowMeshVoice.openHelp) window.FlowMeshVoice.openHelp();
    });
    document.addEventListener('flowmesh:route', function (event) { if (event.detail.route === 'guide') enter(); });
    if (window.FlowMeshRouter && window.FlowMeshRouter.current() === 'guide') enter();
  }

  window.FlowMeshGuide = { render: render, groups: groups };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
