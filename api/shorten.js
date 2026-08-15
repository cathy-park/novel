/**
 * 공유 링크의 실제 도메인(novel-iota-mauve.vercel.app)을 안 보이게 짧은 링크로 줄여준다.
 * 1순위 buly.kr(계정 보유, 중간 페이지 없이 바로 리다이렉트) → 실패 시 is.gd → TinyURL 순으로
 * 폴백한다. buly.kr 자격증명(BULY_CUSTOMER_ID, BULY_API_KEY)은 Vercel 환경변수로만 저장하고
 * 이 코드에는 절대 값을 직접 적지 않는다.
 * 브라우저에서 직접 부르면 CORS가 막을 수 있어 서버(이 함수)에서 대신 호출한다.
 * 임의의 url을 받지 않고 slug만 받아 서버가 직접 우리 도메인 링크를 만든다 —
 * 이 엔드포인트가 아무 URL이나 줄여주는 공개 프록시로 악용되지 않게 하기 위함이다.
 */
module.exports = async (req, res) => {
  const slug = req.query.slug;
  if (!slug || typeof slug !== 'string' || !/^[a-z0-9]+$/i.test(slug)) {
    res.status(400).json({ error: '유효하지 않은 slug입니다.' });
    return;
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const longUrl = `https://${host}/share?s=${slug}`;

  async function tryBuly() {
    const customerId = process.env.BULY_CUSTOMER_ID;
    const apiKey = process.env.BULY_API_KEY;
    if (!customerId || !apiKey) throw new Error('buly.kr 환경변수 미설정');

    const body = new URLSearchParams({ customer_id: customerId, partner_api_id: apiKey, org_url: longUrl });
    const r = await fetch('https://www.buly.kr/api/shoturl.siso', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await r.json();
    if (!r.ok || data.result !== 'Y' || !data.url) throw new Error('buly.kr 응답 이상: ' + JSON.stringify(data));
    return data.url.startsWith('http') ? data.url : `https://${data.url}`;
  }

  async function tryPlainShortener(apiUrl) {
    const r = await fetch(apiUrl);
    const text = (await r.text()).trim();
    if (!r.ok || !text.startsWith('http')) throw new Error('단축 서비스 응답 이상: ' + text);
    return text;
  }

  let bulyErrorForDebug = null;
  let bulyShortUrl = null;
  try {
    bulyShortUrl = await tryBuly();
  } catch (e0) {
    console.error('buly.kr 단축 실패:', e0);
    bulyErrorForDebug = String((e0 && e0.message) || e0);
  }

  if (req.query.debug) {
    res.status(200).json({ bulyShortUrl, bulyErrorForDebug, hasCustomerId: !!process.env.BULY_CUSTOMER_ID, hasApiKey: !!process.env.BULY_API_KEY });
    return;
  }

  if (bulyShortUrl) {
    res.status(200).json({ shortUrl: bulyShortUrl });
    return;
  }

  try {
    res.status(200).json({ shortUrl: await tryPlainShortener(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(longUrl)}`) });
    return;
  } catch (e1) {
    console.error('is.gd 단축 실패, TinyURL로 재시도:', e1);
  }

  try {
    res.status(200).json({ shortUrl: await tryPlainShortener(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`) });
  } catch (e2) {
    console.error('TinyURL도 실패:', e2);
    res.status(200).json({ shortUrl: null, longUrl, bulyErrorForDebug });
  }
};
