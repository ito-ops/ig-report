import 'dotenv/config';
import fs from 'node:fs/promises';

type Insight = {
  reach?: number;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saved?: number;
  total_interactions?: number;
  ig_reels_avg_watch_time?: number;
};

type Post = {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  media_url?: string;
  permalink?: string;
  thumbnail_url?: string;
  timestamp?: string;
  insights: Insight;
};

type DataFile = { fetched_at: string; lookback_days: number; posts: Post[] };

type Enriched = Post & {
  watch_s: number;
  share_pct: number;
  save_pct: number;
  replay_rate: number;
  engagement_rate: number;
  interactions: number;
  hook_score: number;
  hook_score_watch: number;
  hook_score_reach: number;
  hook_score_amp: number;
  caption_len: number;
  hashtag_count: number;
  posted_hour: number;
  posted_day: number;
  diagnosis: string;
  diagnosis_class: string;
  diagnosis_reason: string;
  rank: number;
  thumb_b64?: string;
};

// ───────────────────────────────────────────────────────
// Industry benchmarks for Instagram Reels (publicly cited 2024–2025 data:
// Hootsuite / Later / SocialInsider / Phlanx). Values are conservative averages.
// ───────────────────────────────────────────────────────
const BENCHMARK = {
  engagement_rate: { poor: 1.0, avg: 2.0, good: 4.0, excellent: 6.0, unit: '%', label: 'エンゲージメント率', desc: '(いいね+コメント+シェア+保存) ÷ リーチ' },
  save_pct: { poor: 0.4, avg: 1.0, good: 2.0, excellent: 4.0, unit: '%', label: '保存率', desc: '保存 ÷ リーチ — "後でまた見たい" 指標' },
  share_pct: { poor: 0.2, avg: 0.5, good: 1.0, excellent: 2.0, unit: '%', label: 'シェア率', desc: 'シェア ÷ リーチ — 拡散ポテンシャル' },
  replay_rate: { poor: 1.0, avg: 1.3, good: 1.6, excellent: 2.0, unit: 'x', label: 'リプレイ率', desc: '再生数 ÷ リーチ — 1人あたり何回見られたか' },
  watch_s: { poor: 4, avg: 8, good: 12, excellent: 18, unit: 's', label: '平均視聴秒数', desc: 'リール平均視聴時間' },
};

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}
function safeNum(n: any, fallback = 0): number {
  return typeof n === 'number' && !isNaN(n) ? n : fallback;
}
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function fmt(n: number, digits = 0): string {
  if (!isFinite(n)) return '-';
  return n.toLocaleString('ja-JP', { maximumFractionDigits: digits });
}
function fmtPct(n: number, digits = 2): string {
  if (!isFinite(n)) return '-';
  return n.toFixed(digits) + '%';
}

async function downloadAsBase64(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') || 'image/jpeg';
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch {
    return undefined;
  }
}

function tokenize(caption: string): string[] {
  if (!caption) return [];
  const cleaned = caption
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#@]/g, ' ')
    .replace(/[\n\r]+/g, ' ');
  const tokens: string[] = [];
  for (const w of cleaned.split(/[\s、。,.!?！？・「」『』\(\)\[\]\/\\]+/)) {
    const t = w.trim().toLowerCase();
    if (t.length >= 2 && t.length <= 20 && !/^\d+$/.test(t)) tokens.push(t);
  }
  return tokens;
}

function wordDiff(top: Post[], bottom: Post[]) {
  const tc = new Map<string, number>();
  const bc = new Map<string, number>();
  for (const p of top) for (const t of tokenize(p.caption || '')) tc.set(t, (tc.get(t) || 0) + 1);
  for (const p of bottom) for (const t of tokenize(p.caption || '')) bc.set(t, (bc.get(t) || 0) + 1);
  const stop = new Set(['this','that','with','from','have','your','about','です','ます','して','こと','ある','いる','する','これ','それ','the','and','for','are','you','was']);
  const all = new Set([...tc.keys(), ...bc.keys()]);
  const out: Array<{ word: string; t: number; b: number; d: number }> = [];
  for (const w of all) {
    if (stop.has(w)) continue;
    const t = tc.get(w) || 0;
    const b = bc.get(w) || 0;
    out.push({ word: w, t, b, d: t - b });
  }
  out.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  return out.slice(0, 10);
}

function diagnose(p: Enriched, ctx: any): { label: string; cls: string; reason: string } {
  const isTopReach = ctx.topReachIds.has(p.id);
  const isTopWatch = ctx.topWatchIds.has(p.id);
  const isTopShare = ctx.topShareIds.has(p.id);
  const lowReach = (p.insights.reach ?? 0) < ctx.reachMed * 0.8;
  const lowWatch = p.watch_s < ctx.watchMed * 0.8;
  if (isTopReach && isTopWatch && isTopShare) return { label: 'Winner', cls: 'tag-winner', reason: '視聴・リーチ・拡散すべて上位。完璧なバランス。次もこの型で。' };
  if (isTopWatch && lowReach) return { label: 'Strong hook, IG didn’t push it', cls: 'tag-strong-hook', reason: 'フックは強いがアルゴリズムが押してくれず。サムネ/最初の3秒は良いがリーチが伸びなかった。再投稿/プロモを検討。' };
  if (isTopReach && lowWatch) return { label: 'People clicked, content didn’t hold', cls: 'tag-no-hold', reason: 'リーチは出たが視聴が続かない＝離脱。中盤の編集テンポを見直し。' };
  if (isTopShare && lowWatch) return { label: 'Sharable concept, weak delivery', cls: 'tag-sharable', reason: '拡散はされたが視聴が短い。コンセプトは良いので演出を磨く。' };
  if (isTopWatch) return { label: 'Hook landed', cls: 'tag-hook-landed', reason: 'フックは効いた。他指標が平均的なので、リーチ拡大の仕掛けを追加。' };
  if (lowReach && lowWatch) return { label: 'Underperformed', cls: 'tag-underperformed', reason: '全体的に伸び悩み。トピック・サムネ・最初の1秒を全面見直し。' };
  return { label: 'Average', cls: 'tag-average', reason: '平均的なパフォーマンス。次の一手で1指標を尖らせると上位に上がりやすい。' };
}

function benchmarkBadge(value: number, bm: { poor: number; avg: number; good: number; excellent: number }) {
  if (value >= bm.excellent) return { label: '🏆 Excellent', cls: 'bm-excellent', score: 4 };
  if (value >= bm.good) return { label: '✨ Good', cls: 'bm-good', score: 3 };
  if (value >= bm.avg) return { label: '✓ 平均以上', cls: 'bm-avg', score: 2 };
  if (value >= bm.poor) return { label: '△ 要改善', cls: 'bm-poor', score: 1 };
  return { label: '✗ 低水準', cls: 'bm-low', score: 0 };
}

function hourBucket(h: number): { key: string; label: string } {
  if (h >= 5 && h < 11) return { key: 'morning', label: '朝 (5-11時)' };
  if (h >= 11 && h < 15) return { key: 'midday', label: '昼 (11-15時)' };
  if (h >= 15 && h < 19) return { key: 'evening', label: '夕方 (15-19時)' };
  return { key: 'night', label: '夜 (19-5時)' };
}
const DAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

