// Auth providers for the request engine. Pure Node — no Electron imports, so
// the engine and unit tests can use this module directly.
//
// Contract: every provider implements
//   buildHeaders(auth, ctx)  -> [{ key, value }]
//   buildQuery(auth, ctx)    -> [{ key, value }]
// where ctx = { method, url, body: Buffer|null, headers: object }.
//
// Challenge based schemes (Digest, NTLM) cannot produce their final header
// without the server challenge. They expose `needsChallenge` and
// `buildChallenge(auth, challenge, ctx)`; the engine retries a 401 once.
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// RFC 5849 / RFC 3986 percent-encoding: encodeURIComponent leaves !'()* alone.
function percentEncode(value) {
  return encodeURIComponent(String(value ?? '')).replace(/[!'()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function headerValue(headers, name) {
  if (!headers) return '';
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : '';
}

function urlOf(ctx) {
  return new URL(String(ctx?.url || '').trim());
}

function methodOf(ctx) {
  return String(ctx?.method || 'GET').toUpperCase();
}

function pathAndQuery(url) {
  return `${url.pathname || '/'}${url.search || ''}`;
}

function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

// ---------------------------------------------------------------------------
// none / bearer / basic / apikey
// ---------------------------------------------------------------------------

const noneProvider = {
  buildHeaders: () => [],
  buildQuery: () => [],
};

const bearerProvider = {
  buildHeaders(auth) {
    const token = auth?.bearer?.token;
    if (!token) return [];
    return [{ key: 'Authorization', value: `Bearer ${token}` }];
  },
  buildQuery: () => [],
};

const basicProvider = {
  buildHeaders(auth) {
    const username = auth?.basic?.username ?? '';
    const password = auth?.basic?.password ?? '';
    const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
    return [{ key: 'Authorization', value: `Basic ${encoded}` }];
  },
  buildQuery: () => [],
};

const apikeyProvider = {
  buildHeaders(auth) {
    const key = auth?.apikey?.key;
    if (!key || auth?.apikey?.addTo === 'query') return [];
    return [{ key, value: auth.apikey.value ?? '' }];
  },
  buildQuery(auth) {
    const key = auth?.apikey?.key;
    if (!key || auth?.apikey?.addTo !== 'query') return [];
    return [{ key, value: auth.apikey.value ?? '' }];
  },
};

// ---------------------------------------------------------------------------
// OAuth 1.0a (RFC 5849) — HMAC-SHA1/256 and PLAINTEXT
// ---------------------------------------------------------------------------

function oauth1Config(auth) {
  const o = auth?.oauth1 || {};
  return {
    consumerKey: o.consumerKey || '',
    consumerSecret: o.consumerSecret || '',
    token: o.token || '',
    tokenSecret: o.tokenSecret || '',
    signatureMethod: (o.signatureMethod || 'HMAC-SHA1').toUpperCase(),
    realm: o.realm || '',
    addTo: o.addTo === 'query' ? 'query' : 'header',
    version: o.version ?? '1.0',
  };
}

function oauth1Signature({ method, url, body, headers, cfg, nonce, timestamp }) {
  const params = [];
  for (const [key, value] of url.searchParams.entries()) params.push([key, value]);

  if (/application\/x-www-form-urlencoded/i.test(headerValue(headers, 'content-type')) && body) {
    for (const [key, value] of new URLSearchParams(body.toString('utf8')).entries()) {
      params.push([key, value]);
    }
  }

  const oauthParams = [
    ['oauth_consumer_key', cfg.consumerKey],
    ['oauth_nonce', nonce],
    ['oauth_signature_method', cfg.signatureMethod],
    ['oauth_timestamp', String(timestamp)],
  ];
  if (cfg.token) oauthParams.push(['oauth_token', cfg.token]);
  if (cfg.version) oauthParams.push(['oauth_version', cfg.version]);
  for (const p of oauthParams) params.push(p);

  const normalized = params
    .map(([k, v]) => [percentEncode(k), percentEncode(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const baseUrl = `${url.protocol}//${url.host}${url.pathname || '/'}`;
  const baseString = `${method}&${percentEncode(baseUrl)}&${percentEncode(normalized)}`;
  const key = `${percentEncode(cfg.consumerSecret)}&${percentEncode(cfg.tokenSecret)}`;

  if (cfg.signatureMethod === 'PLAINTEXT') return key;
  const algo = cfg.signatureMethod === 'HMAC-SHA256' ? 'sha256' : 'sha1';
  return crypto.createHmac(algo, key).update(baseString).digest('base64');
}

function buildOAuth1(auth, ctx) {
  const cfg = oauth1Config(auth);
  if (!cfg.consumerKey) return { headers: [], query: [] };
  const url = urlOf(ctx);
  const nonce = ctx?.oauthNonce || randomHex(16);
  const timestamp = ctx?.oauthTimestamp ?? Math.floor(Date.now() / 1000);
  const signature = oauth1Signature({
    method: methodOf(ctx),
    url,
    body: ctx?.body || null,
    headers: ctx?.headers || {},
    cfg,
    nonce,
    timestamp,
  });

  const params = [
    ['oauth_consumer_key', cfg.consumerKey],
    ['oauth_nonce', nonce],
    ['oauth_signature', signature],
    ['oauth_signature_method', cfg.signatureMethod],
    ['oauth_timestamp', String(timestamp)],
  ];
  if (cfg.token) params.push(['oauth_token', cfg.token]);
  if (cfg.version) params.push(['oauth_version', cfg.version]);

  if (cfg.addTo === 'query') {
    return { headers: [], query: params.map(([key, value]) => ({ key, value })) };
  }
  const parts = params.map(([key, value]) => `${key}="${percentEncode(value)}"`);
  if (cfg.realm) parts.unshift(`realm="${percentEncode(cfg.realm)}"`);
  return { headers: [{ key: 'Authorization', value: `OAuth ${parts.join(', ')}` }], query: [] };
}

const oauth1Provider = {
  // One call produces both sides so the nonce/signature are computed once.
  build: (auth, ctx) => buildOAuth1(auth, ctx),
  buildHeaders: (auth, ctx) => buildOAuth1(auth, ctx).headers,
  buildQuery: (auth, ctx) => buildOAuth1(auth, ctx).query,
};

// ---------------------------------------------------------------------------
// Digest (RFC 7616) — MD5 / SHA-256, qop=auth
// ---------------------------------------------------------------------------

function parseChallenge(value) {
  const out = {};
  const re = /([\w-]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let match;
  while ((match = re.exec(String(value || ''))) !== null) {
    out[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : match[3];
  }
  return out;
}

function pickChallengeHeader(value, scheme) {
  // Node joins multiple WWW-Authenticate headers into one comma-separated
  // string. Digest parameters also contain commas, so only split when the
  // scheme name appears at the start of a challenge.
  const entries = Array.isArray(value) ? value : [String(value || '')];
  const re = new RegExp(`(?:^|,\\s*)${scheme}\\s`, 'i');
  for (const entry of entries) {
    const text = String(entry);
    if (text.trim().toLowerCase().startsWith(scheme.toLowerCase())) return text.trim();
    const match = re.exec(text);
    if (match) return text.slice(match.index === 0 ? 0 : match.index + 1).trim();
  }
  return null;
}

function digestHashName(algorithm) {
  const alg = String(algorithm || 'MD5').toUpperCase();
  if (alg.startsWith('SHA-256')) return { alg: 'sha256', sess: alg.endsWith('-SESS') };
  return { alg: 'md5', sess: alg.endsWith('-SESS') };
}

function buildDigestChallenge(auth, challengeHeader, ctx) {
  const raw = pickChallengeHeader(challengeHeader, 'Digest');
  if (!raw) return [];
  const challenge = parseChallenge(raw.slice(6));
  const username = auth?.digest?.username || '';
  const password = auth?.digest?.password || '';
  const realm = challenge.realm || '';
  const nonce = challenge.nonce || '';
  if (!nonce) return [];

  const { alg, sess } = digestHashName(challenge.algorithm || auth?.digest?.algorithm);
  const hash = (value) => crypto.createHash(alg).update(value).digest('hex');
  const method = methodOf(ctx);
  const uri = ctx?.uri || pathAndQuery(urlOf(ctx));
  const cnonce = ctx?.cnonce || randomHex(16);
  const nc = ctx?.nc || '00000001';
  const qopOffered = String(challenge.qop || '')
    .split(',')
    .map((s) => s.trim().toLowerCase());
  const useQop = qopOffered.includes('auth');

  let ha1 = hash(`${username}:${realm}:${password}`);
  if (sess) ha1 = hash(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = hash(`${method}:${uri}`);
  const response = useQop
    ? hash(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)
    : hash(`${ha1}:${nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `algorithm=${sess ? String(challenge.algorithm || 'MD5') : alg === 'sha256' ? 'SHA-256' : 'MD5'}`,
    `response="${response}"`,
  ];
  if (useQop) parts.push('qop=auth', `nc=${nc}`, `cnonce="${cnonce}"`);
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);

  return [{ key: 'Authorization', value: `Digest ${parts.join(', ')}` }];
}

const digestProvider = {
  needsChallenge: true,
  buildHeaders: () => [],
  buildQuery: () => [],
  buildChallenge: (auth, challenge, ctx) => buildDigestChallenge(auth, challenge, ctx),
};

// ---------------------------------------------------------------------------
// NTLM (MS-NLMP) — Type 1 + NTLMv2 Type 3
// ---------------------------------------------------------------------------

const NTLM = {
  UNICODE: 0x00000001,
  OEM: 0x00000002,
  REQUEST_TARGET: 0x00000004,
  SIGN: 0x00000010,
  SEAL: 0x00000020,
  NTLM: 0x00000200,
  ALWAYS_SIGN: 0x00008000,
  TARGET_TYPE_SERVER: 0x00020000,
  EXTENDED_SESSIONSECURITY: 0x00080000,
  TARGET_INFO: 0x00800000,
  VERSION: 0x02000000,
  KEY_128: 0x20000000,
  KEY_EXCH: 0x40000000,
  KEY_56: 0x80000000,
};

const NTLM_SIGNATURE = Buffer.from('NTLMSSP\0', 'latin1');
// Type 3 flags: we never send a version blob or a session key, and do not
// implement signing/sealing (see limitations below).
const NTLM_TYPE3_FLAGS =
  NTLM.UNICODE | NTLM.NTLM | NTLM.ALWAYS_SIGN | NTLM.EXTENDED_SESSIONSECURITY;

// Pure JS MD4: OpenSSL 3 (Node 22 / Electron 33) refuses createHash('md4')
// without the legacy provider, and NTLMv2 needs it for the NT hash.
function md4(input) {
  const buf = Buffer.from(input);
  const bitLength = buf.length * 8;
  const padded = Buffer.alloc(((buf.length + 8 + 63) >> 6) << 6);
  buf.copy(padded);
  padded[buf.length] = 0x80;
  padded.writeUInt32LE(bitLength >>> 0, padded.length - 8);
  padded.writeUInt32LE(Math.floor(bitLength / 2 ** 32), padded.length - 4);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  const rol = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
  const F = (x, y, z) => ((x & y) | (~x & z)) >>> 0;
  const G = (x, y, z) => ((x & y) | (x & z) | (y & z)) >>> 0;
  const H = (x, y, z) => (x ^ y ^ z) >>> 0;
  const S2 = [3, 5, 9, 13];
  const I2 = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
  const S3 = [3, 9, 11, 15];
  const I3 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];

  for (let off = 0; off < padded.length; off += 64) {
    const X = [];
    for (let i = 0; i < 16; i += 1) X.push(padded.readUInt32LE(off + i * 4));
    let A = a;
    let B = b;
    let C = c;
    let D = d;
    const step = (fn, k, s, constant) => {
      const t = rol((A + fn(B, C, D) + X[k] + constant) >>> 0, s);
      A = D;
      D = C;
      C = B;
      B = t;
    };
    for (let i = 0; i < 16; i += 1) {
      step(F, i, [3, 7, 11, 19][i % 4], 0);
    }
    for (let i = 0; i < 16; i += 1) {
      step(G, I2[i], S2[i % 4], 0x5a827999);
    }
    for (let i = 0; i < 16; i += 1) {
      step(H, I3[i], S3[i % 4], 0x6ed9eba1);
    }
    a = (a + A) >>> 0;
    b = (b + B) >>> 0;
    c = (c + C) >>> 0;
    d = (d + D) >>> 0;
  }

  const out = Buffer.alloc(16);
  out.writeUInt32LE(a, 0);
  out.writeUInt32LE(b, 4);
  out.writeUInt32LE(c, 8);
  out.writeUInt32LE(d, 12);
  return out;
}

function utf16le(value) {
  return Buffer.from(String(value ?? ''), 'utf16le');
}

function hmacMd5(key, data) {
  return crypto.createHmac('md5', key).update(data).digest();
}

function ntowfV2(password, user, domain) {
  const ntHash = md4(utf16le(password));
  return hmacMd5(ntHash, utf16le(String(user || '').toUpperCase() + String(domain || '')));
}

function writeSecBuf(buffer, offset, length, dataOffset) {
  buffer.writeUInt16LE(length, offset);
  buffer.writeUInt16LE(length, offset + 2);
  buffer.writeUInt32LE(dataOffset, offset + 4);
}

function readSecBuf(buffer, offset) {
  const length = buffer.readUInt16LE(offset);
  const dataOffset = buffer.readUInt32LE(offset + 4);
  return buffer.subarray(dataOffset, dataOffset + length);
}

function buildNtlmType1() {
  const flags =
    (NTLM.UNICODE |
      NTLM.OEM |
      NTLM.REQUEST_TARGET |
      NTLM.NTLM |
      NTLM.ALWAYS_SIGN |
      NTLM.EXTENDED_SESSIONSECURITY |
      NTLM.TARGET_INFO |
      NTLM.KEY_128 |
      NTLM.KEY_56) >>>
    0;
  const message = Buffer.alloc(32);
  NTLM_SIGNATURE.copy(message, 0);
  message.writeUInt32LE(1, 8);
  message.writeUInt32LE(flags, 12);
  // Domain and workstation security buffers are empty; payload starts at 32.
  writeSecBuf(message, 16, 0, 32);
  writeSecBuf(message, 24, 0, 32);
  return message;
}

function parseNtlmType2(buffer) {
  if (buffer.length < 48 || buffer.toString('latin1', 0, 8) !== 'NTLMSSP\0') {
    throw new Error('Malformed NTLM challenge');
  }
  if (buffer.readUInt32LE(8) !== 2) throw new Error('Expected an NTLM Type 2 message');
  const flags = buffer.readUInt32LE(20);
  const serverChallenge = buffer.subarray(24, 32);
  const targetInfo = buffer.length >= 48 ? readSecBuf(buffer, 40) : Buffer.alloc(0);
  return { flags, serverChallenge, targetInfo };
}

function ntlmTargetDomain(targetInfo) {
  // MsvAvNbDomainName (AV id 2). Used when the profile omits a domain.
  let offset = 0;
  if (!targetInfo || targetInfo.length < 4) return '';
  while (offset + 4 <= targetInfo.length) {
    const id = targetInfo.readUInt16LE(offset);
    const length = targetInfo.readUInt16LE(offset + 2);
    if (id === 0) break;
    const value = targetInfo.subarray(offset + 4, offset + 4 + length);
    if (id === 2) return value.toString('utf16le');
    offset += 4 + length;
  }
  return '';
}

function fileTimeNow() {
  const value = (BigInt(Date.now()) + 11644473600000n) * 10000n;
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

function buildNtlmType3(auth, challenge, ctx) {
  const parsed = parseNtlmType2(challenge);
  const username = auth?.ntlm?.username || '';
  const password = auth?.ntlm?.password || '';
  const domain = auth?.ntlm?.domain || ntlmTargetDomain(parsed.targetInfo);
  const workstation = auth?.ntlm?.workstation || '';

  const clientChallenge = ctx?.clientChallenge
    ? Buffer.from(ctx.clientChallenge)
    : crypto.randomBytes(8);
  if (clientChallenge.length !== 8) throw new Error('NTLM client challenge must be 8 bytes');
  const timestamp = ctx?.timestamp ? Buffer.from(ctx.timestamp) : fileTimeNow();
  if (timestamp.length !== 8) throw new Error('NTLM timestamp must be 8 bytes');

  // NTLMv2_CLIENT_CHALLENGE: Z(4) || Z(4) || Time || ClientChallenge || Z(4)
  //   || ServerName || Z(4)
  const targetInfo = parsed.targetInfo.length
    ? parsed.targetInfo
    : Buffer.concat([avPair(2, utf16le(domain)), Buffer.alloc(4)]);
  const temp = Buffer.concat([
    Buffer.from('0101000000000000', 'hex'),
    timestamp,
    clientChallenge,
    Buffer.alloc(4),
    targetInfo,
    Buffer.alloc(4),
  ]);

  const responseKey = ntowfV2(password, username, domain);
  const ntProof = hmacMd5(responseKey, Buffer.concat([parsed.serverChallenge, temp]));
  const ntResponse = Buffer.concat([ntProof, temp]);
  const lmResponse = Buffer.concat([
    hmacMd5(responseKey, Buffer.concat([parsed.serverChallenge, clientChallenge])),
    clientChallenge,
  ]);

  const domainBuf = utf16le(domain);
  const userBuf = utf16le(username);
  const workstationBuf = utf16le(workstation);
  const payloadOffset = 64;
  const lmOffset = payloadOffset;
  const ntOffset = lmOffset + lmResponse.length;
  const domainOffset = ntOffset + ntResponse.length;
  const userOffset = domainOffset + domainBuf.length;
  const workstationOffset = userOffset + userBuf.length;
  const total = workstationOffset + workstationBuf.length;

  const message = Buffer.alloc(total);
  NTLM_SIGNATURE.copy(message, 0);
  message.writeUInt32LE(3, 8);
  writeSecBuf(message, 12, lmResponse.length, lmOffset);
  writeSecBuf(message, 20, ntResponse.length, ntOffset);
  writeSecBuf(message, 28, domainBuf.length, domainOffset);
  writeSecBuf(message, 36, userBuf.length, userOffset);
  writeSecBuf(message, 44, workstationBuf.length, workstationOffset);
  writeSecBuf(message, 52, 0, total);
  message.writeUInt32LE(NTLM_TYPE3_FLAGS, 60);

  lmResponse.copy(message, lmOffset);
  ntResponse.copy(message, ntOffset);
  domainBuf.copy(message, domainOffset);
  userBuf.copy(message, userOffset);
  workstationBuf.copy(message, workstationOffset);
  return message;
}

function avPair(id, value) {
  const out = Buffer.alloc(4 + value.length);
  out.writeUInt16LE(id, 0);
  out.writeUInt16LE(value.length, 2);
  Buffer.from(value).copy(out, 4);
  return out;
}

const ntlmProvider = {
  needsChallenge: true,
  buildHeaders(auth) {
    if (!auth?.ntlm?.username) return [];
    return [{ key: 'Authorization', value: `NTLM ${buildNtlmType1().toString('base64')}` }];
  },
  buildQuery: () => [],
  buildChallenge(auth, challengeHeader, ctx) {
    const header = pickChallengeHeader(challengeHeader, 'NTLM');
    if (!header) return [];
    const token = header.split(/\s+/)[1] || '';
    if (!token) return [];
    const type3 = buildNtlmType3(auth, Buffer.from(token, 'base64'), ctx);
    return [{ key: 'Authorization', value: `NTLM ${type3.toString('base64')}` }];
  },
};

// ---------------------------------------------------------------------------
// AWS Signature V4
// ---------------------------------------------------------------------------
// Limitations: no streaming/chunked payloads, no S3 UNSIGNED-PAYLOAD policy,
// and only header/query placement — enough for standard REST APIs.

function awsUriEncode(value) {
  return encodeURIComponent(String(value ?? '')).replace(/[!'()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function awsCanonicalUri(pathname) {
  const path = pathname && pathname !== '/' ? pathname : '/';
  return path
    .split('/')
    .map((segment) => awsUriEncode(segment))
    .join('/');
}

function awsCanonicalQuery(entries) {
  return entries
    .map(([key, value]) => [awsUriEncode(key), awsUriEncode(value)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function awsTimestamp(ctx) {
  const date = ctx?.awsDate ? new Date(ctx.awsDate) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error('Invalid AWS signing date');
  const iso = date.toISOString();
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function buildAwsV4(auth, ctx) {
  const cfg = auth?.awsv4 || {};
  if (!cfg.accessKey || !cfg.secretKey) return { headers: [], query: [] };
  if (!cfg.region || !cfg.service) {
    throw new Error('AWS region and service are required');
  }

  const url = urlOf(ctx);
  const amzDate = ctx?.awsDateString || awsTimestamp(ctx);
  const dateStamp = amzDate.slice(0, 8);
  // The Host header Node sends omits the scheme's default port; the signature
  // must use exactly the same value.
  const defaultPort =
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80');
  const host = defaultPort ? url.host.replace(/:\d+$/, '') : url.host;
  const method = methodOf(ctx);
  const payloadHash = crypto
    .createHash('sha256')
    .update(ctx?.body || Buffer.alloc(0))
    .digest('hex');

  const queryEntries = [];
  for (const [key, value] of url.searchParams.entries()) queryEntries.push([key, value]);

  const headers = {
    host,
    'x-amz-date': amzDate,
  };
  if (cfg.sessionToken) headers['x-amz-security-token'] = cfg.sessionToken;
  const contentType = headerValue(ctx?.headers, 'content-type');
  if (contentType) headers['content-type'] = contentType;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');
  const scope = `${dateStamp}/${cfg.region}/${cfg.service}/aws4_request`;
  const addToQuery = cfg.addTo === 'query';

  if (addToQuery) {
    queryEntries.push(
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', `${cfg.accessKey}/${scope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', '3600'],
      ['X-Amz-SignedHeaders', signedHeaders]
    );
    if (cfg.sessionToken) queryEntries.push(['X-Amz-Security-Token', cfg.sessionToken]);
  }

  const canonicalRequest = [
    method,
    awsCanonicalUri(url.pathname),
    awsCanonicalQuery(queryEntries),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${cfg.secretKey}`, dateStamp), cfg.region), cfg.service),
    'aws4_request'
  );
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  if (addToQuery) {
    queryEntries.push(['X-Amz-Signature', signature]);
    return {
      headers: [],
      query: queryEntries
        .filter(([key]) => /^X-Amz-/.test(key))
        .map(([key, value]) => ({ key, value })),
    };
  }

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const out = [
    { key: 'X-Amz-Date', value: amzDate },
    { key: 'Authorization', value: authorization },
  ];
  if (cfg.sessionToken) out.push({ key: 'X-Amz-Security-Token', value: cfg.sessionToken });
  return { headers: out, query: [] };
}

const awsv4Provider = {
  build: (auth, ctx) => buildAwsV4(auth, ctx),
  buildHeaders: (auth, ctx) => buildAwsV4(auth, ctx).headers,
  buildQuery: (auth, ctx) => buildAwsV4(auth, ctx).query,
};

// ---------------------------------------------------------------------------
// JWT bearer
// ---------------------------------------------------------------------------

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function jwtHash(algorithm) {
  const alg = String(algorithm || 'HS256').toUpperCase();
  if (alg === 'HS256' || alg === 'RS256') return 'sha256';
  if (alg === 'HS384' || alg === 'RS384') return 'sha384';
  if (alg === 'HS512' || alg === 'RS512') return 'sha512';
  throw new Error(`Unsupported JWT algorithm: ${algorithm}`);
}

export function signJwt({ payload, secret, privateKey, algorithm = 'HS256', kid = '' }) {
  const parsed = typeof payload === 'string' ? JSON.parse(payload || '{}') : payload;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JWT payload must be a JSON object');
  }
  const header = { alg: algorithm, typ: 'JWT' };
  if (kid) header.kid = kid;
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(parsed))}`;
  const hash = jwtHash(algorithm);

  let signature;
  if (algorithm.toUpperCase().startsWith('HS')) {
    if (!secret) throw new Error('JWT secret is required for HMAC algorithms');
    signature = crypto.createHmac(hash, secret).update(signingInput).digest('base64url');
  } else {
    if (!privateKey) throw new Error('JWT private key is required for RSA algorithms');
    const signer = crypto.createSign(`RSA-${hash.toUpperCase()}`);
    signer.update(signingInput);
    signature = signer.sign(privateKey).toString('base64url');
  }
  return `${signingInput}.${signature}`;
}

function buildJwtHeaders(auth) {
  const cfg = auth?.jwt || {};
  const token = signJwt({
    payload: cfg.payload || '{}',
    secret: cfg.secret,
    privateKey: cfg.privateKey,
    algorithm: cfg.algorithm || 'HS256',
    kid: cfg.kid || '',
  });
  const prefix = cfg.headerPrefix ?? 'Bearer';
  return [{ key: 'Authorization', value: `${prefix} ${token}`.trim() }];
}

const jwtProvider = {
  buildHeaders: (auth) => buildJwtHeaders(auth),
  buildQuery: () => [],
};

// ---------------------------------------------------------------------------
// Registry + public API
// ---------------------------------------------------------------------------

const PROVIDERS = {
  none: noneProvider,
  bearer: bearerProvider,
  basic: basicProvider,
  apikey: apikeyProvider,
  oauth1: oauth1Provider,
  oauth2: {
    // The engine resolves OAuth2 through auth/index.js (token cache + refresh);
    // this fallback keeps `applyAuth` usable on its own.
    buildHeaders(auth) {
      const token = auth?.oauth2?.accessToken;
      if (!token) return [];
      const prefix = auth.oauth2.headerPrefix || 'Bearer';
      return [{ key: 'Authorization', value: `${prefix} ${token}`.trim() }];
    },
    buildQuery: () => [],
  },
  digest: digestProvider,
  ntlm: ntlmProvider,
  awsv4: awsv4Provider,
  jwt: jwtProvider,
};

export function providerTypes() {
  return Object.keys(PROVIDERS);
}

export function getProvider(type) {
  return PROVIDERS[type] || null;
}

/**
 * Synchronous auth application. Digest/NTLM return no header here because they
 * need a server challenge; use buildChallengeResponse for the retry.
 */
export function applyAuth(auth, ctx = {}) {
  const provider = getProvider(auth?.type);
  if (!provider) return { headers: [], query: [] };
  if (typeof provider.build === 'function') {
    return provider.build(auth, ctx) || { headers: [], query: [] };
  }
  const headers = provider.buildHeaders(auth, ctx) || [];
  const query = provider.buildQuery(auth, ctx) || [];
  return { headers, query };
}

export function needsChallenge(type) {
  return Boolean(getProvider(type)?.needsChallenge);
}

/**
 * Build the Authorization header for a 401 challenge. Returns [] when the
 * challenge is malformed or does not match the auth type.
 */
export function buildChallengeResponse(auth, challenge, ctx = {}) {
  const provider = getProvider(auth?.type);
  if (!provider?.buildChallenge) return [];
  return provider.buildChallenge(auth, challenge, ctx) || [];
}

// Exported for tests and advanced callers.
export const _internals = {
  percentEncode,
  md4,
  ntowfV2,
  buildNtlmType1,
  parseNtlmType2,
  buildNtlmType3,
  buildDigestChallenge,
  buildOAuth1,
  buildAwsV4,
};
