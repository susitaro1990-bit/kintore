'use strict';

// ---------- 保存 ----------
const KEY = 'kintore-v1';
let S = load() || { profile: null, slots: {}, logs: [], weights: [], protein: {}, sessions: 0 };
function load() { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } }
S.fats ||= [];
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* 保存できない環境 */ } }

// ---------- 日付 ----------
const pad = n => String(n).padStart(2, '0');
const dstr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => dstr(new Date());
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function weekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; } // 月曜始まり

// ---------- 計算 ----------
function plannedDays(p) { return WEEK_PLAN[p.days] || WEEK_PLAN[3]; }
function bmi(p) { return p.weight / Math.pow(p.height / 100, 2); }

// 1日の平均歩数 → 活動量の倍率(区間ごとの直線補間。厚生労働省の身体活動レベルの目安を参考)
const STEP_POINTS = [[0, 1.2], [5000, 1.3], [7500, 1.4], [10000, 1.475], [12500, 1.55], [15000, 1.6]];
function stepsToActivity(steps) {
  const s = Math.max(0, steps || 0);
  for (let i = 0; i < STEP_POINTS.length - 1; i++) {
    const [s0, a0] = STEP_POINTS[i], [s1, a1] = STEP_POINTS[i + 1];
    if (s <= s1) return +(a0 + (a1 - a0) * (Math.max(s, s0) - s0) / (s1 - s0)).toFixed(3);
  }
  return STEP_POINTS[STEP_POINTS.length - 1][1];
}
function activityLabel(a) { return a < 1.33 ? '座り仕事が中心' : a < 1.45 ? '普通' : a < 1.58 ? 'よく動く' : 'かなり活発'; }
function stepsHint(steps) {
  if (!steps) return 'スマホのヘルスケア/Google Fitなどで、直近の平均を確認できます。';
  const a = stepsToActivity(+steps);
  return `活動量の目安: ${activityLabel(a)}(消費の倍率 ${a.toFixed(2)})`;
}

function nutrition(p) {
  const pat = PATTERNS[p.pattern];
  const sexAdj = p.sex === 'm' ? 5 : p.sex === 'f' ? -161 : -78;
  const bmr = 10 * p.weight + 6.25 * p.height - 5 * p.age + sexAdj;
  const tdee = bmr * p.activity;
  return { tdee: Math.round(tdee), kcal: Math.round((tdee + pat.kcal) / 10) * 10, protein: Math.round(p.weight * pat.prot) };
}

function estimate(p) {
  const pat = PATTERNS[p.pattern];
  const diff = p.targetWeight - p.weight;
  const dirOk = pat.rate < 0 ? diff < 0 : diff > 0;
  if (!dirOk || diff === 0) return { ok: false };
  const months = Math.abs(diff) / Math.abs(pat.rate);
  const marks = [];
  for (let m = 1; m < months; m += m < 3 ? 1 : 3) marks.push({ m, w: p.weight + Math.sign(diff) * Math.abs(pat.rate) * m });
  return { ok: true, months, marks, rate: Math.abs(pat.rate) };
}

// ---------- メニュー生成 ----------
function initSlots(p) {
  for (const [id, slot] of Object.entries(SLOTS)) {
    if (S.slots[id]) continue;
    let level = 0, target = slot.chain[0].range[0];
    if (id === 'push') {
      level = p.pushups < 10 ? 0 : p.pushups < 40 ? 1 : 2;
      const [mn, mx] = slot.chain[level].range;
      target = Math.min(mx, Math.max(mn, Math.round(p.pushups * 0.5)));
    }
    S.slots[id] = { level, target };
  }
}

function itemFor(slotId, sets, rest) {
  const st = S.slots[slotId], ex = SLOTS[slotId].chain[st.level];
  const work = ex.type === 'time' ? st.target : st.target * 3 * (ex.perSide ? 2 : 1) * (ex.tempo || 1);
  const est = sets * work + (sets - 1) * rest + 30;
  return { slot: slotId, ex, target: st.target, sets, rest, est };
}

function buildMenu(p) {
  const pat = PATTERNS[p.pattern];
  const budget = p.minutes * 60 - 180; // ウォームアップ2分+クールダウン1分
  const rot = S.sessions % EXTRA_SLOTS.length;
  const extras = EXTRA_SLOTS.slice(rot).concat(EXTRA_SLOTS.slice(0, rot));
  // 全身の4種目は必ず入れる。時間が足りなければ、種目を削らずセット数を減らす(1割までの超過は許容)
  let sets = pat.sets, core;
  for (;;) {
    core = CORE_SLOTS.map(s => itemFor(s, sets, pat.rest));
    if (core.reduce((a, i) => a + i.est, 0) <= budget * 1.1 || sets <= 2) break;
    sets--;
  }
  const items = core.slice();
  let used = items.reduce((a, i) => a + i.est, 0);
  while (used > budget * 1.1 && items.length > 2) used -= items.pop().est; // 極端に短い時間の場合は種目を減らす
  for (const s of extras) {
    const it = itemFor(s, sets, pat.rest);
    if (used + it.est <= budget) { items.push(it); used += it.est; }
  }
  items.sort((a, b) => RUN_ORDER.indexOf(a.slot) - RUN_ORDER.indexOf(b.slot));
  return { items, minutes: Math.round((used + 180) / 60) };
}

