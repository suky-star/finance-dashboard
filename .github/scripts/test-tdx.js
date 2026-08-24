const https = require('https');

const TDX_URL = 'https://txmcp.tdx.com.cn:3001/traemcp';
const TDX_TOKEN = process.env.TDX_TOKEN || 'TDX-89062d6e0ea69b67ae616653dc9f6e4b';

function post(body, sessionId) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = {
      'Authorization': `Bearer ${TDX_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(data),
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const req = https.request(TDX_URL, { method: 'POST', headers }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, session: res.headers['mcp-session-id'], raw }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

function parseMcpResponse(raw) {
  const sseLines = raw.split('\n').filter(l => l.startsWith('data:'));
  if (sseLines.length > 0) return JSON.parse(sseLines.map(l => l.slice(5)).join(''));
  return JSON.parse(raw);
}

async function call(session, name, args) {
  const res = await post({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args } }, session);
  const parsed = parseMcpResponse(res.raw);
  const content = parsed.result?.content || [];
  const text = content.map(c => c.text || '').join('\n');
  const m = text.match(/```json\n([\s\S]*?)```/);
  if (m) return JSON.parse(m[1]);
  // Try raw JSON object at the end of text
  const start = text.indexOf('{');
  if (start >= 0) {
    try { return JSON.parse(text.slice(start)); } catch (e) {}
  }
  return { rawText: text };
}

async function main() {
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } });
  const session = init.session;
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);

  // Sector codes
  const sectors = [
    { code: '880654', name: 'AI/人工智能', setcode: '1' },
    { code: '880521', name: '贵金属', setcode: '1' },
    { code: '880667', name: '数据要素', setcode: '1' },
    { code: '000819', name: '有色金属', setcode: '1' },
    { code: '881394', name: '金融/券商', setcode: '1' },
    { code: '881211', name: '汽车/整车', setcode: '1' },
    { code: '399808', name: '新能源', setcode: '0' },
  ];

  console.log('=== 板块行情 ===');
  for (const s of sectors) {
    try {
      const r = await call(session, 'tdx_quotes', { code: s.code, setcode: s.setcode, hasHQInfo: '1' });
      const hq = r.HQInfo || {};
      const base = r.BaseInfo || {};
      const now = hq.Now;
      const close = hq.Close;
      const gain = now && close ? ((now - close) / close * 100).toFixed(2) : null;
      console.log(`${s.name} [${s.code}] ${base.Name || '?'}: 现价${now} 昨收${close} 涨跌${gain}%`);
    } catch (e) {
      console.log(`${s.name} [${s.code}] ERROR: ${e.message}`);
    }
  }

  // Screener counts
  console.log('\n=== 涨停/跌停 ===');
  for (const q of ['涨停', '跌停']) {
    const r = await call(session, 'tdx_screener', { message: q, pageSize: '1' });
    console.log(`${q}: ${r.meta?.total} 家`);
  }

  // 主力净流入/流出
  console.log('\n=== 主力资金 ===');
  const big = await call(session, 'tdx_screener', { message: '主力净流入', pageSize: '100' });
  const all = (big.data || []).map(d => {
    const amountKey = Object.keys(d).find(k => k.includes('主力净额'));
    return { name: d.sec_name, amount: d[amountKey] || 0 };
  });
  const neg = all.filter(s => s.amount < 0).sort((a, b) => a.amount - b.amount);
  console.log(`主力净流入查询返回 ${all.length} 条，其中负值 ${neg.length} 条`);
  console.log('最大流入:', all.filter(s => s.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 5).map(s => `${s.name} ${(s.amount / 1e8).toFixed(2)}亿`).join(' | '));

  // 主力净流出大页
  for (const q of ['主力净流出最多', '主力资金净流出超过2亿']) {
    const out = await call(session, 'tdx_screener', { message: q, pageSize: '10' });
    const outRows = (out.data || []).map(d => {
      const amountKey = Object.keys(d).find(k => k.includes('主力净额'));
      return `${d.sec_name} ${amountKey ? (d[amountKey] / 1e8).toFixed(2) : '?'}亿`;
    });
    console.log(`${q}: ${outRows.join(' | ')}`);
  }
}

main().catch(e => console.error('ERROR:', e.message));
