import re

with open('app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Define the exact block to remove
debug_block = """  // 화면 디버깅 창 추가
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

if debug_block in content:
    content = content.replace(debug_block, "")
    print("Removed on-screen console logs.")
else:
    print("Could not find on-screen console logs.")

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(content)
