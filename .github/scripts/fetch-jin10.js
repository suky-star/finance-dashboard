/**
 * 金十数据 MCP 抓取脚本
 * 使用金十数据获取行情、新闻、快讯，并生成各页面分析
 * 
 * 配置环境变量: JIN10_TOKEN (金十MCP授权token)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const MCP_URL = 'https://mcp.jin10.com/mcp';
const TOKEN = process.env.JIN10_TOKEN || 'sk-yxzHj1ElEfADgUMBRncgchcz8nOVi0540_x0yFTg2ZY';

let sessionId = '';
let msgId = 1;

// ============= MCP 基础函数 =============

function parseSSE(body) {
  const lines = body.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try { return JSON.parse(line.substring(6)); } catch(e) {}
    }
  }
  return null;
}

function mcpCall(method, params, id) {
  return new Promise((resolve, reject) => {
    const bodyObj = { jsonrpc: '2.0', method, params };
    if (id !== undefined) bodyObj.id = id;
    const body = JSON.stringify(bodyObj);
    
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': 'Bearer ' + TOKEN,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    
    const options = { method: 'POST', headers };
    const req = https.request(MCP_URL, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.headers['mcp-session-id']) {
          sessionId = res.headers['mcp-session-id'];
        }
        const result = parseSSE(data);
        if (result) resolve(result);
        else resolve({ result: {} });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function initSession() {
  await mcpCall('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'finance-dashboard', version: '2.0.0' }
  }, msgId++);
  
  await mcpCall('notifications/initialized', {});
  console.log('✓ 金十MCP会话已建立');
}

async function callTool(name, args = {}) {
  const result = await mcpCall('tools/call', { name, arguments: args }, msgId++);
  if (result.error) {
    throw new Error(`工具调用失败 [${name}]: ${result.error.message}`);
  }
  return result.result?.structuredContent?.data;
}

// ============= 数据获取 =============

async function fetchQuotes(codes) {
  const quotes = {};
  for (const code of codes) {
    try {
      const data = await callTool('get_quote', { code });
      if (data) {
        quotes[code] = {
          code: data.code,
          name: data.name,
          price: parseFloat(data.close),
          change: parseFloat(data.ups_price),
          changePercent: parseFloat(data.ups_percent),
          open: parseFloat(data.open),
          high: parseFloat(data.high),
          low: parseFloat(data.low),
          volume: data.volume,
          time: data.time,
        };
      }
    } catch (e) {
      console.log(`  ⚠ 获取 ${code} 失败: ${e.message}`);
    }
  }
  return quotes;
}

async function fetchFlash(count = 20) {
  try {
    const data = await callTool('list_flash', {});
    return (data.items || []).slice(0, count).map(item => ({
      id: item.id || Math.random().toString(36).slice(2),
      title: item.title || item.content || '',
      content: item.content || item.title || '',
      time: item.time || item.pub_time || '',
      type: item.type || 'flash',
      important: item.important || item.star || false,
    }));
  } catch (e) {
    console.log('  ⚠ 获取快讯失败:', e.message);
    return [];
  }
}

async function fetchNews(count = 20) {
  try {
    const data = await callTool('list_news', {});
    return (data.items || []).slice(0, count).map(item => ({
      id: item.id || Math.random().toString(36).slice(2),
      title: item.title || '',
      intro: item.introduction || item.intro || '',
      time: item.time || '',
      url: item.url || '',
      type: 'news',
    }));
  } catch (e) {
    console.log('  ⚠ 获取资讯失败:', e.message);
    return [];
  }
}

async function fetchCalendar() {
  try {
    const data = await callTool('list_calendar', {});
    return (data || []).map(item => ({
      time: item.pub_time || '',
      title: item.title || '',
      star: item.star || 0,
      previous: item.previous || '',
      consensus: item.consensus || '',
      actual: item.actual || '',
      affect: item.affect_txt || '',
    }));
  } catch (e) {
    console.log('  ⚠ 获取财经日历失败:', e.message);
    return [];
  }
}

// ============= 分析生成 =============

function generateUsAnalysis(quotes, news) {
  // 金十MCP里美股指数可能用不同的code，先用贵金属和原油数据
  // 如果有美股指数，用美股指数；没有就用黄金白银原油来做国际市场分析
  const xau = quotes['XAUUSD'];
  const xag = quotes['XAGUSD'];
  const oil = quotes['USOIL'];
  const copper = quotes['COPPER'];
  
  const items = [xau, xag, oil, copper].filter(Boolean);
  if (items.length === 0) return null;
  
  const upCount = items.filter(i => i.changePercent > 0).length;
  const allUp = upCount === items.length;
  const allDown = upCount === 0;
  const avgChange = items.reduce((s, i) => s + i.changePercent, 0) / items.length;
  
  let statusLabel = '';
  let statusColor = '';
  if (allUp && avgChange > 1) { statusLabel = '大宗商品普涨'; statusColor = 'rise'; }
  else if (allDown && avgChange < -1) { statusLabel = '大宗商品普跌'; statusColor = 'fall'; }
  else if (avgChange > 0.3) { statusLabel = '商品整体偏强'; statusColor = 'rise'; }
  else if (avgChange < -0.3) { statusLabel = '商品整体偏弱'; statusColor = 'fall'; }
  else { statusLabel = '商品分化震荡'; statusColor = avgChange >= 0 ? 'rise' : 'fall'; }
  
  // 从新闻提取因素
  const keywords = ['美联储', '美债', '美元', '通胀', '降息', '加息', '非农', 'CPI', 'PCE', '地缘', '原油', 'OPEC', '黄金', '白银'];
  const relatedNews = news.filter(n => 
    keywords.some(kw => (n.title || '').includes(kw) || (n.intro || '').includes(kw))
  ).slice(0, 4);
  
  const factors = relatedNews.map(n => n.title).filter(t => t && t.length > 8);
  
  if (factors.length < 2) {
    if (xau && xau.changePercent > 1) factors.push('避险情绪升温支撑贵金属走强');
    else if (oil && oil.changePercent > 0) factors.push('原油供应端担忧持续发酵');
    else if (avgChange < 0) factors.push('美元走强压制大宗商品表现');
    else factors.push('全球宏观经济预期边际改善');
    
    if (xag && Math.abs(xag.changePercent) > 2) factors.push('白银波动放大，商品属性主导');
    else factors.push('市场等待美联储政策信号指引');
  }
  
  // 亮点品种
  const highlights = items
    .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
    .slice(0, 4)
    .map(i => ({ name: i.name, change: i.changePercent, positive: i.changePercent > 0 }));
  
  return {
    statusLabel,
    statusColor,
    items,
    summary: generateCommoditySummary(items, allUp, allDown, avgChange),
    factors: factors.slice(0, 4),
    highlights,
  };
}

function generateCommoditySummary(items, allUp, allDown, avgChange) {
  const xau = items.find(i => i.code === 'XAUUSD');
  const xag = items.find(i => i.code === 'XAGUSD');
  const oil = items.find(i => i.code === 'USOIL');
  const copper = items.find(i => i.code === 'COPPER');
  
  let s = '国际大宗商品市场';
  if (allUp) s += '全线上涨';
  else if (allDown) s += '普遍下跌';
  else s += '涨跌互现';
  s += '。';
  
  if (xau) {
    s += `现货黄金${xau.changePercent >= 0 ? '上涨' : '下跌'}${Math.abs(xau.changePercent).toFixed(2)}%，报${xau.price.toFixed(2)}美元/盎司。`;
  }
  if (xag) {
    s += `白银${xag.changePercent >= 0 ? '涨' : '跌'}${Math.abs(xag.changePercent).toFixed(2)}%。`;
  }
  if (oil) {
    s += `WTI原油${oil.changePercent >= 0 ? '上涨' : '下跌'}${Math.abs(oil.changePercent).toFixed(2)}%，报${oil.price.toFixed(2)}美元/桶。`;
  }
  if (copper) {
    s += `伦铜${copper.changePercent >= 0 ? '上涨' : '下跌'}${Math.abs(copper.changePercent).toFixed(2)}%。`;
  }
  
  return s;
}

function generateMetalsAnalysis(quotes, news) {
  const xau = quotes['XAUUSD'];
  const xag = quotes['XAGUSD'];
  
  if (!xau && !xag) return null;
  
  const goldUp = xau ? xau.changePercent >= 0 : true;
  const silverUp = xag ? xag.changePercent >= 0 : true;
  const bothUp = goldUp && silverUp;
  const bothDown = !goldUp && !silverUp;
  
  let statusLabel = '';
  let statusColor = '';
  if (bothUp && xau && xau.changePercent > 1) { statusLabel = '强势上涨'; statusColor = 'rise'; }
  else if (bothDown && xau && xau.changePercent < -1) { statusLabel = '明显回调'; statusColor = 'fall'; }
  else if (bothUp) { statusLabel = '偏强震荡'; statusColor = 'rise'; }
  else if (bothDown) { statusLabel = '偏弱整理'; statusColor = 'fall'; }
  else { statusLabel = '金银分化'; statusColor = 'rise'; }
  
  // 从新闻提取贵金属相关
  const metalKeywords = ['黄金', '白银', '贵金属', '金价', '银价', '美联储', '降息', '美债', '美元', '地缘', '避险'];
  const metalNews = news.filter(n => 
    metalKeywords.some(kw => (n.title || '').includes(kw) || (n.intro || '').includes(kw))
  ).slice(0, 5);
  
  const factors = metalNews.map(n => n.title).filter(t => t && t.length > 8);
  
  if (factors.length < 2) {
    if (bothUp) {
      factors.push('地缘政治风险持续，避险需求支撑贵金属');
      factors.push('美联储降息预期提振贵金属中长期走势');
    } else if (bothDown) {
      factors.push('美元走强压制贵金属价格');
      factors.push('市场对降息路径预期分歧加剧');
    } else {
      factors.push('多空因素交织，贵金属走势分化');
      factors.push('市场等待关键经济数据指引');
    }
  }
  
  // 技术面解读
  const techViews = [];
  if (xau) {
    if (xau.changePercent > 1) techViews.push({ text: '金价突破关键阻力位，短期趋势偏多', positive: true });
    else if (xau.changePercent < -1) techViews.push({ text: '金价跌破短期支撑，注意回调风险', positive: false });
    else techViews.push({ text: '金价高位震荡，方向待选择', positive: null });
  }
  if (xag && Math.abs(xag.changePercent) > 1.5) {
    techViews.push({ 
      text: `白银波动加剧，${silverUp ? '商品属性发力上攻' : '工业需求担忧拖累'}`, 
      positive: silverUp 
    });
  }
  
  return {
    statusLabel,
    statusColor,
    xau,
    xag,
    summary: generateGoldSummary(xau, xag, bothUp, bothDown),
    factors: factors.slice(0, 4),
    techViews,
  };
}

function generateGoldSummary(xau, xag, bothUp, bothDown) {
  let s = '';
  if (xau) {
    s = `现货黄金${xau.changePercent >= 0 ? '上涨' : '下跌'}${Math.abs(xau.changePercent).toFixed(2)}%，报${xau.price.toFixed(2)}美元/盎司`;
    if (xag) {
      s += `；白银${xag.changePercent >= 0 ? '上涨' : '下跌'}${Math.abs(xag.changePercent).toFixed(2)}%，报${xag.price.toFixed(2)}美元/盎司`;
    }
    s += '。';
  }
  
  if (bothUp && xau && xau.changePercent > 1.5) {
    s += '贵金属市场情绪高涨，资金涌入避险资产。';
  } else if (bothDown && xau && xau.changePercent < -1) {
    s += '贵金属遭遇获利了结，短期承压明显。';
  } else if (xag && Math.abs(xag.changePercent) > Math.abs(xau?.changePercent || 0)) {
    s += '白银波动大于黄金，商品属性主导走势。';
  }
  
  return s;
}

function generateConceptAnalysis(news) {
  // 从新闻中提取热门概念
  const conceptMap = {};
  
  const conceptKeywords = {
    'AI/人工智能': ['AI', '人工智能', '大模型', 'GPT', '算力', '芯片', '半导体', '英伟达'],
    '新能源': ['新能源', '光伏', '风电', '储能', '锂电池', '宁德时代', '比亚迪'],
    '贵金属': ['黄金', '白银', '贵金属', '金价', '避险'],
    '原油/能源': ['原油', '石油', 'OPEC', '油价', '天然气', '煤炭'],
    '有色金属': ['铜', '铝', '锌', '镍', '有色', '矿产'],
    '美联储/降息': ['美联储', '降息', '加息', '鲍威尔', '美债', '美元'],
    '地缘政治': ['地缘', '战争', '冲突', '中东', '俄乌', '制裁'],
    '消费/内需': ['消费', '内需', '零售', '旅游', '餐饮', '白酒'],
    '医药/创新药': ['医药', '创新药', 'CXO', '生物科技', '疫苗'],
    '房地产': ['房地产', '楼市', '房价', '地产', '保障房'],
    '金融/券商': ['券商', '银行', '保险', '金融', '资本市场'],
    '机器人': ['机器人', '人形机器人', '自动化', '特斯拉'],
  };
  
  for (const [concept, keywords] of Object.entries(conceptKeywords)) {
    let score = 0;
    const relatedNews = [];
    for (const n of news) {
      const text = (n.title || '') + ' ' + (n.intro || '');
      let hit = 0;
      for (const kw of keywords) {
        const count = (text.match(new RegExp(kw, 'g')) || []).length;
        hit += count;
      }
      if (hit > 0) {
        score += hit;
        relatedNews.push(n.title);
      }
    }
    if (score > 0) {
      conceptMap[concept] = { name: concept, score, news: relatedNews.slice(0, 3) };
    }
  }
  
  const hotConcepts = Object.values(conceptMap)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  
  // 模拟龙头股（概念板块的代表性股票）
  const leadersMap = {
    'AI/人工智能': [
      { name: '英伟达', code: 'NVDA', region: 'us' },
      { name: '微软', code: 'MSFT', region: 'us' },
      { name: '谷歌', code: 'GOOGL', region: 'us' },
    ],
    '新能源': [
      { name: '特斯拉', code: 'TSLA', region: 'us' },
      { name: '宁德时代', code: '300750', region: 'cn' },
      { name: '比亚迪', code: '002594', region: 'cn' },
    ],
    '贵金属': [
      { name: '巴里克黄金', code: 'GOLD', region: 'us' },
      { name: '山东黄金', code: '600547', region: 'cn' },
      { name: '紫金矿业', code: '601899', region: 'cn' },
    ],
    '原油/能源': [
      { name: '埃克森美孚', code: 'XOM', region: 'us' },
      { name: '雪佛龙', code: 'CVX', region: 'us' },
      { name: '中国海油', code: '600938', region: 'cn' },
    ],
    '有色金属': [
      { name: '自由港麦克莫兰', code: 'FCX', region: 'us' },
      { name: '紫金矿业', code: '601899', region: 'cn' },
      { name: '江西铜业', code: '600362', region: 'cn' },
    ],
    '美联储/降息': [
      { name: '美国国债ETF', code: 'TLT', region: 'us' },
      { name: '黄金ETF', code: 'GLD', region: 'us' },
      { name: '标普500', code: 'SPY', region: 'us' },
    ],
    '地缘政治': [
      { name: '黄金ETF', code: 'GLD', region: 'us' },
      { name: '国防ETF', code: 'ITA', region: 'us' },
      { name: '原油ETF', code: 'USO', region: 'us' },
    ],
    '消费/内需': [
      { name: '亚马逊', code: 'AMZN', region: 'us' },
      { name: '茅台', code: '600519', region: 'cn' },
      { name: '五粮液', code: '000858', region: 'cn' },
    ],
    '医药/创新药': [
      { name: '强生', code: 'JNJ', region: 'us' },
      { name: '辉瑞', code: 'PFE', region: 'us' },
      { name: '恒瑞医药', code: '600276', region: 'cn' },
    ],
    '房地产': [
      { name: '霍顿房屋', code: 'DHI', region: 'us' },
      { name: '万科', code: '000002', region: 'cn' },
      { name: '保利发展', code: '600048', region: 'cn' },
    ],
    '金融/券商': [
      { name: '摩根大通', code: 'JPM', region: 'us' },
      { name: '高盛', code: 'GS', region: 'us' },
      { name: '中信证券', code: '600030', region: 'cn' },
    ],
    '机器人': [
      { name: '特斯拉', code: 'TSLA', region: 'us' },
      { name: '英伟达', code: 'NVDA', region: 'us' },
      { name: '汇川技术', code: '300124', region: 'cn' },
    ],
  };
  
  return hotConcepts.map((c, i) => ({
    rank: i + 1,
    name: c.name,
    score: c.score,
    trend: i < 3 ? 'up' : (i > 7 ? 'down' : 'flat'),
    leaders: leadersMap[c.name] || [],
    relatedNews: c.news,
  }));
}

function generateOverviewAnalysis(quotes, news, concepts) {
  const xau = quotes['XAUUSD'];
  const oil = quotes['USOIL'];
  
  // 判断今日热点
  const hotNews = news.slice(0, 5);
  
  // 走强板块预测（基于热度前3的概念）
  const strongSectors = concepts.slice(0, 3).map(c => ({
    name: c.name,
    reason: (c.relatedNews && c.relatedNews[0]) || '新闻热度较高',
  }));
  
  // 市场情绪判断
  const commodityUp = (xau?.changePercent || 0) + (oil?.changePercent || 0);
  const sentiment = commodityUp > 1 ? '偏暖' : commodityUp < -1 ? '偏冷' : '中性';
  
  return {
    sentiment,
    hotNews,
    strongSectors,
    summary: `今日全球市场情绪${sentiment}。大宗商品方面，${xau ? `黄金${xau.changePercent >= 0 ? '上涨' : '下跌'}${Math.abs(xau.changePercent).toFixed(2)}%` : ''}${oil ? `，原油${oil.changePercent >= 0 ? '上涨' : '下跌'}${Math.abs(oil.changePercent).toFixed(2)}%` : ''}。热点集中在${concepts.slice(0, 3).map(c => c.name).join('、')}等领域。`,
  };
}

// ============= 主函数 =============

async function main() {
  console.log('========== 金十数据抓取 & 分析 ==========');
  console.log('开始时间:', new Date().toLocaleString('zh-CN'));
  
  try {
    // 1. 初始化会话
    await initSession();
    
    // 2. 获取行情数据
    console.log('\\n--- 获取行情数据 ---');
    const codes = ['XAUUSD', 'XAGUSD', 'USOIL', 'UKOIL', 'COPPER', 'USDJPY', 'EURUSD', 'USDCNH'];
    const quotes = await fetchQuotes(codes);
    console.log(`✓ 获取 ${Object.keys(quotes).length} 个品种行情`);
    for (const [code, q] of Object.entries(quotes)) {
      console.log(`  ${q.name}: ${q.price} (${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(2)}%)`);
    }
    
    // 3. 获取快讯
    console.log('\\n--- 获取快讯 ---');
    const flash = await fetchFlash(30);
    console.log(`✓ 获取 ${flash.length} 条快讯`);
    
    // 4. 获取资讯
    console.log('\\n--- 获取资讯 ---');
    const news = await fetchNews(30);
    console.log(`✓ 获取 ${news.length} 条资讯`);
    
    // 5. 获取财经日历
    console.log('\\n--- 获取财经日历 ---');
    const calendar = await fetchCalendar();
    console.log(`✓ 获取 ${calendar.length} 条日历数据`);
    
    // 6. 生成美股/国际市场分析
    console.log('\\n--- 生成国际市场分析 ---');
    const usAnalysis = generateUsAnalysis(quotes, news);
    console.log(`✓ ${usAnalysis?.statusLabel || '无数据'}`);
    
    // 7. 生成贵金属分析
    console.log('\\n--- 生成贵金属分析 ---');
    const metalsAnalysis = generateMetalsAnalysis(quotes, news);
    console.log(`✓ ${metalsAnalysis?.statusLabel || '无数据'}`);
    
    // 8. 生成概念板块分析
    console.log('\\n--- 生成概念板块分析 ---');
    const concepts = generateConceptAnalysis(news);
    console.log(`✓ ${concepts.length} 个热门概念`);
    concepts.slice(0, 5).forEach(c => console.log(`  ${c.rank}. ${c.name} (热度${c.score})`));
    
    // 9. 生成概览分析
    console.log('\\n--- 生成概览分析 ---');
    const overview = generateOverviewAnalysis(quotes, news, concepts);
    console.log(`✓ 市场情绪: ${overview.sentiment}`);
    
    // 10. 保存数据
    console.log('\\n--- 保存数据 ---');
    const outputDir = path.join(__dirname, '..', '..', 'data');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const output = {
      updateTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      updateTimestamp: Date.now(),
      source: '金十数据',
      
      // 行情数据
      quotes,
      
      // 新闻
      news: news.slice(0, 20),
      flash: flash.slice(0, 20),
      calendar: calendar.slice(0, 20),
      
      // 分析结果
      analysis: {
        overview,
        us: usAnalysis,
        metals: metalsAnalysis,
        concepts,
      },
    };
    
    const outputPath = path.join(outputDir, 'news.json');
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`✓ 数据已保存到 ${outputPath}`);
    
    console.log('\\n========== 完成 ==========');
    console.log('结束时间:', new Date().toLocaleString('zh-CN'));
    
  } catch (e) {
    console.error('✗ 错误:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

main();
