const fs = require('fs');

const cookies = JSON.parse(fs.readFileSync('auth-cookies.json', 'utf8'));
const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

const url =
  'https://viewership.softc.one/channel/naverchzzk/f0b10f21e94c0bb8715111f5436cdecb?date=lastmonth';

(async () => {
  const res = await fetch(url, {
    headers: {
      cookie: cookieHeader,
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
    },
  });
  console.log('STATUS:', res.status);
  const html = await res.text();
  fs.writeFileSync('plain-fetch-result.html', html);
  console.log('TITLE:', (html.match(/<title>(.*?)<\/title>/) || [])[1]);

  function extract(label) {
    const re = new RegExp(
      label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '</div><div class="leading-none text-xl font-bold">([\\d.]+)'
    );
    const m = html.match(re);
    return m ? m[1] : null;
  }

  console.log('방송 시간:', extract('방송 시간'));
  console.log('평균 시청자:', extract('평균 시청자'));
  console.log('동시 최고 시청자:', extract('동시 최고 시청자'));
})();