function applyProgress(items, acts) {
  const ups = [];
  items.forEach((it, k) => {
    const sets = acts[k];
    if (!sets.length || !sets.every(v => v >= it.target)) return;
    const st = S.slots[it.slot], chain = SLOTS[it.slot].chain, mx = it.ex.range[1];
    const step = it.ex.type === 'time' ? 5 : 1;
    if (it.target >= mx) {
      if (st.level < chain.length - 1) {
        st.level++; st.target = chain[st.level].range[0];
        ups.push(`${it.ex.name} → ${chain[st.level].name} にレベルアップ`);
      }
    } else {
      st.target = Math.min(mx, it.target + step);
      ups.push(`${it.ex.name}: 次は${st.target}${it.ex.type === 'time' ? '秒' : '回'}`);
    }
  });
  return ups;
}

// ---------- 画面 ----------
// ナビ用の線画アイコン(currentColorで選択色に追従)
const svgIcon = d => `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  today: svgIcon('<path d="M3 9v6M6 6.5v11M18 6.5v11M21 9v6M6 12h12"/>'),
  log: svgIcon('<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>'),
  food: svgIcon('<path d="M7 3v7a2 2 0 0 0 2 2v9M11 3v7a2 2 0 0 1-2 2M9 3v7M17 21V3c-2 1.5-3 4-3 7s1 4 3 4"/>'),
  settings: svgIcon('<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>'),
};
let tab = 'today';
let formDraft = null;
const app = document.getElementById('app');
const nav = document.getElementById('nav');
const runEl = document.getElementById('run');

function render() {
  if (!S.profile) { nav.classList.add('hide'); app.innerHTML = formView(formDraft || defaultDraft(), true); return; }
  nav.classList.remove('hide');
  nav.innerHTML = [['today', '今日'], ['log', '記録'], ['food', '食事'], ['settings', '設定']]
    .map(([id, nm]) => `<button data-act="tab" data-tab="${id}" class="${tab === id ? 'on' : ''}">${ICONS[id]}<span>${nm}</span></button>`).join('');
  if (tab === 'settings') app.innerHTML = formView(formDraft || { ...S.profile }, false);
  else app.innerHTML = ({ today: todayView, log: logView, food: foodView })[tab]();
}

function defaultDraft() {
  return { height: '', weight: '', age: '', sex: 'm', steps: '', pushups: 30, pattern: 'fit', targetWeight: '', minutes: 20, days: 3 };
}

function formView(p, isNew) {
  const b = p.height && p.weight ? bmi(p) : null;
  const leanOff = b !== null && b < 20;
  const pats = Object.entries(PATTERNS).map(([id, pt]) => {
    const off = id === 'lean' && leanOff;
    return `<div class="pattern ${p.pattern === id ? 'sel' : ''} ${off ? 'off' : ''}" data-act="pattern" data-id="${id}">
      <b>${pt.name}</b> <span class="sub">${pt.sub}</span><div class="sub">${pt.desc}</div>
      ${off ? '<div class="sub">今の体型では減量は不要のため選べません</div>' : ''}</div>`;
  }).join('');
  return `<h1>${isNew ? 'はじめに' : '設定'}</h1>
  <p class="sub">${isNew ? '体型と目標を入力すると、毎日のメニューと達成までの目安期間を作ります。' : '内容を変えて保存すると、メニューと期間の見積もりが更新されます。'}</p>
  <form id="f" class="card">
    <h2>今の体型</h2>
    <div class="row"><div><label>身長 (cm)</label><input name="height" type="number" inputmode="decimal" value="${p.height}" required></div>
    <div><label>体重 (kg)</label><input name="weight" type="number" step="0.1" inputmode="decimal" value="${p.weight}" required></div></div>
    <div class="row"><div><label>年齢</label><input name="age" type="number" inputmode="numeric" value="${p.age}" required></div>
    <div><label>性別</label><select name="sex">${[['m', '男性'], ['f', '女性'], ['o', 'その他']].map(([v, n]) => `<option value="${v}" ${p.sex === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div></div>
    <label>1日の平均歩数</label><input id="stepsIn" name="steps" type="number" inputmode="numeric" min="0" step="100" placeholder="例: 8000" value="${p.steps ?? ''}" required>
    <p class="sub" id="stepsHint">${stepsHint(p.steps)}</p>
    <label>腕立て伏せの最大回数(だいたい)</label><input name="pushups" type="number" inputmode="numeric" value="${p.pushups}" required>
    <h2 style="margin-top:20px">目標</h2>
    ${pats}
    <label>目標体重 (kg)</label><input name="targetWeight" type="number" step="0.1" inputmode="decimal" value="${p.targetWeight}" required>
    <h2 style="margin-top:20px">トレーニング時間</h2>
    <div class="row"><div><label>1回の時間 (分)</label><input name="minutes" type="number" inputmode="numeric" min="8" max="90" value="${p.minutes}" required></div>
    <div><label>週の回数</label><select name="days"><option value="3" ${+p.days === 3 ? 'selected' : ''}>週3回(月水金)</option><option value="4" ${+p.days === 4 ? 'selected' : ''}>週4回(月火木土)</option></select></div></div>
    <label class="chk"><input type="checkbox" name="cardio" ${p.cardio !== false ? 'checked' : ''}>筋トレの最後に有酸素3分(脳トレ付き)を足す</label>
    <div id="ferr" class="err"></div>
    <button class="primary big" type="submit">${isNew ? 'メニューを作る' : '保存する'}</button>
  </form>
  ${isNew ? importCard() : backupCard()}
  ${isNew ? '' : '<div class="card"><h3>データを消す</h3><p class="sub">記録・設定がすべて消えます。</p><button class="danger" data-act="reset">すべて消去</button></div>'}`;
}

// ---------- バックアップ ----------
const importBtn = '<input id="impFile" type="file" accept="application/json,.json" class="hide"><button data-act="import" class="ghost big">バックアップから復元</button>';
function importCard() { return `<div class="card"><h3>機種変更・復元</h3><p class="sub">以前のバックアップファイルがあれば、ここから読み込めます。</p>${importBtn}</div>`; }
function backupAgeDays() { return S.lastBackup ? Math.floor((Date.now() - S.lastBackup) / 86400000) : null; }
function backupCard() {
  const age = backupAgeDays();
  const status = age === null ? 'まだバックアップしていません。' : `最後のバックアップ: ${age === 0 ? '今日' : age + '日前'}`;
  return `<div class="card"><h3>バックアップ</h3><p class="sub">記録はこの端末の中だけに保存されています。スマホの故障や機種変更に備えて、ファイルを保存しておきましょう。(${status})</p>
    <button data-act="export" class="primary big" style="margin-bottom:10px">バックアップを保存</button>${importBtn}
    <p class="sub">保存したファイルは、Googleドライブやメールなど、スマホの外に置いてください。</p></div>`;
}
async function exportData() {
  const name = `kintore-backup-${today()}.json`;
  const file = new File([JSON.stringify(S)], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); }
    else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
  } catch (e) { if (e && e.name === 'AbortError') return; alert('保存に失敗しました。'); return; }
  S.lastBackup = Date.now(); save(); render();
}
function importData(file) {
  const rd = new FileReader();
  rd.onload = () => {
    let d;
    try { d = JSON.parse(rd.result); } catch { return alert('ファイルを読み込めませんでした。'); }
    const ok = d && typeof d === 'object' && d.profile && typeof d.profile === 'object' && d.slots && Array.isArray(d.logs) && Array.isArray(d.weights);
    if (!ok) return alert('筋トレアプリのバックアップファイルではありません。');
    if (!confirm(`バックアップから復元します。今のデータは置き換わります。\n(記録 ${d.sessions || d.logs.length}回分)`)) return;
    S = { fats: [], protein: {}, sessions: 0, ...d }; S.fats ||= []; save(); formDraft = null; tab = 'today'; render();
  };
  rd.readAsText(file);
}

