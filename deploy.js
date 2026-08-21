/**
 * GitHub Pages 一键部署脚本（完整版）
 * 支持上传整个目录到 GitHub Pages
 * 
 * 使用方法：
 *   node deploy.js <GitHub用户名> <PersonalAccessToken> [仓库名] [分支名]
 * 
 * 示例：
 *   node deploy.js suky-star ghp_xxxxx finance-dashboard gh-pages
 * 
 * 获取 Token: https://github.com/settings/tokens
 *   - 点击 Generate new token (classic)
 *   - 勾选 repo 权限
 *   - 点击 Generate token 复制
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const username = args[0];
const token = args[1];
const repoName = args[2] || 'finance-dashboard';
const branch = args[3] || 'gh-pages';

if (!username || !token) {
  console.error('❌ 缺少参数！');
  console.error('使用方法: node deploy.js <GitHub用户名> <PersonalAccessToken> [仓库名] [分支名]');
  console.error('');
  console.error('获取 Token: https://github.com/settings/tokens');
  console.error('  - 点击 Generate new token (classic)');
  console.error('  - 勾选 repo 权限');
  console.error('  - 点击 Generate token 复制');
  process.exit(1);
}

const BASE_DIR = __dirname;

function apiRequest(method, apiPath, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: apiPath,
      method: method,
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'finance-dashboard-deploy',
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(result);
          } else {
            reject({ status: res.statusCode, message: result.message || body });
          }
        } catch (e) {
          reject({ status: res.statusCode, message: body });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

// 收集所有要上传的文件
function collectFiles(dir, base = '') {
  const files = [];
  const items = fs.readdirSync(dir);
  
  for (const item of items) {
    // 跳过 node_modules 和 .git
    if (item === 'node_modules' || item === '.git') continue;
    
    const fullPath = path.join(dir, item);
    const relPath = path.join(base, item).replace(/\\/g, '/');
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      files.push(...collectFiles(fullPath, relPath));
    } else {
      files.push({
        path: relPath,
        content: fs.readFileSync(fullPath),
        size: stat.size,
      });
    }
  }
  
  return files;
}

// 创建 blob
async function createBlob(content) {
  const result = await apiRequest('POST', `/repos/${username}/${repoName}/git/blobs`, {
    content: content.toString('base64'),
    encoding: 'base64',
  });
  return result.sha;
}

// 获取当前分支的最新 commit
async function getLatestCommit() {
  try {
    const ref = await apiRequest('GET', `/repos/${username}/${repoName}/git/ref/heads/${branch}`);
    const commit = await apiRequest('GET', `/repos/${username}/${repoName}/git/commits/${ref.object.sha}`);
    return { refSha: ref.object.sha, treeSha: commit.tree.sha };
  } catch (e) {
    if (e.status === 404) {
      return null; // 分支不存在
    }
    throw e;
  }
}

// 创建新树
async function createTree(baseTreeSha, blobs) {
  const tree = blobs.map(b => ({
    path: b.path,
    mode: '100644',
    type: 'blob',
    sha: b.sha,
  }));

  const result = await apiRequest('POST', `/repos/${username}/${repoName}/git/trees`, {
    base_tree: baseTreeSha,
    tree: tree,
  });
  return result.sha;
}

// 创建 commit
async function createCommit(treeSha, parentSha, message) {
  const result = await apiRequest('POST', `/repos/${username}/${repoName}/git/commits`, {
    message: message,
    tree: treeSha,
    parents: parentSha ? [parentSha] : [],
  });
  return result.sha;
}

// 更新分支引用
async function updateRef(commitSha, create = false) {
  if (create) {
    await apiRequest('POST', `/repos/${username}/${repoName}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commitSha,
    });
  } else {
    await apiRequest('PATCH', `/repos/${username}/${repoName}/git/ref/heads/${branch}`, {
      sha: commitSha,
      force: true,
    });
  }
}

// 启用 GitHub Pages
async function enablePages() {
  try {
    await apiRequest('POST', `/repos/${username}/${repoName}/pages`, {
      source: {
        branch: branch,
        path: '/',
      },
    });
    return 'enabled';
  } catch (e) {
    if (e.status === 409) return 'already';
    throw e;
  }
}

async function deploy() {
  console.log('🚀 开始部署到 GitHub Pages...');
  console.log(`📦 仓库: ${username}/${repoName}`);
  console.log(`🌿 分支: ${branch}`);
  console.log('');

  try {
    // 1. 收集文件
    console.log('📁 收集文件...');
    const files = collectFiles(BASE_DIR);
    console.log(`   找到 ${files.length} 个文件`);
    files.forEach(f => {
      console.log(`   - ${f.path} (${Math.round(f.size / 1024)}KB)`);
    });
    console.log('');

    // 2. 检查仓库
    console.log('📦 检查仓库...');
    try {
      await apiRequest('GET', `/repos/${username}/${repoName}`);
      console.log('   仓库已存在');
    } catch (e) {
      if (e.status === 404) {
        console.log('   仓库不存在，正在创建...');
        await apiRequest('POST', '/user/repos', {
          name: repoName,
          description: '财经仪表盘 - 实时行情 & 热点分析',
          private: false,
          auto_init: false,
        });
        console.log('   ✅ 仓库创建成功');
      } else {
        throw e;
      }
    }
    console.log('');

    // 3. 创建 blobs
    console.log('☁️  上传文件...');
    const blobs = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const sha = await createBlob(file.content);
      blobs.push({ path: file.path, sha });
      console.log(`   [${i + 1}/${files.length}] ${file.path}`);
    }
    console.log('   ✅ 所有文件上传完成');
    console.log('');

    // 4. 获取或创建分支
    console.log('🔧 构建提交...');
    const latest = await getLatestCommit();
    const isNewBranch = !latest;
    
    const treeSha = await createTree(latest?.treeSha || null, blobs);
    const commitMessage = `更新财经仪表盘 - ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    const commitSha = await createCommit(treeSha, latest?.refSha || null, commitMessage);
    
    await updateRef(commitSha, isNewBranch);
    console.log('   ✅ 提交成功');
    console.log('');

    // 5. 启用 GitHub Pages
    console.log('🌐 启用 GitHub Pages...');
    const pagesStatus = await enablePages();
    if (pagesStatus === 'enabled') {
      console.log('   ✅ GitHub Pages 已启用');
    } else {
      console.log('   ℹ️  GitHub Pages 已启用');
    }
    console.log('');

    console.log('🎉 部署完成！');
    console.log('');
    console.log(`📦 仓库地址: https://github.com/${username}/${repoName}`);
    console.log(`🌐 访问地址: https://${username}.github.io/${repoName}/`);
    console.log('');
    console.log('⚠️  注意：GitHub Pages 首次部署可能需要 1-2 分钟才能生效');
    console.log('💡 手机上打开上面的链接，添加到主屏幕即可随时查看');
    console.log('🔄 数据每日自动更新 4 次（7:00 / 12:00 / 16:00 / 20:00 北京时间）');

  } catch (e) {
    console.error('');
    console.error('❌ 部署失败！');
    console.error(`状态码: ${e.status}`);
    console.error(`错误信息: ${e.message}`);
    
    if (e.status === 401) {
      console.error('');
      console.error('💡 Token 无效或权限不足，请检查：');
      console.error('   1. 确认 Token 正确无误');
      console.error('   2. 确认 Token 已勾选 repo 权限');
      console.error('   3. 获取地址: https://github.com/settings/tokens');
    }
    
    process.exit(1);
  }
}

deploy();
