import re

with open('app.js', 'r', encoding='utf-8') as f:
    content = f.read()

new_code = """
  // OAuth 리다이렉트 후 에러 확인용 디버그
  const urlHash = window.location.hash;
  const urlSearch = window.location.search;
  if (urlHash.includes('error') || urlSearch.includes('error')) {
    const errParams = new URLSearchParams(urlHash.replace('#', '?') || urlSearch);
    const errDesc = errParams.get('error_description') || errParams.get('error');
    if ($('#authError')) {
      $('#authError').innerHTML = '인증 에러: ' + decodeURIComponent(errDesc);
      $('#authError').style.display = 'block';
    }
    showToast('인증 에러가 발생했습니다.');
  }

  sb.auth.onAuthStateChange(async (event, session) => {
"""

content = content.replace("  sb.auth.onAuthStateChange(async (event, session) => {", new_code, 1)

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("Added auth debug logic.")
