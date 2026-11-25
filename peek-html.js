const fs = require('fs');
const html = fs.readFileSync('connected-current-state.html', 'utf8');

function peek(label) {
  const idx = html.indexOf(label);
  if (idx === -1) {
    console.log(`--- "${label}" NOT FOUND ---`);
    return;
  }
  console.log(`--- around "${label}" (idx ${idx}) ---`);
  console.log(html.slice(Math.max(0, idx - 50), idx + 400));
  console.log();
}

['방송 시간', '평균 시청자', '동시 최고 시청자', '스트리머 요약 데이터', '지난달'].forEach(peek);
