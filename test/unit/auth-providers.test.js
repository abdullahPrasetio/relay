import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyAuth,
  buildChallengeResponse,
  needsChallenge,
  providerTypes,
  signJwt,
  _internals,
} from '../../packages/core/src/auth/providers.js';

// Build a minimal MS-NLMP CHALLENGE_MESSAGE for the NTLMv2 vector tests.
function ntlmType2({ flags, serverChallenge, targetInfo }) {
  const targetInfoBuffer = Buffer.isBuffer(targetInfo) ? targetInfo : Buffer.alloc(0);
  const message = Buffer.alloc(48 + targetInfoBuffer.length);
  message.write('NTLMSSP\0', 0, 'latin1');
  message.writeUInt32LE(2, 8);
  message.writeUInt32LE(flags >>> 0, 20);
  Buffer.from(serverChallenge, 'hex').copy(message, 24);
  message.writeUInt16LE(targetInfoBuffer.length, 40);
  message.writeUInt32LE(48, 44);
  targetInfoBuffer.copy(message, 48);
  return message;
}

const NTLMV2_TARGET_INFO = Buffer.concat([
  Buffer.from('02000c00', 'hex'),
  Buffer.from('Domain', 'utf16le'),
  Buffer.from('01000c00', 'hex'),
  Buffer.from('Server', 'utf16le'),
  Buffer.from('00000000', 'hex'),
]);

describe('provider registry', () => {
  it('lists all implemented auth types', () => {
    expect(providerTypes()).toEqual([
      'none',
      'bearer',
      'basic',
      'apikey',
      'oauth1',
      'oauth2',
      'digest',
      'ntlm',
      'awsv4',
      'jwt',
    ]);
  });

  it('marks only challenge-based schemes', () => {
    expect(needsChallenge('digest')).toBe(true);
    expect(needsChallenge('ntlm')).toBe(true);
    expect(needsChallenge('bearer')).toBe(false);
    expect(needsChallenge('awsv4')).toBe(false);
  });
});

describe('bearer / basic / apikey parity with the old engine', () => {
  it('builds a bearer header', () => {
    expect(applyAuth({ type: 'bearer', bearer: { token: 'abc' } })).toEqual({
      headers: [{ key: 'Authorization', value: 'Bearer abc' }],
      query: [],
    });
  });

  it('builds basic auth with base64 utf8 credentials', () => {
    const encoded = Buffer.from('user:pass', 'utf8').toString('base64');
    expect(
      applyAuth({ type: 'basic', basic: { username: 'user', password: 'pass' } }).headers
    ).toEqual([{ key: 'Authorization', value: `Basic ${encoded}` }]);
  });

  it('places API keys in the header or the query string', () => {
    const auth = { type: 'apikey', apikey: { key: 'X-Key', value: 'v', addTo: 'header' } };
    expect(applyAuth(auth)).toEqual({
      headers: [{ key: 'X-Key', value: 'v' }],
      query: [],
    });
    expect(applyAuth({ ...auth, apikey: { ...auth.apikey, addTo: 'query' } })).toEqual({
      headers: [],
      query: [{ key: 'X-Key', value: 'v' }],
    });
  });

  it('uses the stored OAuth2 access token', () => {
    expect(
      applyAuth({ type: 'oauth2', oauth2: { accessToken: 'tok', headerPrefix: 'Token' } }).headers
    ).toEqual([{ key: 'Authorization', value: 'Token tok' }]);
  });

  it('returns nothing for none/unknown types', () => {
    expect(applyAuth({ type: 'none' })).toEqual({ headers: [], query: [] });
    expect(applyAuth({ type: 'mystery' })).toEqual({ headers: [], query: [] });
    expect(applyAuth(null)).toEqual({ headers: [], query: [] });
  });
});

