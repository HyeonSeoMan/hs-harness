import { describe, expect, it } from 'vitest';
import { maskSecrets, parseSingleJsonObject, redact } from '../src/cli/common.ts';

describe('maskSecrets (합성 값만 사용)', () => {
  it.each([
    ['token = syntheticToken123456', 'syntheticToken123456'],
    ['token=syntheticToken123456', 'syntheticToken123456'],
    ['token   :   syntheticToken123456', 'syntheticToken123456'],
    ['password: hunter2', 'hunter2'],
    ['PASSWORD = hunter2', 'hunter2'],
    ['"api_key": "synthvalue123"', 'synthvalue123'],
    ["'api_key' : 'synthvalue123'", 'synthvalue123'],
    ['{"access_token":"synthvalue123","x":1}', 'synthvalue123'],
    ['client_secret = "plainsecretvalue"', 'plainsecretvalue'], // 따옴표 값은 숫자가 없어도 가린다
    ['password: "changeme"', 'changeme'],
    ['export OPENAI_API_KEY=abc123def456', 'abc123def456'],
  ])('%s', (input, secret) => {
    const out = maskSecrets(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('***');
  });

  it('키 이름은 남기고 값만 가린다', () => {
    expect(maskSecrets('password: hunter2')).toMatch(/^password\s*:\s*\*\*\*$/);
    expect(maskSecrets('"api_key": "synthvalue123"')).toBe('"api_key": "***"');
  });

  it.each([
    ['sk-synthetic-0123456789abcdef', 'sk-synthetic'],
    ['ghp_syntheticSYNTHETICsynthetic0123', 'ghp_synthetic'],
    ['AKIAIOSFODNN7SYNTH12', 'AKIAIOSFODNN7SYNTH12'],
    ['Authorization: Bearer synthetictoken0123456789', 'synthetictoken0123456789'],
  ])('기존 형태 유지: %s', (input, secret) => {
    expect(maskSecrets(input)).not.toContain(secret);
  });

  it('여러 줄의 비밀값을 모두 가리되 줄바꿈과 나머지 내용은 보존한다', () => {
    const out = maskSecrets('line1\ntoken = syntheticToken123456\npassword: hunter2\nline4 ends');
    expect(out.split('\n')).toHaveLength(4);
    expect(out).toContain('line1');
    expect(out).toContain('line4 ends');
    expect(out).not.toMatch(/syntheticToken123456|hunter2/);
  });

  it.each([
    'The token is invalid or expired.',
    'token: handling is missing in the retry path',
    'password: required field',
    'const token = getToken();',
    'const apiKey = process.env.API_KEY;',
    "api_key = os.environ['API_KEY']",
    'secret: string;',
    'max_tokens = 4096',
    'tokens: 1000 per minute',
    'password = x',
    'Use a stronger password = longer passphrase',
    'token = "${TOKEN}"',
    'the secret to good code review is reading the diff',
    'function validatePassword(password) { return password.length > 8 }',
    'Authorization header is missing',
  ])('일반 코드·설명은 그대로 둔다: %s', (text) => {
    expect(maskSecrets(text)).toBe(text);
  });

  it('redact는 마스킹 후 한 줄로 정리하고 길이를 제한한다', () => {
    expect(redact('a\n  token = syntheticToken123456\n b')).toBe('a token = *** b');
    expect(redact('x'.repeat(1000)).length).toBeLessThan(450);
  });
});

describe('parseSingleJsonObject: 키 중복(디코딩 후 기준)', () => {
  const ok = (t: string) => expect(parseSingleJsonObject(t)).not.toBeNull();
  const bad = (t: string) => expect(parseSingleJsonObject(t)).toBeNull();

  it('디코딩 후 같은 키는 거부한다', () => {
    bad(String.raw`{"verdict":"a","verdict":"b"}`);
    bad(String.raw`{"verdict":"a","verdict":"b"}`);
    bad(String.raw`{"a":1,"a":2}`);
    bad(String.raw`{"a\/b":1,"a/b":2}`); // \/ 도 같은 문자
    bad('{"a":1,"a":2}');
  });

  it('중첩 객체와 배열 속 객체도 객체별로 검사한다', () => {
    bad('{"o":{"k":1,"k":2}}');
    bad(String.raw`{"o":[{"k":1},{"x":1,"x":2}]}`);
    bad('{"a":{"b":{"c":[{"d":1,"d":2}]}}}');
  });

  it('형제 객체의 같은 키, 문자열 값 속 키 모양 텍스트, 이스케이프된 따옴표는 중복이 아니다', () => {
    ok('{"a":{"k":1},"b":{"k":2},"c":[{"k":1},{"k":2}]}');
    ok(String.raw`{"a":"{\"k\":1,\"k\":2}","b":"}{","c":"\\"}`);
    ok('{"a":1,"A":2}'); // 대소문자는 다른 키
    ok('{}');
    ok('{"a":[],"b":{}}');
  });

  it('유니코드 키와 서로게이트 쌍도 올바르게 비교한다', () => {
    ok(String.raw`{"한글":1,"한":2}`);
    bad(String.raw`{"한":1,"한":2}`);
    ok(String.raw`{"😀":1,"\ud83d":2}`); // 홀로 선 서로게이트는 다른 문자열
    bad(String.raw`{"😀":1,"😀":2}`);
  });
});

describe('maskSecrets: 따옴표로 감싼 값 전체를 파싱해 가린다 (내부 공백·반대 따옴표·이스케이프)', () => {
  it.each([
    ['Codex 재현 1: 내부 공백', 'password: "synthetic phrase 123456"', ['synthetic', 'phrase', '123456']],
    ['Codex 재현 2: 반대쪽 따옴표 포함', `client_secret = "synthetic'Quoted123"`, ['synthetic', 'Quoted123']],
    ['작은따옴표 값 안의 큰따옴표', `token: 'synth"quoted 987654'`, ['synth', 'quoted', '987654']],
    ['이스케이프된 큰따옴표', String.raw`api_key = "abc\"def123456 tail"`, ['def123456', 'tail']],
    ['이스케이프된 작은따옴표', String.raw`secret: 'it\'s a secret 1234'`, ['secret 1234', "it\\'s"]],
    ['숫자 없는 암구호', 'password = "correct horse battery staple"', ['correct', 'horse', 'battery', 'staple']],
    ['JSON 문자열 안에 이스케이프된 형태', String.raw`{\"api_key\": \"synth value 12345\"}`, ['synth value', '12345']],
    ['키 이름에 따옴표', `{"client_secret": "a b c 123456"}`, ['a b c', '123456']],
  ])('%s', (_name, input, leaked) => {
    const out = maskSecrets(input);
    for (const piece of leaked) expect(out, `leaked "${piece}" in: ${out}`).not.toContain(piece);
    expect(out).toContain('***');
  });

  it('같은 줄의 여러 값과 앞뒤 문맥은 보존하고, 닫히지 않은 따옴표는 그 줄 끝까지만 가린다', () => {
    const two = maskSecrets(`password: "a b 1234", token: 'c d 5678' ok`);
    expect(two).not.toMatch(/a b 1234|c d 5678/);
    expect(two).toContain(', ');
    expect(two.endsWith(' ok')).toBe(true);

    const open = maskSecrets('password: "never closed 123456\nnext line stays: fine');
    expect(open).not.toContain('123456');
    expect(open).toContain('next line stays: fine');
  });

  it('따옴표와 값의 구조(키 이름·따옴표·구분자)는 유지한다', () => {
    expect(maskSecrets('password: "synthetic phrase 123456"')).toBe('password: "***"');
    expect(maskSecrets(`client_secret = 'x y z 1234'`)).toBe(`client_secret = '***'`);
  });

  it.each([
    'password: "${PASSWORD}"',
    'token = "<your token here>"',
    'secret: "{{ vault.secret }}"',
    'password = ""',
    'token = "x"',
    'He said "hello world 123456" to me',
    'the label "password" is shown above the field',
    'if (password == "") return false;',
    'Enter your password: ',
  ])('자리표시자·빈 값·일반 문장은 가리지 않는다: %s', (text) => {
    expect(maskSecrets(text)).toBe(text);
  });
});

describe('maskSecrets: 외부 입력(최대 수 MB)에 대해 선형에 가깝게 동작한다', () => {
  it.each([
    ['키워드 반복', 'token'.repeat(1_000_000)],
    ['접두 문자 반복', ('api_key' + '_'.repeat(50)).repeat(80_000)],
    ['닫히지 않은 따옴표', `password: "${'x'.repeat(5_000_000)}`],
    ['백슬래시 반복', `password: "${'\\'.repeat(5_000_000)}`],
    ['짧은 쌍 반복', 'password: "ab cd 12", '.repeat(150_000)],
  ])('%s', (_name, text) => {
    const started = Date.now();
    maskSecrets(text);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
