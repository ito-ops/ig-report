import 'dotenv/config';
import fs from 'node:fs/promises';
import { Composio } from '@composio/core';

const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY;
const USER_ID = process.env.COMPOSIO_USER_ID || 'ig-report-default';
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 14);
const TOOLKIT_SLUG = 'instagram';

if (!COMPOSIO_API_KEY || COMPOSIO_API_KEY.includes('xxxx')) {
  console.error('❌ COMPOSIO_API_KEY が .env に設定されていません。');
  console.error('   .env.example をコピーして .env を作成し、Composio の API キーを記入してください。');
  process.exit(1);
}

type Media = {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  media_url?: string;
  permalink?: string;
  thumbnail_url?: string;
  timestamp?: string;
};

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

type PostRecord = Media & { insights: Insight };

const composio = new Composio({ apiKey: COMPOSIO_API_KEY });

async function getActiveConnection(): Promise<any | null> {
  try {
    const list: any = await (composio.connectedAccounts as any).list({
      userIds: [USER_ID],
      toolkitSlugs: [TOOLKIT_SLUG],
    });
    const items = list?.items || list?.data || [];
    return items.find((a: any) => (a.status || '').toUpperCase() === 'ACTIVE') || null;
  } catch (e) {
    return null;
  }
}

async function ensureAuthConfigId(): Promise<string> {
  const ac: any = (composio as any).authConfigs;
  try {
    const list: any = await ac.list({ toolkit: TOOLKIT_SLUG });
    const items = list?.items || list?.data || [];
    const enabled = items.find((c: any) => (c.status || 'ENABLED') !== 'DISABLED');
    if (enabled) return enabled.id;
  } catch {}
  console.log('🛠  Instagram の Auth Config を作成中（Composio managed OAuth）...');
  const created: any = await ac.create(TOOLKIT_SLUG, {
    type: 'use_composio_managed_auth',
    name: 'instagram-report',
  });
  return created.id;
}

async function connectInstagram(): Promise<any> {
  const existing = await getActiveConnection();
  if (existing) {
    console.log('✅ Instagramは既に接続済み');
    return existing;
  }

  console.log('🔐 Instagram への OAuth 認証を開始します...');
  let connectionRequest: any;
  try {
    const authConfigId = await ensureAuthConfigId();
    connectionRequest = await (composio.connectedAccounts as any).link(USER_ID, authConfigId);
  } catch (e: any) {
    console.error('❌ 認証リクエストの作成に失敗しました:', e?.message || e);
    console.error('   Composio ダッシュボードで Instagram の Auth Config が有効になっているか確認してください。');
    process.exit(1);
  }

  const redirectUrl = connectionRequest?.redirectUrl || connectionRequest?.redirect_url;
  if (!redirectUrl) {
    console.error('❌ 認証URLが取得できませんでした。Composio のレスポンス:', connectionRequest);
    process.exit(1);
  }

  console.log('');
  console.log('================================================================');
  console.log('👉 このURLをブラウザで開いて Instagram を承認してください:');
  console.log('');
  console.log('   ' + redirectUrl);
  console.log('');
  console.log('   ※ 有効期限は約3分です。');
  console.log('   ※ 承認が完了したら、もう一度  npm run agent  を実行してください。');
  console.log('================================================================');
  process.exit(0);
}

async function igProxyGet(
  connectedAccountId: string,
  endpoint: string,
  params: Record<string, string>,
): Promise<any> {
  const parameters = Object.entries(params).map(([name, value]) => ({
    in: 'query' as const,
    name,
    value,
  }));
  const res: any = await (composio.tools as any).proxyExecute({
    endpoint,
    method: 'GET',
    parameters,
    connectedAccountId,
  });
  const data = res?.data ?? res;
  if (data?.error) {
    throw new Error(`IG API error: ${JSON.stringify(data.error)}`);
  }
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return { raw: data };
    }
  }
  return data;
}

