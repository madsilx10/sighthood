'use strict';
const { readFileSync } = require('fs');
const readline = require('readline');

// ─── CONFIG ────────────────────────────────────────────────────
const AKUN_FILE     = './akun.txt';
const SIGHTHOOD_JWT = 'YOUR_SIGHTHOOD_JWT';
const DELAY_MS      = 3000;

// Bearer publik X — FIXED: huruf L di "ANRILg" harus kapital (bukan "ANRIlg"),
// dan ada 6x A sebelum "nNwIzU" (bukan 5x). Token lama ini yang bikin SEMUA
// request ke x.com kena 401 "Could not authenticate you", termasuk sanity check.
const X_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAA'
               + 'nNwIzUejRCOuH5E6I8xnZz4puTs'
               + '%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36';
// ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(tag, ...args) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] ${tag}`, ...args);
}

function loadAccounts() {
  const raw = readFileSync(AKUN_FILE, 'utf8').trim();
  return raw.split(/\n\s*\n/).map((block, i) => {
    const [authToken, ct0] = block.trim().split('\n').map(l => l.trim());
    if (!authToken || !ct0) throw new Error(`Akun #${i + 1}: format salah`);
    return { index: i + 1, authToken, ct0 };
  });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function connectX({ index, authToken, ct0 }) {
  const tag    = `[Akun #${index}]`;
  const cookie = `auth_token=${authToken}; ct0=${ct0}`;

  try {
    // Step 1 – sighthood start → X OAuth URL
    log(tag, 'Step 1: GET /api/auth/x/start');
    const startResp = await fetch('https://quest.sighthood.com/api/auth/x/start', {
      redirect: 'manual',
      headers: {
        Authorization:     `Bearer ${SIGHTHOOD_JWT}`,
        'User-Agent':      UA,
        Referer:           'https://quest.sighthood.com/',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8',
      },
    });

    let xOAuthUrl = startResp.headers.get('location');
    if (!xOAuthUrl) {
      const followed = await fetch('https://quest.sighthood.com/api/auth/x/start', {
        headers: { Authorization: `Bearer ${SIGHTHOOD_JWT}`, 'User-Agent': UA },
      });
      xOAuthUrl = followed.url;
    }
    if (!xOAuthUrl?.includes('oauth2')) throw new Error('Tidak dapat OAuth URL dari sighthood');

    xOAuthUrl = xOAuthUrl.replace('twitter.com', 'x.com');
    log(tag, 'OAuth URL:', xOAuthUrl);
    const oauthParams = new URLSearchParams(new URL(xOAuthUrl).searchParams).toString();

    const xHeaders = {
      Cookie:                       cookie,
      Authorization:                `Bearer ${X_BEARER}`,
      'X-Csrf-Token':               ct0,
      'User-Agent':                 UA,
      Referer:                      xOAuthUrl,
      Origin:                       'https://x.com',
      Accept:                       '*/*',
      'Accept-Language':            'id-ID,id;q=0.9,en-US;q=0.8',
      'Sec-Fetch-Dest':             'empty',
      'Sec-Fetch-Mode':             'cors',
      'Sec-Fetch-Site':             'same-origin',
      'X-Twitter-Active-User':      'yes',
      'X-Twitter-Auth-Type':        'OAuth2Session',
      'X-Twitter-Client-Language':  'id',
    };

    // Step 2 – GET x.com internal authorize → auth_code
    log(tag, 'Step 2: GET x.com/i/api/2/oauth2/authorize');
    const authResp = await fetch(`https://x.com/i/api/2/oauth2/authorize?${oauthParams}`, {
      headers: xHeaders,
    });
    if (!authResp.ok) throw new Error(`Step 2 gagal ${authResp.status}: ${(await authResp.text()).slice(0, 200)}`);
    const { auth_code } = await authResp.json();
    if (!auth_code) throw new Error('auth_code tidak ada di response');
    log(tag, 'auth_code:', auth_code);

    // Step 3 – POST approval
    log(tag, 'Step 3: POST approval');
    const approveResp = await fetch('https://x.com/i/api/2/oauth2/authorize', {
      method: 'POST',
      headers: { ...xHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `approval=true&code=${encodeURIComponent(auth_code)}`,
    });
    if (!approveResp.ok) throw new Error(`Step 3 gagal ${approveResp.status}: ${(await approveResp.text()).slice(0, 200)}`);
    const { redirect_uri } = await approveResp.json();
    if (!redirect_uri) throw new Error('redirect_uri tidak ada');
    log(tag, 'redirect_uri:', redirect_uri);

    // Step 4 – callback sighthood
    log(tag, 'Step 4: GET callback sighthood');
    const cbResp = await fetch(redirect_uri, {
      headers: {
        Authorization:     `Bearer ${SIGHTHOOD_JWT}`,
        'User-Agent':      UA,
        Referer:           'https://x.com/',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8',
      },
    });

    if (cbResp.ok || cbResp.status === 302) {
      log(tag, '✅ BERHASIL');
      return { success: true };
    }
    throw new Error(`Callback gagal ${cbResp.status}: ${(await cbResp.text()).slice(0, 200)}`);

  } catch (err) {
    log(tag, '❌ GAGAL:', err.message);
    return { success: false, error: err.message };
  }
}

async function main() {
  const accounts = loadAccounts();
  console.log(`\nLoaded ${accounts.length} akun\n`);
  console.log('Pilih mode:');
  console.log('  1. 1 akun');
  console.log('  2. semua');
  console.log('  3. from x to end\n');

  const pilihan = await ask('Pilihan (1/2/3): ');
  let targets = [];

  if (pilihan === '1') {
    const no = await ask(`Akun ke berapa? (1-${accounts.length}): `);
    const idx = parseInt(no);
    if (isNaN(idx) || idx < 1 || idx > accounts.length) {
      console.error('Nomor akun tidak valid'); process.exit(1);
    }
    targets = [accounts[idx - 1]];

  } else if (pilihan === '2') {
    targets = accounts;

  } else if (pilihan === '3') {
    const from = await ask(`Mulai dari akun ke berapa? (1-${accounts.length}): `);
    const idx = parseInt(from);
    if (isNaN(idx) || idx < 1 || idx > accounts.length) {
      console.error('Nomor akun tidak valid'); process.exit(1);
    }
    targets = accounts.slice(idx - 1);
    console.log(`Akan jalankan akun #${idx} sampai #${accounts.length} (${targets.length} akun)\n`);

  } else {
    console.error('Pilihan tidak valid'); process.exit(1);
  }

  console.log();
  const results = [];
  for (let i = 0; i < targets.length; i++) {
    results.push(await connectX(targets[i]));
    if (i < targets.length - 1) {
      log('→', `Jeda ${DELAY_MS / 1000}s...`);
      await sleep(DELAY_MS);
    }
  }

  const ok   = results.filter(r => r.success).length;
  const fail = results.filter(r => !r.success);
  console.log('\n─── RINGKASAN ───');
  console.log(`✅ Berhasil: ${ok}`);
  console.log(`❌ Gagal   : ${fail.length}`);
  fail.forEach((r, i) => console.log(`   Akun #${targets[i].index}: ${r.error}`));
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
