import { sha256Hex, signRequest } from '../../src/common/utils/sigv4';

/**
 * AWS's published Signature V4 example for S3 ("Example: GET Object", Amazon S3 API reference,
 * "Signature Calculations for the Authorization Header"). If this test passes the signer is byte-exact.
 */
describe('SigV4 signer', () => {
  const creds = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };

  it('reproduces the AWS S3 GET Object example signature', () => {
    const headers = signRequest(
      {
        method: 'GET',
        url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
        region: 'us-east-1',
        service: 's3',
        headers: { Range: 'bytes=0-9' },
        payloadHash: sha256Hex(''),
        now: new Date('2013-05-24T00:00:00Z'),
      },
      creds,
    );
    expect(headers.Authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
  });

  it('adds the session token as a signed header when present', () => {
    const h = signRequest(
      {
        method: 'PUT',
        url: new URL('https://b.s3.me-central-1.amazonaws.com/k'),
        region: 'me-central-1',
        service: 's3',
        payloadHash: sha256Hex('x'),
        now: new Date('2026-01-01T00:00:00Z'),
      },
      { ...creds, sessionToken: 'TOKEN' },
    );
    expect(h['x-amz-security-token']).toBe('TOKEN');
    expect(h.Authorization).toContain('x-amz-security-token');
  });
});