// ───────────────────────────────────────────────────────
// Inline SVG Illustrations (storyset flat-style, Instagram palette)
// ───────────────────────────────────────────────────────
const HERO_SVG = `
<svg viewBox="0 0 480 360" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="ig-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#833AB4"/>
      <stop offset="30%" stop-color="#C13584"/>
      <stop offset="55%" stop-color="#E1306C"/>
      <stop offset="80%" stop-color="#F77737"/>
      <stop offset="100%" stop-color="#FCAF45"/>
    </linearGradient>
    <linearGradient id="phone-grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#FCAF45"/>
      <stop offset="50%" stop-color="#E1306C"/>
      <stop offset="100%" stop-color="#833AB4"/>
    </linearGradient>
  </defs>
  <circle cx="380" cy="80" r="60" fill="#FCAF45" opacity="0.18"/>
  <circle cx="80" cy="280" r="48" fill="#833AB4" opacity="0.16"/>
  <circle cx="420" cy="280" r="32" fill="#E1306C" opacity="0.18"/>
  <!-- floating chart bars -->
  <g transform="translate(60 60)">
    <rect x="0" y="40" width="14" height="40" rx="3" fill="#C13584"/>
    <rect x="20" y="20" width="14" height="60" rx="3" fill="#E1306C"/>
    <rect x="40" y="0" width="14" height="80" rx="3" fill="#F77737"/>
    <rect x="60" y="30" width="14" height="50" rx="3" fill="#FCAF45"/>
  </g>
  <!-- character body -->
  <g transform="translate(180 70)">
    <ellipse cx="65" cy="240" rx="80" ry="10" fill="#000" opacity="0.08"/>
    <!-- body -->
    <path d="M30 130 Q65 110 100 130 L110 220 Q65 240 20 220 Z" fill="url(#ig-grad)"/>
    <!-- head -->
    <circle cx="65" cy="80" r="38" fill="#FFD9B8"/>
    <!-- hair -->
    <path d="M28 70 Q35 30 65 32 Q98 30 102 70 Q90 55 65 58 Q40 55 28 70 Z" fill="#3D2C2C"/>
    <!-- eyes -->
    <circle cx="54" cy="85" r="3" fill="#3D2C2C"/>
    <circle cx="78" cy="85" r="3" fill="#3D2C2C"/>
    <!-- smile -->
    <path d="M55 98 Q65 105 75 98" stroke="#3D2C2C" stroke-width="2" fill="none" stroke-linecap="round"/>
    <!-- arm holding phone -->
    <path d="M95 145 L130 130" stroke="#FFD9B8" stroke-width="14" stroke-linecap="round"/>
    <!-- phone -->
    <g transform="translate(120 95) rotate(15)">
      <rect x="0" y="0" width="48" height="80" rx="8" fill="#262626"/>
      <rect x="3" y="6" width="42" height="68" rx="4" fill="url(#phone-grad)"/>
      <!-- play icon -->
      <polygon points="18,30 18,50 34,40" fill="#fff"/>
      <!-- heart on phone -->
      <path d="M10 60 q-4 -4 0 -8 q4 -4 8 0 q4 -4 8 0 q4 4 0 8 l-8 8 z" fill="#fff" opacity="0.9"/>
    </g>
  </g>
  <!-- floating hearts -->
  <g opacity="0.85">
    <path d="M340 140 q-6 -6 0 -12 q6 -6 12 0 q6 -6 12 0 q6 6 0 12 l-12 12 z" fill="#E1306C"/>
    <path d="M390 200 q-4 -4 0 -8 q4 -4 8 0 q4 -4 8 0 q4 4 0 8 l-8 8 z" fill="#F77737"/>
  </g>
  <!-- chart line -->
  <polyline points="320,260 350,240 380,250 410,220 440,200" stroke="#833AB4" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="440" cy="200" r="5" fill="#833AB4"/>
</svg>`;

const ICON_TROPHY = `
<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="trophy-grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#FCAF45"/><stop offset="100%" stop-color="#F77737"/>
    </linearGradient>
  </defs>
  <path d="M20 14 h40 v18 a20 20 0 0 1 -40 0 z" fill="url(#trophy-grad)"/>
  <path d="M20 18 h-8 a4 4 0 0 0 -4 4 v4 a10 10 0 0 0 10 10" stroke="#F77737" stroke-width="3" fill="none"/>
  <path d="M60 18 h8 a4 4 0 0 1 4 4 v4 a10 10 0 0 1 -10 10" stroke="#F77737" stroke-width="3" fill="none"/>
  <rect x="32" y="50" width="16" height="10" fill="#F77737"/>
  <rect x="24" y="60" width="32" height="6" rx="2" fill="#833AB4"/>
  <text x="40" y="32" text-anchor="middle" font-size="16" font-weight="900" fill="#fff" font-family="sans-serif">★</text>
</svg>`;

const ICON_BENCHMARK = `
<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="bm-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#833AB4"/><stop offset="100%" stop-color="#E1306C"/>
    </linearGradient>
  </defs>
  <circle cx="34" cy="34" r="22" stroke="url(#bm-grad)" stroke-width="5" fill="none"/>
  <line x1="50" y1="50" x2="68" y2="68" stroke="url(#bm-grad)" stroke-width="5" stroke-linecap="round"/>
  <rect x="22" y="36" width="5" height="10" fill="#C13584"/>
  <rect x="30" y="28" width="5" height="18" fill="#E1306C"/>
  <rect x="38" y="22" width="5" height="24" fill="#F77737"/>
</svg>`;

const ICON_TIMING = `
<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="t-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#FCAF45"/><stop offset="100%" stop-color="#E1306C"/>
    </linearGradient>
  </defs>
  <circle cx="40" cy="42" r="28" fill="url(#t-grad)"/>
  <circle cx="40" cy="42" r="22" fill="#fff"/>
  <line x1="40" y1="42" x2="40" y2="26" stroke="#262626" stroke-width="3" stroke-linecap="round"/>
  <line x1="40" y1="42" x2="52" y2="48" stroke="#262626" stroke-width="3" stroke-linecap="round"/>
  <circle cx="40" cy="42" r="2.5" fill="#262626"/>
  <rect x="32" y="6" width="16" height="6" rx="2" fill="#833AB4"/>
</svg>`;

const ICON_LIGHTBULB = `
<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="lb-grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#FCAF45"/><stop offset="100%" stop-color="#F77737"/>
    </linearGradient>
  </defs>
  <path d="M40 10 a20 20 0 0 1 14 34 v6 h-28 v-6 a20 20 0 0 1 14 -34 z" fill="url(#lb-grad)"/>
  <rect x="28" y="52" width="24" height="6" rx="2" fill="#262626"/>
  <rect x="30" y="60" width="20" height="4" rx="2" fill="#262626"/>
  <rect x="34" y="66" width="12" height="4" rx="2" fill="#262626"/>
  <g stroke="#FCAF45" stroke-width="2.5" stroke-linecap="round">
    <line x1="14" y1="20" x2="20" y2="24"/>
    <line x1="66" y1="20" x2="60" y2="24"/>
    <line x1="10" y1="40" x2="18" y2="40"/>
    <line x1="70" y1="40" x2="62" y2="40"/>
  </g>
</svg>`;

const ICON_PATTERN = `
<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="p-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#833AB4"/><stop offset="100%" stop-color="#F77737"/>
    </linearGradient>
  </defs>
  <rect x="10" y="14" width="36" height="28" rx="6" fill="url(#p-grad)"/>
  <polygon points="20,42 26,42 22,52" fill="#F77737"/>
  <rect x="34" y="34" width="36" height="28" rx="6" fill="#E1306C" opacity="0.9"/>
  <polygon points="48,62 54,62 50,72" fill="#E1306C"/>
  <circle cx="20" cy="24" r="2.5" fill="#fff"/>
  <circle cx="30" cy="24" r="2.5" fill="#fff"/>
  <rect x="16" y="30" width="20" height="3" rx="1" fill="#fff"/>
  <circle cx="44" cy="44" r="2.5" fill="#fff"/>
  <circle cx="54" cy="44" r="2.5" fill="#fff"/>
  <rect x="40" y="50" width="20" height="3" rx="1" fill="#fff"/>
</svg>`;