async function fetchAllMedia(connectedAccountId: string): Promise<Media[]> {
  const fields = 'id,caption,media_type,media_product_type,media_url,permalink,thumbnail_url,timestamp';
  const all: Media[] = [];
  let json: any = await igProxyGet(connectedAccountId, '/me/media', { fields, limit: '50' });
  let pageCount = 0;
  while (json && pageCount < 5) {
    const data = json?.data || [];
    all.push(...data);
    if (all.length > 200) break;
    const nextCursor = json?.paging?.cursors?.after;
    if (!nextCursor) break;
    pageCount++;
    json = await igProxyGet(connectedAccountId, '/me/media', { fields, limit: '50', after: nextCursor });
  }
  return all;
}

async function fetchInsightsForMedia(connectedAccountId: string, media: Media): Promise<Insight> {
  const isReel =
    (media.media_product_type || '').toUpperCase() === 'REELS' ||
    (media.media_type || '').toUpperCase() === 'VIDEO';
  const metricsAll = ['reach', 'views', 'likes', 'comments', 'shares', 'saved', 'total_interactions'];
  if (isReel) metricsAll.push('ig_reels_avg_watch_time');

  const result: Insight = {};
  try {
    const json = await igProxyGet(connectedAccountId, `/${media.id}/insights`, {
      metric: metricsAll.join(','),
    });
    const data = json?.data || [];
    for (const m of data) {
      const name = m?.name as keyof Insight;
      const value = m?.values?.[0]?.value;
      if (typeof value === 'number') (result as any)[name] = value;
    }
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (msg.includes('ig_reels_avg_watch_time') || msg.includes('invalid metric') || msg.includes('100')) {
      try {
        const fallback = await igProxyGet(connectedAccountId, `/${media.id}/insights`, {
          metric: ['reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions'].join(','),
        });
        for (const m of fallback?.data || []) {
          const name = m?.name as keyof Insight;
          const value = m?.values?.[0]?.value;
          if (typeof value === 'number') (result as any)[name] = value;
        }
      } catch (e2: any) {
        console.warn(`\n⚠️  insights fallback も失敗 (${media.id}): ${String(e2?.message || e2).slice(0, 200)}`);
      }
    } else {
      console.warn(`\n⚠️  insights 取得失敗 (${media.id}): ${msg.slice(0, 200)}`);
    }
  }
  return result;
}

async function main() {
  const connection = await connectInstagram();
  const connectedAccountId = connection.id || connection.connectedAccountId;
  if (!connectedAccountId) {
    console.error('❌ connectedAccountId が取得できませんでした');
    process.exit(1);
  }

  console.log(`\n📥 直近 ${LOOKBACK_DAYS} 日のメディアを取得中...`);
  const allMedia = await fetchAllMedia(connectedAccountId);
  console.log(`   全 ${allMedia.length} 件のメディアを取得`);

  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const targets = allMedia.filter((m) => {
    if (!m.timestamp) return false;
    const t = new Date(m.timestamp).getTime();
    if (t < cutoff) return false;
    const pt = (m.media_product_type || '').toUpperCase();
    const mt = (m.media_type || '').toUpperCase();
    return pt === 'REELS' || mt === 'VIDEO';
  });
  console.log(`   うち分析対象（リール/動画）: ${targets.length} 件`);

  if (targets.length === 0) {
    console.warn('⚠️  分析対象の投稿が見つかりませんでした。');
    await fs.writeFile(
      'data.json',
      JSON.stringify({ fetched_at: new Date().toISOString(), lookback_days: LOOKBACK_DAYS, posts: [] }, null, 2),
    );
    return;
  }

  const posts: PostRecord[] = [];
  for (let i = 0; i < targets.length; i++) {
    const m = targets[i];
    process.stdout.write(`   [${i + 1}/${targets.length}] ${m.id} のインサイト取得中...\r`);
    const insights = await fetchInsightsForMedia(connectedAccountId, m);
    posts.push({ ...m, insights });
  }
  console.log('\n✅ 全件のインサイト取得完了');

  await fs.writeFile(
    'data.json',
    JSON.stringify(
      {
        fetched_at: new Date().toISOString(),
        lookback_days: LOOKBACK_DAYS,
        posts,
      },
      null,
      2,
    ),
  );
  console.log(`💾 data.json に保存しました（${posts.length} 件）`);
  console.log('\n次のコマンドでレポートを生成できます:');
  console.log('   npm run render');
}

main().catch((e) => {
  console.error('❌ エラー:', e);
  process.exit(1);
});