function readForm(form) {
  const fd = new FormData(form), g = k => fd.get(k);
  const steps = +g('steps');
  return { height: +g('height'), weight: +g('weight'), age: +g('age'), sex: g('sex'), steps, activity: stepsToActivity(steps), pushups: +g('pushups'),
    pattern: (formDraft && formDraft.pattern) || (S.profile && S.profile.pattern) || 'fit', targetWeight: +g('targetWeight'), minutes: +g('minutes'), days: +g('days'), cardio: g('cardio') === 'on' };
}

// 仕上げの有酸素3分。設定がない既存データはオン扱い
const cardioOn = p => p.cardio !== false;
const cardioToday = () => CARDIO[S.sessions % CARDIO.length];

function isTrainingDay(d) { return plannedDays(S.profile).includes(d.getDay()); }
function doneOn(ds) { return S.logs.some(l => l.date === ds); }
// 体脂肪率は週1回。今週(月曜始まり)の記録があるか
function fatDoneThisWeek() { const ws = dstr(weekStart(new Date())); return S.fats.some(x => x.date >= ws); }

function todayView() {
  const p = S.profile, pat = PATTERNS[p.pattern], now = new Date();
  const isTrain = isTrainingDay(now), done = doneOn(today());
  const ws = weekStart(now), plan = plannedDays(p);
  const weekCells = [1, 2, 3, 4, 5, 6, 0].map((wd, i) => {
    const d = addDays(ws, i), ds = dstr(d);
    return `<div class="${plan.includes(wd) ? 'plan' : ''} ${doneOn(ds) ? 'done' : ''} ${ds === today() ? 'today' : ''}">${WEEKDAY[wd]}<span>${doneOn(ds) ? '✓' : d.getDate()}</span></div>`;
  }).join('');
  const weekDone = [0, 1, 2, 3, 4, 5, 6].filter(i => doneOn(dstr(addDays(ws, i)))).length;
  const menu = buildMenu(p);
  let next = '';
  if (!isTrain || done) {
    for (let i = 1; i <= 7; i++) { const d = addDays(now, i); if (plan.includes(d.getDay())) { next = `${WEEKDAY[d.getDay()]}曜日`; break; } }
  }
  const head = done ? '今日のトレーニングは完了!' : isTrain ? '今日はトレーニングの日' : '今日は休養日';
  const sub = done ? `お疲れさまでした。次は${next}。` : isTrain ? `${p.minutes}分でこなせる全身メニューです。` : `筋肉は休んでいる間に育ちます。次は${next}。やる気があれば下から始められます。`;
  const items = menu.items.map((it, i) => `<div class="ex"><div class="n">${i + 1}</div><div class="t"><b>${it.ex.name}<span class="tag">${it.ex.eq}</span></b>
    <span class="sub">${SLOTS[it.slot].name}</span></div><div style="text-align:right">${it.sets}セット<br><b>${it.target}${it.ex.type === 'time' ? '秒' : '回'}${it.ex.perSide ? '/片側' : ''}</b></div></div>`).join('');
  const note = t => `<div class="warn" data-act="tab" data-tab="log" style="cursor:pointer">${t}がまだです。タップして記録する →</div>`;
  const weightNote = S.weights.some(x => x.date === today()) ? '' : note('今日の体重');
  const age = backupAgeDays();
  const backupNote = S.sessions >= 3 && (age === null || age >= 14)
    ? `<div class="warn" data-act="tab" data-tab="settings" style="cursor:pointer">バックアップが${age === null ? 'まだ' : age + '日前から'}ありません。設定から保存できます →</div>` : '';
  const fatNote = weightNote + (fatDoneThisWeek() ? '' : note('今週の体脂肪率')) + backupNote;
  return `<h1>${head}</h1><p class="sub">${pat.name}(${pat.sub}) ・ ${sub}</p>${fatNote}
  <div class="card"><h2>今週 ${weekDone}/${plan.length}回</h2><div class="week">${weekCells}</div></div>
  <div class="card"><div class="between"><h2>メニュー</h2><span class="sub">約${menu.minutes + (cardioOn(p) ? CARDIO_SEC / 60 : 0)}分 ・ 休憩${pat.rest}秒</span></div>${items}
    ${cardioOn(p) ? `<div class="ex"><div class="n">+</div><div class="t"><b>仕上げの有酸素<span class="tag">脳トレ付き</span></b><span class="sub">${cardioToday().name}</span></div><div style="text-align:right"><b>${CARDIO_SEC / 60}分</b></div></div>` : ''}
    <p class="sub">ウォームアップ→上のメニュー${cardioOn(p) ? '→有酸素' : ''}→クールダウンの順です。</p>
    <button class="primary big" data-act="start">${done ? 'もう一度やる' : 'トレーニング開始'}</button></div>
  <div class="card sub">累計 ${S.sessions}回 実施</div>`;
}

