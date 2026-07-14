import re

with open('app.js', 'r', encoding='utf-8') as f:
    content = f.read()

old_get_session = """  sb.auth.getSession().then(async ({ data: { session } }) => {"""
new_get_session = """  sb.auth.getSession().then(async ({ data: { session }, error }) => {
    if (error) {
      console.error("getSession error:", error);
      if($('#authError')) {
        $('#authError').innerHTML = '세션 확인 에러: ' + error.message;
        $('#authError').style.display = 'block';
      }
    }"""

if old_get_session in content:
    content = content.replace(old_get_session, new_get_session, 1)
    print("Patched getSession to log errors.")
else:
    print("Could not find getSession block.")

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(content)
