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
    'AI/人工智能': ['AI', '人工智能', '大模型', 'GPT', '算力', '芯片', '半导体', '英伟达', '光模块', 'ChatGPT'],
    '新能源': ['新能源', '光伏', '风电', '储能', '锂电池', '宁德时代', '比亚迪', '电车', '新能源车'],
    '贵金属': ['黄金', '白银', '贵金属', '金价', '避险', '黄金股'],
    '原油/能源': ['原油', '石油', 'OPEC', '油价', '天然气', '煤炭', '三桶油'],
    '有色金属': ['铜', '铝', '锌', '镍', '有色', '矿产', '锂矿'],
    '美联储/降息': ['美联储', '降息', '加息', '鲍威尔', '美债', '美元', '利率决议'],
    '地缘政治': ['地缘', '战争', '冲突', '中东', '俄乌', '制裁', '紧张局势'],
    '消费/内需': ['消费', '内需', '零售', '旅游', '餐饮', '白酒', '免税'],
    '医药/创新药': ['医药', '创新药', 'CXO', '生物科技', '疫苗', '医保'],
    '房地产': ['房地产', '楼市', '房价', '地产', '保障房', '限购'],
    '金融/券商': ['券商', '银行', '保险', '金融', '资本市场', '牛市'],
    '机器人': ['机器人', '人形机器人', '自动化', '智能制造'],
    '汽车/整车': ['汽车', '整车', '乘用车', '销量', '车展'],
    '军工/国防': ['军工', '国防', '军品', '航天', '航空', '导弹'],
    '数据要素': ['数据', '数据要素', '数据资产', '数字经济', '信创'],
    '中特估/国企': ['中特估', '国企改革', '央企', '估值重塑'],
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
    .slice(0, 15);
  
  // A股龙头股映射（只保留A股）
  const aShareLeadersMap = {
    'AI/人工智能': [
      { name: '中际旭创', code: '300308', region: 'cn' },
      { name: '新易盛', code: '300502', region: 'cn' },
      { name: '寒武纪', code: '688256', region: 'cn' },
      { name: '海光信息', code: '688041', region: 'cn' },
    ],
    '新能源': [
      { name: '宁德时代', code: '300750', region: 'cn' },
      { name: '比亚迪', code: '002594', region: 'cn' },
      { name: '阳光电源', code: '300274', region: 'cn' },
      { name: '隆基绿能', code: '601012', region: 'cn' },
    ],
    '贵金属': [
      { name: '山东黄金', code: '600547', region: 'cn' },
      { name: '紫金矿业', code: '601899', region: 'cn' },
      { name: '中金黄金', code: '600489', region: 'cn' },
      { name: '湖南黄金', code: '002155', region: 'cn' },
    ],
    '原油/能源': [
      { name: '中国海油', code: '600938', region: 'cn' },
      { name: '中国石油', code: '601857', region: 'cn' },
      { name: '中国石化', code: '600028', region: 'cn' },
      { name: '中国神华', code: '601088', region: 'cn' },
    ],
    '有色金属': [
      { name: '紫金矿业', code: '601899', region: 'cn' },
      { name: '江西铜业', code: '600362', region: 'cn' },
      { name: '铜陵有色', code: '000630', region: 'cn' },
      { name: '洛阳钼业', code: '603993', region: 'cn' },
    ],
    '美联储/降息': [
      { name: '山东黄金', code: '600547', region: 'cn' },
      { name: '招商银行', code: '600036', region: 'cn' },
      { name: '宁波银行', code: '002142', region: 'cn' },
      { name: '平安银行', code: '000001', region: 'cn' },
    ],
    '地缘政治': [
      { name: '山东黄金', code: '600547', region: 'cn' },
      { name: '中航沈飞', code: '600760', region: 'cn' },
      { name: '中国船舶', code: '600150', region: 'cn' },
      { name: '北方导航', code: '600435', region: 'cn' },
    ],
    '消费/内需': [
      { name: '贵州茅台', code: '600519', region: 'cn' },
      { name: '五粮液', code: '000858', region: 'cn' },
      { name: '中国中免', code: '601888', region: 'cn' },
      { name: '美的集团', code: '000333', region: 'cn' },
    ],
    '医药/创新药': [
      { name: '恒瑞医药', code: '600276', region: 'cn' },
      { name: '药明康德', code: '603259', region: 'cn' },
      { name: '迈瑞医疗', code: '300760', region: 'cn' },
      { name: '片仔癀', code: '600436', region: 'cn' },
    ],
    '房地产': [
      { name: '保利发展', code: '600048', region: 'cn' },
      { name: '万科A', code: '000002', region: 'cn' },
      { name: '招商蛇口', code: '001979', region: 'cn' },
      { name: '金地集团', code: '600383', region: 'cn' },
    ],
    '金融/券商': [
      { name: '中信证券', code: '600030', region: 'cn' },
      { name: '东方财富', code: '300059', region: 'cn' },
      { name: '招商银行', code: '600036', region: 'cn' },
      { name: '中国平安', code: '601318', region: 'cn' },
    ],
    '机器人': [
      { name: '汇川技术', code: '300124', region: 'cn' },
      { name: '埃斯顿', code: '002747', region: 'cn' },
      { name: '绿的谐波', code: '688017', region: 'cn' },
      { name: '拓斯达', code: '300607', region: 'cn' },
    ],
    '汽车/整车': [
      { name: '比亚迪', code: '002594', region: 'cn' },
      { name: '长安汽车', code: '000625', region: 'cn' },
      { name: '长城汽车', code: '601633', region: 'cn' },
      { name: '赛力斯', code: '601127', region: 'cn' },
    ],
    '军工/国防': [
      { name: '中航沈飞', code: '600760', region: 'cn' },
      { name: '航发动力', code: '600893', region: 'cn' },
      { name: '中国船舶', code: '600150', region: 'cn' },
      { name: '光威复材', code: '300699', region: 'cn' },
    ],
    '数据要素': [
      { name: '浪潮信息', code: '000977', region: 'cn' },
      { name: '中科曙光', code: '603019', region: 'cn' },
      { name: '易华录', code: '300212', region: 'cn' },
      { name: '人民网', code: '603000', region: 'cn' },
    ],
    '中特估/国企': [
      { name: '中国移动', code: '600941', region: 'cn' },
      { name: '中国电信', code: '601728', region: 'cn' },
      { name: '中国联通', code: '600050', region: 'cn' },
      { name: '中国建筑', code: '601668', region: 'cn' },
    ],
  };
  
  return hotConcepts.map((c, i) => ({
    rank: i + 1,
    name: c.name,
    score: c.score,
    trend: i < 5 ? 'up' : (i > 10 ? 'down' : 'flat'),
    leaders: aShareLeadersMap[c.name] || [],
    relatedNews: c.news,
  }));
}