function logView() {
  const p = S.profile, est = estimate(p), now = new Date();
  const lastW = S.weights.length ? S.weights[S.weights.length - 1].kg : p.weight;
  let goal;
  if (est.ok) {
    const m = est.months, whole = Math.ceil(m);
    goal = `<p>目標 <b>${p.weight}kg → ${p.targetWeight}kg</b> まで、目安 <b>約${whole}ヶ月</b>(${(whole / 12).toFixed(1)}年)</p>
    <p class="sub">初心者が無理なく変えられるペース(月${est.rate}kg)から逆算しています。</p>
    ${m > 18 ? '<div class="warn">かなり長い目標です。まず3ヶ月ごとに区切って見直すのがおすすめです。</div>' : ''}
    <table><tr><th>時期</th><th>体重の目安</th></tr>${est.marks.map(x => `<tr><td>${x.m}ヶ月後</td><td>${x.w.toFixed(1)}kg</td></tr>`).join('')}<tr><td><b>${whole}ヶ月後</b></td><td><b>${p.targetWeight}kg</b></td></tr></table>`;
  } else goal = '<div class="warn">目標体重の方向がパターンと合っていません。設定で見直してください。</div>';
  const cal = ['月', '火', '水', '木', '金', '土', '日'].map(w => `<div class="head">${w}</div>`).join('') +
    Array.from({ length: 28 }, (_, i) => { const d = addDays(weekStart(now), i - 21); return `<div class="${doneOn(dstr(d)) ? 'done' : ''}">${d.getDate()}</div>`; }).join('');
  return `<h1>記録</h1>
  <div class="card"><h2>達成までの目安</h2>${goal}</div>
  <div class="card"><h2>体重</h2><div class="between"><div><span class="big-num">${lastW}</span> kg</div></div>
    <div class="row"><input id="wIn" type="number" step="0.1" inputmode="decimal" placeholder="今日の体重"><button data-act="addw" class="primary">記録</button></div>
    ${weekAvgCard()}
    ${chart(S.weights, 'kg', true)}</div>
  ${fatCard(lastW)}
  <div class="card"><h2>トレーニングカレンダー(4週間)</h2><div class="cal">${cal}</div></div>`;
}

