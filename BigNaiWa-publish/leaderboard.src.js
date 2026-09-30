/* ============================================================
 *  合成大奶娃 · 排行榜（leaderboard.min.js 的可读还原版）
 *
 *  原文件把后端配置用 XOR 混淆成十六进制串（_u 函数），
 *  这里已全部解码还原成明文，逻辑与原文件完全一致：
 *
 *    API    = https://tinywebdb.appinventor.space/api
 *    USER   = jackieqi
 *    SECRET = 829fec11
 *    PREFIX = dnw_        （key 前缀，换它等于另开一个榜）
 *    action = update（写）/ search（按 tag 前缀读）
 *
 *  后端是 App Inventor 的 TinyWebDB（极简 KV 云存储，跨域 *），
 *  纯静态页直接 POST 表单即可读写，无需自建服务器。
 * ============================================================ */
(function () {
  'use strict';

  /* —— 后端配置（原文件里被 _u() XOR 混淆，此处还原为明文）—— */
  const API    = 'https://tinywebdb.appinventor.space/api';
  const USER   = 'jackieqi';
  const SECRET = '829fec11';
  const PREFIX = 'dnw_';
  const NAME_KEY = 'danaiwa.name';

  const DEFAULT_NAME = '默认用户';
  const MUTE_MIN_GAP = 3000;        // 两次自动提交的最小间隔（防手抖）
  const MAX_SCORE = 50000;          // 分数明显离谱的不收（正常最高约 6500，留足余量）
  const SCAN_PAGES = 2;             // 只读最新两页（每页 100 条）
  const WINDOW = 20;                // 榜单窗口 = 最近 20 次提交

  const $ = (id) => document.getElementById(id);

  /* POST 到 TinyWebDB，带一次自动重试（接口偶发 502） */
  function post(params) {
    const body = new URLSearchParams();
    body.set('user', USER);
    body.set('secret', SECRET);
    for (const k in params) body.set(k, params[k]);
    const once = () => fetch(API, { method: 'POST', body: body })
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then((text) => {
        const s = (text || '').trim();
        if (!s) return {};
        try {
          return JSON.parse(s);
        } catch (e) {
          throw new Error('服务器返回看不懂：' + s.slice(0, 60));
        }
      });
    return once().catch((err) =>
      new Promise((r) => setTimeout(r, 700)).then(once).catch(() => { throw err; })
    );
  }

  /* 提交一条成绩：key = dnw_<时间戳36进制>_<随机4位>，value = JSON */
  function addScore(name, score) {
    const tag = PREFIX + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const value = JSON.stringify({ n: name, s: score, t: Date.now() });
    return post({ action: 'update', tag: tag, value: value });
  }

  /* 读榜：search 按 dnw_ 前缀翻最新两页，返回 {key: value} 字典 */
  function scan() {
    const out = {};
    let no = 1, page = 0;
    function step() {
      return post({
        action: 'search', no: String(no), count: '100', tag: PREFIX, type: 'both'
      }).then((obj) => {
        for (const k in obj) {
          if (k.indexOf(PREFIX) === 0 && typeof obj[k] === 'string') out[k] = obj[k];
        }
        page++;
        if (page < SCAN_PAGES) { no += 100; return step(); }
        return out;
      });
    }
    return step();
  }

  /* 从 tag 或记录里取时间戳（tag 里带 36 进制时间，读不到时回退） */
  function timeOf(tag, rec) {
    const t = Number(rec && rec.t);
    if (isFinite(t) && t > 0) return t;
    const mid = String(tag).split('_')[1] || '';
    if (/^\d{12,}$/.test(mid)) return Number(mid);
    const s = parseInt(mid, 36);
    return isFinite(s) ? s : 0;
  }

  /* 拉取 + 过滤 + 排序：按时间取最近 20 条，窗口内再按分数排 */
  function fetchTop() {
    return scan().then((obj) => {
      const now = Date.now();
      const all = [];
      for (const tag in obj) {
        const raw = obj[tag];
        if (typeof raw !== 'string') continue;
        let rec;
        try { rec = JSON.parse(raw); } catch (e) { continue; }
        const s = Number(rec && rec.s);
        if (!isFinite(s) || s < 0 || s > MAX_SCORE) continue;
        const t = timeOf(tag, rec);
        if (t > now + 60000) continue; // 未来时间戳（偏差>1分钟）拒收
        all.push({
          tag: tag,
          name: String((rec && rec.n) || '匿名玩家').slice(0, 16),
          score: s,
          t: t
        });
      }
      all.sort((a, b) => (b.t - a.t) || (b.tag > a.tag ? 1 : -1));
      const fresh = all.slice(0, WINDOW);
      fresh.sort((a, b) => (b.score - a.score) || (b.t - a.t));
      return fresh;
    });
  }

  function cleanName(raw) {
    let n = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (n.length > 12) n = n.slice(0, 12);
    return n;
  }
  function loadName() {
    try { return cleanName(localStorage.getItem(NAME_KEY) || ''); } catch (e) { return ''; }
  }
  function saveName(n) {
    try { localStorage.setItem(NAME_KEY, n); } catch (e) { }
  }
  function myName() { return loadName() || DEFAULT_NAME; }

  const listEl = $('boardList');
  const modal = $('boardModal');
  const msgEl = $('submitMsg');
  const nickInput = $('nickInput');
  const nameLabel = $('myNameLabel');
  const submitBtn = $('submitBtn');
  const submitBox = $('submitBox');

  let lastSubmitAt = 0;
  let submitting = false;
  let pendingScore = 0;

  function setMsg(text, kind) {
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.className = 'submit-msg' + (kind ? ' is-' + kind : '');
  }
  function showRetry(show) { if (submitBtn) submitBtn.hidden = !show; }
  function paintName() {
    const n = myName();
    if (nameLabel) nameLabel.textContent = n;
    if (nickInput && document.activeElement !== nickInput) nickInput.value = loadName();
  }
  function boardMessage(text) {
    if (!listEl) return;
    listEl.textContent = '';
    const p = document.createElement('p');
    p.className = 'board-empty';
    p.textContent = text;
    listEl.appendChild(p);
  }
  function rankClass(i) { return i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : ''; }

  /* 渲染榜单 —— 全部 textContent，不拼 HTML（防 XSS） */
  function renderBoard(rows, myScore) {
    if (!listEl) return;
    listEl.textContent = '';
    if (!rows.length) { boardMessage('最近还没有人提交，快去玩一局！'); return; }
    let marked = false;
    rows.forEach((row, i) => {
      const line = document.createElement('div');
      line.className = 'board-row ' + rankClass(i);
      const rank = document.createElement('span');
      rank.className = 'board-rank';
      rank.textContent = i < 3 ? ['🥇', '🥈', '🥉'][i] : String(i + 1);
      const name = document.createElement('span');
      name.className = 'board-name';
      name.textContent = row.name;
      const score = document.createElement('span');
      score.className = 'board-score';
      score.textContent = row.score;
      line.appendChild(rank);
      line.appendChild(name);
      line.appendChild(score);
      if (!marked && myScore != null && row.score === myScore) {
        line.classList.add('is-mine');
        marked = true;
      }
      listEl.appendChild(line);
    });
  }

  function refreshBoard(myScore) {
    boardMessage('正在读取排行榜…');
    return fetchTop().then((rows) => {
      renderBoard(rows, myScore);
      return rows;
    }).catch((err) => {
      boardMessage('读取失败：' + err.message + '（检查一下网络？）');
      throw err;
    });
  }
  function openBoard() {
    if (!modal) return;
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    refreshBoard(null).catch(() => { });
  }
  function closeBoard() {
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
  }

  /* 提交成绩：自动提交受 3 秒节流；手动重试不受限 */
  function pushScore(name, score, viaRetry) {
    if (submitting) return Promise.resolve(false);
    if (!viaRetry) {
      const now = Date.now();
      if (now - lastSubmitAt < MUTE_MIN_GAP) {
        setMsg('刚提交过啦，稍等一下', 'bad');
        return Promise.resolve(false);
      }
    }
    submitting = true;
    showRetry(false);
    setMsg('正在提交…', '');
    return addScore(name, score).then(() => {
      lastSubmitAt = Date.now();
      setMsg('已上榜 ✓　' + name + ' · ' + score + ' 分', 'good');
      return refreshBoard(score).then(() => true, () => true);
    }).catch((err) => {
      setMsg('提交失败：' + err.message, 'bad');
      showRetry(true);
      return false;
    }).then((ok) => { submitting = false; return ok; });
  }
  function retry() {
    if (!pendingScore) return;
    pushScore(myName(), pendingScore, true);
  }

  /* 游戏结束回调（由 game.js 调用）：0 分不上榜 */
  function onGameOver(score) {
    if (!submitBox) return;
    pendingScore = Number(score) || 0;
    paintName();
    showRetry(false);
    if (!(pendingScore > 0)) { submitBox.style.display = 'none'; return; }
    submitBox.style.display = '';
    setMsg('正在结算…', '');
    pushScore(myName(), pendingScore, true);
  }

  function bind() {
    const boardBtn = $('boardBtn');
    if (boardBtn) boardBtn.addEventListener('click', openBoard);
    const boardBtn2 = $('boardBtn2');
    if (boardBtn2) boardBtn2.addEventListener('click', openBoard);
    const closeBtn = $('boardClose');
    if (closeBtn) closeBtn.addEventListener('click', closeBoard);
    const refreshBtn = $('boardRefresh');
    if (refreshBtn) refreshBtn.addEventListener('click', () => { refreshBoard(null).catch(() => {}); });
    if (modal) {
      modal.addEventListener('click', (e) => { if (e.target === modal) closeBoard(); });
    }
    if (submitBtn) submitBtn.addEventListener('click', retry);
    if (nickInput) {
      nickInput.value = loadName();
      const commit = () => {
        saveName(cleanName(nickInput.value));
        nickInput.value = loadName();
        paintName();
      };
      nickInput.addEventListener('change', commit);
      nickInput.addEventListener('blur', commit);
      nickInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); nickInput.blur(); }
      });
    }
    const editNameBtn = $('editNameBtn');
    if (editNameBtn) {
      editNameBtn.addEventListener('click', () => {
        openBoard();
        if (nickInput) setTimeout(() => { nickInput.focus(); nickInput.select(); }, 260);
      });
    }
    paintName();
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeBoard(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  window.DanaiwaBoard = {
    open: openBoard,
    close: closeBoard,
    refresh: refreshBoard,
    onGameOver: onGameOver,
    fetchTop: fetchTop,
    submitScore: addScore,
    myName: myName,
    setName: function (n) { saveName(cleanName(n)); paintName(); },
    hasName: function () { return !!loadName(); }
  };
})();
