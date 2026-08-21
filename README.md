# 财经仪表盘 - GitHub Pages 部署指南

实时行情 + 热点分析 + AI 解读，手机随时可看。

## 📱 功能说明

| 功能 | 数据来源 | 更新频率 |
|------|----------|----------|
| A股指数（上证/深证/创业板） | 腾讯财经 | 每2分钟自动刷新 |
| 美股指数（道指/纳指/标普） | 腾讯财经 | 每2分钟自动刷新 |
| 贵金属（黄金/白银） | 腾讯财经 | 每2分钟自动刷新 |
| 财经新闻 + AI 解读 | 新浪财经（GitHub Actions） | 每天3次（7点/12点/19点） |
| 热门板块分析 | 基于新闻关键词生成 | 随新闻更新 |
| 热门概念板块 | 基于新闻热度排序 | 随新闻更新 |

## 🚀 快速部署

### 方法一：手动上传（最简单）

1. 在 GitHub 创建一个公开仓库（比如 `finance-dashboard`）
2. 把 `gh-pages` 文件夹里的**所有文件和文件夹**都上传到仓库根目录
   - `index.html` - 主页面
   - `data/news.json` - 新闻数据（初始数据）
   - `.github/workflows/update-news.yml` - 自动更新配置
   - `.github/scripts/fetch-news.js` - 新闻抓取脚本
3. 开启 GitHub Pages：Settings → Pages → Branch 选 `main` / root → Save
4. 等待 1-2 分钟，访问 `https://你的用户名.github.io/仓库名/`

### 方法二：一键部署脚本

```powershell
cd gh-pages
node deploy.js 你的GitHub用户名 你的PersonalAccessToken
```

## ⚙️ 开启自动新闻更新

**重要**：上传 `.github` 文件夹后，GitHub Actions 默认是禁用的，需要手动开启：

1. 打开仓库页面 → 顶部 **Actions** 标签
2. 如果看到 "Workflows aren't being run"，点 **I understand my workflows, go ahead and enable them**
3. 左边选 **每日财经新闻更新**
4. 点 **Enable workflow**
5. 右边点 **Run workflow** → 选 `main` → 点绿色的 **Run workflow** 按钮

开启后，每天会自动更新 3 次：
- 早上 7:00（北京时间）
- 中午 12:00
- 晚上 19:00

也可以随时手动点 **Run workflow** 立即更新。

## 📱 手机使用

### iPhone
1. Safari 打开网址
2. 点底部分享按钮（方框+箭头）
3. 选「添加到主屏幕」
4. 命名后点「添加」

### Android
1. Chrome 打开网址
2. 点右上角三个点
3. 选「添加到主屏幕」或「安装应用」

## 📂 文件结构

```
gh-pages/
├── index.html                    # 主页面（纯JS，无依赖）
├── data/
│   └── news.json                 # 新闻+热点数据（GitHub Actions自动更新）
├── .github/
│   ├── workflows/
│   │   └── update-news.yml       # GitHub Actions 定时任务配置
│   └── scripts/
│       └── fetch-news.js         # 新闻抓取脚本
├── deploy.js                     # 一键部署脚本
└── README.md                     # 本文档
```

## 🔧 常见问题

### 为什么新闻不更新？
- 检查 GitHub Actions 是否开启（见上文「开启自动新闻更新」）
- 检查 Actions 页面有没有失败的运行记录
- 可以手动点「Run workflow」立即触发一次

### 行情数据准确吗？
- 行情数据来自腾讯财经，实时更新
- 每2分钟自动刷新一次
- 交易时间外显示的是最近收盘价

### 可以添加更多新闻源吗？
- 可以，修改 `.github/scripts/fetch-news.js` 里的 `NEWS_SOURCES` 数组
- 支持新浪财经 JSON 接口和 RSS 格式

### 手机上为什么有时候加载慢？
- 第一次加载需要下载页面（约 50KB）
- 行情数据从腾讯财经获取，取决于网络速度
- 建议添加到主屏幕，启动更快