function fatCard(weight) {
  const list = S.fats, last = list[list.length - 1], done = fatDoneThisWeek();
  const first = list[0];
  const delta = list.length > 1 ? last.pct - first.pct : null;
  const lean = last ? (weight * (1 - last.pct / 100)).toFixed(1) : null;
  return `<div class="card"><div class="between"><h2>体脂肪率(週1回)</h2><span class="pill ${done ? 'on' : ''}">${done ? '今週 記録済み' : '今週 未記録'}</span></div>
    ${last ? `<div><span class="big-num">${last.pct}</span> %
      <span class="sub">(${last.date.slice(5).replace('-', '/')} 測定)</span></div>
      <p class="sub">除脂肪体重の目安 ${lean}kg${delta !== null ? ` ・ 開始時から ${delta > 0 ? '+' : ''}${delta.toFixed(1)}%` : ''}</p>` : '<p class="sub">まだ記録がありません。週に1回、同じ条件(朝など)で測るのがおすすめです。</p>'}
    <div class="row"><input id="fIn" type="number" step="0.1" inputmode="decimal" placeholder="体脂肪率 (%)"><button data-act="addf" class="primary">記録</button></div>
    ${chart(list, 'pct')}</div>`;
}

const dayNum = ds => Math.round(new Date(ds + 'T00:00:00').getTime() / 86400000);
function avgBetween(list, key, fromDs, toDs) { // fromDs以上 toDs未満
  const xs = list.filter(x => x.date >= fromDs && x.date < toDs).map(x => x[key]);
  return xs.length ? { v: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length } : null;
}
// 体重の週平均(今週 vs 先週)
function weekAvgCard() {
  const ws = weekStart(new Date()), thisS = dstr(ws), lastS = dstr(addDays(ws, -7)), nextS = dstr(addDays(ws, 7));
  const a = avgBetween(S.weights, 'kg', thisS, nextS), b = avgBetween(S.weights, 'kg', lastS, thisS);
  const diff = a && b ? a.v - b.v : null;
  const cell = (t, x) => `<div><div class="sub">${t}</div><div class="big-num" style="font-size:28px">${x ? x.v.toFixed(1) : '−'}</div><div class="sub">${x ? `kg(${x.n}回)` : '記録なし'}</div></div>`;
  return `<div class="row" style="margin-top:12px">${cell('今週の平均', a)}${cell('先週の平均', b)}</div>
    <p class="sub">${diff === null ? '2週分の記録がそろうと、増減が分かります。日々の値ではなく、週平均で判断しましょう。' : `先週との差 <b>${diff > 0 ? '+' : ''}${diff.toFixed(2)}kg</b>。日々のブレは気にせず、この平均の動きを見ます。`}</p>`;
}

