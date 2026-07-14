import re

with open('app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Replace signInWithOAuth to omit redirectTo so it uses the configured Site URL,
# or handle any errors.
old_login = """  $('#googleLoginBtn').onclick = async () => {
    $('#googleLoginBtn').style.opacity = '0.7';
    $('#googleLoginBtn').textContent = '로그인 중...';
    try {
      const { data, error } = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin
        }
      });
      if(error) throw error;
    } catch(err) {"""

new_login = """  $('#googleLoginBtn').onclick = async () => {
    $('#googleLoginBtn').style.opacity = '0.7';
    $('#googleLoginBtn').textContent = '로그인 중...';
    try {
      const { data, error } = await sb.auth.signInWithOAuth({
        provider: 'google'
      });
      if(error) throw error;
    } catch(err) {"""

if old_login in content:
    content = content.replace(old_login, new_login, 1)
    print("Patched signInWithOAuth to remove redirectTo.")
else:
    print("Could not find signInWithOAuth block.")

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(content)