const ICON_RANKING = `
<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="rk-grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#833AB4"/><stop offset="100%" stop-color="#E1306C"/>
    </linearGradient>
  </defs>
  <rect x="10" y="46" width="18" height="24" rx="3" fill="#F77737"/>
  <rect x="32" y="30" width="18" height="40" rx="3" fill="url(#rk-grad)"/>
  <rect x="54" y="38" width="18" height="32" rx="3" fill="#FCAF45"/>
  <text x="19" y="62" text-anchor="middle" font-size="12" font-weight="900" fill="#fff" font-family="sans-serif">2</text>
  <text x="41" y="54" text-anchor="middle" font-size="14" font-weight="900" fill="#fff" font-family="sans-serif">1</text>
  <text x="63" y="58" text-anchor="middle" font-size="12" font-weight="900" fill="#fff" font-family="sans-serif">3</text>
  <polygon points="41,18 44,26 52,26 46,31 48,39 41,34 34,39 36,31 30,26 38,26" fill="#FCAF45"/>
</svg>`;

async function main() {
  let raw: string;
  try {
    raw = await fs.readFile('data.json', 'utf-8');
  } catch {
    console.error('❌ data.json が見つかりません。先に npm run agent を実行してください。');
    process.exit(1);
  }
  const data: DataFile = JSON.parse(raw);

  if (!data.posts.length) {
    const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>Instagram Reels Report</title>
<body style="font-family:'Noto Sans JP',sans-serif;padding:40px;background:#fafafa">
<h1>分析対象の投稿がありません</h1>
<p>直近 ${data.lookback_days} 日間にリール/動画投稿が見つかりませんでした。</p></body></html>`;
    await fs.writeFile('report.html', html);
    console.log('⚠️  投稿0件のためダミーレポートを出力しました。');
    return;
  }

  const enriched: Enriched[] = data.posts.map((p) => {
    const reach = safeNum(p.insights.reach);
    const views = safeNum(p.insights.views);
    const shares = safeNum(p.insights.shares);
    const saved = safeNum(p.insights.saved);
    const watch_ms = safeNum(p.insights.ig_reels_avg_watch_time);
    const watch_s = watch_ms / 1000;
    const share_pct = reach > 0 ? (shares / reach) * 100 : 0;
    const save_pct = reach > 0 ? (saved / reach) * 100 : 0;
    const replay_rate = reach > 0 ? views / reach : 0;
    const interactions = safeNum(p.insights.total_interactions) ||
      (safeNum(p.insights.likes) + safeNum(p.insights.comments) + shares + saved);
    const engagement_rate = reach > 0 ? (interactions / reach) * 100 : 0;
    const hook_score_watch = watch_s;
    const hook_score_reach = Math.sqrt(Math.max(0, reach));
    const hook_score_amp = 1 + share_pct / 100 + save_pct / 200;
    const hook_score = hook_score_watch * hook_score_reach * hook_score_amp;
    const caption_len = (p.caption || '').length;
    const hashtag_count = ((p.caption || '').match(/#[^\s#]+/g) || []).length;
    const dt = p.timestamp ? new Date(p.timestamp) : new Date(0);
    return {
      ...p,
      watch_s, share_pct, save_pct, replay_rate, engagement_rate, interactions,
      hook_score, hook_score_watch, hook_score_reach, hook_score_amp,
      caption_len, hashtag_count,
      posted_hour: dt.getHours(),
      posted_day: dt.getDay(),
      diagnosis: '', diagnosis_class: '', diagnosis_reason: '', rank: 0,
    };
  });

  enriched.sort((a, b) => b.hook_score - a.hook_score);
  enriched.forEach((p, i) => (p.rank = i + 1));

  const watches = enriched.map((p) => p.watch_s).filter((n) => n > 0);
  const reaches = enriched.map((p) => safeNum(p.insights.reach)).filter((n) => n > 0);
  const watchMed = median(watches);
  const reachMed = median(reaches);

  const topN = Math.max(1, Math.ceil(enriched.length * 0.3));
  const topReachIds = new Set([...enriched].sort((a, b) => safeNum(b.insights.reach) - safeNum(a.insights.reach)).slice(0, topN).map((p) => p.id));
  const topWatchIds = new Set([...enriched].sort((a, b) => b.watch_s - a.watch_s).slice(0, topN).map((p) => p.id));
  const topShareIds = new Set([...enriched].sort((a, b) => safeNum(b.insights.shares) - safeNum(a.insights.shares)).slice(0, topN).map((p) => p.id));

  for (const p of enriched) {
    const d = diagnose(p, { watchMed, reachMed, topReachIds, topWatchIds, topShareIds });
    p.diagnosis = d.label;
    p.diagnosis_class = d.cls;
    p.diagnosis_reason = d.reason;
  }

  console.log(`🖼  サムネイル ${enriched.length} 件をダウンロード中...`);
  await Promise.all(enriched.map(async (p) => {
    const url = p.thumbnail_url || p.media_url;
    if (url) p.thumb_b64 = await downloadAsBase64(url);
  }));
  console.log('   完了');

  // Aggregate stats
  const aggEngagement = avg(enriched.map((p) => p.engagement_rate));
  const aggSave = avg(enriched.map((p) => p.save_pct));
  const aggShare = avg(enriched.map((p) => p.share_pct));
  const aggReplay = avg(enriched.map((p) => p.replay_rate));
  const aggWatch = avg(enriched.map((p) => p.watch_s));

  // Reach concentration
  const totalReach = enriched.reduce((s, p) => s + safeNum(p.insights.reach), 0);
  const top3Reach = [...enriched].sort((a, b) => safeNum(b.insights.reach) - safeNum(a.insights.reach)).slice(0, 3)
    .reduce((s, p) => s + safeNum(p.insights.reach), 0);
  const reachConcentration = totalReach > 0 ? (top3Reach / totalReach) * 100 : 0;

  const topWatchMax = Math.max(...enriched.map((p) => p.watch_s));
  const watchGap = watchMed > 0 ? topWatchMax / watchMed : 0;
  const strongHookCount = enriched.filter((p) => p.watch_s > watchMed * 1.5).length;
  const replayWins = enriched.filter((p) => p.replay_rate > 1.5).length;

  // Time-of-day analysis
  const hourGroups: Record<string, { label: string; reach: number[]; watch: number[]; eng: number[] }> = {
    morning: { label: '朝 (5-11時)', reach: [], watch: [], eng: [] },
    midday: { label: '昼 (11-15時)', reach: [], watch: [], eng: [] },
    evening: { label: '夕方 (15-19時)', reach: [], watch: [], eng: [] },
    night: { label: '夜 (19-5時)', reach: [], watch: [], eng: [] },
  };
  for (const p of enriched) {
    const b = hourBucket(p.posted_hour);
    hourGroups[b.key].reach.push(safeNum(p.insights.reach));
    hourGroups[b.key].watch.push(p.watch_s);
    hourGroups[b.key].eng.push(p.engagement_rate);
  }

  // Day-of-week
  const dayStats: Array<{ label: string; count: number; reach: number; eng: number }> = [];
  for (let d = 0; d < 7; d++) {
    const posts = enriched.filter((p) => p.posted_day === d);
    dayStats.push({
      label: DAY_LABELS[d],
      count: posts.length,
      reach: posts.length ? avg(posts.map((p) => safeNum(p.insights.reach))) : 0,
      eng: posts.length ? avg(posts.map((p) => p.engagement_rate)) : 0,
    });
  }

  // Caption length buckets
  const sortedByCap = [...enriched].sort((a, b) => a.caption_len - b.caption_len);
  const thirdsLen = Math.ceil(sortedByCap.length / 3);
  const capShort = sortedByCap.slice(0, thirdsLen);
  const capMed = sortedByCap.slice(thirdsLen, thirdsLen * 2);
  const capLong = sortedByCap.slice(thirdsLen * 2);
  const capBuckets = [
    { label: '短文 (~' + (capShort[capShort.length - 1]?.caption_len || 0) + '文字)', engAvg: avg(capShort.map((p) => p.engagement_rate)), reachAvg: avg(capShort.map((p) => safeNum(p.insights.reach))) },
    { label: '中文 (~' + (capMed[capMed.length - 1]?.caption_len || 0) + '文字)', engAvg: avg(capMed.map((p) => p.engagement_rate)), reachAvg: avg(capMed.map((p) => safeNum(p.insights.reach))) },
    { label: '長文 (' + (capLong[0]?.caption_len || 0) + '文字+)', engAvg: avg(capLong.map((p) => p.engagement_rate)), reachAvg: avg(capLong.map((p) => safeNum(p.insights.reach))) },
  ];

  // Hashtag buckets
  const hashGroups = [
    { label: 'なし (0個)', posts: enriched.filter((p) => p.hashtag_count === 0) },
    { label: '少なめ (1-5個)', posts: enriched.filter((p) => p.hashtag_count >= 1 && p.hashtag_count <= 5) },
    { label: '多め (6個以上)', posts: enriched.filter((p) => p.hashtag_count >= 6) },
  ].map((g) => ({
    label: g.label,
    count: g.posts.length,
    reachAvg: g.posts.length ? avg(g.posts.map((p) => safeNum(p.insights.reach))) : 0,
    engAvg: g.posts.length ? avg(g.posts.map((p) => p.engagement_rate)) : 0,
  }));

  // Word diff
  const topRanked = enriched.slice(0, 3);
  const botRanked = enriched.slice(-3);
  const wordDiffs = wordDiff(topRanked, botRanked);

  // Headline
  const topReachPost = [...enriched].sort((a, b) => safeNum(b.insights.reach) - safeNum(a.insights.reach))[0];
  const headline = topReachPost && reachMed > 0
    ? `トップ投稿は中央値の ${(safeNum(topReachPost.insights.reach) / reachMed).toFixed(1)}倍リーチ`
    : 'リーチデータが揃っていません';

  // Action Grid
  const doMore: string[] = [];
  for (const p of topRanked) {
    const cap = (p.caption || '').slice(0, 40).replace(/\n/g, ' ');
    doMore.push(`「${cap || '(キャプションなし)'}」型: 視聴 ${p.watch_s.toFixed(1)}秒 / リーチ ${fmt(safeNum(p.insights.reach))}`);
  }
  const stopDoing: string[] = [];
  const underperformers = enriched.filter((p) => p.diagnosis === 'Underperformed').slice(0, 3);
  for (const p of underperformers) {
    const cap = (p.caption || '').slice(0, 40).replace(/\n/g, ' ');
    stopDoing.push(`「${cap || '(キャプションなし)'}」: 視聴 ${p.watch_s.toFixed(1)}秒 / リーチ ${fmt(safeNum(p.insights.reach))}`);
  }
  if (!stopDoing.length) stopDoing.push('明確に「止めるべき」パターンは見つかりませんでした');
  const fixThese: string[] = [];
  for (const p of enriched.filter((p) => p.diagnosis.includes('clicked, content didn’t hold') || p.diagnosis.includes('Sharable')).slice(0, 3)) {
    const cap = (p.caption || '').slice(0, 40).replace(/\n/g, ' ');
    fixThese.push(`「${cap || '(キャプションなし)'}」: ${p.diagnosis}`);
  }
  if (!fixThese.length) fixThese.push('要改善カテゴリの該当投稿はありません');

  const html = renderHtml({
    data, enriched, headline, reachConcentration, watchGap, strongHookCount, replayWins,
    wordDiffs, doMore, stopDoing, fixThese,
    aggEngagement, aggSave, aggShare, aggReplay, aggWatch,
    hourGroups, dayStats, capBuckets, hashGroups,
  });

  await fs.writeFile('report.html', html);
  console.log(`✅ report.html を生成しました（${enriched.length} 件）`);
}

function gaugeSvg(value: number, bm: { poor: number; avg: number; good: number; excellent: number }, unit: string, index: number = 0): string {
  const radius = 42;
  const halfC = Math.PI * radius;
  const max = bm.excellent * 1.2;
  const pct = Math.min(1, Math.max(0, value / max));
  const targetOffset = -halfC * pct;
  const uid = `g${index}_${Math.floor(Math.random() * 1000000)}`;
  const decimals = unit === 's' || unit === 'x' ? 1 : 2;
  const displayValue = value.toFixed(decimals);
  const strokeDelay = 0.25 + index * 0.18;
  const textDelay = strokeDelay + 0.15;
  return `<svg viewBox="0 0 100 62" xmlns="http://www.w3.org/2000/svg" class="gauge-svg"><defs><linearGradient id="ga-${uid}" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#FCAF45"/><stop offset="40%" stop-color="#F77737"/><stop offset="65%" stop-color="#E1306C"/><stop offset="100%" stop-color="#833AB4"/></linearGradient></defs><g fill="none" stroke-width="8" stroke-linecap="round" transform="translate(50 50.5)"><circle r="${radius}" stroke="#EFEFEF"/><circle r="${radius}" stroke="url(#ga-${uid})" stroke-dasharray="${halfC.toFixed(2)} ${halfC.toFixed(2)}" stroke-dashoffset="0"><animate attributeName="stroke-dashoffset" from="0" to="${targetOffset.toFixed(2)}" dur="1.4s" begin="${strokeDelay}s" fill="freeze" calcMode="spline" keySplines="0.65 0 0.35 1"/></circle></g><text x="50" y="44" text-anchor="middle" font-size="14" font-weight="900" fill="#262626" font-family="'Noto Sans JP',sans-serif" class="gauge-num" style="--num-delay:${textDelay}s" data-target="${displayValue}" data-unit="${unit}" data-decimals="${decimals}" data-delay="${(textDelay * 1000).toFixed(0)}">0${unit}</text></svg>`;
}

function benchmarkRow(label: string, desc: string, value: number, bm: any, index: number = 0): string {
  const badge = benchmarkBadge(value, bm);
  const max = bm.excellent * 1.2;
  const pct = Math.min(100, (value / max) * 100);
  const avgPct = Math.min(100, (bm.avg / max) * 100);
  const goodPct = Math.min(100, (bm.good / max) * 100);
  const excPct = Math.min(100, (bm.excellent / max) * 100);
  const barDelay = 0.4 + index * 0.18;
  return `
  <div class="bm-row">
    <div class="bm-left">
      <div class="bm-label">${label}</div>
      <div class="bm-desc">${desc}</div>
    </div>
    <div class="bm-mid">
      ${gaugeSvg(value, bm, bm.unit, index)}
    </div>
    <div class="bm-right">
      <div class="bm-badge ${badge.cls}">${badge.label}</div>
      <div class="bm-bar-wrap">
        <div class="bm-bar-track">
          <div class="bm-bar-fill" style="--bar-target:${pct}%;--bar-delay:${barDelay}s"></div>
          <div class="bm-mark" style="left:${avgPct}%" title="平均"></div>
          <div class="bm-mark good" style="left:${goodPct}%" title="Good"></div>
          <div class="bm-mark exc" style="left:${excPct}%" title="Excellent"></div>
        </div>
        <div class="bm-bar-legend">
          <span>平均 ${bm.avg}${bm.unit}</span>
          <span>Good ${bm.good}${bm.unit}</span>
          <span>Excellent ${bm.excellent}${bm.unit}</span>
        </div>
      </div>
    </div>
  </div>`;
}

function renderHtml(ctx: any): string {
  const {
    data, enriched, headline, reachConcentration, watchGap, strongHookCount, replayWins,
    wordDiffs, doMore, stopDoing, fixThese,
    aggEngagement, aggSave, aggShare, aggReplay, aggWatch,
    hourGroups, dayStats, capBuckets, hashGroups,
  } = ctx;
  const bottomIds = new Set(enriched.slice(-3).map((p: any) => p.id));
  const topIds = new Set(enriched.slice(0, 3).map((p: any) => p.id));

  const cards = enriched.map((p: Enriched) => {
    const ringCls =
      topIds.has(p.id) ? 'card top'
      : bottomIds.has(p.id) ? 'card bottom'
      : (p.diagnosis.includes('Strong hook') || p.diagnosis.includes('Hook landed')) ? 'card yellow'
      : 'card';
    const cap = escapeHtml(p.caption || '(キャプションなし)').slice(0, 220);
    const date = p.timestamp ? new Date(p.timestamp).toLocaleDateString('ja-JP') : '-';
    const time = p.timestamp ? new Date(p.timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '';
    const engBadge = benchmarkBadge(p.engagement_rate, BENCHMARK.engagement_rate);
    const saveBadge = benchmarkBadge(p.save_pct, BENCHMARK.save_pct);
    const shareBadge = benchmarkBadge(p.share_pct, BENCHMARK.share_pct);
    const watchBadge = benchmarkBadge(p.watch_s, BENCHMARK.watch_s);
    const replayBadge = benchmarkBadge(p.replay_rate, BENCHMARK.replay_rate);
    return `
    <div class="${ringCls}">
      <div class="card-top-row">
        <div class="rank-pill">#${p.rank}</div>
        <div class="hook-score-pill">Hook ${fmt(p.hook_score, 0)}</div>
      </div>
      <a href="${escapeHtml(p.permalink || '#')}" target="_blank" rel="noopener" class="thumb-link">
        ${p.thumb_b64 ? `<img class="thumb" src="${p.thumb_b64}" alt="thumbnail" loading="lazy">` : '<div class="thumb placeholder">no image</div>'}
        <div class="thumb-overlay"></div>
      </a>
      <div class="card-body">
        <div class="card-meta">${date} ${time} ・ ${escapeHtml(p.media_product_type || p.media_type || '')}</div>
        <div class="tag ${p.diagnosis_class}">${escapeHtml(p.diagnosis)}</div>
        <div class="diag-reason">${escapeHtml(p.diagnosis_reason)}</div>
        <div class="card-caption">${cap}</div>

        <div class="hook-breakdown">
          <div class="hb-title">Hook Score 内訳</div>
          <div class="hb-row"><span>視聴秒</span><span class="hb-val">${p.watch_s.toFixed(1)}</span></div>
          <div class="hb-row"><span>√リーチ</span><span class="hb-val">${p.hook_score_reach.toFixed(1)}</span></div>
          <div class="hb-row"><span>拡散係数</span><span class="hb-val">${p.hook_score_amp.toFixed(3)}</span></div>
        </div>

        <div class="bench-grid">
          <div class="bench-pill ${engBadge.cls}"><span class="bp-label">エンゲージ</span><span class="bp-val">${fmtPct(p.engagement_rate)}</span></div>
          <div class="bench-pill ${saveBadge.cls}"><span class="bp-label">保存</span><span class="bp-val">${fmtPct(p.save_pct)}</span></div>
          <div class="bench-pill ${shareBadge.cls}"><span class="bp-label">シェア</span><span class="bp-val">${fmtPct(p.share_pct)}</span></div>
          <div class="bench-pill ${watchBadge.cls}"><span class="bp-label">視聴</span><span class="bp-val">${p.watch_s.toFixed(1)}s</span></div>
          <div class="bench-pill ${replayBadge.cls}"><span class="bp-label">リプレイ</span><span class="bp-val">${p.replay_rate.toFixed(2)}x</span></div>
        </div>

        <div class="metrics">
          <div class="metric"><span class="m-label">リーチ</span><span class="m-val">${fmt(safeNum(p.insights.reach))}</span></div>
          <div class="metric"><span class="m-label">再生</span><span class="m-val">${fmt(safeNum(p.insights.views))}</span></div>
          <div class="metric"><span class="m-label">いいね</span><span class="m-val">${fmt(safeNum(p.insights.likes))}</span></div>
          <div class="metric"><span class="m-label">コメント</span><span class="m-val">${fmt(safeNum(p.insights.comments))}</span></div>
          <div class="metric"><span class="m-label">シェア</span><span class="m-val">${fmt(safeNum(p.insights.shares))}</span></div>
          <div class="metric"><span class="m-label">保存</span><span class="m-val">${fmt(safeNum(p.insights.saved))}</span></div>
        </div>
      </div>
    </div>`;
  }).join('\n');

  const wordRows = wordDiffs.length
    ? wordDiffs.map((w: any) => `<tr>
        <td>${escapeHtml(w.word)}</td>
        <td style="text-align:right">${w.t}</td>
        <td style="text-align:right">${w.b}</td>
        <td style="text-align:right;color:${w.d > 0 ? '#16a34a' : '#dc2626'};font-weight:700">${w.d > 0 ? '+' : ''}${w.d}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:24px">十分なキャプションデータがありません</td></tr>';

  const hourBars = Object.entries(hourGroups as any).map(([k, g]: any) => {
    const reachAvg = g.reach.length ? avg(g.reach) : 0;
    const engAvg = g.eng.length ? avg(g.eng) : 0;
    return { key: k, label: g.label, count: g.reach.length, reach: reachAvg, eng: engAvg };
  });
  const maxHourReach = Math.max(1, ...hourBars.map((h) => h.reach));

  const dayBars = (dayStats as any[]).map((d) => ({ ...d }));
  const maxDayReach = Math.max(1, ...dayBars.map((d) => d.reach));

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Instagram Reels Insight Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;500;700;900&family=Noto+Sans:wght@400;600;700;900&display=swap" rel="stylesheet">
<style>
:root{
  --ig-purple:#833AB4; --ig-magenta:#C13584; --ig-pink:#E1306C; --ig-red:#FD1D1D;
  --ig-orange:#F77737; --ig-yellow:#FCAF45;
  --ig-grad:linear-gradient(135deg,#833AB4 0%,#C13584 25%,#E1306C 50%,#F77737 75%,#FCAF45 100%);
  --ig-grad-soft:linear-gradient(135deg,#833AB422 0%,#E1306C22 50%,#FCAF4522 100%);
  --ink:#262626; --muted:#737373; --line:#EFEFEF; --panel:#fff; --bg:#FAFAFA;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);font-family:'Noto Sans JP','Noto Sans',-apple-system,BlinkMacSystemFont,sans-serif;line-height:1.6;-webkit-font-smoothing:antialiased}
.container{max-width:1240px;margin:0 auto;padding:24px 24px 80px}

/* Hero */
.hero{position:relative;border-radius:28px;background:var(--ig-grad);padding:48px 40px;color:#fff;overflow:hidden;margin-bottom:32px;display:grid;grid-template-columns:1.3fr 1fr;gap:24px;align-items:center}
.hero::before{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at top right,rgba(255,255,255,0.18),transparent 60%);pointer-events:none}
.hero h1{font-size:34px;font-weight:900;margin:0 0 8px;letter-spacing:-0.02em;line-height:1.2}
.hero h1 .accent{display:inline-block;background:rgba(255,255,255,0.18);padding:2px 12px;border-radius:999px;font-size:0.5em;font-weight:700;vertical-align:middle;margin-left:8px}
.hero .subtitle{font-size:14px;opacity:0.92;font-weight:500}
.hero-stats{display:flex;gap:12px;margin-top:20px;flex-wrap:wrap}
.hero-stats .hs{background:rgba(255,255,255,0.18);backdrop-filter:blur(8px);padding:10px 16px;border-radius:14px;font-weight:600;font-size:13px}
.hero-stats .hs strong{font-size:18px;font-weight:900;display:block}
.hero-illust{position:relative;z-index:1}
.hero-illust svg{width:100%;height:auto;max-height:300px}

/* Section base */
.section{background:var(--panel);border-radius:20px;padding:32px;margin-bottom:24px;border:1px solid var(--line);position:relative;overflow:hidden}
.section-header{display:flex;align-items:center;gap:16px;margin-bottom:24px}
.section-icon{width:56px;height:56px;flex-shrink:0;background:var(--ig-grad-soft);border-radius:14px;display:flex;align-items:center;justify-content:center}
.section-icon svg{width:42px;height:42px}
.section h2{font-size:22px;font-weight:900;margin:0;letter-spacing:-0.01em}
.section-subtitle{font-size:13px;color:var(--muted);margin-top:4px;font-weight:500}
.layer-tag{display:inline-block;font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;background:var(--ig-grad);color:#fff;margin-left:8px;vertical-align:middle;letter-spacing:0.02em}

/* Headline section */
.headline-big{font-size:32px;font-weight:900;background:var(--ig-grad);-webkit-background-clip:text;background-clip:text;color:transparent;letter-spacing:-0.02em;line-height:1.3;margin-bottom:24px}
.stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.stat-card{background:linear-gradient(180deg,#fff 0%,#FAFAFA 100%);border:1px solid var(--line);border-radius:16px;padding:20px;position:relative;overflow:hidden}
.stat-card::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:var(--ig-grad)}
.stat-card .lbl{font-size:12px;color:var(--muted);font-weight:600;margin-bottom:6px}
.stat-card .val{font-size:28px;font-weight:900;letter-spacing:-0.02em}
.stat-card .hint{font-size:11px;color:var(--muted);margin-top:4px}

/* Benchmark section */
.bm-row{display:grid;grid-template-columns:1fr 200px 1.4fr;gap:24px;padding:20px 0;border-bottom:1px solid var(--line);align-items:center}
.bm-row:last-child{border-bottom:none}
.bm-label{font-size:16px;font-weight:700;margin-bottom:4px}
.bm-desc{font-size:12px;color:var(--muted)}
.gauge-svg{display:block;margin:0 auto;width:100%;max-width:200px}
.gauge-num{opacity:0;animation:gauge-num-fade .5s ease-out forwards;animation-delay:var(--num-delay,.6s)}
@keyframes gauge-num-fade{to{opacity:1}}
.bm-badge{display:inline-block;font-size:13px;font-weight:700;padding:6px 14px;border-radius:999px;margin-bottom:12px}
.bm-excellent{background:#16a34a;color:#fff}
.bm-good{background:#22c55e22;color:#16a34a;border:1px solid #22c55e44}
.bm-avg{background:#3b82f622;color:#1e40af;border:1px solid #3b82f644}
.bm-poor{background:#f59e0b22;color:#92400e;border:1px solid #f59e0b44}
.bm-low{background:#ef444422;color:#991b1b;border:1px solid #ef444444}
.bm-bar-wrap{margin-top:8px}
.bm-bar-track{position:relative;height:10px;background:#F0F0F0;border-radius:999px;overflow:visible}
.bm-bar-fill{position:absolute;top:0;left:0;bottom:0;width:0;background:var(--ig-grad);border-radius:999px;animation:bm-bar-grow 1.4s cubic-bezier(0.65,0,0.35,1) forwards;animation-delay:var(--bar-delay,.5s)}
@keyframes bm-bar-grow{to{width:var(--bar-target,0%)}}
.bm-mark{position:absolute;top:-3px;width:2px;height:16px;background:#737373;opacity:0.5}
.bm-mark.good{background:#22c55e;opacity:0.9}
.bm-mark.exc{background:#16a34a;opacity:1;width:3px}
.bm-bar-legend{display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-top:6px;font-weight:600}
.bm-note{font-size:11px;color:var(--muted);margin-top:16px;padding-top:16px;border-top:1px dashed var(--line);font-style:italic}

/* Timing / Pattern grids */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:24px}
.mini-section{background:#FAFAFA;border-radius:14px;padding:20px;border:1px solid var(--line)}
.mini-section h3{font-size:14px;font-weight:700;margin:0 0 14px;color:var(--ink)}
.bar-list{display:flex;flex-direction:column;gap:10px}
.bar-row{display:grid;grid-template-columns:120px 1fr 70px;gap:12px;align-items:center;font-size:13px}
.bar-row .bl{font-weight:600;color:var(--ink)}
.bar-row .bb-track{height:12px;background:#EFEFEF;border-radius:999px;position:relative;overflow:hidden}
.bar-row .bb-fill{position:absolute;inset:0;width:0%;background:var(--ig-grad);border-radius:999px;transition:width 0.6s}
.bar-row .bv{text-align:right;font-weight:700;color:var(--muted);font-size:12px}
.day-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;text-align:center}
.day-cell{background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 4px}
.day-cell .dl{font-size:11px;color:var(--muted);font-weight:700}
.day-cell .dv{font-size:16px;font-weight:900;margin-top:4px}
.day-cell .dc{font-size:10px;color:var(--muted)}
.day-cell.has{background:var(--ig-grad-soft)}

/* Action Grid */
.action-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.action{border-radius:16px;padding:20px;border:2px solid;position:relative;overflow:hidden}
.action.do{background:linear-gradient(180deg,#ECFDF522,#fff);border-color:#22c55e55}
.action.stop{background:linear-gradient(180deg,#FEF2F222,#fff);border-color:#ef444455}
.action.fix{background:linear-gradient(180deg,#FEFCE822,#fff);border-color:#FCAF4555}
.action h3{margin:0 0 14px;font-size:16px;font-weight:900;display:flex;align-items:center;gap:8px}
.action ul{padding-left:18px;margin:0;font-size:13px;color:#374151}
.action ul li{margin-bottom:8px;line-height:1.5}

/* Words table */
table.words{width:100%;border-collapse:collapse;font-size:14px;font-family:'Noto Sans JP',sans-serif}
table.words th,table.words td{padding:10px 12px;border-bottom:1px solid var(--line)}
table.words th{text-align:left;color:var(--muted);font-weight:700;background:#FAFAFA;font-size:12px;letter-spacing:0.04em;text-transform:uppercase}
table.words tr:hover td{background:#FAFAFA}

/* Cards */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:20px}
.card{background:#fff;border-radius:18px;border:1px solid var(--line);overflow:hidden;display:flex;flex-direction:column;position:relative;transition:transform 0.2s,box-shadow 0.2s}
.card:hover{transform:translateY(-4px);box-shadow:0 12px 32px rgba(131,58,180,0.12)}
.card.top{border:2px solid transparent;background:linear-gradient(#fff,#fff) padding-box,var(--ig-grad) border-box;box-shadow:0 8px 24px rgba(225,48,108,0.18)}
.card.bottom{border:2px solid #ef4444;background:linear-gradient(180deg,#FEF2F2,#fff)}
.card.yellow{border:2px solid var(--ig-yellow);background:linear-gradient(180deg,#FEFBF3,#fff)}
.card-top-row{position:absolute;top:12px;left:12px;right:12px;display:flex;justify-content:space-between;z-index:2}
.rank-pill{background:rgba(0,0,0,0.85);color:#fff;padding:5px 12px;border-radius:999px;font-size:12px;font-weight:900;backdrop-filter:blur(4px)}
.card.top .rank-pill{background:var(--ig-grad)}
.hook-score-pill{background:rgba(255,255,255,0.95);color:var(--ig-pink);padding:5px 12px;border-radius:999px;font-size:11px;font-weight:900;backdrop-filter:blur(4px)}
.thumb-link{display:block;aspect-ratio:1/1;background:#f3f4f6;overflow:hidden;position:relative}
.thumb{width:100%;height:100%;object-fit:cover;display:block}
.thumb.placeholder{display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:12px}
.thumb-overlay{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0.25) 0%,transparent 30%,transparent 70%,rgba(0,0,0,0.18) 100%);pointer-events:none}
.card-body{padding:16px;display:flex;flex-direction:column;gap:12px}
.card-meta{font-size:11px;color:var(--muted);font-weight:600;letter-spacing:0.02em}
.tag{display:inline-block;font-size:11px;font-weight:700;padding:5px 10px;border-radius:6px;align-self:flex-start}
.tag-winner{background:var(--ig-grad);color:#fff}
.tag-strong-hook{background:#FEF3C7;color:#854D0E}
.tag-no-hold{background:#FEE2E2;color:#991B1B}
.tag-sharable{background:#EDE9FE;color:#5B21B6}
.tag-hook-landed{background:#DBEAFE;color:#1E40AF}
.tag-underperformed{background:#F3F4F6;color:#4B5563}
.tag-average{background:#F9FAFB;color:#6B7280}
.diag-reason{font-size:11px;color:var(--muted);line-height:1.5;padding:8px 10px;background:#FAFAFA;border-radius:8px;border-left:3px solid var(--ig-pink)}
.card-caption{font-size:12px;color:#374151;line-height:1.5;max-height:4.5em;overflow:hidden}
.hook-breakdown{background:#FAFAFA;border-radius:10px;padding:10px 12px}
.hb-title{font-size:10px;color:var(--muted);font-weight:700;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:6px}
.hb-row{display:flex;justify-content:space-between;font-size:11px;font-weight:600;padding:2px 0}
.hb-val{font-family:'Noto Sans',monospace;color:var(--ig-purple);font-weight:900}
.bench-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:4px}
.bench-pill{padding:6px 4px;border-radius:8px;text-align:center;font-size:9px;font-weight:700;line-height:1.3;border:1px solid transparent}
.bench-pill.bm-excellent{background:#16a34a;color:#fff}
.bench-pill.bm-good{background:#22c55e22;color:#16a34a;border-color:#22c55e44}
.bench-pill.bm-avg{background:#3b82f622;color:#1e40af;border-color:#3b82f644}
.bench-pill.bm-poor{background:#f59e0b22;color:#92400e;border-color:#f59e0b44}
.bench-pill.bm-low{background:#ef444422;color:#991b1b;border-color:#ef444444}
.bench-pill .bp-label{display:block;font-size:9px;opacity:0.85;margin-bottom:2px}
.bench-pill .bp-val{display:block;font-size:11px;font-weight:900}
.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:6px 12px;padding-top:10px;border-top:1px dashed var(--line)}
.metric{display:flex;flex-direction:column;font-size:11px;text-align:center}
.m-label{color:var(--muted);font-size:10px;font-weight:600;margin-bottom:2px}
.m-val{font-weight:900;font-size:13px;color:var(--ink)}

/* Footer */
footer{text-align:center;margin-top:48px;padding:24px;color:var(--muted);font-size:12px}
footer .ig-line{display:inline-block;width:60px;height:3px;background:var(--ig-grad);border-radius:999px;margin:0 8px;vertical-align:middle}

@media (max-width:900px){
  .hero{grid-template-columns:1fr;padding:32px 24px}
  .hero h1{font-size:26px}
  .stats-grid,.action-grid{grid-template-columns:1fr 1fr}
  .two-col{grid-template-columns:1fr}
  .bm-row{grid-template-columns:1fr;gap:12px;text-align:left}
}
</style>
</head>
<body>
<div class="container">

  <!-- HERO -->
  <div class="hero">
    <div>
      <h1>Instagram Reels<br/>Insight Report<span class="accent">直近 ${data.lookback_days} 日</span></h1>
      <div class="subtitle">📅 取得日時 ${escapeHtml(new Date(data.fetched_at).toLocaleString('ja-JP'))}</div>
      <div class="hero-stats">
        <div class="hs">投稿数<strong>${enriched.length}</strong></div>
        <div class="hs">総リーチ<strong>${fmt(enriched.reduce((s: number, p: any) => s + safeNum(p.insights.reach), 0))}</strong></div>
        <div class="hs">総インタラクション<strong>${fmt(enriched.reduce((s: number, p: any) => s + p.interactions, 0))}</strong></div>
      </div>
    </div>
    <div class="hero-illust">${HERO_SVG}</div>
  </div>

  <!-- HEADLINE -->
  <div class="section">
    <div class="section-header">
      <div class="section-icon">${ICON_TROPHY}</div>
      <div>
        <h2>ヘッドラインインサイト<span class="layer-tag">Layer 2</span></h2>
        <div class="section-subtitle">あなたの投稿群を俯瞰した時の核心メッセージ</div>
      </div>
    </div>
    <div class="headline-big">${escapeHtml(headline)}</div>
    <div class="stats-grid">
      <div class="stat-card"><div class="lbl">リーチ集中度 (Top3占有率)</div><div class="val">${fmtPct(reachConcentration, 1)}</div><div class="hint">特定投稿への依存度</div></div>
      <div class="stat-card"><div class="lbl">視聴時間ギャップ</div><div class="val">${watchGap.toFixed(1)}x</div><div class="hint">Top ÷ 中央値</div></div>
      <div class="stat-card"><div class="lbl">強フック投稿数</div><div class="val">${strongHookCount}</div><div class="hint">視聴 > 中央値×1.5</div></div>
      <div class="stat-card"><div class="lbl">リプレイ勝利数</div><div class="val">${replayWins}</div><div class="hint">再生÷リーチ > 1.5x</div></div>
    </div>
  </div>

  <!-- BENCHMARK -->
  <div class="section">
    <div class="section-header">
      <div class="section-icon">${ICON_BENCHMARK}</div>
      <div>
        <h2>業界ベンチマーク比較<span class="layer-tag">Layer 3</span></h2>
        <div class="section-subtitle">Instagram Reels の平均値（Hootsuite / Later / SocialInsider 公開データ）と比較</div>
      </div>
    </div>
    ${benchmarkRow(BENCHMARK.engagement_rate.label, BENCHMARK.engagement_rate.desc, aggEngagement, BENCHMARK.engagement_rate, 0)}
    ${benchmarkRow(BENCHMARK.save_pct.label, BENCHMARK.save_pct.desc, aggSave, BENCHMARK.save_pct, 1)}
    ${benchmarkRow(BENCHMARK.share_pct.label, BENCHMARK.share_pct.desc, aggShare, BENCHMARK.share_pct, 2)}
    ${benchmarkRow(BENCHMARK.replay_rate.label, BENCHMARK.replay_rate.desc, aggReplay, BENCHMARK.replay_rate, 3)}
    ${benchmarkRow(BENCHMARK.watch_s.label, BENCHMARK.watch_s.desc, aggWatch, BENCHMARK.watch_s, 4)}
    <div class="bm-note">※ 数値は業界の公開データに基づく目安です。フォロワー規模・ニッチ・期間によって実際の基準は変動します。</div>
  </div>

  <!-- TIMING -->
  <div class="section">
    <div class="section-header">
      <div class="section-icon">${ICON_TIMING}</div>
      <div>
        <h2>投稿タイミング分析<span class="layer-tag">Layer 2</span></h2>
        <div class="section-subtitle">時間帯・曜日とパフォーマンスの相関</div>
      </div>
    </div>
    <div class="two-col">
      <div class="mini-section">
        <h3>🕐 時間帯別 平均リーチ</h3>
        <div class="bar-list">
          ${hourBars.map((h) => `
            <div class="bar-row">
              <div class="bl">${escapeHtml(h.label)}</div>
              <div class="bb-track"><div class="bb-fill" style="width:${(h.reach / maxHourReach) * 100}%"></div></div>
              <div class="bv">${fmt(h.reach)} <span style="opacity:0.6">(${h.count}件)</span></div>
            </div>`).join('')}
        </div>
      </div>
      <div class="mini-section">
        <h3>📅 曜日別 平均リーチ</h3>
        <div class="day-grid">
          ${dayBars.map((d: any) => `
            <div class="day-cell ${d.count > 0 ? 'has' : ''}">
              <div class="dl">${d.label}</div>
              <div class="dv">${d.count > 0 ? fmt(d.reach) : '–'}</div>
              <div class="dc">${d.count}件</div>
            </div>`).join('')}
        </div>
      </div>
    </div>
  </div>

  <!-- PATTERN -->
  <div class="section">
    <div class="section-header">
      <div class="section-icon">${ICON_PATTERN}</div>
      <div>
        <h2>キャプション・ハッシュタグ分析<span class="layer-tag">Layer 2</span></h2>
        <div class="section-subtitle">上位 vs 下位の差分、文字数・ハッシュタグ数とパフォーマンスの相関</div>
      </div>
    </div>
    <div class="two-col" style="margin-bottom:24px">
      <div class="mini-section">
        <h3>📝 キャプション長 × エンゲージ率</h3>
        <div class="bar-list">
          ${(capBuckets as any[]).map((b) => `
            <div class="bar-row">
              <div class="bl">${escapeHtml(b.label)}</div>
              <div class="bb-track"><div class="bb-fill" style="width:${Math.min(100, (b.engAvg / Math.max(...(capBuckets as any[]).map((x) => x.engAvg || 0.001))) * 100)}%"></div></div>
              <div class="bv">${fmtPct(b.engAvg)}</div>
            </div>`).join('')}
        </div>
      </div>
      <div class="mini-section">
        <h3>#️⃣ ハッシュタグ数 × 平均リーチ</h3>
        <div class="bar-list">
          ${(hashGroups as any[]).map((g) => `
            <div class="bar-row">
              <div class="bl">${escapeHtml(g.label)}</div>
              <div class="bb-track"><div class="bb-fill" style="width:${Math.min(100, (g.reachAvg / Math.max(1, ...(hashGroups as any[]).map((x) => x.reachAvg || 0))) * 100)}%"></div></div>
              <div class="bv">${fmt(g.reachAvg)} <span style="opacity:0.6">(${g.count}件)</span></div>
            </div>`).join('')}
        </div>
      </div>
    </div>
    <h3 style="font-size:14px;font-weight:700;margin:0 0 12px;color:var(--ink)">🔍 上位3件 vs 下位3件 キャプション頻出ワード</h3>
    <table class="words">
      <thead><tr><th>ワード</th><th style="text-align:right">上位</th><th style="text-align:right">下位</th><th style="text-align:right">差分</th></tr></thead>
      <tbody>${wordRows}</tbody>
    </table>
  </div>

  <!-- ACTION GRID -->
  <div class="section">
    <div class="section-header">
      <div class="section-icon">${ICON_LIGHTBULB}</div>
      <div>
        <h2>Action Grid — 次やること<span class="layer-tag">Layer 2</span></h2>
        <div class="section-subtitle">継続・停止・改善の3軸で具体アクションを提示</div>
      </div>
    </div>
    <div class="action-grid">
      <div class="action do">
        <h3>🟢 Do More</h3>
        <ul>${(doMore as string[]).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
      </div>
      <div class="action stop">
        <h3>🔴 Stop</h3>
        <ul>${(stopDoing as string[]).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
      </div>
      <div class="action fix">
        <h3>🟡 Fix</h3>
        <ul>${(fixThese as string[]).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
      </div>
    </div>
  </div>

  <!-- RANKING / PER-VIDEO -->
  <div class="section">
    <div class="section-header">
      <div class="section-icon">${ICON_RANKING}</div>
      <div>
        <h2>投稿別ディープダイブ<span class="layer-tag">Layer 1</span></h2>
        <div class="section-subtitle">Hook Score 順 ・ 各指標を業界平均と比較したバッジ付き</div>
      </div>
    </div>
    <div class="cards">${cards}</div>
  </div>

  <footer>
    <span class="ig-line"></span>
    Generated with Composio + Instagram Graph API · Noto Sans JP
    <span class="ig-line"></span>
  </footer>
</div>
<script>
(function(){
  function easeInOut(t){return t<0.5?2*t*t:1-Math.pow(-2*t+2,2)/2;}
  function animateCounter(el){
    var target=parseFloat(el.getAttribute('data-target'));
    var unit=el.getAttribute('data-unit')||'';
    var decimals=parseInt(el.getAttribute('data-decimals')||'2',10);
    var delay=parseInt(el.getAttribute('data-delay')||'500',10);
    var duration=1400;
    if(isNaN(target))return;
    el.textContent='0'+unit;
    setTimeout(function(){
      var start=performance.now();
      function tick(now){
        var elapsed=now-start;
        var t=Math.min(1,elapsed/duration);
        var eased=easeInOut(t);
        var current=target*eased;
        el.textContent=current.toFixed(decimals)+unit;
        if(t<1)requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    },delay);
  }
  function init(){
    var nodes=document.querySelectorAll('.gauge-num');
    for(var i=0;i<nodes.length;i++)animateCounter(nodes[i]);
  }
  if(document.readyState!=='loading')init();
  else document.addEventListener('DOMContentLoaded',init);
})();
</script>
</body>
</html>`;
}

main().catch((e) => {
  console.error('❌ エラー:', e);
  process.exit(1);
});