function chart(list, key, avg) {
  const w = list.slice(-30);
  if (w.length < 2) return '<p class="sub">2回以上記録するとグラフが出ます。</p>';
  // 7日移動平均(記録日を含む直近7日間の平均)
  const ma = w.map(x => { const d = dayNum(x.date), xs = list.filter(y => { const e = dayNum(y.date); return e <= d && e > d - 7; }); return xs.reduce((a, y) => a + y[key], 0) / xs.length; });
  const vals = w.map(x => x[key]), mn = Math.min(...vals) - 0.5, mx = Math.max(...vals) + 0.5;
  const px = i => 10 + i * (280 / (w.length - 1)), py = v => 110 - (v - mn) / (mx - mn) * 100;
  const pts = w.map((x, i) => `${px(i)},${py(x[key])}`).join(' ');
  const avgLine = avg ? `<polyline points="${ma.map((v, i) => `${px(i)},${py(v)}`).join(' ')}" fill="none" stroke="var(--warn)" stroke-width="3" stroke-linejoin="round"/>` : '';
  const legend = avg ? '<div class="sub" style="margin-top:4px"><span style="color:var(--accent)">●</span> 日々の値 <span style="color:var(--warn)">●</span> 7日平均</div>' : '';
  return `<svg viewBox="0 0 300 120" style="width:100%;margin-top:10px"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="${avg ? 1.5 : 3}" stroke-opacity="${avg ? .7 : 1}" stroke-linejoin="round"/>${w.map((x, i) => avg ? `<circle cx="${px(i)}" cy="${py(x[key])}" r="2.5" fill="var(--accent)"/>` : '').join('')}${avgLine}
    <text x="10" y="12" fill="var(--sub)" font-size="10">${mx.toFixed(1)}</text><text x="10" y="118" fill="var(--sub)" font-size="10">${mn.toFixed(1)}</text></svg>${legend}`;
}

function foodView() {
  const p = S.profile, n = nutrition(p), pat = PATTERNS[p.pattern];
  const list = S.protein[today()] || [];
  const got = list.reduce((a, x) => a + x.g, 0);
  const left = Math.max(0, n.protein - got);
  const scoops = Math.ceil(left / 20);
  return `<h1>食事</h1>
  <div class="card"><h2>1日の目安(${pat.name})</h2>
    <div class="row"><div><div class="sub">カロリー</div><div class="big-num">${n.kcal}</div><div class="sub">kcal(維持 ${n.tdee})</div></div>
    <div><div class="sub">たんぱく質</div><div class="big-num">${n.protein}</div><div class="sub">g(体重×${pat.prot})</div></div></div>
    <p class="sub">${pat.kcal > 0 ? `維持カロリーより+${pat.kcal}kcal食べて筋肉の材料を確保します。` : `維持カロリーより${pat.kcal}kcalに抑えて脂肪を落とします。`}体重が2週間変わらなければ、量を少し調整します。</p></div>
  <div class="card"><h2>今日のたんぱく質</h2><div class="between"><span><b class="big-num">${got}</b> / ${n.protein} g</span></div>
    <div class="bar"><i style="width:${Math.min(100, got / n.protein * 100)}%"></i></div>
    <p class="sub">${left > 0 ? `あと${left}g。プロテインなら約${scoops}杯(1杯20gの場合)。` : '目標達成!'}</p>
    <div class="row" style="margin-bottom:10px"><button data-act="addp" data-g="20" data-l="プロテイン">+ プロテイン 20g</button><button data-act="addp" data-g="10" data-l="食事">+ 食事 10g</button></div>
    <div class="row"><input id="pIn" type="number" inputmode="numeric" placeholder="g を入力"><button data-act="addp-custom">追加</button></div>
    ${list.map((x, i) => `<div class="between ex"><span>${x.l} ${x.g}g</span><button class="ghost" data-act="delp" data-i="${i}">削除</button></div>`).join('')}</div>
  <div class="card"><h3>コツ</h3><ul class="list sub"><li>プロテインはトレーニング後か、間食に。</li><li>食事のたんぱく質は、肉・魚・卵・大豆で3食に分ける。</li><li>体重は朝、同じ条件ではかると見やすいです。</li></ul></div>`;
}

// ---------- 実行画面 ----------
let R = null, wakeLock = null;
const fmt = s => `${Math.floor(s / 60)}:${pad(s % 60)}`;

async function wake() { try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* 非対応 */ } }
function release() { try { wakeLock && wakeLock.release(); } catch { /* */ } wakeLock = null; }
function beep() {
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)(), o = c.createOscillator(), g = c.createGain();
    o.connect(g); g.connect(c.destination); o.frequency.value = 880; g.gain.value = 0.15; o.start(); o.stop(c.currentTime + 0.25);
  } catch { /* */ }
  try { navigator.vibrate && navigator.vibrate(200); } catch { /* */ }
}
function tickStop() { if (R && R.t) { clearInterval(R.t); R.t = null; } }
function startTick(fn) { tickStop(); R.t = setInterval(fn, 1000); }

