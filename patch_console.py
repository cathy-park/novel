import re

with open('app.js', 'r', encoding='utf-8') as f:
    content = f.read()

debug_js = """
  // 화면 디버깅 창 추가
  const dbg = document.createElement('div');
  dbg.style.cssText = 'position:fixed;bottom:0;left:0;right:0;max-height:30%;background:rgba(0,0,0,0.8);color:#0f0;font-family:monospace;font-size:11px;overflow-y:auto;z-index:99999;padding:10px;pointer-events:none;';
  document.body.appendChild(dbg);
  
  const origLog = console.log;
  const origErr = console.error;
  console.log = function(...args) {
    origLog(...args);
    dbg.innerHTML += '<div>LOG: ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ') + '</div>';
    dbg.scrollTop = dbg.scrollHeight;
  };
  console.error = function(...args) {
    origErr(...args);
    dbg.innerHTML += '<div style="color:red">ERR: ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ') + '</div>';
    dbg.scrollTop = dbg.scrollHeight;
  };
"""

content = content.replace("async function initApp() {", "async function initApp() {\n" + debug_js, 1)

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("Added console to screen patch.")