describe('OAuth 1.0a', () => {
  // RFC 5849 signature vector (Twitter's documented example, consistent with
  // RFC 5849 §3.4.1). Expected signature: hCtSmYh+iHYCEqBWrE7C7hYmtUk=
  const auth = {
    type: 'oauth1',
    oauth1: {
      consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
      consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
      token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
      tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
      signatureMethod: 'HMAC-SHA1',
      addTo: 'header',
      version: '1.0',
    },
  };
  const ctx = {
    method: 'POST',
    url: 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true',
    body: Buffer.from(
      'status=Hello%20Ladies%20%2b%20Gentlemen%2c%20a%20signed%20OAuth%20request%21'
    ),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    oauthNonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    oauthTimestamp: 1318622958,
  };

  it('matches the RFC 5849 HMAC-SHA1 signature vector', () => {
    const { headers } = applyAuth(auth, ctx);
    const header = headers[0].value;
    // The signature is percent-encoded inside the Authorization header.
    expect(header).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
    expect(header).toContain('oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg"');
    expect(header).toContain('oauth_timestamp="1318622958"');
  });

  it('can place OAuth params in the query string', () => {
    const { headers, query } = applyAuth(
      { ...auth, oauth1: { ...auth.oauth1, addTo: 'query' } },
      ctx
    );
    expect(headers).toEqual([]);
    const signature = query.find((p) => p.key === 'oauth_signature');
    expect(signature.value).toBe('hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
  });
});

describe('Digest (RFC 7616)', () => {
  const challenge =
    'Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=MD5, ' +
    'nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", ' +
    'opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"';
  const ctx = {
    method: 'GET',
    url: 'http://www.example.com/dir/index.html',
    headers: {},
    uri: '/dir/index.html',
    cnonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ',
    nc: '00000001',
  };

  it('matches the RFC 7616 MD5 vector', () => {
    const [header] = buildChallengeResponse(
      { type: 'digest', digest: { username: 'Mufasa', password: 'Circle of Life' } },
      challenge,
      ctx
    );
    expect(header.value).toContain('response="8ca523f5e9506fed4657c9700eebdbec"');
    expect(header.value).toContain('qop=auth');
    expect(header.value).toContain('nc=00000001');
    expect(header.value).toContain(
      'cnonce="f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ"'
    );
  });

  it('matches the RFC 7616 SHA-256 vector', () => {
    const [header] = buildChallengeResponse(
      { type: 'digest', digest: { username: 'Mufasa', password: 'Circle of Life' } },
      challenge.replace('MD5', 'SHA-256'),
      ctx
    );
    expect(header.value).toContain(
      'response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"'
    );
    expect(header.value).toContain('algorithm=SHA-256');
  });

  it('does not emit a header without a challenge', () => {
    expect(applyAuth({ type: 'digest', digest: {} }, ctx)).toEqual({ headers: [], query: [] });
  });
});

describe('NTLM (MS-NLMP)', () => {
  const auth = {
    type: 'ntlm',
    ntlm: { username: 'User', password: 'Password', domain: 'Domain', workstation: 'COMPUTER' },
  };
  const type2 = ntlmType2({
    flags: 0x00088207,
    serverChallenge: '0123456789abcdef',
    targetInfo: NTLMV2_TARGET_INFO,
  });

  it('emits a well-formed Type 1 message', () => {
    const { headers } = applyAuth(auth, { method: 'GET', url: 'http://localhost/' });
    const type1 = Buffer.from(headers[0].value.split(' ')[1], 'base64');
    expect(type1.toString('latin1', 0, 8)).toBe('NTLMSSP\0');
    expect(type1.readUInt32LE(8)).toBe(1);
    // UNICODE | NTLM | EXTENDED_SESSIONSECURITY must be negotiated.
    const flags = type1.readUInt32LE(12);
    expect(flags & 0x00000001).toBeTruthy();
    expect(flags & 0x00000200).toBeTruthy();
    expect(flags & 0x00080000).toBeTruthy();
    // Empty domain + workstation security buffers.
    expect(type1.readUInt16LE(16)).toBe(0);
    expect(type1.readUInt16LE(24)).toBe(0);
  });

  it('matches the MS-NLMP §4.2.4 NTLMv2 vector', () => {
    // Source: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-nlmp/946f54bd-76b5-4b18-ace8-6e8c992d5847
    const [header] = buildChallengeResponse(
      auth,
      `NTLM ${type2.toString('base64')}`,
      {
        clientChallenge: Buffer.from('aaaaaaaaaaaaaaaa', 'hex'),
        timestamp: Buffer.alloc(8),
      }
    );
    expect(header.value).toMatch(/^NTLM /);
    const type3 = Buffer.from(header.value.split(' ')[1], 'base64');
    expect(type3.toString('latin1', 0, 8)).toBe('NTLMSSP\0');
    expect(type3.readUInt32LE(8)).toBe(3);

    const lmLen = type3.readUInt16LE(12);
    const lmOff = type3.readUInt32LE(16);
    const ntLen = type3.readUInt16LE(20);
    const ntOff = type3.readUInt32LE(24);

    // LMv2 response from the same vector.
    expect(type3.subarray(lmOff, lmOff + lmLen).toString('hex')).toBe(
      '86c35097ac9cec102554764a57cccc19aaaaaaaaaaaaaaaa'
    );

    // NTProofStr followed by NTLMv2_CLIENT_CHALLENGE.
    const expectedTemp = Buffer.concat([
      Buffer.from('0101000000000000', 'hex'),
      Buffer.alloc(8),
      Buffer.from('aaaaaaaaaaaaaaaa', 'hex'),
      Buffer.from('00000000', 'hex'),
      Buffer.from('02000c0044006f006d00610069006e00', 'hex'),
      Buffer.from('01000c00530065007200760065007200', 'hex'),
      Buffer.from('0000000000000000', 'hex'),
    ]);
    expect(type3.subarray(ntOff, ntOff + ntLen).toString('hex')).toBe(
      `68cd0ab851e51c96aabc927bebef6a1c${expectedTemp.toString('hex')}`
    );
  });

  it('ignores challenges for other schemes', () => {
    expect(buildChallengeResponse(auth, 'Bearer realm="x"', {})).toEqual([]);
  });
});

describe('AWS Signature V4', () => {
  // Official AWS SigV4 test suite "get-vanilla" vector:
  // https://github.com/awslabs/aws-c-auth/tree/main/tests/aws-signing-test-suite/v4/get-vanilla
  const auth = {
    type: 'awsv4',
    awsv4: {
      accessKey: 'AKIDEXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 'service',
      addTo: 'header',
    },
  };
  const ctx = {
    method: 'GET',
    url: 'http://example.amazonaws.com/',
    headers: {},
    body: null,
    awsDate: '2015-08-30T12:36:00Z',
  };

  it('matches the official get-vanilla signature', () => {
    const { headers } = applyAuth(auth, ctx);
    const authorization = headers.find((h) => h.key === 'Authorization').value;
    expect(authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
    );
    expect(headers.find((h) => h.key === 'X-Amz-Date').value).toBe('20150830T123600Z');
  });

  it('adds the session token header', () => {
    const { headers } = applyAuth(
      { ...auth, awsv4: { ...auth.awsv4, sessionToken: 'session-token' } },
      ctx
    );
    expect(headers.find((h) => h.key === 'X-Amz-Security-Token').value).toBe('session-token');
  });

  it('supports query-string signing', () => {
    const { headers, query } = applyAuth(
      { ...auth, awsv4: { ...auth.awsv4, addTo: 'query' } },
      ctx
    );
    expect(headers).toEqual([]);
    expect(query.find((q) => q.key === 'X-Amz-Signature')).toBeTruthy();
    expect(query.find((q) => q.key === 'X-Amz-Algorithm').value).toBe('AWS4-HMAC-SHA256');
  });

  it('requires region and service', () => {
    expect(() => applyAuth({ type: 'awsv4', awsv4: { accessKey: 'a', secretKey: 'b' } }, ctx)).toThrow(
      /region and service/
    );
  });
});

describe('JWT', () => {
  const payload = { sub: '1234567890', name: 'John Doe', iat: 1516239022 };

  it('matches the jwt.io HS256 vector', () => {
    const token = signJwt({
      payload: JSON.stringify(payload),
      secret: 'your-256-bit-secret',
      algorithm: 'HS256',
    });
    expect(token).toBe(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
        'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.' +
        'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    );
  });

  it('sends the token as a Bearer header', () => {
    const { headers } = applyAuth({
      type: 'jwt',
      jwt: { algorithm: 'HS256', secret: 's', payload: JSON.stringify(payload) },
    });
    expect(headers[0].key).toBe('Authorization');
    expect(headers[0].value.startsWith('Bearer eyJ')).toBe(true);
  });

  it('round-trips an RS256 signature', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = signJwt({
      payload: JSON.stringify(payload),
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      algorithm: 'RS256',
    });
    const [header, body, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString()).alg).toBe('RS256');
    expect(JSON.parse(Buffer.from(body, 'base64url').toString())).toEqual(payload);
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${header}.${body}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  });

  it('rejects invalid payloads and missing keys', () => {
    expect(() => signJwt({ payload: 'not json', secret: 's' })).toThrow(/JSON/);
    expect(() => signJwt({ payload: '{}', algorithm: 'HS256' })).toThrow(/secret is required/);
  });
});

describe('internal crypto helpers', () => {
  it('implements MD4 (OpenSSL legacy provider is unavailable)', () => {
    // RFC 1320 test vector.
    expect(_internals.md4(Buffer.from('abc')).toString('hex')).toBe(
      'a448017aaf21d8525fc10ae87aa6729d'
    );
  });
});