function startRun() {
  const menu = buildMenu(S.profile);
  R = { items: menu.items, i: 0, s: 0, acts: menu.items.map(() => []), phase: 'warm', left: 120, timing: null, t: null, cur: 0, ups: null };
  wake(); runEl.classList.remove('hide'); renderRun();
  startTick(() => { R.left--; if (R.left <= 0) { beep(); beginWork(); } else renderRun(); });
}

function beginWork() { tickStop(); R.phase = 'work'; R.timing = null; R.cur = R.items[R.i].target; renderRun(); }

// 筋トレの後、仕上げの有酸素3分(設定でオフなら省略)
function startCardio() {
  if (!cardioOn(S.profile)) return finishRun();
  R.phase = 'cardio'; R.left = CARDIO_SEC; R.cardio = cardioToday(); R.cardioDone = false;
  beep(); renderRun();
  startTick(() => { R.left--; if (R.left <= 0) { beep(); R.cardioDone = true; finishRun(); } else renderRun(); });
}

function finishSet(reps) {
  tickStop();
  R.acts[R.i].push(reps);
  const it = R.items[R.i];
  if (R.s + 1 >= it.sets) {
    if (R.i + 1 >= R.items.length) return startCardio();
    R.i++; R.s = 0;
  } else R.s++;
  R.phase = 'rest'; R.left = it.rest;
  renderRun();
  startTick(() => { R.left--; if (R.left <= 0) { beep(); beginWork(); } else renderRun(); });
}

function finishRun() {
  tickStop(); release();
  const ups = applyProgress(R.items, R.acts);
  S.logs.push({ date: today(), cardio: !!R.cardioDone, items: R.items.map((it, k) => ({ id: it.ex.id, name: it.ex.name, target: it.target, sets: R.acts[k] })) });
  S.sessions++; save();
  R.phase = 'done'; R.ups = ups; renderRun();
}

function renderRun() {
  const r = R; if (!r) return;
  let body;
  if (r.phase === 'warm') {
    body = `<p class="sub">ウォームアップ</p><div class="timer">${fmt(r.left)}</div><ul class="list">${WARMUP.map(x => `<li>${x}</li>`).join('')}</ul>
      <button class="primary big" data-act="skipwarm">ウォームアップ完了</button>`;
  } else if (r.phase === 'work') {
    const it = r.items[r.i], ex = it.ex, isTime = ex.type === 'time', unit = isTime ? '秒' : '回';
    const set = `${r.s + 1} / ${it.sets}`;
    body = `<div class="between"><span class="sub">種目 ${r.i + 1}/${r.items.length}</span><span class="pill on">セット ${set}</span></div>
      <h1 style="margin-top:12px">${ex.name}</h1><div class="sub">${ex.eq} ・ 目標 ${it.target}${unit}${ex.perSide ? '(左右それぞれ)' : ''}</div>
      <div class="card" style="margin-top:12px"><span class="sub">やり方</span><p style="margin:4px 0 0">${ex.note}</p></div>
      ${isTime ? (r.timing === null
        ? `<button class="primary big" data-act="tstart">スタート(${it.target}秒)</button>`
        : `<div class="timer">${r.timing}</div><button class="big ghost" data-act="tstop">やめる</button>`)
        : `<div class="stepper"><button data-act="rep" data-d="-1">−</button><div class="val">${r.cur}</div><button data-act="rep" data-d="1">＋</button></div>
        <div class="sub" style="text-align:center;margin-bottom:12px">実際にできた${unit}数</div><button class="primary big" data-act="setdone">セット完了</button>`}`;
  } else if (r.phase === 'rest') {
    const nx = r.items[r.i];
    body = `<p class="sub">休憩</p><div class="timer">${r.left}</div>
      <div class="row"><button data-act="rest15">+15秒</button><button data-act="skiprest">スキップ</button></div>
      <div class="card" style="margin-top:16px"><span class="sub">次</span><h2>${nx.ex.name}</h2><span class="sub">セット ${r.s + 1}/${nx.sets} ・ 目標 ${nx.target}${nx.ex.type === 'time' ? '秒' : '回'}</span></div>`;
  } else if (r.phase === 'cardio') {
    const c = r.cardio;
    body = `<p class="sub">仕上げの有酸素(脳トレ付き)</p><div class="timer">${fmt(r.left)}</div>
      <div class="card"><h2>${c.name}</h2><ul class="list">${c.steps.map(x => `<li>${x}</li>`).join('')}</ul></div>
      <p class="sub">少し息が上がるが、会話はできる強さで。</p>
      <button class="ghost big" data-act="skipcardio">スキップして終了</button>`;
  } else {
    body = `<h1>お疲れさまでした!🎉</h1><p class="sub">全${r.items.length}種目 完了。${r.cardioDone ? '有酸素3分も完了です。' : ''}</p>
      <div class="card"><h2>次回の変化</h2>${r.ups.length ? `<ul class="list">${r.ups.map(u => `<li>${u}</li>`).join('')}</ul>` : '<p class="sub">今回は目標に届かなかった種目があるため、次回も同じ回数です。</p>'}</div>
      <div class="card"><h2>クールダウン</h2><ul class="list">${COOLDOWN.map(x => `<li>${x}</li>`).join('')}</ul></div>
      <div class="card"><p>トレーニング後のプロテインをお忘れなく。</p></div>
      <button class="primary big" data-act="close">ホームへ</button>`;
  }
  const top = r.phase === 'done' ? '' : '<div style="text-align:right"><button class="ghost" data-act="abort" style="padding:8px 12px">中止</button></div>';
  runEl.innerHTML = `<div class="in">${top}${body}</div>`;
}