// 为新闻生成AI智能分析的一句话要闻和高度相关的A股
function enrichNewsWithSummaryAndStocks(news) {
  // 关键词权重映射：关键词 -> { 权重, 关联股票: [{name, code, weight}] }
  // 权重越高表示该关键词与新闻的相关性越强
  const keywordAnalysisMap = {
    // ===== 宏观政策类（高权重） =====
    '美联储': {
      weight: 10,
      impact: '美联储政策直接影响全球流动性和美元走势',
      stocks: [
        { name: '山东黄金', code: '600547', weight: 9, reason: '降息预期升温利好金价' },
        { name: '中金黄金', code: '600489', weight: 8, reason: '黄金板块直接受益' },
        { name: '招商银行', code: '600036', weight: 6, reason: '利率敏感型银行股' },
      ]
    },
    '美债': {
      weight: 8,
      impact: '美债收益率攀升推高全球融资成本',
      stocks: [
        { name: '招商银行', code: '600036', weight: 7, reason: '利率敏感型银行股' },
        { name: '宁波银行', code: '002142', weight: 6, reason: '城商行利率敏感性高' },
        { name: '平安银行', code: '000001', weight: 5, reason: '零售行受息差影响' },
      ]
    },
    '降息': {
      weight: 9,
      impact: '降息释放流动性，利好风险资产',
      stocks: [
        { name: '山东黄金', code: '600547', weight: 9, reason: '降息直接利好黄金' },
        { name: '招商银行', code: '600036', weight: 6, reason: '银行股估值修复' },
        { name: '保利发展', code: '600048', weight: 7, reason: '地产板块受益利率下行' },
      ]
    },
    '加息': {
      weight: 9,
      impact: '加息收紧流动性，压制风险资产估值',
      stocks: [
        { name: '招商银行', code: '600036', weight: 6, reason: '加息利好银行息差' },
        { name: '宁波银行', code: '002142', weight: 5, reason: '城商行息差弹性大' },
        { name: '中国平安', code: '601318', weight: 5, reason: '保险投资端受益' },
      ]
    },
    '鲍威尔': {
      weight: 8,
      impact: '美联储主席表态直接影响市场预期',
      stocks: [
        { name: '山东黄金', code: '600547', weight: 8, reason: '金价对美联储政策敏感' },
        { name: '中金黄金', code: '600489', weight: 7, reason: '黄金板块联动' },
        { name: '招商银行', code: '600036', weight: 5, reason: '银行利率敏感性' },
      ]
    },
    '杰克逊霍尔': {
      weight: 7,
      impact: '全球央行年会释放货币政策信号',
      stocks: [
        { name: '山东黄金', code: '600547', weight: 8, reason: '政策信号影响金价' },
        { name: '招商银行', code: '600036', weight: 5, reason: '利率预期影响银行估值' },
        { name: '中金黄金', code: '600489', weight: 7, reason: '黄金板块联动' },
      ]
    },
    '央行': {
      weight: 7,
      impact: '央行货币政策决定市场流动性',
      stocks: [
        { name: '招商银行', code: '600036', weight: 7, reason: '银行直接受政策影响' },
        { name: '宁波银行', code: '002142', weight: 6, reason: '城商行政策弹性大' },
        { name: '中国平安', code: '601318', weight: 5, reason: '保险投资端受利率影响' },
      ]
    },
    '通胀': {
      weight: 8,
      impact: '通胀水平决定货币政策走向',
      stocks: [
        { name: '贵州茅台', code: '600519', weight: 6, reason: '消费龙头抗通胀属性' },
        { name: '紫金矿业', code: '601899', weight: 7, reason: '大宗商品抗通胀' },
        { name: '山东黄金', code: '600547', weight: 8, reason: '黄金抗通胀首选' },
      ]
    },
    '美元': {
      weight: 7,
      impact: '美元走势影响大宗商品价格和资本流动',
      stocks: [
        { name: '山东黄金', code: '600547', weight: 8, reason: '金价与美元负相关' },
        { name: '紫金矿业', code: '601899', weight: 7, reason: '有色金属定价受美元影响' },
        { name: '中国海油', code: '600938', weight: 6, reason: '原油以美元计价' },
      ]
    },

    // ===== 地缘政治类 =====
    '避险': {
      weight: 8,
      impact: '避险情绪升温利好黄金、国债等安全资产',
      stocks: [
        { name: '山东黄金', code: '600547', weight: 9, reason: '黄金是核心避险资产' },
        { name: '中金黄金', code: '600489', weight: 8, reason: '黄金板块直接受益' },
        { name: '紫金矿业', code: '601899', weight: 7, reason: '铜金双重属性' },
      ]
    },
    '中东': {
      weight: 7,
      impact: '中东局势紧张推升油价和避险情绪',
      stocks: [
        { name: '中国海油', code: '600938', weight: 8, reason: '原油供给担忧推升油价' },
        { name: '中国石油', code: '601857', weight: 7, reason: '上游油气受益油价上涨' },
        { name: '山东黄金', code: '600547', weight: 7, reason: '避险情绪利好黄金' },
      ]
    },
    '地缘': {
      weight: 6,
      impact: '地缘冲突加剧市场不确定性',
      stocks: [
        { name: '山东黄金', code: '600547', weight: 8, reason: '避险首选黄金' },
        { name: '中航沈飞', code: '600760', weight: 6, reason: '军工板块事件驱动' },
        { name: '中国船舶', code: '600150', weight: 5, reason: '海军装备需求' },
      ]
    },

    // ===== 大宗商品类 =====
    'OPEC': {
      weight: 8,
      impact: 'OPEC减产决定直接影响原油供给',
      stocks: [
        { name: '中国海油', code: '600938', weight: 9, reason: '纯上游油气公司' },
        { name: '中国石油', code: '601857', weight: 7, reason: '上游业务占比高' },
        { name: '中国石化', code: '600028', weight: 5, reason: '炼化占比高，弹性小' },
      ]
    },
    '金价': {
      weight: 9,
      impact: '金价变动直接影响黄金公司盈利',
      stocks: [
        { name: '山东黄金', code: '600547', weight: 10, reason: '纯黄金标的，弹性最大' },
        { name: '紫金矿业', code: '601899', weight: 7, reason: '铜金双主业' },
        { name: '中金黄金', code: '600489', weight: 9, reason: '黄金主业占比高' },
      ]
    },
    '黄金': {
      weight: 9,
      impact: '黄金价格走势影响板块整体估值',
      stocks: [
        { name: '山东黄金', code: '600547', weight: 10, reason: 'A股黄金龙头' },
        { name: '紫金矿业', code: '601899', weight: 7, reason: '全球矿业巨头' },
        { name: '中金黄金', code: '600489', weight: 9, reason: '央企黄金平台' },
      ]
    },
    '白银': {
      weight: 7,
      impact: '白银价格上涨利好白银生产企业',
      stocks: [
        { name: '盛达资源', code: '000603', weight: 8, reason: '白银龙头' },
        { name: '兴业银锡', code: '000426', weight: 7, reason: '银锡双主业' },
        { name: '湖南黄金', code: '002155', weight: 6, reason: '黄金白银伴生' },
      ]
    },
    '油价': {
      weight: 8,
      impact: '油价波动影响油气公司盈利和化工成本',
      stocks: [
        { name: '中国海油', code: '600938', weight: 9, reason: '纯上游弹性最大' },
        { name: '中国石油', code: '601857', weight: 7, reason: '上游占比高' },
        { name: '中国神华', code: '601088', weight: 5, reason: '煤炭替代能源' },
      ]
    },
    '原油': {
      weight: 8,
      impact: '原油价格影响能源板块整体',
      stocks: [
        { name: '中国海油', code: '600938', weight: 9, reason: '上游龙头' },
        { name: '中国石油', code: '601857', weight: 7, reason: '一体化油气巨头' },
        { name: '中国石化', code: '600028', weight: 5, reason: '炼化为主' },
      ]
    },
    '铜': {
      weight: 7,
      impact: '铜价反映全球经济景气度',
      stocks: [
        { name: '紫金矿业', code: '601899', weight: 9, reason: '国内铜资源龙头' },
        { name: '江西铜业', code: '600362', weight: 8, reason: '铜业龙头' },
        { name: '铜陵有色', code: '000630', weight: 7, reason: '铜加工+冶炼' },
      ]
    },
    '煤炭': {
      weight: 7,
      impact: '煤价影响煤企业绩和能源结构',
      stocks: [
        { name: '中国神华', code: '601088', weight: 8, reason: '煤炭龙头，高股息' },
        { name: '陕西煤业', code: '601225', weight: 7, reason: '优质动力煤' },
        { name: '兖矿能源', code: '600188', weight: 7, reason: '煤电化一体化' },
      ]
    },

    // ===== 科技产业类 =====
    'AI': {
      weight: 9,
      impact: 'AI产业爆发带动算力、光模块、芯片需求',
      stocks: [
        { name: '中际旭创', code: '300308', weight: 9, reason: '光模块全球龙头' },
        { name: '新易盛', code: '300502', weight: 8, reason: '光模块主力厂商' },
        { name: '寒武纪', code: '688256', weight: 7, reason: 'AI芯片国产替代' },
      ]
    },
    '人工智能': {
      weight: 9,
      impact: '人工智能是科技产业核心赛道',
      stocks: [
        { name: '中际旭创', code: '300308', weight: 9, reason: '算力基础设施核心' },
        { name: '科大讯飞', code: '002230', weight: 7, reason: 'AI应用龙头' },
        { name: '海康威视', code: '002415', weight: 6, reason: 'AI+安防龙头' },
      ]
    },
    '大模型': {
      weight: 8,
      impact: '大模型竞争推动AI产业发展',
      stocks: [
        { name: '科大讯飞', code: '002230', weight: 8, reason: '星火大模型' },
        { name: '三六零', code: '601360', weight: 7, reason: '360大模型' },
        { name: '昆仑万维', code: '300418', weight: 7, reason: '天工大模型' },
      ]
    },
    '算力': {
      weight: 8,
      impact: '算力是AI时代核心基础设施',
      stocks: [
        { name: '浪潮信息', code: '000977', weight: 9, reason: 'AI服务器龙头' },
        { name: '中科曙光', code: '603019', weight: 8, reason: '高性能计算龙头' },
        { name: '紫光股份', code: '000938', weight: 7, reason: '新华三算力设备' },
      ]
    },
    '光模块': {
      weight: 9,
      impact: '光模块是AI算力网络核心器件',
      stocks: [
        { name: '中际旭创', code: '300308', weight: 10, reason: '全球光模块龙头' },
        { name: '新易盛', code: '300502', weight: 9, reason: '高速光模块主力' },
        { name: '天孚通信', code: '300394', weight: 8, reason: '光器件龙头' },
      ]
    },
    '芯片': {
      weight: 8,
      impact: '芯片是科技产业自主可控核心',
      stocks: [
        { name: '中芯国际', code: '688981', weight: 9, reason: '晶圆制造龙头' },
        { name: '北方华创', code: '002371', weight: 8, reason: '半导体设备龙头' },
        { name: '韦尔股份', code: '603501', weight: 7, reason: 'CIS芯片龙头' },
      ]
    },
    '半导体': {
      weight: 8,
      impact: '半导体国产替代是长期主线',
      stocks: [
        { name: '中芯国际', code: '688981', weight: 9, reason: '制造环节龙头' },
        { name: '北方华创', code: '002371', weight: 8, reason: '设备龙头' },
        { name: '兆易创新', code: '603986', weight: 7, reason: '存储芯片龙头' },
      ]
    },

    // ===== 新能源类 =====
    '新能源': {
      weight: 8,
      impact: '新能源是双碳战略核心赛道',
      stocks: [
        { name: '宁德时代', code: '300750', weight: 9, reason: '动力电池全球龙头' },
        { name: '比亚迪', code: '002594', weight: 9, reason: '新能源车全产业链' },
        { name: '隆基绿能', code: '601012', weight: 7, reason: '光伏组件龙头' },
      ]
    },
    '光伏': {
      weight: 8,
      impact: '光伏装机增长带动产业链需求',
      stocks: [
        { name: '隆基绿能', code: '601012', weight: 9, reason: '组件全球龙头' },
        { name: '通威股份', code: '600438', weight: 8, reason: '硅料+电池片龙头' },
        { name: '阳光电源', code: '300274', weight: 8, reason: '逆变器龙头' },
      ]
    },
    '锂电': {
      weight: 8,
      impact: '锂电池是新能源车核心部件',
      stocks: [
        { name: '宁德时代', code: '300750', weight: 10, reason: '动力电池绝对龙头' },
        { name: '天齐锂业', code: '002466', weight: 7, reason: '锂资源龙头' },
        { name: '赣锋锂业', code: '002460', weight: 7, reason: '锂盐龙头' },
      ]
    },
    '储能': {
      weight: 7,
      impact: '储能是新能源消纳关键环节',
      stocks: [
        { name: '宁德时代', code: '300750', weight: 9, reason: '储能电池龙头' },
        { name: '阳光电源', code: '300274', weight: 8, reason: '储能逆变器龙头' },
        { name: '派能科技', code: '688063', weight: 7, reason: '户储龙头' },
      ]
    },
    '风电': {
      weight: 6,
      impact: '风电装机增长带动产业链',
      stocks: [
        { name: '金风科技', code: '002202', weight: 8, reason: '风机龙头' },
        { name: '明阳智能', code: '601615', weight: 7, reason: '海风龙头' },
        { name: '东方电缆', code: '603606', weight: 7, reason: '海缆龙头' },
      ]
    },

    // ===== 消费类 =====
    '消费': {
      weight: 7,
      impact: '消费复苏是经济增长重要动力',
      stocks: [
        { name: '贵州茅台', code: '600519', weight: 9, reason: '消费龙头，品牌护城河' },
        { name: '五粮液', code: '000858', weight: 7, reason: '白酒次高端龙头' },
        { name: '中国中免', code: '601888', weight: 6, reason: '免税消费龙头' },
      ]
    },
    '白酒': {
      weight: 8,
      impact: '白酒是消费板块核心资产',
      stocks: [
        { name: '贵州茅台', code: '600519', weight: 10, reason: '白酒绝对龙头' },
        { name: '五粮液', code: '000858', weight: 8, reason: '浓香龙头' },
        { name: '泸州老窖', code: '000568', weight: 7, reason: '高端白酒第三极' },
      ]
    },
    '比亚迪': {
      weight: 9,
      impact: '比亚迪是新能源车产业风向标',
      stocks: [
        { name: '比亚迪', code: '002594', weight: 10, reason: '新能源车销量冠军' },
        { name: '赛力斯', code: '601127', weight: 7, reason: '华为合作车企' },
        { name: '长安汽车', code: '000625', weight: 6, reason: '自主车企龙头' },
      ]
    },
    '汽车': {
      weight: 7,
      impact: '汽车消费是内需重要支柱',
      stocks: [
        { name: '比亚迪', code: '002594', weight: 9, reason: '新能源汽车龙头' },
        { name: '长安汽车', code: '000625', weight: 7, reason: '自主品牌龙头' },
        { name: '长城汽车', code: '601633', weight: 6, reason: 'SUV/皮卡龙头' },
      ]
    },

    // ===== 金融地产类 =====
    '券商': {
      weight: 8,
      impact: '券商是牛市风向标，贝塔属性强',
      stocks: [
        { name: '中信证券', code: '600030', weight: 9, reason: '行业龙头' },
        { name: '东方财富', code: '300059', weight: 8, reason: '互联网券商龙头' },
        { name: '华泰证券', code: '601688', weight: 7, reason: '财富管理龙头' },
      ]
    },
    '银行': {
      weight: 7,
      impact: '银行是金融体系核心',
      stocks: [
        { name: '招商银行', code: '600036', weight: 9, reason: '零售银行龙头' },
        { name: '宁波银行', code: '002142', weight: 8, reason: '城商行龙头' },
        { name: '工商银行', code: '601398', weight: 6, reason: '国有大行龙头' },
      ]
    },
    '地产': {
      weight: 7,
      impact: '地产政策影响产业链投资机会',
      stocks: [
        { name: '保利发展', code: '600048', weight: 8, reason: '央企地产龙头' },
        { name: '万科A', code: '000002', weight: 7, reason: '行业标杆' },
        { name: '招商蛇口', code: '001979', weight: 7, reason: '央企开发商' },
      ]
    },
    '房地产': {
      weight: 7,
      impact: '房地产是经济重要支柱产业',
      stocks: [
        { name: '保利发展', code: '600048', weight: 8, reason: '央企地产龙头' },
        { name: '万科A', code: '000002', weight: 7, reason: '行业标杆' },
        { name: '招商蛇口', code: '001979', weight: 7, reason: '央企开发商' },
      ]
    },

    // ===== 其他板块 =====
    '医药': {
      weight: 7,
      impact: '医药是长期刚需，创新药是核心方向',
      stocks: [
        { name: '恒瑞医药', code: '600276', weight: 8, reason: '创新药龙头' },
        { name: '药明康德', code: '603259', weight: 7, reason: 'CXO龙头' },
        { name: '迈瑞医疗', code: '300760', weight: 8, reason: '医疗器械龙头' },
      ]
    },
    '机器人': {
      weight: 7,
      impact: '人形机器人是AI具身化核心载体',
      stocks: [
        { name: '汇川技术', code: '300124', weight: 8, reason: '工控龙头' },
        { name: '埃斯顿', code: '002747', weight: 7, reason: '工业机器人龙头' },
        { name: '绿的谐波', code: '688017', weight: 8, reason: '谐波减速器龙头' },
      ]
    },
    '军工': {
      weight: 7,
      impact: '军工板块受地缘事件和国防预算驱动',
      stocks: [
        { name: '中航沈飞', code: '600760', weight: 8, reason: '战机龙头' },
        { name: '航发动力', code: '600893', weight: 7, reason: '航空发动机龙头' },
        { name: '中国船舶', code: '600150', weight: 7, reason: '造船龙头' },
      ]
    },
    '信创': {
      weight: 7,
      impact: '信创是数字经济安全底座',
      stocks: [
        { name: '中国软件', code: '600536', weight: 8, reason: '操作系统龙头' },
        { name: '太极股份', code: '002368', weight: 7, reason: '信创集成龙头' },
        { name: '诚迈科技', code: '300598', weight: 6, reason: '统信系统' },
      ]
    },
    '数据要素': {
      weight: 7,
      impact: '数据要素是数字经济核心生产资料',
      stocks: [
        { name: '浪潮信息', code: '000977', weight: 7, reason: '数据基础设施' },
        { name: '中科曙光', code: '603019', weight: 7, reason: '算力基础设施' },
        { name: '易华录', code: '300212', weight: 8, reason: '数据湖龙头' },
      ]
    },
    '央企': {
      weight: 6,
      impact: '中特估背景下央企估值重塑',
      stocks: [
        { name: '中国移动', code: '600941', weight: 8, reason: '通信运营龙头' },
        { name: '中国电信', code: '601728', weight: 7, reason: '运营商第二梯队' },
        { name: '中国联通', code: '600050', weight: 6, reason: '运营商混改标杆' },
      ]
    },
    'A股': {
      weight: 5,
      impact: 'A股整体走势反映市场情绪',
      stocks: [
        { name: '中信证券', code: '600030', weight: 6, reason: '券商龙头，贝塔属性' },
        { name: '东方财富', code: '300059', weight: 6, reason: '互联网券商风向标' },
        { name: '贵州茅台', code: '600519', weight: 5, reason: '核心资产代表' },
      ]
    },
  };

  // 判断新闻的多空方向
  function detectSentiment(text) {
    const positiveWords = ['上涨', '利好', '增长', '超预期', '突破', '创新高', '强劲', '复苏', '回暖', '加速', '降息', '宽松', '支持', '提振', '受益', '盈利', '增利'];
    const negativeWords = ['下跌', '利空', '下滑', '不及预期', '暴跌', '崩盘', '疲软', '衰退', '降温', '放缓', '加息', '收紧', '打压', '担忧', '亏损', '承压', '风险'];
    
    let posScore = 0, negScore = 0;
    for (const w of positiveWords) if (text.includes(w)) posScore++;
    for (const w of negativeWords) if (text.includes(w)) negScore++;
    
    if (posScore > negScore + 1) return '利好';
    if (negScore > posScore + 1) return '利空';
    return '中性';
  }

  return news.map(item => {
    const text = (item.title || '') + ' ' + (item.intro || '');
    
    // ===== Step 1: 关键词匹配与权重分析 =====
    const matchedKeywords = [];
    for (const [keyword, analysis] of Object.entries(keywordAnalysisMap)) {
      const count = (text.match(new RegExp(keyword, 'g')) || []).length;
      if (count > 0) {
        matchedKeywords.push({
          keyword,
          weight: analysis.weight * count,
          impact: analysis.impact,
          stocks: analysis.stocks,
        });
      }
    }
    
    // 按权重排序
    matchedKeywords.sort((a, b) => b.weight - a.weight);
    
    // ===== Step 2: 生成AI智能分析的一句话要闻 =====
    let aiSummary = '';
    const sentiment = detectSentiment(text);
    const topKeyword = matchedKeywords[0];
    
    if (topKeyword) {
      // 有核心关键词的情况下，生成结构化分析
      const coreTopic = topKeyword.keyword;
      const impactDesc = topKeyword.impact;
      
      // 从 intro 中提取关键句子
      let keyPoint = '';
      if (item.intro && item.intro.length > 10) {
        const sentences = item.intro.split(/[。！？]/).filter(s => s.length > 5 && s.length < 60);
        keyPoint = sentences[0] || item.intro.substring(0, 40);
        keyPoint = keyPoint.replace(/\s+/g, '').replace(/^[，、；：]/, '');
      } else {
        keyPoint = item.title || '';
      }
      
      // 组合成一句话AI分析
      if (matchedKeywords.length >= 2) {
        aiSummary = `【${sentiment}】${keyPoint}。核心涉及${coreTopic}、${matchedKeywords[1].keyword}，${impactDesc}。`;
      } else {
        aiSummary = `【${sentiment}】${keyPoint}。核心涉及${coreTopic}，${impactDesc}。`;
      }
      
      // 控制长度
      if (aiSummary.length > 80) {
        aiSummary = aiSummary.substring(0, 77) + '...';
      }
    } else {
      // 没有匹配到关键词，生成基础摘要
      if (item.intro && item.intro.length > 10) {
        aiSummary = item.intro.replace(/\s+/g, '').substring(0, 60);
        if (item.intro.length > 60) aiSummary += '...';
      } else {
        aiSummary = item.title || '';
      }
    }
    
    // ===== Step 3: 计算个股相关性得分，取最相关的2-3只 =====
    const stockScores = {};
    for (const kw of matchedKeywords) {
      for (const stock of kw.stocks) {
        if (!stockScores[stock.code]) {
          stockScores[stock.code] = {
            name: stock.name,
            code: stock.code,
            region: 'cn',
            score: 0,
            reasons: [],
          };
        }
        // 得分 = 关键词权重 × 股票权重 / 10
        stockScores[stock.code].score += (kw.weight * stock.weight) / 10;
        if (stock.reason && !stockScores[stock.code].reasons.includes(stock.reason)) {
          stockScores[stock.code].reasons.push(stock.reason);
        }
      }
    }
    
    // 按得分排序，取前3只（得分>5才算高度相关）
    const topStocks = Object.values(stockScores)
      .sort((a, b) => b.score - a.score)
      .filter(s => s.score >= 5)
      .slice(0, 3)
      .map(s => ({
        name: s.name,
        code: s.code,
        region: 'cn',
        relevance: s.score >= 15 ? '极高' : s.score >= 10 ? '高' : '中高',
        reason: s.reasons[0] || '',
      }));
    
    return {
      ...item,
      summary: aiSummary,
      aiTag: topKeyword ? sentiment : '待分析',
      relatedStocks: topStocks,
      matchedTopics: matchedKeywords.slice(0, 3).map(k => k.keyword),
    };
  });
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
    console.log('\n--- 生成概念板块分析 ---');
    const concepts = generateConceptAnalysis(news);
    console.log(`✓ ${concepts.length} 个热门概念`);
    concepts.slice(0, 5).forEach(c => console.log(`  ${c.rank}. ${c.name} (热度${c.score})`));
    
    // 8.5 新闻增强：添加一句话摘要和关联A股
    console.log('\n--- 新闻增强处理 ---');
    const enrichedNews = enrichNewsWithSummaryAndStocks(news);
    const withStocks = enrichedNews.filter(n => n.relatedStocks && n.relatedStocks.length > 0).length;
    console.log(`✓ ${withStocks}/${enrichedNews.length} 条新闻关联了A股`);
    
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
      news: enrichedNews.slice(0, 20),
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
