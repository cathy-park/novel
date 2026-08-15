/**
 * Google 로그인 버튼이 뜨기 전에 거치는 간단한 아이디/비밀번호 문. Google 계정만 있으면
 * 누구나 회원가입해서 새 서재를 만들 수 있었던 걸 막기 위한 것으로, 데이터/로그인 방식은
 * 전혀 안 건드리고 그 앞에 문 하나만 추가한다. 공유 링크(/share)는 이 문을 거치지 않는
 * 완전히 별도 경로라 영향 없다.
 * 값은 Vercel 환경변수(SITE_GATE_ID, SITE_GATE_PASSWORD)로만 저장하고 클라이언트로는
 * 절대 내려주지 않는다 — 브라우저 JS에 값이 있으면 누구나 소스만 봐도 알 수 있어서 의미가 없다.
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, message: 'POST만 허용됩니다.' });
    return;
  }

  let body = req.body;
  if (!body || typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
  }

  const { id, password } = body || {};
  const expectedId = process.env.SITE_GATE_ID;
  const expectedPassword = process.env.SITE_GATE_PASSWORD;

  const ok = !!expectedId && !!expectedPassword && id === expectedId && password === expectedPassword;
  res.status(200).json({ ok });
};