// ---------- イベント ----------
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const a = t.dataset.act;
  switch (a) {
    case 'tab': tab = t.dataset.tab; formDraft = null; render(); break;
    case 'pattern': {
      if (t.classList.contains('off')) break;
      formDraft = readForm(document.getElementById('f')); formDraft.pattern = t.dataset.id;
      const pat = PATTERNS[t.dataset.id]; formDraft.days = pat.days;
      render(); break;
    }
    case 'start': startRun(); break;
    case 'skipwarm': beginWork(); break;
    case 'rep': R.cur = Math.max(0, R.cur + +t.dataset.d); renderRun(); break;
    case 'setdone': finishSet(R.cur); break;
    case 'tstart': {
      const it = R.items[R.i]; R.timing = it.target; renderRun();
      startTick(() => { R.timing--; if (R.timing <= 0) { beep(); finishSet(it.target); } else renderRun(); });
      break;
    }
    case 'tstop': { const it = R.items[R.i], done = it.target - R.timing; R.timing = null; finishSet(Math.max(0, done)); break; }
    case 'rest15': R.left += 15; renderRun(); break;
    case 'skiprest': beginWork(); break;
    case 'skipcardio': R.cardioDone = false; finishRun(); break;
    case 'abort': if (confirm('トレーニングを中止しますか?(記録は保存されません)')) { tickStop(); release(); R = null; runEl.classList.add('hide'); } break;
    case 'close': R = null; runEl.classList.add('hide'); tab = 'today'; render(); break;
    case 'addw': {
      const v = parseFloat(document.getElementById('wIn').value); if (!(v > 0)) break;
      S.weights = S.weights.filter(x => x.date !== today()); S.weights.push({ date: today(), kg: v }); save(); render(); break;
    }
    case 'export': exportData(); break;
    case 'import': document.getElementById('impFile').click(); break;
    case 'addf': {
      const v = parseFloat(document.getElementById('fIn').value); if (!(v > 0 && v < 70)) break;
      S.fats = S.fats.filter(x => x.date !== today()); S.fats.push({ date: today(), pct: v }); save(); render(); break;
    }
    case 'addp': { (S.protein[today()] ||= []).push({ g: +t.dataset.g, l: t.dataset.l }); save(); render(); break; }
    case 'addp-custom': {
      const v = parseInt(document.getElementById('pIn').value, 10); if (!(v > 0)) break;
      (S.protein[today()] ||= []).push({ g: v, l: '追加' }); save(); render(); break;
    }
    case 'delp': S.protein[today()].splice(+t.dataset.i, 1); save(); render(); break;
    case 'reset': if (confirm('本当にすべてのデータを消しますか?')) { S = { profile: null, slots: {}, logs: [], weights: [], fats: [], protein: {}, sessions: 0 }; save(); formDraft = null; tab = 'today'; render(); } break;
  }
});

document.addEventListener('change', e => {
  if (e.target.id === 'impFile' && e.target.files[0]) importData(e.target.files[0]);
});

document.addEventListener('input', e => {
  if (e.target.id === 'stepsIn') document.getElementById('stepsHint').textContent = stepsHint(e.target.value);
});

document.addEventListener('submit', e => {
  if (e.target.id !== 'f') return;
  e.preventDefault();
  const p = readForm(e.target), err = document.getElementById('ferr');
  const est = estimate(p);
  if (!est.ok) { err.textContent = p.pattern === 'lean' ? '減量パターンでは、目標体重を今の体重より軽くしてください。' : '目標体重を今の体重より重くしてください。'; return; }
  if (p.pattern === 'lean' && bmi(p) < 20) { err.textContent = '今の体型では減量パターンは選べません。'; return; }
  const isNew = !S.profile;
  S.profile = p; initSlots(p);
  if (isNew) { S.weights.push({ date: today(), kg: p.weight }); }
  save(); formDraft = null; tab = isNew ? 'log' : 'today'; render(); window.scrollTo(0, 0);
});

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
render();
